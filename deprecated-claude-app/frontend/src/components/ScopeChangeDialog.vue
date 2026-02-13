<template>
  <v-card
    variant="outlined"
    color="warning"
    density="compact"
    class="scope-change-dialog"
  >
    <v-card-title class="text-subtitle-2 d-flex align-center py-2">
      <v-icon size="small" color="warning" class="mr-2">mdi-shield-alert</v-icon>
      Delegate &laquo;{{ request.delegateName }}&raquo; wants to connect:
    </v-card-title>

    <v-card-text class="py-1">
      <v-list density="compact" class="pa-0 bg-transparent">
        <v-list-item
          v-for="(server, i) in request.servers"
          :key="i"
          class="px-0"
        >
          <template v-slot:prepend>
            <v-icon size="small" color="primary" class="mr-2">mdi-server-network</v-icon>
          </template>
          <v-list-item-title class="text-body-2">{{ server.name }}</v-list-item-title>
          <v-list-item-subtitle class="text-caption">{{ server.url }}</v-list-item-subtitle>
          <template v-slot:append>
            <span class="text-caption text-medium-emphasis">{{ server.reason }}</span>
          </template>
        </v-list-item>
      </v-list>

      <div class="text-caption mt-1" :class="remaining < 60000 ? 'text-error' : 'text-medium-emphasis'">
        Auto-deny in {{ countdownText }}
      </div>
    </v-card-text>

    <v-card-actions class="py-1">
      <v-spacer />
      <v-btn variant="text" size="small" @click="emit('deny', request.requestId)">
        Deny
      </v-btn>
      <v-btn variant="flat" color="primary" size="small" @click="emit('approve', request.requestId)">
        Approve
      </v-btn>
    </v-card-actions>
  </v-card>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';

interface ScopeChangeServer {
  url: string;
  name: string;
  reason: string;
}

interface PendingScopeChange {
  requestId: string;
  conversationId: string;
  delegateId: string;
  delegateName: string;
  servers: ScopeChangeServer[];
  timeout: number;
  receivedAt: number;
}

const props = defineProps<{ request: PendingScopeChange }>();
const emit = defineEmits<{
  approve: [requestId: string];
  deny: [requestId: string];
}>();

const TIMEOUT_MS = computed(() => props.request.timeout * 1000);
const remaining = ref(TIMEOUT_MS.value);
let timer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  remaining.value = Math.max(0, TIMEOUT_MS.value - (Date.now() - props.request.receivedAt));
  timer = setInterval(() => {
    remaining.value = Math.max(0, TIMEOUT_MS.value - (Date.now() - props.request.receivedAt));
    if (remaining.value <= 0) {
      clearInterval(timer!);
      timer = null;
      emit('deny', props.request.requestId);
    }
  }, 1000);
});

onUnmounted(() => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
});

const countdownText = computed(() => {
  const secs = Math.ceil(remaining.value / 1000);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
});
</script>

<style scoped>
.scope-change-dialog {
  border-width: 2px;
}
</style>
