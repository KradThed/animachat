<template>
  <div class="sub-agent-panel">
    <!-- Progress banner: active sub-agents running -->
    <v-alert
      v-if="active && !finalized"
      type="info"
      variant="tonal"
      density="compact"
      class="mb-2"
    >
      <template #prepend>
        <v-progress-circular
          indeterminate
          size="18"
          width="2"
          class="mr-2"
        />
      </template>
      <div class="sub-agent-title">
        Sub-agents working ({{ tasks.length }} {{ tasks.length === 1 ? 'task' : 'tasks' }})
      </div>
      <div class="sub-agent-task-list">
        <div
          v-for="task in tasks"
          :key="task.taskId"
          class="sub-agent-task-item"
        >
          <span class="task-icon">{{ statusIcon(task.status) }}</span>
          <span class="task-instruction">{{ task.instructionPreview }}</span>
        </div>
      </div>
    </v-alert>

    <!-- Queue indicator: user message queued while sub-agents active -->
    <v-alert
      v-if="queuedText && !finalized"
      type="warning"
      variant="tonal"
      density="compact"
      class="mb-2"
    >
      <v-icon size="16" class="mr-1">mdi-clock-outline</v-icon>
      Message queued — will be sent after sub-agents finish
    </v-alert>

    <!-- Post-finalize: show task results -->
    <v-alert
      v-if="finalized"
      type="success"
      variant="tonal"
      density="compact"
      class="mb-2"
    >
      <div class="sub-agent-title">
        Subtasks completed ({{ tasks.length }} {{ tasks.length === 1 ? 'task' : 'tasks' }})
      </div>
      <div class="sub-agent-task-list">
        <div
          v-for="task in tasks"
          :key="task.taskId"
          class="sub-agent-task-item"
        >
          <span class="task-icon">{{ statusIcon(task.status) }}</span>
          <span class="task-instruction">{{ task.instructionPreview }}</span>
          <span class="task-status-label">{{ statusLabel(task.status) }}</span>
          <div v-if="task.result" class="task-result">
            {{ truncateResult(task.result) }}
            <span v-if="task.resultTruncated" class="task-result-truncated">(truncated)</span>
          </div>
        </div>
      </div>

      <!-- Auto-finalize CTA: prompt user to summarize results -->
      <div v-if="autoFinalized && !queuedText" class="auto-finalize-actions mt-2">
        <v-btn
          color="primary"
          variant="tonal"
          size="small"
          @click="$emit('summarize-results')"
        >
          Summarize results
        </v-btn>
        <v-btn
          size="x-small"
          variant="text"
          density="compact"
          class="ml-2"
          @click="$emit('dismiss')"
        >
          Dismiss
        </v-btn>
      </div>

      <!-- Dismiss button when no queued text (non-auto-finalize) -->
      <div v-if="!autoFinalized && !queuedText" class="dismiss-action mt-1">
        <v-btn
          size="x-small"
          variant="text"
          density="compact"
          @click="$emit('dismiss')"
        >
          Dismiss
        </v-btn>
      </div>

      <!-- Queued message actions (post-finalize) -->
      <div v-if="queuedText" class="queued-actions mt-2">
        <div class="queued-text-preview">
          <v-icon size="14" class="mr-1">mdi-message-text-outline</v-icon>
          Queued: "{{ truncateQueued(queuedText) }}"
        </div>
        <div class="queued-buttons mt-1">
          <v-btn
            size="x-small"
            variant="tonal"
            color="primary"
            @click="$emit('send-queued')"
          >
            Send
          </v-btn>
          <v-btn
            size="x-small"
            variant="tonal"
            @click="$emit('edit-queued')"
          >
            Edit
          </v-btn>
          <v-btn
            size="x-small"
            variant="tonal"
            color="error"
            @click="$emit('discard-queued')"
          >
            Discard
          </v-btn>
        </div>
      </div>
    </v-alert>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  active: boolean;
  groupId: string | null;
  tasks: Array<{
    taskId: string;
    instructionPreview: string;
    status: string;
    result?: string | null;
    resultTruncated?: boolean;
  }>;
  finalized: boolean;
  autoFinalized: boolean;
  queuedText: string | null;
}>();

defineEmits<{
  'send-queued': [];
  'edit-queued': [];
  'discard-queued': [];
  'dismiss': [];
  'summarize-results': [];
}>();

function statusIcon(status: string): string {
  switch (status) {
    case 'FINALIZED': return '\u2705';
    case 'ERROR': return '\u274C';
    case 'CANCELLED': return '\u2B1C';
    case 'RUNNING': return '\u23F3';
    case 'QUEUED': return '\u23F8\uFE0F';
    case 'FINALIZING': return '\u23F3';
    default: return '\u2B1C';
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case 'FINALIZED': return 'done';
    case 'ERROR': return 'error';
    case 'CANCELLED': return 'cancelled';
    default: return status.toLowerCase();
  }
}

function truncateQueued(text: string): string {
  if (text.length <= 60) return text;
  return text.slice(0, 60) + '...';
}

function truncateResult(text: string): string {
  if (text.length <= 200) return text;
  return text.slice(0, 200) + '\u2026';
}
</script>

<style scoped>
.sub-agent-panel {
  padding: 0 8px;
}

.sub-agent-title {
  font-weight: 500;
  font-size: 0.85rem;
  margin-bottom: 4px;
}

.sub-agent-task-list {
  margin-left: 4px;
}

.sub-agent-task-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.8rem;
  line-height: 1.6;
  opacity: 0.9;
}

.task-icon {
  flex-shrink: 0;
  font-size: 0.75rem;
}

.task-instruction {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-status-label {
  flex-shrink: 0;
  font-size: 0.7rem;
  opacity: 0.7;
  font-style: italic;
}

.auto-finalize-actions {
  display: flex;
  align-items: center;
  border-top: 1px solid rgba(128, 128, 128, 0.2);
  padding-top: 8px;
}

.queued-actions {
  border-top: 1px solid rgba(128, 128, 128, 0.2);
  padding-top: 8px;
}

.queued-text-preview {
  font-size: 0.8rem;
  opacity: 0.8;
  display: flex;
  align-items: center;
}

.queued-buttons {
  display: flex;
  gap: 6px;
}

.task-result {
  font-size: 0.75rem;
  opacity: 0.8;
  margin-left: 20px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 80px;
  overflow: hidden;
  margin-top: 2px;
  width: 100%;
}

.task-result-truncated {
  font-style: italic;
  opacity: 0.6;
}
</style>
