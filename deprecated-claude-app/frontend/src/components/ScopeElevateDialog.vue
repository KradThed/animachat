<template>
  <v-card
    variant="outlined"
    color="warning"
    density="compact"
    class="scope-elevate-dialog"
  >
    <v-card-title class="text-subtitle-2 d-flex align-center py-2">
      <v-icon size="small" color="warning" class="mr-2">mdi-shield-key</v-icon>
      Delegate &laquo;{{ request.delegateName }}&raquo; requests elevated access:
    </v-card-title>

    <v-card-text class="py-1">
      <div class="text-body-2 mb-1">
        <strong>{{ request.label }}</strong> ({{ request.featureSet }})
      </div>
      <div class="text-caption text-medium-emphasis mb-1">{{ request.reason }}</div>
      <div class="text-caption mb-1">
        Capabilities: {{ request.requestedCapabilities.join(', ') }}
      </div>
      <v-checkbox
        v-model="remember"
        label="Remember this choice"
        density="compact"
        hide-details
        class="mt-1"
      />
      <div class="text-caption mt-1" :class="remaining < 60000 ? 'text-error' : 'text-medium-emphasis'">
        Auto-deny in {{ countdownText }}
      </div>
    </v-card-text>

    <v-card-actions class="py-1">
      <v-spacer />
      <v-btn variant="text" size="small" @click="emit('deny', request.requestId, remember)">
        Deny
      </v-btn>
      <v-btn variant="flat" color="primary" size="small" @click="emit('approve', request.requestId, remember)">
        Approve
      </v-btn>
    </v-card-actions>
  </v-card>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';

interface PendingScopeElevate {
  requestId: string;
  conversationId: string;
  delegateId: string;
  delegateName: string;
  featureSet: string;
  label: string;
  requestedCapabilities: string[];
  reason: string;
  timeout: number;
  receivedAt: number;
}

const props = defineProps<{ request: PendingScopeElevate }>();
const emit = defineEmits<{
  approve: [requestId: string, remember: boolean];
  deny: [requestId: string, remember: boolean];
}>();

const remember = ref(false);
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
      emit('deny', props.request.requestId, false);
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
.scope-elevate-dialog {
  border-width: 2px;
}
</style>
