import { ref, watch, onMounted, onUnmounted, type Ref, computed, isRef } from 'vue';
import {
  getVisibleTools,
  getDelegateFeatureSets,
  type ToolInfo,
  type DelegateFeatureSets,
} from '@/services/api';
import { useDelegates } from './useDelegates';
import { useStore } from '@/store';

/**
 * Composable for conversation-scoped tool + feature-set state.
 *
 * Fetches visible tools and delegate feature sets for a specific conversation.
 * Refreshes on:
 *   1. useDelegates().lastFetched change (session-level runtime changes)
 *   2. WS `mcpl/conversation_feature_sets_changed` (user-triggered per-conversation toggles)
 *
 * useDelegates stays global-only; this composable owns conversation-scoped data.
 */
export function useConversationDelegateTools(conversationId: Ref<string | undefined> | string) {
  const store = useStore();
  const { lastFetched } = useDelegates();

  const visibleTools = ref<ToolInfo[]>([]);
  const delegateFeatureSets = ref<DelegateFeatureSets[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let wsListenerRegistered = false;

  const resolvedConversationId = computed(() =>
    isRef(conversationId) ? conversationId.value : conversationId
  );

  const refresh = async (): Promise<void> => {
    const convId = resolvedConversationId.value;
    if (!convId) return;

    loading.value = true;
    error.value = null;

    try {
      const [toolsResult, featureSetsResult] = await Promise.all([
        getVisibleTools(convId),
        getDelegateFeatureSets(convId),
      ]);
      visibleTools.value = toolsResult.tools;
      delegateFeatureSets.value = featureSetsResult.delegates;
    } catch (err) {
      console.error('[useConversationDelegateTools] Fetch error:', err);
      error.value = err instanceof Error ? err.message : 'Failed to fetch';
    } finally {
      loading.value = false;
    }
  };

  const debouncedRefresh = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      refresh();
      debounceTimer = null;
    }, 500);
  };

  // WS handler for conversation-level feature set changes
  const handleConversationFeatureSetsChanged = (data: any) => {
    if (data.conversationId === resolvedConversationId.value) {
      debouncedRefresh();
    }
  };

  const setupWsListener = () => {
    if (wsListenerRegistered) return;
    const wsService = store.state.wsService;
    if (wsService) {
      wsService.on('mcpl/conversation_feature_sets_changed', handleConversationFeatureSetsChanged);
      wsListenerRegistered = true;
    }
  };

  const cleanupWsListener = () => {
    if (!wsListenerRegistered) return;
    const wsService = store.state.wsService;
    if (wsService) {
      wsService.off('mcpl/conversation_feature_sets_changed', handleConversationFeatureSetsChanged);
      wsListenerRegistered = false;
    }
  };

  // Watch session-level changes (useDelegates refreshes on mcpl/feature_sets_runtime_changed)
  watch(lastFetched, () => {
    if (resolvedConversationId.value) {
      debouncedRefresh();
    }
  });

  // Watch conversationId changes
  watch(resolvedConversationId, (newId) => {
    if (newId) {
      refresh();
    } else {
      visibleTools.value = [];
      delegateFeatureSets.value = [];
    }
  });

  // Watch for wsService availability
  watch(
    () => store.state.wsService,
    (wsService) => {
      if (wsService) {
        setupWsListener();
      }
    },
    { immediate: true }
  );

  onMounted(() => {
    setupWsListener();
    if (resolvedConversationId.value) {
      refresh();
    }
  });

  onUnmounted(() => {
    cleanupWsListener();
    if (debounceTimer) clearTimeout(debounceTimer);
  });

  return {
    visibleTools,
    delegateFeatureSets,
    loading,
    error,
    refresh,
  };
}
