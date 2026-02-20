<template>
  <div
    class="checkpoint-panel"
    :class="{ 'mobile-overlay': isMobile }"
  >
    <div class="panel-header">
      <h3>Checkpoints</h3>
      <div class="panel-actions">
        <v-btn-toggle v-model="activeView" mandatory density="compact" class="mr-1">
          <v-btn value="tree" size="x-small" title="Branch tree">
            <v-icon size="16">mdi-graph-outline</v-icon>
          </v-btn>
          <v-btn value="timeline" size="x-small" title="Timeline">
            <v-icon size="16">mdi-timeline-clock-outline</v-icon>
          </v-btn>
        </v-btn-toggle>
        <v-btn
          icon="mdi-refresh"
          size="small"
          variant="text"
          :loading="loading || timelineLoading"
          @click="activeView === 'timeline' ? loadTimeline() : loadCheckpoints()"
          title="Refresh"
        />
        <v-btn
          icon="mdi-close"
          size="small"
          variant="text"
          @click="$emit('close')"
        />
      </div>
    </div>

    <div class="panel-content">
      <!-- ==================== Tree View ==================== -->
      <template v-if="activeView === 'tree'">
        <!-- Initial loading state -->
        <div v-if="loading && !loadedOnce" class="loading-state">
          <v-progress-circular indeterminate size="24" />
        </div>

        <!-- Empty state (only shown after first load completes) -->
        <div v-else-if="loadedOnce && checkpoints.length === 0 && !errorMessage" class="empty-state">
          <v-icon size="32" color="grey">mdi-flag-outline</v-icon>
          <p>No checkpoints yet</p>
        </div>

        <!-- Error state -->
        <div v-else-if="errorMessage" class="empty-state">
          <v-icon size="32" color="error">mdi-alert-circle-outline</v-icon>
          <p>{{ errorMessage }}</p>
        </div>

        <!-- Tree + detail card -->
        <template v-else-if="loadedOnce && checkpoints.length > 0">
          <!-- Subtle loading indicator for refreshes -->
          <v-progress-linear
            v-if="loading"
            indeterminate
            color="primary"
            height="2"
            class="refresh-indicator"
          />

          <!-- D3 Mini-Tree SVG -->
          <div class="tree-container">
            <svg ref="svgRef" class="checkpoint-tree"></svg>
          </div>

          <!-- Selected Node Detail Card -->
          <v-card
            v-if="selectedNode && selectedNode.id !== '__root__'"
            class="detail-card"
            variant="outlined"
          >
            <v-card-text class="pa-3">
              <div class="detail-header">
                <span class="detail-id">{{ selectedNode.id.slice(0, 12) }}...</span>
                <v-chip
                  v-if="selectedNode.isCurrent"
                  size="x-small"
                  color="success"
                  variant="flat"
                >
                  Current
                </v-chip>
              </div>
              <div class="detail-label" v-if="selectedNode.label">
                {{ selectedNode.label }}
              </div>
              <div class="detail-meta">
                <div><v-icon size="12" class="mr-1">mdi-clock-outline</v-icon>{{ formatTime(selectedNode.createdAt) }}</div>
                <div><v-icon size="12" class="mr-1">mdi-counter</v-icon>{{ selectedNode.mutationCount }} mutations</div>
                <div v-if="selectedNode.children.length > 0">
                  <v-icon size="12" class="mr-1">mdi-source-branch</v-icon>{{ selectedNode.children.length }} {{ selectedNode.children.length === 1 ? 'branch' : 'branches' }}
                </div>
              </div>
              <v-btn
                v-if="!selectedNode.isCurrent"
                block
                size="small"
                color="warning"
                variant="outlined"
                class="mt-2"
                :loading="rollingBack"
                @click="showRollbackConfirm = true"
              >
                <v-icon size="16" class="mr-1">mdi-undo</v-icon>
                Rollback to here
              </v-btn>
            </v-card-text>
          </v-card>
        </template>
      </template>

      <!-- ==================== Timeline View ==================== -->
      <template v-else-if="activeView === 'timeline'">
        <v-progress-linear v-if="timelineLoading" indeterminate height="2" color="primary" />

        <div v-if="timelineError" class="empty-state">
          <v-icon size="32" color="error">mdi-alert-circle-outline</v-icon>
          <p>{{ timelineError }}</p>
        </div>

        <div v-else-if="!timelineLoading && timelineEvents.length === 0" class="empty-state">
          <v-icon size="32" color="grey">mdi-timeline-clock-outline</v-icon>
          <p>No checkpoint events yet</p>
        </div>

        <div v-else class="timeline-list">
          <div
            v-for="evt in timelineEvents"
            :key="`${evt.timestamp}|${evt.action}|${evt.checkpointId ?? ''}|${evt.nodeId ?? ''}`"
            class="timeline-item"
          >
            <v-icon :color="getActionColor(evt.action)" size="18">
              {{ getActionIcon(evt.action) }}
            </v-icon>
            <div class="timeline-content">
              <div class="timeline-desc">{{ getActionDescription(evt) }}</div>
              <div class="timeline-meta">{{ formatTime(new Date(evt.timestamp).getTime()) }}</div>
            </div>
          </div>
        </div>
      </template>

      <!-- Not connected warning -->
      <v-alert
        v-if="!wsService"
        type="warning"
        variant="tonal"
        density="compact"
        class="ma-2"
      >
        Not connected
      </v-alert>
    </div>

    <!-- Rollback Confirmation Dialog -->
    <v-dialog v-model="showRollbackConfirm" max-width="400">
      <v-card>
        <v-card-title class="text-h6">Confirm Rollback</v-card-title>
        <v-card-text>
          This will restore the conversation state to this checkpoint. Continue?
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="showRollbackConfirm = false">Cancel</v-btn>
          <v-btn
            color="warning"
            variant="flat"
            :loading="rollingBack"
            @click="doRollback"
          >
            Rollback
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Snackbar for errors/feedback -->
    <v-snackbar
      v-model="snackbar.show"
      :color="snackbar.color"
      :timeout="4000"
      location="bottom"
    >
      {{ snackbar.text }}
    </v-snackbar>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, watch, onUnmounted, computed, nextTick } from 'vue';
import { useStore } from '@/store';
import * as d3 from 'd3';
import type { CheckpointNodeInfo, CheckpointTimelineEvent } from '@deprecated-claude/shared';

// --------------------------------------------------------------------------
// Props / Emits
// --------------------------------------------------------------------------

const props = defineProps<{
  conversationId: string;
  isMobile: boolean;
  checkpointEpoch: number;
}>();

const emit = defineEmits<{
  close: [];
  'rollback-complete': [];
}>();

// --------------------------------------------------------------------------
// Store + WS
// --------------------------------------------------------------------------

const store = useStore();
const wsService = computed(() => store.state.wsService);

// --------------------------------------------------------------------------
// State
// --------------------------------------------------------------------------

const loading = ref(false);
const loadedOnce = ref(false);
const pendingReload = ref(false);
const checkpoints = ref<CheckpointNodeInfo[]>([]);
const currentCheckpointId = ref('');
const selectedNodeId = ref<string | null>(null);
const rollingBack = ref(false);
const showRollbackConfirm = ref(false);
const errorMessage = ref<string | null>(null);
const pendingListRequestId = ref<string | null>(null);
const pendingRollbackRequestId = ref<string | null>(null);
const snackbar = reactive({ show: false, text: '', color: 'error' });
const svgRef = ref<SVGSVGElement | null>(null);
const activeView = ref<'tree' | 'timeline'>('tree');

const selectedNode = computed(() => {
  if (!selectedNodeId.value) return null;
  return checkpoints.value.find(c => c.id === selectedNodeId.value) ?? null;
});

// --------------------------------------------------------------------------
// UUID Helper
// --------------------------------------------------------------------------

function generateRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }
  // Last-resort fallback
  return 'req_' + Math.random().toString(16).slice(2);
}

// --------------------------------------------------------------------------
// Time formatting (same as EventHistoryPanel)
// --------------------------------------------------------------------------

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// --------------------------------------------------------------------------
// Load checkpoints
// --------------------------------------------------------------------------

let listTimeout: ReturnType<typeof setTimeout> | null = null;

function loadCheckpoints() {
  if (!wsService.value) return;
  if (loading.value) {
    pendingReload.value = true;
    return;
  }

  loading.value = true;
  pendingReload.value = false;
  errorMessage.value = null;

  const requestId = generateRequestId();
  pendingListRequestId.value = requestId;

  wsService.value.sendMessage({
    type: 'checkpoint_list',
    conversationId: props.conversationId,
    requestId,
  });

  // Timeout: reset loading + drain queued reload + snackbar
  if (listTimeout) clearTimeout(listTimeout);
  listTimeout = setTimeout(() => {
    if (pendingListRequestId.value === requestId) {
      loading.value = false;
      pendingListRequestId.value = null;

      const shouldRetry = pendingReload.value;
      pendingReload.value = false;

      snackbar.text = 'Checkpoint list request timed out';
      snackbar.color = 'warning';
      snackbar.show = true;

      if (shouldRetry) loadCheckpoints();
    }
  }, 15_000);
}

// --------------------------------------------------------------------------
// Rollback
// --------------------------------------------------------------------------

let rollbackTimeout: ReturnType<typeof setTimeout> | null = null;

function doRollback() {
  if (!wsService.value || !selectedNodeId.value) return;

  showRollbackConfirm.value = false;
  rollingBack.value = true;

  const requestId = generateRequestId();
  pendingRollbackRequestId.value = requestId;

  wsService.value.sendMessage({
    type: 'checkpoint_rollback',
    conversationId: props.conversationId,
    checkpointId: selectedNodeId.value,
    requestId,
  });

  // Timeout: reset rollingBack + snackbar
  if (rollbackTimeout) clearTimeout(rollbackTimeout);
  rollbackTimeout = setTimeout(() => {
    if (pendingRollbackRequestId.value === requestId) {
      rollingBack.value = false;
      pendingRollbackRequestId.value = null;
      snackbar.text = 'Rollback request timed out';
      snackbar.color = 'warning';
      snackbar.show = true;
    }
  }, 15_000);
}

// --------------------------------------------------------------------------
// Timeline
// --------------------------------------------------------------------------

const timelineEvents = ref<CheckpointTimelineEvent[]>([]);
const timelineLoading = ref(false);
const timelineError = ref<string | null>(null);
const pendingTimelineRequestId = ref<string | null>(null);
const timelinePendingReload = ref(false);
let timelineTimeout: ReturnType<typeof setTimeout> | null = null;

function loadTimeline() {
  if (!wsService.value) return;
  if (timelineLoading.value) {
    timelinePendingReload.value = true;
    return;
  }

  timelineLoading.value = true;
  timelinePendingReload.value = false;
  const requestId = generateRequestId();
  pendingTimelineRequestId.value = requestId;

  wsService.value.sendMessage({
    type: 'checkpoint_timeline',
    conversationId: props.conversationId,
    requestId,
  });

  // Timeout: reset loading + drain queued reload + snackbar
  if (timelineTimeout) clearTimeout(timelineTimeout);
  timelineTimeout = setTimeout(() => {
    if (pendingTimelineRequestId.value === requestId) {
      timelineLoading.value = false;
      pendingTimelineRequestId.value = null;

      const shouldRetry = timelinePendingReload.value;
      timelinePendingReload.value = false;

      snackbar.text = 'Timeline request timed out';
      snackbar.color = 'warning';
      snackbar.show = true;

      if (shouldRetry) loadTimeline();
    }
  }, 15_000);
}

// --------------------------------------------------------------------------
// Timeline helpers
// --------------------------------------------------------------------------

function getActionIcon(action: string): string {
  const icons: Record<string, string> = {
    checkpoint: 'mdi-flag-checkered',
    rollback: 'mdi-undo-variant',
    remove_node: 'mdi-close-circle-outline',
    mode_upgrade: 'mdi-arrow-up-bold-circle-outline',
  };
  return icons[action] ?? 'mdi-circle-small';
}

function getActionColor(action: string): string {
  const colors: Record<string, string> = {
    checkpoint: 'success',
    rollback: 'warning',
    remove_node: 'error',
    mode_upgrade: 'info',
  };
  return colors[action] ?? 'grey';
}

function getActionDescription(evt: CheckpointTimelineEvent): string {
  switch (evt.action) {
    case 'checkpoint':
      return evt.label ? `Checkpoint: ${evt.label}` : 'Checkpoint created';
    case 'rollback':
      return `Rolled back to ${evt.checkpointId ?? 'checkpoint'}`;
    case 'remove_node':
      return `Removed node ${evt.nodeId ?? ''}`;
    case 'mode_upgrade':
      return `Upgraded to ${evt.mode ?? 'tree'} mode`;
    default:
      return evt.action;
  }
}

// --------------------------------------------------------------------------
// WS Response Handlers (named references for proper off() cleanup)
// --------------------------------------------------------------------------

const onListResponse = (data: any) => {
  // Stale guard
  if (data.requestId !== pendingListRequestId.value) return;
  if (data.conversationId !== props.conversationId) return;

  if (listTimeout) { clearTimeout(listTimeout); listTimeout = null; }

  // Access denied — set loadedOnce, show error, don't get stuck in loading
  if (data.error === 'conversation_access_denied') {
    loading.value = false;
    loadedOnce.value = true;
    pendingListRequestId.value = null;
    errorMessage.value = 'Access denied';
    checkpoints.value = [];
    return;
  }

  // Update state
  checkpoints.value = data.checkpoints || [];
  currentCheckpointId.value = data.current || '';
  errorMessage.value = null;

  // Stale selectedNodeId guard: if selected id no longer exists, reset
  if (selectedNodeId.value) {
    const exists = checkpoints.value.some(c => c.id === selectedNodeId.value);
    if (!exists) {
      selectedNodeId.value = null;
    }
  }

  loading.value = false;
  loadedOnce.value = true;
  pendingListRequestId.value = null;

  // Render tree
  nextTick(() => renderTree());

  // Drain queued reload (from broadcast/epoch that arrived during loading)
  if (pendingReload.value) {
    pendingReload.value = false;
    loadCheckpoints();
  }
};

const onRollbackResponse = (data: any) => {
  // Stale guard
  if (data.requestId !== pendingRollbackRequestId.value) return;
  if (data.conversationId !== props.conversationId) return;

  if (rollbackTimeout) { clearTimeout(rollbackTimeout); rollbackTimeout = null; }
  rollingBack.value = false;
  pendingRollbackRequestId.value = null;

  if (data.success) {
    snackbar.text = 'Rollback successful';
    snackbar.color = 'success';
    snackbar.show = true;
    emit('rollback-complete');
    loadCheckpoints();
  } else {
    const errorMessages: Record<string, string> = {
      'conversation_access_denied': 'Access denied',
      'checkpoint_expired': 'Checkpoint expired',
      'checkpoint_unknown': 'Checkpoint not found',
      'no_checkpoints': 'No checkpoints available',
      'rollback_failed': 'Rollback failed',
    };
    snackbar.text = errorMessages[data.error] ?? 'Rollback failed';
    snackbar.color = data.error === 'checkpoint_expired' ? 'warning' : 'error';
    snackbar.show = true;
  }
};

const onTimelineResponse = (data: any) => {
  if (data.requestId !== pendingTimelineRequestId.value) return;
  if (data.conversationId !== props.conversationId) return;

  if (timelineTimeout) { clearTimeout(timelineTimeout); timelineTimeout = null; }
  timelineLoading.value = false;
  pendingTimelineRequestId.value = null;

  if (data.error) {
    timelineError.value = data.error === 'conversation_access_denied'
      ? 'Access denied' : String(data.error);
    timelineEvents.value = [];
    return;
  }

  timelineError.value = null;
  // Server returns oldest→newest; reverse for newest-first UX (non-mutating copy)
  timelineEvents.value = [...(data.events || [])].reverse();

  // Drain queued reload (from broadcast/epoch that arrived during loading)
  if (timelinePendingReload.value) {
    timelinePendingReload.value = false;
    loadTimeline();
  }
};

// --------------------------------------------------------------------------
// D3 Tree Builder — eviction-safe + cycle-safe
// --------------------------------------------------------------------------

interface TreeNode extends CheckpointNodeInfo {
  d3children: TreeNode[];
}

function buildD3Tree(nodes: CheckpointNodeInfo[]): d3.HierarchyNode<TreeNode> | null {
  if (nodes.length === 0) return null;

  const nodeMap = new Map<string, TreeNode>(
    nodes.map(c => [c.id, { ...c, d3children: [] }]),
  );

  const attached = new Set<string>();
  const roots: TreeNode[] = [];

  for (const node of nodeMap.values()) {
    if (node.parent && nodeMap.has(node.parent) && !attached.has(node.id)) {
      // Defensive: should never happen with well-formed checkpoint data.
      // mcplStateManager structurally can't produce cycles (each node has exactly one
      // parent, set at creation). This guards against direct file corruption only.
      let ancestor = nodeMap.get(node.parent);
      let cycleDetected = false;
      const visited = new Set<string>([node.id]);
      while (ancestor) {
        if (visited.has(ancestor.id)) { cycleDetected = true; break; }
        visited.add(ancestor.id);
        ancestor = ancestor.parent ? nodeMap.get(ancestor.parent) : undefined;
      }
      if (!cycleDetected) {
        nodeMap.get(node.parent)!.d3children.push(node);
        attached.add(node.id);
      } else {
        roots.push(node); // break cycle by treating as root
      }
    } else if (!attached.has(node.id)) {
      roots.push(node); // orphan (parent evicted) or true root
    }
  }

  if (roots.length === 0) return null;
  if (roots.length === 1) return d3.hierarchy(roots[0], d => d.d3children);

  // Multiple roots (eviction orphaned subtrees) → synthetic __root__
  const synthetic: TreeNode = {
    id: '__root__',
    parent: null,
    children: [],
    label: '',
    isCurrent: false,
    createdAt: 0,
    mutationCount: 0,
    d3children: roots,
  };
  return d3.hierarchy(synthetic, d => d.d3children);
}

// --------------------------------------------------------------------------
// D3 Render
// --------------------------------------------------------------------------

function renderTree() {
  if (!svgRef.value || checkpoints.value.length === 0) return;

  const svg = d3.select(svgRef.value);

  // SVG cleanup: remove all children to prevent ghost elements
  svg.selectAll('*').remove();

  const root = buildD3Tree(checkpoints.value);
  if (!root) return;

  const treeLayout = d3.tree<TreeNode>().nodeSize([40, 60]);
  treeLayout(root);

  const g = svg.append('g').attr('class', 'tree-content');

  // Links
  g.selectAll('.link')
    .data(root.links())
    .enter()
    .append('path')
    .attr('class', 'link')
    .attr('fill', 'none')
    .attr('stroke', '#555')
    .attr('stroke-width', 1.5)
    .attr('d', d3.linkVertical<any, any>()
      .x((d: any) => d.x)
      .y((d: any) => d.y) as any,
    );

  // Nodes
  const nodeGroups = g.selectAll('.node')
    .data(root.descendants())
    .enter()
    .append('g')
    .attr('class', 'node')
    .attr('transform', (d: any) => `translate(${d.x},${d.y})`)
    .style('cursor', (d: any) => d.data.id === '__root__' ? 'default' : 'pointer')
    .on('click', (_event: any, d: any) => {
      if (d.data.id === '__root__') return;
      selectedNodeId.value = d.data.id;
    });

  // Circles
  nodeGroups.append('circle')
    .attr('r', 8)
    .attr('fill', (d: any) => {
      if (d.data.id === '__root__') return 'transparent';
      if (d.data.isCurrent) return '#4caf50';
      return '#1e1e1e';
    })
    .attr('stroke', (d: any) => {
      if (d.data.id === '__root__') return 'transparent';
      if (d.data.id === selectedNodeId.value) return '#ff9800';
      return '#bb86fc';
    })
    .attr('stroke-width', (d: any) => {
      if (d.data.id === '__root__') return 0;
      if (d.data.id === selectedNodeId.value) return 3;
      return 2;
    })
    .attr('opacity', (d: any) => d.data.id === '__root__' ? 0 : 1);

  // Labels (skip __root__)
  nodeGroups
    .filter((d: any) => d.data.id !== '__root__')
    .append('text')
    .attr('dy', 22)
    .attr('text-anchor', 'middle')
    .attr('fill', 'rgba(255, 255, 255, 0.7)')
    .attr('font-size', '10px')
    .text((d: any) => {
      const label = d.data.label || d.data.id.slice(0, 8);
      return label.length > 15 ? label.slice(0, 12) + '...' : label;
    });

  // Auto-fit with getBBox guard
  const gNode = g.node() as SVGGElement | null;
  if (gNode && typeof gNode.getBBox === 'function') {
    try {
      const box = gNode.getBBox();
      svg.attr('viewBox', `${box.x - 20} ${box.y - 20} ${box.width + 40} ${box.height + 40}`);
    } catch {
      // getBBox() can throw if element is not in DOM yet — safe to ignore
    }
  }
}

// --------------------------------------------------------------------------
// WS Listener Registration (watch-based — survives reconnect)
// --------------------------------------------------------------------------

let registeredWs: typeof wsService.value = null;

// Reload active view after reconnect — stale data from old connection
function onConnectionState(data: { state: string }) {
  if (data.state !== 'connected') return;
  // Cancel any inflight requests (they went to the old socket)
  pendingListRequestId.value = null;
  pendingRollbackRequestId.value = null;
  pendingTimelineRequestId.value = null;
  loading.value = false;
  rollingBack.value = false;
  timelineLoading.value = false;
  timelinePendingReload.value = false;
  if (listTimeout) { clearTimeout(listTimeout); listTimeout = null; }
  if (rollbackTimeout) { clearTimeout(rollbackTimeout); rollbackTimeout = null; }
  if (timelineTimeout) { clearTimeout(timelineTimeout); timelineTimeout = null; }
  // Reload active view with fresh data
  if (activeView.value === 'timeline') loadTimeline();
  else loadCheckpoints();
}

function registerAllListeners(ws: typeof wsService.value) {
  if (registeredWs) {
    registeredWs.off('checkpoint_list_response', onListResponse);
    registeredWs.off('checkpoint_rollback_response', onRollbackResponse);
    registeredWs.off('checkpoint_timeline_response', onTimelineResponse);
    registeredWs.off('connection_state', onConnectionState);
  }
  registeredWs = ws;
  if (ws) {
    ws.on('checkpoint_list_response', onListResponse);
    ws.on('checkpoint_rollback_response', onRollbackResponse);
    ws.on('checkpoint_timeline_response', onTimelineResponse);
    ws.on('connection_state', onConnectionState);
  }
}

watch(wsService, (ws) => registerAllListeners(ws), { immediate: true });

// Initial load
loadCheckpoints();

onUnmounted(() => {
  if (registeredWs) {
    registeredWs.off('checkpoint_list_response', onListResponse);
    registeredWs.off('checkpoint_rollback_response', onRollbackResponse);
    registeredWs.off('checkpoint_timeline_response', onTimelineResponse);
    registeredWs.off('connection_state', onConnectionState);
    registeredWs = null;
  }
  if (listTimeout) clearTimeout(listTimeout);
  if (rollbackTimeout) clearTimeout(rollbackTimeout);
  if (timelineTimeout) clearTimeout(timelineTimeout);
});

// Watch conversationId: reset ALL state, then reload
watch(() => props.conversationId, () => {
  pendingListRequestId.value = null;
  pendingRollbackRequestId.value = null;
  pendingTimelineRequestId.value = null;
  selectedNodeId.value = null;
  checkpoints.value = [];
  currentCheckpointId.value = '';
  loading.value = false;
  loadedOnce.value = false;
  rollingBack.value = false;
  showRollbackConfirm.value = false;
  errorMessage.value = null;
  pendingReload.value = false;
  timelineEvents.value = [];
  timelineError.value = null;
  timelineLoading.value = false;
  timelinePendingReload.value = false;
  if (listTimeout) { clearTimeout(listTimeout); listTimeout = null; }
  if (rollbackTimeout) { clearTimeout(rollbackTimeout); rollbackTimeout = null; }
  if (timelineTimeout) { clearTimeout(timelineTimeout); timelineTimeout = null; }
  snackbar.show = false;
  if (activeView.value === 'timeline') loadTimeline();
  else loadCheckpoints();
});

// Watch checkpointEpoch: parent increments on broadcast → reload active view
watch(() => props.checkpointEpoch, () => {
  if (activeView.value === 'timeline') loadTimeline();
  else loadCheckpoints();
});

// Watch activeView: load timeline on first switch
watch(activeView, (v) => {
  if (v === 'timeline' && timelineEvents.value.length === 0) loadTimeline();
});

// Re-render tree when selected node changes (to update stroke highlights)
watch(selectedNodeId, () => {
  if (loadedOnce.value && checkpoints.value.length > 0) {
    nextTick(() => renderTree());
  }
});
</script>

<style scoped lang="scss">
.checkpoint-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: rgb(var(--v-theme-surface));
  border-left: 1px solid rgba(255, 255, 255, 0.1);
  width: 320px;

  &.mobile-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    width: 100%;
    z-index: 1000;
    border-left: none;
  }
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);

  h3 {
    font-size: 14px;
    font-weight: 500;
    margin: 0;
    color: rgba(255, 255, 255, 0.9);
  }
}

.panel-actions {
  display: flex;
  gap: 2px;
}

.panel-content {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.loading-state,
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 200px;
  color: rgba(255, 255, 255, 0.5);

  p {
    margin-top: 12px;
    font-size: 13px;
  }
}

.refresh-indicator {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
}

.tree-container {
  width: 100%;
  max-height: 400px;
  overflow-y: auto;
  margin-bottom: 8px;
}

.checkpoint-tree {
  width: 100%;
  min-height: 100px;
}

.detail-card {
  margin: 8px 0;
  border-color: rgba(255, 255, 255, 0.15) !important;
}

.detail-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}

.detail-id {
  font-family: monospace;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.6);
}

.detail-label {
  font-size: 13px;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.85);
  margin-bottom: 8px;
}

.detail-meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);

  div {
    display: flex;
    align-items: center;
  }
}

// Timeline view
.timeline-list {
  padding: 8px 4px;
}

.timeline-item {
  display: flex;
  gap: 10px;
  padding: 6px 8px;
  border-left: 2px solid rgba(255, 255, 255, 0.1);
  margin-left: 8px;

  &:first-child { padding-top: 2px; }
  &:last-child { border-left-color: transparent; }
}

.timeline-content { flex: 1; min-width: 0; }

.timeline-desc {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.85);
}

.timeline-meta {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.45);
  margin-top: 2px;
}
</style>
