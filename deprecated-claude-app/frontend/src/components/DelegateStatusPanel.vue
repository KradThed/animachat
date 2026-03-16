<template>
  <v-card variant="outlined" class="delegate-status-panel">
    <v-card-title class="text-subtitle-1 d-flex align-center">
      <v-icon size="small" class="mr-2">mdi-connection</v-icon>
      Connected Delegates
      <v-chip
        v-if="delegates.length > 0"
        size="x-small"
        color="success"
        class="ml-2"
      >
        {{ delegates.length }}
      </v-chip>
    </v-card-title>

    <v-card-text class="py-2">
      <div v-if="loading && delegates.length === 0" class="text-center py-4">
        <v-progress-circular indeterminate size="24" />
      </div>

      <div v-else-if="delegates.length === 0" class="text-body-2 text-medium-emphasis">
        No delegates connected. Delegates provide remote tool execution capabilities.
      </div>

      <v-list v-else density="compact" class="pa-0">
        <template v-for="delegate in delegates" :key="delegate.delegateId">
          <v-list-item class="px-0">
            <template v-slot:prepend>
              <v-icon
                :color="isOnline(delegate) ? 'success' : 'grey'"
                size="small"
              >
                {{ isOnline(delegate) ? 'mdi-circle' : 'mdi-circle-outline' }}
              </v-icon>
            </template>

            <v-list-item-title class="text-body-2">
              {{ delegate.delegateId }}
            </v-list-item-title>

            <v-list-item-subtitle class="text-caption">
              {{ delegate.tools.length }} tool{{ delegate.tools.length === 1 ? '' : 's' }}
              <span v-if="delegate.capabilities.canShellAccess" class="ml-1">
                <v-chip size="x-small" color="warning" variant="text">shell</v-chip>
              </span>
              <span v-if="delegate.capabilities.canFileAccess" class="ml-1">
                <v-chip size="x-small" color="info" variant="text">files</v-chip>
              </span>
            </v-list-item-subtitle>

            <template v-slot:append>
              <v-tooltip location="top">
                <template v-slot:activator="{ props: tooltipProps }">
                  <span v-bind="tooltipProps" class="text-caption text-medium-emphasis">
                    {{ formatConnectedTime(delegate.connectedAt) }}
                  </span>
                </template>
                Connected at {{ new Date(delegate.connectedAt).toLocaleString() }}
              </v-tooltip>
            </template>
          </v-list-item>

          <!-- Feature sets for this delegate (conversation mode only) -->
          <template v-if="mode === 'conversation' && featureSetsForDelegate(delegate.delegateId).length > 0">
            <v-list-item
              v-for="fs in featureSetsForDelegate(delegate.delegateId)"
              :key="`${delegate.delegateId}:${fs.name}`"
              class="px-0 ml-6"
              density="compact"
            >
              <v-list-item-title class="text-caption">
                {{ fs.name }}
                <v-chip
                  v-if="fs.quarantined"
                  size="x-small"
                  color="error"
                  variant="text"
                >quarantined</v-chip>
                <v-chip
                  v-else-if="fs.visible === false"
                  size="x-small"
                  color="grey"
                  variant="text"
                >disabled</v-chip>
              </v-list-item-title>

              <v-list-item-subtitle class="text-caption text-medium-emphasis">
                {{ fs.visibleToolCount ?? fs.totalToolCount }} tool{{ (fs.visibleToolCount ?? fs.totalToolCount) === 1 ? '' : 's' }}
              </v-list-item-subtitle>

              <template v-slot:append>
                <v-switch
                  v-if="onToggleFeatureSet"
                  :model-value="fs.visible !== false"
                  :disabled="fs.quarantined"
                  density="compact"
                  hide-details
                  class="mt-0"
                  @update:model-value="(val: boolean) => onToggleFeatureSet!(delegate.delegateId, fs.name, val)"
                />
              </template>
            </v-list-item>
          </template>
        </template>
      </v-list>
    </v-card-text>

    <v-card-actions v-if="!loading || delegates.length > 0">
      <v-btn
        size="small"
        variant="text"
        @click="handleRefresh"
        :loading="manualRefreshing"
      >
        <v-icon size="small" class="mr-1">mdi-refresh</v-icon>
        Refresh
      </v-btn>
    </v-card-actions>
  </v-card>
</template>

<script setup lang="ts">
import { ref, type PropType } from 'vue';
import type { DelegateInfo } from '@/services/api';
import type { DelegateFeatureSets, FeatureSetSummary } from '@/services/api';

const props = defineProps({
  delegates: {
    type: Array as PropType<DelegateInfo[]>,
    required: true,
  },
  featureSets: {
    type: Array as PropType<DelegateFeatureSets[]>,
    default: undefined,
  },
  loading: {
    type: Boolean,
    default: false,
  },
  mode: {
    type: String as PropType<'global' | 'conversation'>,
    default: 'global',
  },
  onRefresh: {
    type: Function as PropType<(() => void) | undefined>,
    default: undefined,
  },
  onToggleFeatureSet: {
    type: Function as PropType<((delegateId: string, featureSet: string, enabled: boolean) => void) | undefined>,
    default: undefined,
  },
});

const manualRefreshing = ref(false);

function featureSetsForDelegate(delegateId: string): FeatureSetSummary[] {
  if (!props.featureSets) return [];
  const entry = props.featureSets.find(d => d.delegateId === delegateId);
  return entry?.featureSets ?? [];
}

function isOnline(delegate: DelegateInfo): boolean {
  const connectedAt = new Date(delegate.connectedAt).getTime();
  const now = Date.now();
  return now - connectedAt < 60 * 60 * 1000;
}

function formatConnectedTime(connectedAt: string): string {
  const now = Date.now();
  const connected = new Date(connectedAt).getTime();
  const diffMs = now - connected;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return new Date(connectedAt).toLocaleDateString();
}

const handleRefresh = async () => {
  if (props.onRefresh) {
    manualRefreshing.value = true;
    await props.onRefresh();
    manualRefreshing.value = false;
  }
};
</script>

<style scoped>
.delegate-status-panel {
  max-width: 400px;
}
</style>
