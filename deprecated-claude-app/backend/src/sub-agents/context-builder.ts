/**
 * Sub-Agent Context Builder
 *
 * Builds the message array for sub-agent inference calls.
 *
 * Strategy:
 *   1. Load parent conversation messages (hydrated Message[])
 *   2. Slice to forkPoint (first N messages = parent context preamble)
 *   3. Load branch events from BranchEventStore
 *   4. Hydrate branch events into Message[] format
 *   5. Concatenate preamble + branch messages
 *   6. Prepend task instruction as a system-level directive
 */

import { v4 as uuidv4 } from 'uuid';
import type { Message, MessageBranch, Participant, Conversation } from '@deprecated-claude/shared';
import type { Database } from '../database/index.js';
import type { BranchEventStore } from '../database/branch-event-store.js';
import type { Event } from '../database/persistence.js';

// =============================================================================
// Types
// =============================================================================

export interface ContextBuildParams {
  conversationId: string;
  userId: string;
  taskId: string;
  taskInstruction: string;
  forkPoint: number;
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
    const { conversationId, userId, taskId, taskInstruction, forkPoint } = params;

    // 1. Get conversation metadata
    const conversation = await this.db.getConversation(conversationId, userId);
    if (!conversation) {
      throw new Error(`Conversation ${conversationId} not found`);
    }

    // 2. Get participants
    const participants = await this.db.getConversationParticipants(conversationId, userId);

    // 3. Load parent conversation messages and slice to forkPoint
    const allMessages = await this.db.getConversationMessages(conversationId, userId);

    // C4: Belt+suspenders assert — forkPoint was snapshotted as messages.length at spawn time.
    // Messages cannot shrink during group lifetime because parent is frozen.
    if (allMessages.length < forkPoint) {
      console.error(
        `[ContextBuilder] Messages shrank: expected >=${forkPoint}, got ${allMessages.length}. ` +
        `Using all available messages as fallback.`,
      );
    }
    const preamble = forkPoint > 0 ? allMessages.slice(0, forkPoint) : allMessages;

    // 4. Load branch events and hydrate into messages
    const branchEvents = await this.branchStore.loadEvents(taskId);
    const branchMessages = hydrateBranchEvents(branchEvents);

    // 5. Concatenate preamble + branch messages
    const messages = [...preamble, ...branchMessages];

    // 6. Build system prompt with task instruction
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
 * Build system prompt for sub-agent with task instruction prepended.
 */
function buildSubAgentSystemPrompt(basePrompt: string, taskInstruction: string): string {
  const taskBlock = [
    '## Sub-Agent Task',
    '',
    'You are a sub-agent working on a specific subtask within a larger conversation.',
    'Focus exclusively on the following task and produce a clear, concise summary when done.',
    '',
    `**Task:** ${taskInstruction}`,
    '',
    'When you have completed the task, provide a final summary of your findings or results.',
    'Do not ask follow-up questions — complete the task autonomously.',
  ].join('\n');

  return basePrompt ? `${taskBlock}\n\n---\n\n${basePrompt}` : taskBlock;
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
