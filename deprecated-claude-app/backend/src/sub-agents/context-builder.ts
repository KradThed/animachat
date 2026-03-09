/**
 * Sub-Agent Context Builder
 *
 * Builds the message array for sub-agent inference calls.
 *
 * Strategy:
 *   1. NO parent conversation history — sub-agent is a clean worker
 *   2. Synthetic user message as "task anchor" (models follow user turns better)
 *   3. Load branch events from BranchEventStore (sub-agent's own tool-loop history)
 *   4. Hydrate branch events into Message[] format
 *   5. System prompt with task instruction + rules
 */

import { v4 as uuidv4 } from 'uuid';
import type { Message, MessageBranch, Participant, Conversation } from '@deprecated-claude/shared';
import type { Database } from '../database/index.js';
import type { BranchEventStore } from '../database/branch-event-store.js';
import type { Event } from '../database/persistence.js';
import type { SubAgentContext } from './types.js';

// =============================================================================
// Types
// =============================================================================

export interface ContextBuildParams {
  conversationId: string;
  userId: string;
  taskId: string;
  taskInstruction: string;
  taskContext?: SubAgentContext;  // Optional structured context from spawn
  // forkPoint/forkBranchId: stored in SubAgentTask for potential future use, not used in MVP context builder
}

export interface BuiltContext {
  messages: Message[];
  participants: Participant[];
  systemPrompt: string;
  conversation: Conversation;
}

// =============================================================================
// Context Builder
// =============================================================================

export class SubAgentContextBuilder {
  constructor(
    private db: Database,
    private branchStore: BranchEventStore,
  ) {}

  /**
   * Build full context for a sub-agent inference call.
   */
  async buildContext(params: ContextBuildParams): Promise<BuiltContext> {
    const { conversationId, userId, taskId, taskInstruction, taskContext } = params;

    // 1. Get conversation metadata
    const conversation = await this.db.getConversation(conversationId, userId);
    if (!conversation) {
      throw new Error(`Conversation ${conversationId} not found`);
    }

    // 2. Get participants
    const participants = await this.db.getConversationParticipants(conversationId, userId);

    // 3. Sub-agent starts with NO parent history — all context in instruction.
    //    Branch events from previous tool-loop iterations are loaded (sub-agent's own history).
    const branchEvents = await this.branchStore.loadEvents(taskId);
    const branchMessages = hydrateBranchEvents(branchEvents);

    // 4. Synthetic user message as "task anchor" — models follow user turns better than system-only.
    //    Uses contentBlocks with text block (consistent with system message format).
    //    Deterministic IDs from taskId — stable across iterations, less noise in logs.
    let taskContent = `Task: ${taskInstruction}`;
    if (taskContext) {
      taskContent += formatTaskContext(taskContext);
    }

    const syntheticBranchId = `synthetic-branch:${taskId}`;
    const syntheticUser: Message = {
      id: `synthetic:${taskId}`,
      conversationId,
      branches: [{
        id: syntheticBranchId,
        role: 'user',
        content: taskContent,
        contentBlocks: [{ type: 'text', text: taskContent }],
        createdAt: new Date(),
      }],
      activeBranchId: syntheticBranchId,
      order: (branchMessages[0]?.order ?? 0) - 1,
    };

    const messages = [syntheticUser, ...branchMessages];

    // 5. Build system prompt with task instruction
    const assistantParticipant = participants.find(p => p.type === 'assistant');
    const baseSystemPrompt = assistantParticipant?.systemPrompt || conversation.systemPrompt || '';
    const systemPrompt = buildSubAgentSystemPrompt(baseSystemPrompt, taskInstruction);

    return { messages, participants, systemPrompt, conversation };
  }
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Build system prompt for sub-agent with task instruction + execution rules.
 */
function buildSubAgentSystemPrompt(basePrompt: string, taskInstruction: string): string {
  const taskBlock = [
    '## Sub-Agent Task',
    '',
    'You are a focused sub-agent executing a specific task.',
    `Your task: ${taskInstruction}`,
    '',
    'RULES:',
    '- Execute tools to complete the task. Do NOT discuss or comment on the task.',
    '- Do NOT reference any debugging, errors, or meta-discussion.',
    '- Return concrete results only.',
    '- Do not ask follow-up questions — complete the task autonomously.',
    '- Do not list or describe available tools — just use them.',
    '- If a tool returns a limit error, STOP calling tools and return your results immediately.',
  ].join('\n');

  return basePrompt ? `${taskBlock}\n\n---\n\n${basePrompt}` : taskBlock;
}

/**
 * Format SubAgentContext into a text block appended to the task instruction.
 * Keeps structure readable for the LLM without being overly verbose.
 */
function formatTaskContext(ctx: SubAgentContext): string {
  const parts: string[] = [];

  if (ctx.files?.length) {
    parts.push('\n\nRelevant files:\n' + ctx.files.map(f => `- ${f}`).join('\n'));
  }

  if (ctx.data && Object.keys(ctx.data).length > 0) {
    parts.push('\n\nContext data:');
    for (const [key, value] of Object.entries(ctx.data)) {
      parts.push(`- ${key}: ${value}`);
    }
  }

  if (ctx.previousResults?.length) {
    parts.push('\n\nPrevious results:');
    for (let i = 0; i < ctx.previousResults.length; i++) {
      parts.push(`[Result ${i + 1}]: ${ctx.previousResults[i]}`);
    }
  }

  return parts.join('\n');
}

/**
 * Convert branch events (from BranchEventStore) into Message[] format.
 * Branch events are stored as JSONL with types like:
 *   - assistant_message: LLM response
 *   - tool_call: tool invocation
 *   - tool_result: tool response
 *   - user_message: injected user context (e.g., tool results)
 */
function hydrateBranchEvents(events: Event[]): Message[] {
  const messages: Message[] = [];
  let order = 0;

  for (const event of events) {
    const data = event.data;

    switch (event.type) {
      case 'assistant_message': {
        const messageId = data.messageId || uuidv4();
        const branch: MessageBranch = {
          id: data.branchId || uuidv4(),
          role: 'assistant',
          content: data.content || '',
          contentBlocks: data.contentBlocks || [],
          model: data.model || '',
          createdAt: event.timestamp,
          participantId: data.participantId,
        };
        messages.push({
          id: messageId,
          conversationId: data.conversationId || '',
          branches: [branch],
          activeBranchId: branch.id,
          order: order++,
        });
        break;
      }

      case 'user_message': {
        const messageId = data.messageId || uuidv4();
        const branch: MessageBranch = {
          id: data.branchId || uuidv4(),
          role: 'user',
          content: data.content || '',
          contentBlocks: data.contentBlocks || [],
          createdAt: event.timestamp,
          participantId: data.participantId,
        };
        messages.push({
          id: messageId,
          conversationId: data.conversationId || '',
          branches: [branch],
          activeBranchId: branch.id,
          order: order++,
        });
        break;
      }

      // tool_call and tool_result are typically embedded in contentBlocks
      // of assistant_message / user_message, so we don't create separate
      // Message objects for them. They're handled by the inference runner
      // which appends them as part of the message flow.
      default:
        // Ignore unknown event types during hydration
        break;
    }
  }

  return messages;
}
