/**
 * Sub-Agent Tools
 *
 * Registers 11 tools with the tool registry for LLM-driven sub-agent orchestration:
 *   1. spawn_subtask    — spawn a single sub-agent (with optional context, deps, retry, budget)
 *   2. spawn_subtasks   — batch spawn multiple sub-agents (with DAG deps, retry, budget)
 *   3. poll_subtasks    — check status of a task group
 *   4. get_subtask_results — get results of completed tasks
 *   5. cancel_subtasks  — cancel running tasks in a group
 *   6. finalize_task_group — finalize + unfreeze parent conversation
 *   7. get_subtask_progress — intermediate progress of a running task
 *   8. update_subtask_instruction — modify instruction for a QUEUED task
 *   9. set_group_concurrency — dynamically change maxConcurrent for a group
 *  10. get_group_metrics — aggregated metrics across all tasks in a group
 *  11. resume_subtask   — re-queue a terminal task (ERROR/FINALIZED/CANCELLED)
 */

import { toolRegistry } from '../tools/tool-registry.js';
import type { SubAgentManager } from './sub-agent-manager.js';
import type { SubAgentContext } from './types.js';

// =============================================================================
// Constants
// =============================================================================

/** Max characters for result content in get_subtask_results + finalize_task_group. */
const MAX_RESULT_FULL = 4000;

/**
 * BUG T-5: Single source of truth for sub-agent tool names.
 * Used by inference-runner.ts to filter these from sub-agent tool lists (depth=1 limit).
 */
export const SUB_AGENT_TOOL_NAMES = new Set([
  'spawn_subtask', 'spawn_subtasks', 'poll_subtasks',
  'get_subtask_results', 'cancel_subtasks', 'finalize_task_group',
  'get_subtask_progress', 'update_subtask_instruction',
  'set_group_concurrency', 'get_group_metrics',
  'resume_subtask',
]);

/**
 * BUG T-5: MCPL management tools that sub-agents should not access.
 * Sub-agents are narrow workers — they should not enable/disable servers or manage policies.
 */
export const MCPL_MANAGEMENT_TOOL_NAMES = new Set([
  'list_mcp_servers', 'get_server_status', 'enable_server',
  'disable_server', 'manage_scope_policies',
]);

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
          context: {
            type: 'object',
            description: 'Optional structured context for the sub-agent (files, data, previous results)',
            properties: {
              files: {
                type: 'array',
                items: { type: 'string' },
                description: 'File paths or URIs relevant to the task',
              },
              data: {
                type: 'object',
                additionalProperties: { type: 'string' },
                description: 'Arbitrary key-value data pairs',
              },
              previousResults: {
                type: 'array',
                items: { type: 'string' },
                description: 'Results from previously completed sub-agent tasks',
              },
            },
          },
          dependsOn: {
            type: 'array',
            items: { type: 'string' },
            description: 'Task IDs this task depends on. Task stays QUEUED until all dependencies are FINALIZED. If any dependency fails (ERROR/CANCELLED), this task auto-errors.',
          },
          maxRetries: {
            type: 'number',
            description: 'Maximum auto-retries on transient errors (429, 500, 502, 503, network). Default: 0, max: 3.',
          },
          tokenBudget: {
            type: 'number',
            description: 'Maximum total tokens (input + output) for this task. Enforced post-hoc with best-effort maxToolCalls heuristic. Minimum: 1000.',
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

        // Feature C: Validate dependsOn format
        if (input.dependsOn !== undefined) {
          if (!Array.isArray(input.dependsOn)) {
            return { toolUseId: '', content: 'Error: dependsOn must be an array of task ID strings', isError: true };
          }
          for (const dep of input.dependsOn) {
            if (typeof dep !== 'string' || !dep.trim()) {
              return { toolUseId: '', content: 'Error: each dependsOn entry must be a non-empty string', isError: true };
            }
          }
        }

        // Feature F: Validate maxRetries
        if (input.maxRetries !== undefined) {
          if (typeof input.maxRetries !== 'number' || !Number.isInteger(input.maxRetries) || input.maxRetries < 0) {
            return { toolUseId: '', content: 'Error: maxRetries must be a non-negative integer', isError: true };
          }
        }

        // Feature E: Validate tokenBudget
        if (input.tokenBudget !== undefined) {
          if (typeof input.tokenBudget !== 'number' || input.tokenBudget < 1000) {
            return { toolUseId: '', content: 'Error: tokenBudget must be a number >= 1000', isError: true };
          }
        }

        const task = await manager.spawnSubtask({
          conversationId: context.conversationId,
          userId: context.userId,
          instruction: instruction as string,
          groupId: input.groupId as string | undefined,
          context: input.context as SubAgentContext | undefined,
          dependsOn: input.dependsOn as string[] | undefined,
          maxRetries: input.maxRetries as number | undefined,
          tokenBudget: input.tokenBudget as number | undefined,
        });

        return {
          toolUseId: '',
          content: JSON.stringify({
            taskId: task.taskId,
            groupId: task.groupId,
            state: task.state,
            instruction: task.instruction,
            ...(task.dependsOn?.length ? { dependsOn: task.dependsOn } : {}),
            ...(task.maxRetries ? { maxRetries: task.maxRetries } : {}),
            ...(task.tokenBudget ? { tokenBudget: task.tokenBudget } : {}),
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
        'Supports DAG dependencies: tasks can depend on sibling tasks within the same batch. ' +
        'Returns a groupId and list of taskIds.',
      inputSchema: {
        type: 'object',
        properties: {
          instructions: {
            type: 'array',
            description: 'Array of instructions. Each item can be a plain string or an object with {instruction, dependsOn?, context?}. ' +
              'When using objects, dependsOn references taskIds of sibling tasks (returned in order). ' +
              'Use poll_subtasks after spawning to get the actual taskIds for dependency references.',
            items: {
              oneOf: [
                { type: 'string' },
                {
                  type: 'object',
                  properties: {
                    instruction: { type: 'string', description: 'Task instruction' },
                    dependsOn: {
                      type: 'array',
                      items: { type: 'string' },
                      description: 'Task IDs this task depends on (sibling taskIds from same batch or existing group tasks)',
                    },
                    context: {
                      type: 'object',
                      description: 'Per-task context override (merged with shared group context)',
                      properties: {
                        files: { type: 'array', items: { type: 'string' } },
                        data: { type: 'object', additionalProperties: { type: 'string' } },
                        previousResults: { type: 'array', items: { type: 'string' } },
                      },
                    },
                  },
                  required: ['instruction'],
                },
              ],
            },
          },
          maxConcurrent: {
            type: 'number',
            description: 'Maximum concurrent sub-agents (default: 3)',
          },
          context: {
            type: 'object',
            description: 'Optional structured context shared by all sub-agents (files, data, previous results)',
            properties: {
              files: {
                type: 'array',
                items: { type: 'string' },
                description: 'File paths or URIs relevant to the tasks',
              },
              data: {
                type: 'object',
                additionalProperties: { type: 'string' },
                description: 'Arbitrary key-value data pairs',
              },
              previousResults: {
                type: 'array',
                items: { type: 'string' },
                description: 'Results from previously completed sub-agent tasks',
              },
            },
          },
          maxRetries: {
            type: 'number',
            description: 'Default max auto-retries for all tasks in batch (0-3). Individual tasks inherit this unless overridden.',
          },
          tokenBudget: {
            type: 'number',
            description: 'Default token budget for all tasks in batch. Minimum: 1000.',
          },
        },
        required: ['instructions'],
      },
    },
    async (input, context) => {
      try {
        // H6: Input validation — supports both string[] and SpawnSubtaskInstruction[]
        const instructions = input.instructions;
        if (!Array.isArray(instructions) || instructions.length === 0) {
          return { toolUseId: '', content: 'Error: instructions must be a non-empty array', isError: true };
        }

        // Validate each instruction item (string or structured object)
        for (let i = 0; i < instructions.length; i++) {
          const item = instructions[i];
          if (typeof item === 'string') {
            if (!item.trim()) {
              return { toolUseId: '', content: `Error: instructions[${i}] must be a non-empty string`, isError: true };
            }
          } else if (typeof item === 'object' && item !== null) {
            if (typeof item.instruction !== 'string' || !item.instruction.trim()) {
              return { toolUseId: '', content: `Error: instructions[${i}].instruction must be a non-empty string`, isError: true };
            }
            if (item.dependsOn !== undefined) {
              if (!Array.isArray(item.dependsOn)) {
                return { toolUseId: '', content: `Error: instructions[${i}].dependsOn must be an array of task ID strings`, isError: true };
              }
              for (const dep of item.dependsOn) {
                if (typeof dep !== 'string' || !dep.trim()) {
                  return { toolUseId: '', content: `Error: instructions[${i}].dependsOn entries must be non-empty strings`, isError: true };
                }
              }
            }
          } else {
            return { toolUseId: '', content: `Error: instructions[${i}] must be a string or {instruction, dependsOn?, context?} object`, isError: true };
          }
        }

        // Feature F: Validate maxRetries
        if (input.maxRetries !== undefined) {
          if (typeof input.maxRetries !== 'number' || !Number.isInteger(input.maxRetries) || input.maxRetries < 0) {
            return { toolUseId: '', content: 'Error: maxRetries must be a non-negative integer', isError: true };
          }
        }

        // Feature E: Validate tokenBudget
        if (input.tokenBudget !== undefined) {
          if (typeof input.tokenBudget !== 'number' || input.tokenBudget < 1000) {
            return { toolUseId: '', content: 'Error: tokenBudget must be a number >= 1000', isError: true };
          }
        }

        const tasks = await manager.spawnSubtasks({
          conversationId: context.conversationId,
          userId: context.userId,
          instructions: instructions as any, // Union type: string[] | SpawnSubtaskInstruction[]
          maxConcurrent: input.maxConcurrent as number | undefined,
          context: input.context as SubAgentContext | undefined,
          maxRetries: input.maxRetries as number | undefined,
          tokenBudget: input.tokenBudget as number | undefined,
        });

        // BUG T-7: Guard against empty result array (groupId would be undefined)
        if (tasks.length === 0) {
          return {
            toolUseId: '',
            content: JSON.stringify({ error: 'No tasks were spawned' }),
            isError: true,
          };
        }

        return {
          toolUseId: '',
          content: JSON.stringify({
            groupId: tasks[0].groupId,
            tasks: tasks.map(t => ({
              taskId: t.taskId,
              instruction: t.instruction,
              state: t.state,
              ...(t.dependsOn?.length ? { dependsOn: t.dependsOn } : {}),
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

  // -------------------------------------------------------------------------
  // 7. get_subtask_progress
  // -------------------------------------------------------------------------
  toolRegistry.registerMcplManagementTool(
    'get_subtask_progress',
    {
      name: 'get_subtask_progress',
      description:
        'Get intermediate progress of a sub-agent task. ' +
        'Shows tools called, event count, and last activity. ' +
        'Works for tasks in any state, most useful for RUNNING tasks.',
      inputSchema: {
        type: 'object',
        properties: {
          taskId: {
            type: 'string',
            description: 'The task ID to get progress for',
          },
        },
        required: ['taskId'],
      },
    },
    async (input, context) => {
      try {
        // H6: Input validation
        const taskId = input.taskId;
        if (typeof taskId !== 'string' || !taskId.trim()) {
          return { toolUseId: '', content: 'Error: taskId must be a non-empty string', isError: true };
        }

        const progress = await manager.getTaskProgress(
          taskId as string,
          context.conversationId,
        );

        return {
          toolUseId: '',
          content: JSON.stringify(progress),
        };
      } catch (error) {
        return {
          toolUseId: '',
          content: `Error getting subtask progress: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // 8. update_subtask_instruction
  // -------------------------------------------------------------------------
  toolRegistry.registerMcplManagementTool(
    'update_subtask_instruction',
    {
      name: 'update_subtask_instruction',
      description:
        'Update the instruction for a QUEUED sub-agent task. ' +
        'Only works if the task has not started running yet.',
      inputSchema: {
        type: 'object',
        properties: {
          taskId: {
            type: 'string',
            description: 'The task ID to update',
          },
          instruction: {
            type: 'string',
            description: 'The new instruction for the sub-agent',
          },
        },
        required: ['taskId', 'instruction'],
      },
    },
    async (input, context) => {
      try {
        // H6: Input validation
        const taskId = input.taskId;
        if (typeof taskId !== 'string' || !taskId.trim()) {
          return { toolUseId: '', content: 'Error: taskId must be a non-empty string', isError: true };
        }
        const instruction = input.instruction;
        if (typeof instruction !== 'string' || !instruction.trim()) {
          return { toolUseId: '', content: 'Error: instruction must be a non-empty string', isError: true };
        }

        const task = await manager.updateTaskInstruction(
          taskId as string,
          instruction as string,
          context.conversationId,
          context.userId,
        );

        return {
          toolUseId: '',
          content: JSON.stringify({
            taskId: task.taskId,
            groupId: task.groupId,
            instruction: task.instruction,
            state: task.state,
          }),
        };
      } catch (error) {
        return {
          toolUseId: '',
          content: `Error updating subtask instruction: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // 9. set_group_concurrency
  // -------------------------------------------------------------------------
  toolRegistry.registerMcplManagementTool(
    'set_group_concurrency',
    {
      name: 'set_group_concurrency',
      description:
        'Dynamically change the maximum concurrent sub-agents for a task group. ' +
        'If increased, queued tasks may start immediately.',
      inputSchema: {
        type: 'object',
        properties: {
          groupId: {
            type: 'string',
            description: 'The task group ID',
          },
          maxConcurrent: {
            type: 'number',
            description: 'New maximum concurrent sub-agents (1-10)',
          },
        },
        required: ['groupId', 'maxConcurrent'],
      },
    },
    async (input, context) => {
      try {
        // H6: Input validation
        const groupId = input.groupId;
        if (typeof groupId !== 'string' || !groupId.trim()) {
          return { toolUseId: '', content: 'Error: groupId must be a non-empty string', isError: true };
        }
        const maxConcurrent = input.maxConcurrent;
        if (typeof maxConcurrent !== 'number' || !Number.isInteger(maxConcurrent)) {
          return { toolUseId: '', content: 'Error: maxConcurrent must be an integer', isError: true };
        }

        const config = manager.setGroupConcurrency(
          groupId as string,
          maxConcurrent as number,
          context.conversationId,
        );

        return {
          toolUseId: '',
          content: JSON.stringify({ groupId, config }),
        };
      } catch (error) {
        return {
          toolUseId: '',
          content: `Error setting group concurrency: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // 10. get_group_metrics
  // -------------------------------------------------------------------------
  toolRegistry.registerMcplManagementTool(
    'get_group_metrics',
    {
      name: 'get_group_metrics',
      description:
        'Get aggregated metrics across all tasks in a group: token counts, tool calls, duration, ' +
        'and per-state task counts.',
      inputSchema: {
        type: 'object',
        properties: {
          groupId: {
            type: 'string',
            description: 'The task group ID to get metrics for',
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

        const metrics = manager.getGroupMetrics(
          groupId as string,
          context.conversationId,
        );

        return {
          toolUseId: '',
          content: JSON.stringify(metrics),
        };
      } catch (error) {
        return {
          toolUseId: '',
          content: `Error getting group metrics: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // 11. resume_subtask (Feature D: Agent Resumption)
  // -------------------------------------------------------------------------
  toolRegistry.registerMcplManagementTool(
    'resume_subtask',
    {
      name: 'resume_subtask',
      description:
        'Re-queue a terminal sub-agent task (ERROR, FINALIZED, or CANCELLED) for another attempt. ' +
        'The task returns to QUEUED state and re-runs with its existing branch context (previous tool work preserved). ' +
        'Optionally provide a new instruction to refine the task. ' +
        'Maximum 3 resumes per task. Cannot resume tasks in an already-finalized group.',
      inputSchema: {
        type: 'object',
        properties: {
          taskId: {
            type: 'string',
            description: 'The task ID to resume',
          },
          instruction: {
            type: 'string',
            description: 'Optional new instruction to replace the current one (e.g., to refine after seeing the error)',
          },
        },
        required: ['taskId'],
      },
    },
    async (input, context) => {
      try {
        // H6: Input validation
        const taskId = input.taskId;
        if (typeof taskId !== 'string' || !taskId.trim()) {
          return { toolUseId: '', content: 'Error: taskId must be a non-empty string', isError: true };
        }

        if (input.instruction !== undefined) {
          if (typeof input.instruction !== 'string' || !input.instruction.trim()) {
            return { toolUseId: '', content: 'Error: instruction must be a non-empty string if provided', isError: true };
          }
        }

        const task = await manager.resumeTask(
          taskId as string,
          context.conversationId,
          context.userId,
          input.instruction as string | undefined,
        );

        return {
          toolUseId: '',
          content: JSON.stringify({
            taskId: task.taskId,
            groupId: task.groupId,
            state: task.state,
            instruction: task.instruction,
            resumeCount: task.resumeCount,
          }),
        };
      } catch (error) {
        return {
          toolUseId: '',
          content: `Error resuming subtask: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }
    },
  );

  console.log('[SubAgentTools] Registered 11 sub-agent tools');
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
