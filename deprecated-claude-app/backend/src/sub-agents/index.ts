/**
 * Sub-Agent System — Barrel Exports
 */

export type {
  SubAgentState,
  SubAgentTask,
  TaskGroup,
  TaskGroupConfig,
  TaskMetrics,
  SubAgentResult,
  FinalizeResult,
  SpawnSubtaskParams,
  SpawnSubtasksParams,
  SubAgentEventType,
  SubAgentLifecycleEvent,
  QueuedUserMessage,
} from './types.js';

export {
  CHECKPOINT_INTERVAL,
  LEASE_MS,
  FINALIZE_GRACE_MS,
  MAX_ITERATIONS,
  TERMINAL_STATUSES,
} from './types.js';

export { BranchEventStore } from '../database/branch-event-store.js';
export { LLMClientAdapter } from './llm-client-adapter.js';
export { SubAgentContextBuilder } from './context-builder.js';
export { InferenceRunner } from './inference-runner.js';
export { SubAgentManager } from './sub-agent-manager.js';
export { NotificationBus } from './notification-bus.js';
export { SystemTurnTrigger } from './system-turn-trigger.js';
export { registerSubAgentTools } from './sub-agent-tools.js';
