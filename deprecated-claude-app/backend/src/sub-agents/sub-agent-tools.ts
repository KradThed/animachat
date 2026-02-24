/**
 * Sub-Agent Tools
 *
 * Registers 6 tools with the tool registry for LLM-driven sub-agent orchestration:
 *   1. spawn_subtask    — spawn a single sub-agent
 *   2. spawn_subtasks   — batch spawn multiple sub-agents
 *   3. poll_subtasks    — check status of a task group
 *   4. get_subtask_results — get results of completed tasks
 *   5. cancel_subtasks  — cancel running tasks in a group
 *   6. finalize_task_group — finalize + unfreeze parent conversation
 */

import { toolRegistry } from '../tools/tool-registry.js';
import type { SubAgentManager } from './sub-agent-manager.js';

// =============================================================================
// Constants
// =============================================================================

/** Max characters for result content in get_subtask_results + finalize_task_group. */
const MAX_RESULT_FULL = 4000;

// =============================================================================
// Registration
// =============================================================================

export function registerSubAgentTools(manager: SubAgentManager): void {
  // -------------------------------------------------------------------------
  // 1. spawn_subtask
  // -------------------------------------------------------------------------
  toolRegistry.registerMcplManagementTool(
    'spawn_subtask',
    {
      name: 'spawn_subtask',
      description:
        'Spawn a single sub-agent to work on a subtask in parallel. ' +
        'The sub-agent gets a snapshot of the current conversation context and works independently. ' +
        'Returns a taskId and groupId for tracking. ' +
        'Use poll_subtasks to check progress and get_subtask_results when done.',
      inputSchema: {
        type: 'object',
        properties: {
          instruction: {
            type: 'string',
            description: 'Clear, specific instruction for the sub-agent to execute',
          },
          groupId: {
            type: 'string',
            description: 'Optional group ID to add this task to an existing group',
          },
        },
        required: ['instruction'],
      },
    },
    async (input, context) => {
      try {
        // H6: Input validation
        const instruction = input.instruction;
        if (typeof instruction !== 'string' || !instruction.trim()) {
          return { toolUseId: '', content: 'Error: instruction must be a non-empty string', isError: true };
        }

        const task = await manager.spawnSubtask({
          conversationId: context.conversationId,
          userId: context.userId,
          instruction: instruction as string,
          groupId: input.groupId as string | undefined,
        });

        return {
          toolUseId: '',
          content: JSON.stringify({
            taskId: task.taskId,
            groupId: task.groupId,
            state: task.state,
            instruction: task.instruction,
          }),
        };
      } catch (error) {
        return {
          toolUseId: '',
          content: `Error spawning subtask: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // 2. spawn_subtasks
  // -------------------------------------------------------------------------
  toolRegistry.registerMcplManagementTool(
    'spawn_subtasks',
    {
      name: 'spawn_subtasks',
      description:
        'Spawn multiple sub-agents as a batch. All tasks share the same group. ' +
        'Each sub-agent works independently on its assigned instruction. ' +
        'Returns a groupId and list of taskIds.',
      inputSchema: {
        type: 'object',
        properties: {
          instructions: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of instructions, one per sub-agent',
          },
          maxConcurrent: {
            type: 'number',
            description: 'Maximum concurrent sub-agents (default: 3)',
          },
        },
        required: ['instructions'],
      },
    },
    async (input, context) => {
      try {
        // H6: Input validation
        const instructions = input.instructions;
        if (!Array.isArray(instructions) || instructions.length === 0) {
          return { toolUseId: '', content: 'Error: instructions must be a non-empty array', isError: true };
        }
        for (let i = 0; i < instructions.length; i++) {
          if (typeof instructions[i] !== 'string' || !(instructions[i] as string).trim()) {
            return { toolUseId: '', content: `Error: instructions[${i}] must be a non-empty string`, isError: true };
          }
        }

        const tasks = await manager.spawnSubtasks({
          conversationId: context.conversationId,
          userId: context.userId,
          instructions: instructions as string[],
          maxConcurrent: input.maxConcurrent as number | undefined,
        });

        return {
          toolUseId: '',
          content: JSON.stringify({
            groupId: tasks[0]?.groupId,
            tasks: tasks.map(t => ({
              taskId: t.taskId,
              instruction: t.instruction,
              state: t.state,
            })),
          }),
        };
      } catch (error) {
        return {
          toolUseId: '',
          content: `Error spawning subtasks: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // 3. poll_subtasks
  // -------------------------------------------------------------------------
  toolRegistry.registerMcplManagementTool(
    'poll_subtasks',
    {
      name: 'poll_subtasks',
      description:
        'Check the current status of all tasks in a group. ' +
        'Returns each task\'s state (QUEUED, RUNNING, FINALIZED, ERROR, CANCELLED) and whether all are complete.',
      inputSchema: {
        type: 'object',
        properties: {
          groupId: {
            type: 'string',
            description: 'The task group ID to poll',
          },
        },
        required: ['groupId'],
      },
    },
    async (input, context) => {
      try {
        // H6: Input validation
        const groupId = input.groupId;
        if (typeof groupId !== 'string' || !groupId.trim()) {
          return { toolUseId: '', content: 'Error: groupId must be a non-empty string', isError: true };
        }

        // BUG 11: Pass conversationId for ownership validation
        const result = manager.pollSubtasks(groupId as string, context.conversationId);

        // Poll returns status only — no results/metrics. Use get_subtask_results for content.
        return {
          toolUseId: '',
          content: JSON.stringify({
            tasks: result.tasks.map(t => ({ taskId: t.taskId, state: t.state })),
            allTerminal: result.allTerminal,
          }),
        };
      } catch (error) {
        // M9: Try-catch for poll
        return {
          toolUseId: '',
          content: `Error polling subtasks: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // 4. get_subtask_results
  // -------------------------------------------------------------------------
  toolRegistry.registerMcplManagementTool(
    'get_subtask_results',
    {
      name: 'get_subtask_results',
      description:
        'Get the results of completed tasks in a group. ' +
        'Only returns results for tasks in terminal states (FINALIZED, ERROR, CANCELLED). ' +
        'Use poll_subtasks first to check if tasks are complete.',
      inputSchema: {
        type: 'object',
        properties: {
          groupId: {
            type: 'string',
            description: 'The task group ID to get results for',
          },
        },
        required: ['groupId'],
      },
    },
    async (input, context) => {
      try {
        // H6: Input validation
        const groupId = input.groupId;
        if (typeof groupId !== 'string' || !groupId.trim()) {
          return { toolUseId: '', content: 'Error: groupId must be a non-empty string', isError: true };
        }

        // BUG 11: Pass conversationId for ownership validation
        const result = manager.getSubtaskResults(groupId as string, context.conversationId);

        return {
          toolUseId: '',
          content: JSON.stringify({
            results: result.results.map(r => ({
              taskId: r.taskId,
              instruction: r.instruction,
              state: r.state,
              result: truncateResult(r.result),
              error: r.error,
            })),
          }),
        };
      } catch (error) {
        // M9: Try-catch for get_results
        return {
          toolUseId: '',
          content: `Error getting subtask results: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // 5. cancel_subtasks
  // -------------------------------------------------------------------------
  toolRegistry.registerMcplManagementTool(
    'cancel_subtasks',
    {
      name: 'cancel_subtasks',
      description:
        'Cancel all running and queued tasks in a group. ' +
        'Tasks that have already completed are not affected.',
      inputSchema: {
        type: 'object',
        properties: {
          groupId: {
            type: 'string',
            description: 'The task group ID to cancel',
          },
        },
        required: ['groupId'],
      },
    },
    async (input, context) => {
      try {
        // H6: Input validation
        const groupId = input.groupId;
        if (typeof groupId !== 'string' || !groupId.trim()) {
          return { toolUseId: '', content: 'Error: groupId must be a non-empty string', isError: true };
        }

        // BUG 11: Pass conversationId for ownership validation
        await manager.cancelSubtasks(groupId as string, context.conversationId);

        return {
          toolUseId: '',
          content: JSON.stringify({ success: true, groupId }),
        };
      } catch (error) {
        return {
          toolUseId: '',
          content: `Error cancelling subtasks: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // 6. finalize_task_group
  // -------------------------------------------------------------------------
  toolRegistry.registerMcplManagementTool(
    'finalize_task_group',
    {
      name: 'finalize_task_group',
      description:
        'Finalize a task group: abort any remaining tasks, collect all results, ' +
        'and unfreeze the parent conversation. Call this when you want to stop ' +
        'all sub-agents and review their work.',
      inputSchema: {
        type: 'object',
        properties: {
          groupId: {
            type: 'string',
            description: 'The task group ID to finalize',
          },
        },
        required: ['groupId'],
      },
    },
    async (input, context) => {
      try {
        // H6: Input validation
        const groupId = input.groupId;
        if (typeof groupId !== 'string' || !groupId.trim()) {
          return { toolUseId: '', content: 'Error: groupId must be a non-empty string', isError: true };
        }

        // SA-3: Pass conversationId for ownership validation (matches poll/cancel/get_results)
        const result = await manager.finalizeTaskGroup(groupId as string, false, context.conversationId);

        // C3: Handle already_finalized gracefully (AI-friendly message)
        if (result.status === 'already_finalized') {
          return {
            toolUseId: '',
            content: JSON.stringify({
              groupId: result.groupId,
              status: 'already_finalized',
              message: 'Task group was already finalized (possibly by auto-finalize). Results are available via get_subtask_results.',
              resultCount: result.results.length,
              results: result.results.map(r => ({
                taskId: r.taskId,
                instruction: r.instruction,
                state: r.state,
                result: truncateResult(r.result),
                error: r.error,
              })),
            }),
          };
        }

        return {
          toolUseId: '',
          content: JSON.stringify({
            groupId: result.groupId,
            status: 'ok',
            resultCount: result.results.length,
            results: result.results.map(r => ({
              taskId: r.taskId,
              instruction: r.instruction,
              state: r.state,
              // M8: Add truncation indicator
              result: truncateResult(r.result),
              error: r.error,
            })),
          }),
        };
      } catch (error) {
        return {
          toolUseId: '',
          content: `Error finalizing task group: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }
    },
  );

  console.log('[SubAgentTools] Registered 6 sub-agent tools');
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * M8: Truncate result with indicator so the AI knows content was cut.
 * JSONL persistence keeps full result. AI tools get up to MAX_RESULT_FULL (4000 chars).
 */
function truncateResult(result: string | null): string | null {
  if (!result) return result;
  if (result.length <= MAX_RESULT_FULL) return result;
  return result.slice(0, MAX_RESULT_FULL) + `...(truncated, ${result.length} total chars)`;
}
