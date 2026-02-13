<template>
  <div class="mcpl-queue-widget px-2 py-1">
    <div
      class="d-flex align-center cursor-pointer"
      @click="expanded = !expanded"
    >
      <v-icon size="small" class="mr-1">mdi-tray-full</v-icon>
      <span class="text-caption flex-grow-1">Queue</span>
      <v-badge
        :content="queue.totalCount"
        color="primary"
        inline
        class="mr-1"
      />
      <v-icon v-if="queue.isPaused" size="small" color="warning">mdi-pause-circle</v-icon>
      <v-icon size="x-small">{{ expanded ? 'mdi-chevron-down' : 'mdi-chevron-up' }}</v-icon>
    </div>

    <v-expand-transition>
      <div v-if="expanded" class="mt-1">
        <v-list density="compact" class="pa-0 bg-transparent" style="max-height: 200px; overflow-y: auto;">
          <v-list-item
            v-for="item in displayItems"
            :key="item.id"
            class="px-0"
            style="min-height: 28px;"
          >
            <v-list-item-title class="text-caption">
              {{ item.source }}/{{ item.eventType }}
            </v-list-item-title>
            <template v-slot:append>
              <v-chip
                :color="statusColor(item.status)"
                size="x-small"
                variant="tonal"
                label
              >
                {{ item.status }}
              </v-chip>
            </template>
          </v-list-item>
        </v-list>

        <v-btn
          variant="text"
          size="x-small"
          class="mt-1"
          :prepend-icon="queue.isPaused ? 'mdi-play' : 'mdi-pause'"
          @click.stop="emit('toggle-pause')"
        >
          {{ queue.isPaused ? 'Resume' : 'Pause' }}
        </v-btn>
      </div>
    </v-expand-transition>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';

interface QueueItem {
  id: string;
  source: string;
  eventType: string;
  status: string;
  timestamp: string;
}

interface QueueState {
  items: QueueItem[];
  totalCount: number;
  isPaused: boolean;
}

const props = defineProps<{ queue: QueueState }>();
const emit = defineEmits<{ 'toggle-pause': [] }>();

const expanded = ref(false);

const displayItems = computed(() => props.queue.items.slice(0, 5));

function statusColor(status: string): string {
  switch (status) {
    case 'queued': return 'blue';
    case 'processing': return 'orange';
    case 'completed': return 'green';
    case 'failed': return 'red';
    case 'rate_limited': return 'warning';
    case 'duplicate_ignored': return 'grey';
    default: return 'grey';
  }
}
</script>

<style scoped>
.mcpl-queue-widget {
  border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}
.cursor-pointer {
  cursor: pointer;
}
</style>
