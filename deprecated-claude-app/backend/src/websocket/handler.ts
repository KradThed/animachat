import { WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { v4 as uuidv4 } from 'uuid';
import { WsMessageSchema, WsMessage, Message, Participant, Conversation, ToolConfig } from '@deprecated-claude/shared';
import { Database } from '../database/index.js';
import { verifyToken } from '../middleware/auth.js';
import { InferenceService } from '../services/inference.js';
import { MembraneInferenceService } from '../services/membrane-inference.js';
import { EnhancedInferenceService, validatePricingAvailable, PricingNotConfiguredError } from '../services/enhanced-inference.js';
import { ContextManager } from '../services/context-manager.js';
import { Logger } from '../utils/logger.js';
import { llmLogger } from '../utils/llmLogger.js';
import { ModelLoader } from '../config/model-loader.js';
import { roomManager } from './room-manager.js';
import { USER_FACING_ERRORS } from '../utils/error-messages.js';
import { checkContent, type UserContext } from '../services/content-filter.js';
import { toolRegistry } from '../tools/tool-registry.js';
import type { ToolCall, ToolResult } from '../tools/tool-registry.js';
import { buildFeatureSetPredicate } from '../utils/feature-set-predicate.js';
import { delegateWebsocketHandler, resolveScopeChange, resolveScopeElevate } from '../delegate/delegate-handler.js';
import { delegateManager } from '../delegate/delegate-manager.js';
import { mcplHookManager } from '../services/mcpl-hook-manager.js';
import type { InferenceHookContext } from '../services/mcpl-hook-manager.js';
import { mcplEventQueue } from '../services/mcpl-event-queue.js';
import { mcplStateManager } from '../services/mcpl-state-manager.js';
import type { McplContextInjection } from '@deprecated-claude/shared';
import { normalizeInjectionContent, getInjectionContentSize } from '@deprecated-claude/shared';
import { findLastUserMessageIndex } from '../utils/message-helpers.js';

interface AuthenticatedWebSocket extends WebSocket {
  userId?: string;
  isAlive?: boolean;
}

// Sub-agent manager interface (used for frozen parent gate + UI state)
// Set via setSubAgentManager() from index.ts startup
import type { QueuedUserMessage, SubAgentStateSnapshot } from '../sub-agents/types.js';

interface SubAgentManagerLike {
  getBlockingGroupId(conversationId: string): string | null;
  getQueuedMessage(conversationId: string, userId: string): QueuedUserMessage | null;
  queueUserMessage(msg: QueuedUserMessage): void;
  releaseQueuedMessage(conversationId: string, userId: string): QueuedUserMessage | null;
  cancelQueuedMessage(conversationId: string, userId: string): void;
  getStateSnapshot(conversationId: string, userId: string): SubAgentStateSnapshot;
  getSubtaskResultsWithMeta(groupId: string): Promise<{
    found: boolean;
    results: import('../sub-agents/types.js').SubAgentResult[];
    conversationId: string | null;
  }>;
}

let _subAgentManager: SubAgentManagerLike | null = null;

export function setSubAgentManager(manager: SubAgentManagerLike): void {
  _subAgentManager = manager;
}

// Track active generations for abort support
// Key: `${userId}:${conversationId}`
interface ActiveGeneration {
  controller: AbortController;
  startedAt: number;
}
const activeGenerations = new Map<string, ActiveGeneration>();

// Safety-net sweep: abort and remove entries older than 10 minutes.
// Protects against leaks when a generation hangs or an outer catch fails.
const GENERATION_TTL_MS = 10 * 60 * 1000;
const GENERATION_SWEEP_INTERVAL_MS = 60 * 1000;
const generationSweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, gen] of activeGenerations) {
    if (now - gen.startedAt > GENERATION_TTL_MS) {
      console.warn(`[WS] Sweeping stale generation: ${key} (age ${Math.round((now - gen.startedAt) / 1000)}s)`);
      gen.controller.abort();
      activeGenerations.delete(key);
    }
  }
}, GENERATION_SWEEP_INTERVAL_MS);
generationSweepTimer.unref(); // Don't prevent process exit

function getGenerationKey(userId: string, conversationId: string): string {
  return `${userId}:${conversationId}`;
}

function startGeneration(userId: string, conversationId: string): AbortController {
  const key = getGenerationKey(userId, conversationId);
  // Abort any existing generation for this conversation
  const existing = activeGenerations.get(key);
  if (existing) {
    existing.controller.abort();
  }
  const controller = new AbortController();
  activeGenerations.set(key, { controller, startedAt: Date.now() });
  return controller;
}

function endGeneration(userId: string, conversationId: string): void {
  const key = getGenerationKey(userId, conversationId);
  activeGenerations.delete(key);
}

function abortGeneration(userId: string, conversationId: string): boolean {
  const key = getGenerationKey(userId, conversationId);
  const gen = activeGenerations.get(key);
  if (gen) {
    gen.controller.abort();
    activeGenerations.delete(key);
    return true;
  }
  return false;
}

const EVICTION_INTERVAL_MS = 5 * 60 * 1000; // check every 5 minutes
const EVICTION_MAX_AGE_MS = 30 * 60 * 1000; // evict after 30 min idle

/**
 * INF-4+5: Periodically evict conversations not accessed within EVICTION_MAX_AGE_MS.
 * Conversations with active inference are protected.
 */
export function startEvictionTimer(db: Database): NodeJS.Timeout {
  return setInterval(() => {
    const evicted = db.evictStaleConversations(EVICTION_MAX_AGE_MS, (conversationId) => {
      // Protect conversations with in-flight inference
      for (const key of activeGenerations.keys()) {
        if (key.endsWith(`:${conversationId}`)) return true;
      }
      return false;
    });
    if (evicted > 0) {
      console.log(`[Eviction] Unloaded ${evicted} stale conversation(s)`);
    }
  }, EVICTION_INTERVAL_MS);
}

function safeSend(ws: AuthenticatedWebSocket, data: any): void {
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  } catch {
    // Connection closed mid-send
  }
}

/**
 * Build tool options for inference based on toolConfig.
 * For 1-on-1 chats: uses conversation.toolConfig
 * For group chats: uses responder.toolConfig
 * Returns undefined if no tools are available or tools are disabled.
 */
export interface ToolOptions {
  tools: any[];
  snapshotHash: string;
  toolCount: number;
  onToolCall?: (call: ToolCall) => void;
  onToolResult?: (result: ToolResult) => void;
  executeToolCall: (call: ToolCall) => Promise<ToolResult>;
}

export function buildToolOptions(
  userId: string,
  conversation: Conversation,
  responder?: Participant,
  db?: import('../database/index.js').Database
): ToolOptions | undefined {
  // Determine which toolConfig to use:
  // - For 1-on-1 (standard) chats: conversation.toolConfig
  // - For group chats: responder.toolConfig
  // - Participant toolConfig takes precedence if both exist
  const toolConfig: ToolConfig | undefined = responder?.toolConfig ?? conversation.toolConfig;

  console.log('[buildToolOptions] Input:', {
    userId,
    conversationFormat: conversation.format,
    conversationToolConfig: conversation.toolConfig,
    responderToolConfig: responder?.toolConfig,
    effectiveToolConfig: toolConfig
  });

  // If tools are explicitly disabled, return undefined
  if (toolConfig?.toolsEnabled === false) {
    console.log('[buildToolOptions] Tools disabled, returning undefined');
    return undefined;
  }

  // Get all tools available to this user (filtering disabled feature sets if db available)
  const conversationId = conversation.id;
  const isFeatureSetEnabled = db
    ? buildFeatureSetPredicate(userId, conversationId, db)
    : undefined;
  const allTools = toolRegistry.getToolsForUser(userId, isFeatureSetEnabled);
  console.log('[buildToolOptions] All tools for user:', allTools.length);

  // Filter by toolConfig if present
  // BUG T-11: pass isFeatureSetEnabled to getToolsForUserWithSource (was missing, causing
  // disabled feature sets to be re-included when toolConfig filtering was active)
  const tools = toolConfig
    ? toolRegistry.getToolsForParticipant(
        toolRegistry.getToolsForUserWithSource(userId, isFeatureSetEnabled),
        toolConfig
      )
    : allTools;

  console.log('[buildToolOptions] Filtered tools:', tools.length, tools.map((t: any) => t.name));

  if (tools.length === 0) {
    console.log('[buildToolOptions] No tools available, returning undefined');
    return undefined;
  }

  const snapshotHash = toolRegistry.computeToolsetHash(tools);

  console.log('[buildToolOptions] Returning toolOptions with', tools.length, 'tools, hash:', snapshotHash);
  return {
    tools,
    snapshotHash,
    toolCount: tools.length,
    executeToolCall: async (call: ToolCall): Promise<ToolResult> => {
      return toolRegistry.executeTool(call, userId, toolConfig, conversationId);
    }
  };
}

/**
 * Apply backroom CLI prompt for early group chats.
 * Only applies when:
 * 1. Conversation is in group chat (prefill) format
 * 2. Less than 10 messages in the conversation
 * 3. Model supports prefill
 * 4. Participant's mode is NOT explicitly set to 'messages'
 */
const BACKROOM_PROMPT = 'The assistant is in CLI simulation mode, and responds to the user\'s CLI commands only with the output of the command.';

interface BackroomPromptParams {
  conversationFormat: 'standard' | 'prefill';
  messageCount: number;
  modelProvider: string;
  modelSupportsPrefill?: boolean;
  participantConversationMode?: string;
  existingSystemPrompt: string;
  cliModePrompt?: { enabled: boolean; messageThreshold: number };
}

function applyBackroomPromptIfNeeded(params: BackroomPromptParams): string {
  const {
    conversationFormat,
    messageCount,
    modelProvider,
    modelSupportsPrefill,
    participantConversationMode,
    existingSystemPrompt,
    cliModePrompt
  } = params;
  
  // Check if CLI mode prompt is disabled by toggle
  const cliEnabled = cliModePrompt?.enabled ?? true;
  const threshold = cliModePrompt?.messageThreshold ?? 10;
  
  if (!cliEnabled) {
    return existingSystemPrompt;
  }
  
  // Only for group chats with fewer than threshold messages
  if (conversationFormat !== 'prefill' || messageCount >= threshold) {
    return existingSystemPrompt;
  }
  
  // Check if model supports prefill
  const supportsPrefill = modelSupportsPrefill !== false && (modelProvider === 'anthropic' || modelProvider === 'bedrock' || modelSupportsPrefill === true);
  if (!supportsPrefill) {
    return existingSystemPrompt;
  }
  
  // Check if participant wants prefill mode (not explicitly 'messages' or 'completion')
  const wantsPrefill = !participantConversationMode || 
                       participantConversationMode === 'auto' || 
                       participantConversationMode === 'prefill';
  if (!wantsPrefill) {
    return existingSystemPrompt;
  }
  
  // CLI mode is enabled and conditions are met - apply the backroom prompt
  // If there's an existing system prompt, prepend the CLI prompt to it
  if (existingSystemPrompt) {
    Logger.websocket(`[WebSocket] Applied backroom prompt + custom prompt (${messageCount} messages, provider: ${modelProvider})`);
    return `${BACKROOM_PROMPT}\n\n${existingSystemPrompt}`;
  }
  
  Logger.websocket(`[WebSocket] Applied backroom prompt (${messageCount} messages, provider: ${modelProvider})`);
  return BACKROOM_PROMPT;
}

/**
 * Apply identity prompt for participants in 'messages' mode.
 * In 'messages' mode, the model only sees alternating user/assistant messages
 * and doesn't know its identity from the conversation format.
 * 
 * This adds a default identity prompt like "You are {name}." which can be
 * overridden by the participant's custom system prompt.
 */
interface IdentityPromptParams {
  conversationFormat: 'standard' | 'prefill';
  participantName: string;
  participantConversationMode?: string;
  modelProvider: string;
  modelSupportsPrefill?: boolean;
  existingSystemPrompt: string;
  hasCustomSystemPrompt: boolean; // Whether participant has their own system prompt
}

function applyIdentityPromptIfNeeded(params: IdentityPromptParams): string {
  const {
    conversationFormat,
    participantName,
    participantConversationMode,
    modelProvider,
    modelSupportsPrefill,
    existingSystemPrompt,
    hasCustomSystemPrompt
  } = params;
  
  // Only for group chats (prefill format) - standard conversations use different flow
  if (conversationFormat !== 'prefill') {
    return existingSystemPrompt;
  }
  
  // If participant has a custom system prompt, they've already defined their identity
  if (hasCustomSystemPrompt) {
    return existingSystemPrompt;
  }
  
  // Check if model supports prefill
  const supportsPrefill = modelSupportsPrefill !== false && (modelProvider === 'anthropic' || modelProvider === 'bedrock' || modelSupportsPrefill === true);
  
  // Determine if we're actually using messages mode
  // (either explicitly set to 'messages', or 'auto'/undefined with a model that doesn't support prefill)
  const explicitMessagesMode = participantConversationMode === 'messages' || participantConversationMode === 'completion';
  const autoFallbackToMessages = (!participantConversationMode || participantConversationMode === 'auto') && !supportsPrefill;
  
  const usingMessagesMode = explicitMessagesMode || autoFallbackToMessages;
  
  if (!usingMessagesMode) {
    // Using prefill mode - participant name is in the message format, no identity prompt needed
    return existingSystemPrompt;
  }
  
  // Build identity prompt
  const identityPrompt = `You are ${participantName}. You are connected to a multi-participant chat system. Please respond in character.`;
  
  Logger.websocket(`[WebSocket] Applied identity prompt for "${participantName}" (messages mode)`);
  
  return existingSystemPrompt 
    ? `${identityPrompt}\n\n${existingSystemPrompt}`
    : identityPrompt;
}

/**
 * Build conversation history by following the active branch path backwards
 * from a given branch ID to the root.
 * 
 * @param allMessages - All messages in the conversation
 * @param fromBranchId - The branch ID to start from (going backwards)
 * @param includeMessage - Optional message to include/replace in the history
 * @returns Array of messages in chronological order (oldest first)
 */
export function buildConversationHistory(
  allMessages: Message[],
  fromBranchId: string | undefined,
  includeMessage?: { messageId: string; message: Message }
): Message[] {
  const history: Message[] = [];
  
  // Build a map for quick lookup
  const messagesByBranchId = new Map<string, Message>();
  for (const msg of allMessages) {
    for (const branch of msg.branches) {
      messagesByBranchId.set(branch.id, msg);
    }
  }
  
  // Start from the specified branch and work backwards
  let currentBranchId = fromBranchId;
  
  while (currentBranchId && currentBranchId !== 'root') {
    const message = messagesByBranchId.get(currentBranchId);
    if (!message) {
      Logger.debug('[buildConversationHistory] Could not find message for branch:', currentBranchId);
      break;
    }
    
    // Use the provided message if this is the one to replace
    let messageToAdd = includeMessage && message.id === includeMessage.messageId 
      ? includeMessage.message 
      : message;
    
    // CRITICAL: Ensure activeBranchId matches the branch we're traversing
    // Without this, if user switched branches before regenerating, the prefill
    // would contain content from the wrong branch!
    if (messageToAdd.activeBranchId !== currentBranchId) {
      messageToAdd = {
        ...messageToAdd,
        activeBranchId: currentBranchId
      };
      Logger.debug(`[buildConversationHistory] Fixed activeBranchId mismatch for message ${message.id.substring(0, 8)}`);
    }
    
    // Add to beginning of history (we're building backwards)
    history.unshift(messageToAdd);
    
    // Find the branch and get its parent
    const branch = messageToAdd.branches.find(b => b.id === currentBranchId);
    if (!branch) {
      console.log('[buildConversationHistory] Could not find branch:', currentBranchId);
      break;
    }
    
    currentBranchId = branch.parentBranchId;
  }
  
  return history;
}

/**
 * Filter out messages that are marked as hidden from AI.
 * These messages are visible to humans but should not be included in the AI context.
 * 
 * @param messages - Array of messages to filter
 * @returns Array of messages with hiddenFromAi branches removed
 */
function filterHiddenFromAiMessages(messages: Message[]): Message[] {
  return messages
    .map(msg => {
      // Get the active branch
      const activeBranch = msg.branches.find(b => b.id === msg.activeBranchId);
      
      // If the active branch is hidden from AI, skip this message entirely
      if (activeBranch?.hiddenFromAi) {
        return null;
      }
      
      return msg;
    })
    .filter((msg): msg is Message => msg !== null);
}

async function userHasSufficientCredits(db: Database, userId: string, modelId?: string): Promise<boolean> {
  // Check if the user has their own API key for the model's provider
  if (modelId) {
    const modelLoader = ModelLoader.getInstance();
    const model = await modelLoader.getModelById(modelId, userId);
    if (model) {
      // Check if user has their own API key for this provider
      const userApiKeys = await db.getUserApiKeys(userId);
      const hasProviderKey = userApiKeys.some(key => key.provider === model.provider);
      if (hasProviderKey) {
        console.log(`[Credits] User ${userId} has custom ${model.provider} API key, skipping credit check`);
        return true;
      }
    }
  }

  const summary = await db.getUserGrantSummary(userId);
  const currencies = await db.getApplicableGrantCurrencies(modelId, userId);
  for (const currency of currencies) {
    const balance = Number(summary.totals[currency] ?? 0);
    if (balance > 0) return true;
  }
  return await db.userHasActiveGrantCapability(userId, 'overspend');
}

function sendInsufficientCreditsError(ws: AuthenticatedWebSocket): void {
  ws.send(JSON.stringify({
    type: 'error',
    error: 'Insufficient credits. Please add credits before generating more responses.'
  }));
}

// =============================================================================
// Fix #1: Hook Injection — block-aware beforeUser/afterUser injection
// =============================================================================

const MAX_INJECTION_CHARS = 4000; // sum of all injected text across all positions

/**
 * Apply beforeUser/afterUser injections into the last user message in historyMessages.
 * Mutates historyMessages in-place (replaces the message at the found index).
 *
 * Block-aware: if active branch has `contentBlocks`, inject as new text blocks;
 * if only `content` string, prepend/append to the string.
 * Priority rule: `contentBlocks` wins — if both `content` and `contentBlocks` exist,
 * inject into `contentBlocks` only, leave `content` untouched.
 *
 * Active branch invariant: uses `msg.activeBranchId` to find the branch — same
 * source of truth as the inference resolver.
 *
 * Falls back to system prompt if no user messages found.
 */
function applyUserMessageInjections(
  historyMessages: any[], // Message[]
  beforeUser: McplContextInjection[],
  afterUser: McplContextInjection[],
  _effectiveSystemPrompt: string, // unused, kept for signature clarity
  fallbackToSystemPrompt: (text: string) => void,
): void {
  // Sort injections deterministically: by namespace, then by original index
  const sortInjections = (arr: McplContextInjection[]): McplContextInjection[] =>
    arr.map((inj, idx) => ({ ...inj, _idx: idx }))
      .sort((a, b) => a.namespace.localeCompare(b.namespace) || (a as any)._idx - (b as any)._idx)
      .map(({ _idx, ...rest }) => rest as McplContextInjection);

  const sortedBefore = sortInjections(beforeUser);
  const sortedAfter = sortInjections(afterUser);

  // Token budget: drop lowest priority (last in sorted order) if over budget
  let totalChars = 0;
  const budgetedBefore: McplContextInjection[] = [];
  const budgetedAfter: McplContextInjection[] = [];
  let truncatedCount = 0;

  // beforeUser first, then afterUser
  for (const inj of [...sortedBefore, ...sortedAfter]) {
    // F5 fix: getInjectionContentSize handles McplContentBlock[] (counts serialized size, not array length)
    const contentSize = getInjectionContentSize(inj.content);
    if (totalChars + contentSize > MAX_INJECTION_CHARS) {
      truncatedCount++;
      continue;
    }
    totalChars += contentSize;
    if (inj.position === 'beforeUser') {
      budgetedBefore.push(inj);
    } else {
      budgetedAfter.push(inj);
    }
  }

  if (truncatedCount > 0) {
    console.warn(`[ParallelInference] injections_truncated: ${truncatedCount} injection(s) dropped (budget: ${MAX_INJECTION_CHARS} chars)`);
  }

  if (budgetedBefore.length === 0 && budgetedAfter.length === 0) {
    return; // all truncated
  }

  // Find last user message (walk backwards)
  const lastUserIdx = findLastUserMessageIndex(historyMessages);

  if (lastUserIdx === -1) {
    // Edge case: no user messages → fall back to system prompt (existing behavior)
    const allContents = [
      ...budgetedBefore.map(i => `[Context from ${i.namespace}]\n${normalizeInjectionContent(i.content)}`),
      ...budgetedAfter.map(i => `[Context from ${i.namespace}]\n${normalizeInjectionContent(i.content)}`),
    ].join('\n\n');
    fallbackToSystemPrompt(allContents);
    return;
  }

  const originalMsg = historyMessages[lastUserIdx];

  // Deep clone branches (don't mutate cached DB objects)
  const clonedBranches = originalMsg.branches.map((b: any) => ({
    ...b,
    // Deep clone contentBlocks if present
    contentBlocks: b.contentBlocks ? b.contentBlocks.map((block: any) => ({ ...block })) : b.contentBlocks,
  }));

  // Find the active branch in cloned branches (same as inference resolver)
  const activeBranch = clonedBranches.find((b: any) => b.id === originalMsg.activeBranchId);
  if (!activeBranch) {
    // Should not happen — log and bail
    console.error('[ParallelInference] injection_branch_missing: activeBranch not found in cloned branches');
    return;
  }

  // Determine injection path: contentBlocks wins if both exist
  const hasContentBlocks = Array.isArray(activeBranch.contentBlocks) && activeBranch.contentBlocks.length > 0;

  // Gap 5: Helper to convert injection content to content blocks.
  // Handles both string (text-only) and McplContentBlock[] (multimodal) content.
  const injectionToBlocks = (inj: McplContextInjection): Array<{ type: string; text?: string; source?: any }> => {
    if (typeof inj.content === 'string') {
      return [{ type: 'text', text: `[Context from ${inj.namespace}]\n${inj.content}` }];
    }
    // Multimodal: array of content blocks
    const blocks: Array<{ type: string; text?: string; source?: any }> = [];
    // Prepend server label as text block
    blocks.push({ type: 'text', text: `[Context from ${inj.namespace}]` });
    for (const cb of inj.content) {
      if (cb.type === 'text' && cb.text) {
        blocks.push({ type: 'text', text: cb.text });
      } else if (cb.type === 'image' && cb.data && cb.mimeType) {
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: cb.mimeType, data: cb.data },
        });
      }
    }
    return blocks;
  };

  // Helper: extract text representation for string-only path
  const injectionToString = (inj: McplContextInjection): string => {
    if (typeof inj.content === 'string') {
      return `[Context from ${inj.namespace}]\n${inj.content}`;
    }
    // Multimodal: extract text blocks only (images can't be injected into plain string)
    const texts = inj.content
      .filter(cb => cb.type === 'text' && cb.text)
      .map(cb => cb.text!);
    return `[Context from ${inj.namespace}]\n${texts.join('\n')}`;
  };

  if (hasContentBlocks) {
    // Block-aware path: inject as content blocks (supports multimodal)

    // beforeUser: unshift (trailing \n\n separator prevents "sticking" to user content)
    for (let i = budgetedBefore.length - 1; i >= 0; i--) {
      const blocks = injectionToBlocks(budgetedBefore[i]);
      // Add trailing separator to last block
      const lastBlock = blocks[blocks.length - 1];
      if (lastBlock?.type === 'text' && lastBlock.text) {
        lastBlock.text = lastBlock.text + '\n\n';
      }
      activeBranch.contentBlocks.unshift(...blocks);
    }

    // afterUser: push (leading \n\n separator)
    for (const inj of budgetedAfter) {
      const blocks = injectionToBlocks(inj);
      // Add leading separator to first block
      const firstBlock = blocks[0];
      if (firstBlock?.type === 'text' && firstBlock.text) {
        firstBlock.text = '\n\n' + firstBlock.text;
      }
      activeBranch.contentBlocks.push(...blocks);
    }
  } else {
    // String-only path: modify content directly (images downgraded to text)
    let content = activeBranch.content || '';

    // beforeUser: prepend
    for (let i = budgetedBefore.length - 1; i >= 0; i--) {
      content = `${injectionToString(budgetedBefore[i])}\n\n${content}`;
    }

    // afterUser: append
    for (const inj of budgetedAfter) {
      content = `${content}\n\n${injectionToString(inj)}`;
    }

    activeBranch.content = content;
  }

  // Replace message in array (historyMessages is const but array elements are mutable)
  historyMessages[lastUserIdx] = { ...originalMsg, branches: clonedBranches };
}

/**
 * Truncate messages to fit within the model's context window when persona context is present.
 * The persona context is a fixed block injected into every API call, so conversation messages
 * must fit in whatever space remains. Without persona context, returns messages unchanged.
 */
function truncateForPersonaBudget(
  messages: any[],
  personaContext: string | undefined,
  systemPrompt: string,
  maxOutputTokens: number,
  contextWindow: number,
  participantName: string
): any[] {
  if (!personaContext || !personaContext.trim()) return messages;

  const estimateTokens = (text: string) => Math.ceil(text.length / 4);
  const personaTokens = estimateTokens(personaContext);
  const systemTokens = estimateTokens(systemPrompt);
  const outputTokens = maxOutputTokens || 8192;
  const safetyBuffer = 2000;
  const available = contextWindow - personaTokens - systemTokens - outputTokens - safetyBuffer;

  console.log(`[PersonaContext] Budget for ${participantName}: contextWindow=${contextWindow}, persona=${personaTokens}, system=${systemTokens}, output=${outputTokens}, available=${available}`);

  if (available <= 0) {
    console.warn(`[PersonaContext] WARNING: Persona context (${personaTokens} tokens) exceeds available budget. Sending minimal conversation.`);
    return messages.slice(-3);
  }

  let totalTokens = 0;
  let startIndex = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const branch = msg.branches?.find((b: any) => b.id === msg.activeBranchId) || msg.branches?.[0];
    const msgTokens = estimateTokens(branch?.content || '');
    if (totalTokens + msgTokens > available && startIndex < messages.length) break;
    totalTokens += msgTokens;
    startIndex = i;
  }

  if (startIndex > 0) {
    console.log(`[PersonaContext] Truncating: keeping ${messages.length - startIndex}/${messages.length} messages (${totalTokens} est. tokens)`);
    return messages.slice(startIndex);
  }

  return messages;
}

/**
 * Parameters for running parallel branch inference.
 * This shared utility handles creating multiple branches and running inference on them in parallel.
 */
interface ParallelInferenceParams {
  ws: AuthenticatedWebSocket;
  db: Database;
  inferenceService: EnhancedInferenceService;
  conversation: any; // Conversation object
  targetMessage: Message; // The message to add branches to
  initialBranchId: string; // The first branch ID (already created)
  parentBranchId: string; // Parent branch for all new branches
  samplingBranchCount: number; // Total number of branches to generate
  modelConfig: any; // Model configuration
  model: string; // Model ID
  historyMessages: any[]; // Conversation history for inference
  systemPrompt: string;
  settings: any; // Inference settings
  participants: Participant[];
  responderParticipant?: Participant;
  participantId?: string; // Participant ID for new branches
  userContext: UserContext; // For content filtering
  abortSignal: AbortSignal;
  creationSource: 'inference' | 'regeneration';
  conversationId: string; // For room broadcasts
  toolOptions?: ToolOptions;
  personaContext?: string; // Per-participant persona context to inject
}

/**
 * Run inference on multiple branches in parallel.
 * Creates additional branches if samplingBranchCount > 1, then runs inference on all branches.
 * Records tool snapshot events before inference for audit trail.
 * @returns Array of branch IDs that were generated
 */
async function runParallelBranchInference(params: ParallelInferenceParams): Promise<string[]> {
  const {
    ws,
    db,
    inferenceService,
    conversation,
    targetMessage,
    initialBranchId,
    parentBranchId,
    samplingBranchCount,
    modelConfig,
    model,
    historyMessages,
    systemPrompt,
    settings,
    participants,
    responderParticipant,
    participantId,
    userContext,
    abortSignal,
    creationSource,
    conversationId,
    toolOptions,
    personaContext
  } = params;

  // Record tool snapshot for this inference turn (Phase 2c)
  let effectiveSystemPrompt = systemPrompt;
  if (toolOptions) {
    try {
      const turnId = initialBranchId; // use first branch ID as turn identifier
      const toolsetChangeInfo = await db.recordToolsetForInference(
        conversationId,
        turnId,
        toolOptions.tools,
        toolOptions.snapshotHash
      );

      // Phase 2d: Inject toolset change notification into system prompt
      if (toolsetChangeInfo.changed) {
        const parts: string[] = [];
        if (toolsetChangeInfo.added.length > 0) {
          parts.push(`Added: ${toolsetChangeInfo.added.join(', ')}`);
        }
        if (toolsetChangeInfo.removed.length > 0) {
          parts.push(`Removed: ${toolsetChangeInfo.removed.join(', ')}`);
        }
        const available = toolOptions.tools.map((t: any) => t.name).join(', ');
        const changeNotice = `[System: Tool availability changed. ${parts.join('. ')}. Available: ${available}]`;
        effectiveSystemPrompt = effectiveSystemPrompt
          ? `${effectiveSystemPrompt}\n\n${changeNotice}`
          : changeNotice;
        console.log(`[ParallelInference] Toolset changed for conversation ${conversationId.substring(0, 8)}... +${toolsetChangeInfo.added.length}/-${toolsetChangeInfo.removed.length}`);
      }
    } catch (err) {
      console.error('[ParallelInference] Failed to record toolset snapshot:', err);
    }
  }

  // Phase 4: MCPL beforeInference hooks — collect context injections
  // F9: extract last user message for context hooks
  const lastUserMsg = [...historyMessages].reverse().find((m: any) => m.role === 'user');
  const userMessageText = typeof lastUserMsg?.content === 'string'
    ? lastUserMsg.content
    : Array.isArray(lastUserMsg?.content)
      ? lastUserMsg.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('')
      : undefined;

  const parentContext: InferenceHookContext = {
    conversationId,
    userId: conversation.userId,
    isSubAgent: false,
    // Spec fields (Section 10.1):
    inferenceId: initialBranchId,
    turnIndex: historyMessages.length,
    model: modelConfig ? {
      id: model,
      vendor: modelConfig.provider ?? 'unknown',
      contextWindow: modelConfig.contextWindow ?? 0,
      capabilities: [
        ...(modelConfig.capabilities?.imageInput ? ['vision'] : []),
        ...(modelConfig.capabilities?.audioInput ? ['audio'] : []),
      ],
    } : undefined,
    userMessage: userMessageText,
  };
  try {
    const hookResult = await mcplHookManager.beforeInference(
      conversation.userId,
      conversationId,
      undefined,  // messagesSummary
      0,          // hookDepth: top-level inference (user message or push event)
      parentContext,
    );

    // Gap 3: abort — MCP server can block inference (content moderation, compliance, etc.)
    if (hookResult.abort) {
      const reason = hookResult.abortReason || 'Inference blocked by MCP server';
      console.warn(`[ParallelInference] Inference aborted by ${hookResult.abortDelegateId}: ${reason}`);
      ws.send(JSON.stringify({
        type: 'error',
        error: `Inference blocked: ${reason}`,
      }));
      return [];
    }

    const injections = hookResult.contextInjections;
    if (injections.length > 0) {
      // Place injections by position (already sorted by namespace)
      // F4 fix: normalizeInjectionContent handles McplContentBlock[] (avoids "[object Object]")
      const systemInjections = injections.filter(i => i.position === 'system').map(i => normalizeInjectionContent(i.content));
      if (systemInjections.length > 0) {
        effectiveSystemPrompt = effectiveSystemPrompt
          ? `${effectiveSystemPrompt}\n\n${systemInjections.join('\n')}`
          : systemInjections.join('\n');
      }
      // Fix #1: beforeUser/afterUser — inject into last user message (block-aware)
      // TODO(multi-path): when we add second inference path (e.g., batch/streaming split),
      // move applyInjections() to service layer
      const beforeUserInjections = injections.filter(i => i.position === 'beforeUser');
      const afterUserInjections = injections.filter(i => i.position === 'afterUser');
      if (beforeUserInjections.length > 0 || afterUserInjections.length > 0) {
        applyUserMessageInjections(historyMessages, beforeUserInjections, afterUserInjections, effectiveSystemPrompt, (fallback) => {
          effectiveSystemPrompt = effectiveSystemPrompt
            ? `${effectiveSystemPrompt}\n\n${fallback}`
            : fallback;
        });
      }
      console.log(`[ParallelInference] MCPL injected ${injections.length} context block(s)`);
    }
  } catch (err) {
    console.error('[ParallelInference] MCPL beforeInference error:', err);
  }

  // Track branches to generate
  const branchesToGenerate: { branchId: string; branchContent: string }[] = [
    { branchId: initialBranchId, branchContent: '' }
  ];

  // Create additional branches if sampling multiple responses
  if (samplingBranchCount > 1) {
    for (let i = 1; i < samplingBranchCount; i++) {
      // Add a new branch to the same message
      // Use preserveActiveBranch: true to keep selection on the first branch
      const newBranchMessage = await db.addMessageBranch(
        targetMessage.id,
        targetMessage.conversationId,
        conversation.userId,
        '', // empty content
        'assistant',
        parentBranchId,
        model,
        participantId,
        undefined, // no attachments
        ws.userId,  // user who triggered the generation
        undefined, // hiddenFromAi
        true,      // preserveActiveBranch - keep selection on first branch during parallel gen
        creationSource
      );
      
      if (newBranchMessage) {
        const newBranch = newBranchMessage.branches[newBranchMessage.branches.length - 1];
        branchesToGenerate.push({ branchId: newBranch.id, branchContent: '' });
        
        // Update our local targetMessage with the new branch
        targetMessage.branches.push(newBranch);
        
        // Send branch created notification
        const editEvent = { type: 'message_edited', message: targetMessage };
        ws.send(JSON.stringify(editEvent));
        
        // Broadcast to other users
        roomManager.broadcastToRoom(conversationId, {
          type: 'message_edited',
          message: targetMessage,
          fromUserId: ws.userId
        }, ws);
      }
    }
    
    console.log(`[ParallelInference] Created ${branchesToGenerate.length} branches for parallel sampling`);
  }
  
  // Helper function to safely send WebSocket messages (may fail if user disconnected)
  const safeSend = (data: any) => {
    try {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(data));
      } else {
        // Log when we can't send important messages
        if (data.isComplete) {
          console.warn(`[WebSocket] Could not send isComplete for branch ${data.branchId?.substring(0, 8)}... - connection state: ${ws.readyState}`);
        }
      }
    } catch (e) {
      // Log error with context for important messages
      if (data.isComplete) {
        console.error(`[WebSocket] Error sending isComplete for branch ${data.branchId?.substring(0, 8)}...:`, e);
      }
    }
  };
  
  // Helper function to run inference for a single branch
  const runBranchInference = async (branchId: string, branchIndex: number) => {
    let branchContent = '';
    let lastSavedLength = 0;

    await inferenceService.streamCompletion(
      modelConfig,
      historyMessages,
      effectiveSystemPrompt,
      settings,
      conversation.userId,
      async (chunk: string, isComplete: boolean, contentBlocks?: any[], usage?: any) => {
        // Update branch content
        const prevLen = branchContent.length;
        branchContent += chunk;
        // Debug: log chunk accumulation at key points (first chunk, every 500 chars, completion)
        if (prevLen === 0 && chunk.length > 0) {
          console.log(`[StreamChunk] branchId=${branchId.slice(0,8)} FIRST chunk: "${chunk.slice(0, 80)}"`);
        } else if (Math.floor(branchContent.length / 500) > Math.floor(prevLen / 500)) {
          console.log(`[StreamChunk] branchId=${branchId.slice(0,8)} accumulated ${branchContent.length} chars`);
        }
        
        // Find the branch in our message
        const currentBranch = targetMessage.branches.find((b: any) => b.id === branchId);
        if (currentBranch) {
          currentBranch.content = branchContent;
          
          // Store content blocks if provided
          if (contentBlocks && contentBlocks.length > 0) {
            currentBranch.contentBlocks = contentBlocks;
          }
          
          // Save partial content every ~500 characters to prevent data loss
          if (branchContent.length - lastSavedLength >= 500 || isComplete) {
            await db.updateMessageContent(
              targetMessage.id,
              targetMessage.conversationId,
              conversation.userId,
              branchId,
              branchContent,
              currentBranch.contentBlocks
            );
            lastSavedLength = branchContent.length;
          }
        }
        
        // Handle completion — process content recovery BEFORE sending stream event
        // so the frontend receives the correct content in a single isComplete event.
        if (isComplete) {
          console.log(`[StreamComplete] branchId=${branchId.slice(0,8)} branchContent.length=${branchContent.length} contentBlocksCount=${contentBlocks?.length ?? 0} contentBlockTypes=${contentBlocks?.map((b: any) => b.type).join(',') ?? 'none'}`);
          if (branchContent.length > 0) {
            console.log(`[StreamComplete] branchContent preview: "${branchContent.slice(0, 200)}"`);
          }
          const finalBranch = targetMessage.branches.find((b: any) => b.id === branchId);
          if (finalBranch) {
            // Trim whitespace from final content
            finalBranch.content = branchContent.trim();

            // When Membrane handles tool loops internally, onChunk may not fire for
            // intermediate iterations' text — only index-based contentBlockUpdate fires.
            // If branchContent is empty but contentBlocks has text blocks, extract text
            // from contentBlocks so the message isn't blank in the chat UI.
            if (!finalBranch.content && contentBlocks && contentBlocks.length > 0) {
              const textFromBlocks = contentBlocks
                .filter((b: any) => b.type === 'text' && b.text)
                .map((b: any) => b.text)
                .join('\n\n');
              if (textFromBlocks) {
                console.log(`[StreamComplete] Recovered ${textFromBlocks.length} chars from contentBlocks text blocks (onChunk did not stream text)`);
                finalBranch.content = textFromBlocks.trim();
              }
            }

            branchContent = finalBranch.content;

            // Content filter check for AI output with tiered moderation
            const outputFilterResult = await checkContent(finalBranch.content, userContext);
            if (outputFilterResult.blocked) {
              console.warn(`[Content Filter] AI output blocked for conversation ${conversationId}`);
              finalBranch.content = '[Content filtered]';
              finalBranch.contentBlocks = undefined;
              branchContent = finalBranch.content;
            }

            // Send the isComplete stream event with recovered content (if any).
            // For content recovery: chunk was '' but finalBranch.content has text from contentBlocks.
            // For filtered content: send '[Content filtered]' to replace any streamed content.
            // For normal flow: chunk already has the text, this just sends isComplete.
            const completeData = {
              type: 'stream',
              messageId: targetMessage.id,
              branchId: branchId,
              // Use branchContent (recovered or filtered) as fullContent for the frontend
              // to replace any partial streaming content with the authoritative final version.
              content: chunk,
              fullContent: branchContent,
              contentBlocks: outputFilterResult.blocked ? undefined : contentBlocks,
              isComplete: true,
              ...(outputFilterResult.blocked && { filtered: true }),
              branchIndex
            };
            safeSend(completeData);
            roomManager.broadcastToRoom(conversationId, completeData, ws);

            // Final save
            await db.updateMessageContent(
              targetMessage.id,
              targetMessage.conversationId,
              conversation.userId,
              branchId,
              finalBranch.content,
              finalBranch.contentBlocks
            );
          } else {
            // No finalBranch found — still send stream event
            const streamData = {
              type: 'stream',
              messageId: targetMessage.id,
              branchId: branchId,
              content: chunk,
              contentBlocks: contentBlocks,
              isComplete: true,
              branchIndex
            };
            safeSend(streamData);
            roomManager.broadcastToRoom(conversationId, streamData, ws);
          }
        } else {
          // Non-complete stream update
          const streamData = {
            type: 'stream',
            messageId: targetMessage.id,
            branchId: branchId,
            content: chunk,
            contentBlocks: contentBlocks,
            isComplete: false,
            branchIndex
          };
          safeSend(streamData);
          roomManager.broadcastToRoom(conversationId, streamData, ws);
        }
      },
      conversation,
      responderParticipant,
      async (metrics) => {
        // Store metrics only for first branch to avoid duplicate counting
        if (branchIndex === 0) {
          await db.addMetrics(conversation.id, conversation.userId, metrics);

          // Send metrics update to client
          safeSend({
            type: 'metrics_update',
            conversationId: conversation.id,
            metrics,
            branchIndex
          });
        }
      },
      participants,
      abortSignal,
      toolOptions,
      personaContext
    );
    
    return branchContent;
  };
  
  // Run inference for all branches in parallel
  const branchResults = await Promise.all(
    branchesToGenerate.map((branch, index) => runBranchInference(branch.branchId, index))
  );

  // Phase 4: MCPL afterInference hooks — fire-and-forget notify
  // F9: pass assistantMessage from first branch result
  const afterContext: InferenceHookContext = {
    ...parentContext,
    assistantMessage: branchResults[0] || undefined,
  };
  mcplHookManager.afterInference(conversation.userId, conversationId, undefined, afterContext).catch(err => {
    console.error('[ParallelInference] MCPL afterInference error:', err);
  });

  // Return the branch IDs that were generated
  return branchesToGenerate.map(b => b.branchId);
}

export function websocketHandler(ws: AuthenticatedWebSocket, req: IncomingMessage, db: Database) {
  const url = new URL(req.url || '', `http://${req.headers.host}`);

  // Check if this is a delegate connection (role param is non-sensitive, just routing)
  if (url.searchParams.get('delegate') === 'true' || url.searchParams.get('delegateId') || url.searchParams.get('role') === 'delegate') {
    delegateWebsocketHandler(ws, req, db).catch(err => {
      console.error('[WebSocket] Delegate handler error:', err);
      ws.close(1011, 'Internal error');
    });
    return;
  }

  // Frontend connection — wait for first-message auth (token not in URL)
  const authTimeout = setTimeout(() => {
    ws.send(JSON.stringify({ type: 'error', error: 'Authentication timeout' }));
    ws.close(1008, 'Authentication timeout');
  }, 5000);

  // Also support legacy token-in-URL for backward compat during rollout
  const legacyToken = url.searchParams.get('token');

  ws.once('message', (data) => {
    clearTimeout(authTimeout);
    try {
      const msg = JSON.parse(data.toString());

      let token: string | null = null;
      if (msg.type === 'auth' && msg.token) {
        // New first-message auth
        token = msg.token;
      } else if (legacyToken) {
        // Legacy token-in-URL — process this message as a regular message after auth
        token = legacyToken;
      }

      if (!token) {
        ws.send(JSON.stringify({ type: 'error', error: 'Authentication required' }));
        ws.close(1008, 'Authentication required');
        return;
      }

      const decoded = verifyToken(token);
      if (!decoded) {
        ws.send(JSON.stringify({ type: 'error', error: 'Invalid token' }));
        ws.close(1008, 'Invalid token');
        return;
      }

      ws.userId = decoded.userId;
      ws.isAlive = true;

      // Register this connection with the room manager
      roomManager.registerConnection(ws, decoded.userId);

      // Setup heartbeat
      ws.on('pong', () => {
        ws.isAlive = true;
      });

      // Use MembraneInferenceService for native tool support
      const baseInferenceService = new MembraneInferenceService(db);
      const contextManager = ContextManager.getInstance();
      const inferenceService = new EnhancedInferenceService(baseInferenceService, contextManager);

      // Setup authenticated message handler
      setupAuthenticatedMessageHandler(ws, db, inferenceService, baseInferenceService);

      // If legacy token was used, the first message wasn't auth — process it now
      if (msg.type !== 'auth') {
        ws.emit('message', data);
      }
    } catch (error) {
      ws.send(JSON.stringify({ type: 'error', error: 'Authentication error' }));
      ws.close(1008, 'Authentication error');
    }
  });
}

function setupAuthenticatedMessageHandler(ws: AuthenticatedWebSocket, db: Database, inferenceService: EnhancedInferenceService, baseInferenceService: MembraneInferenceService) {
  ws.on('message', (data) => {
    handleAuthenticatedMessage(ws, db, inferenceService, baseInferenceService, data)
      .catch((err) => {
        console.error('[FATAL] Unhandled error in ws message handler:', err);
      });
  });

  ws.on('close', async () => {
    Logger.websocket(`WebSocket closed for user ${ws.userId}`);

    // Unregister from room manager (removes from all rooms)
    roomManager.unregisterConnection(ws);

    // Abort active generations for this user (two-phase delete to avoid iterator invalidation)
    if (ws.userId) {
      // Phase 1: collect matching keys
      const keysToAbort: string[] = [];
      for (const key of activeGenerations.keys()) {
        if (key.startsWith(`${ws.userId}:`)) {
          keysToAbort.push(key);
        }
      }
      // Phase 2: abort + delete
      for (const key of keysToAbort) {
        const gen = activeGenerations.get(key);
        if (gen) gen.controller.abort();
        activeGenerations.delete(key);
      }
      if (keysToAbort.length > 0) {
        Logger.websocket(`Cleaned up ${keysToAbort.length} active generation(s) for ${ws.userId}`);
      }
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });

  // Send initial connection success
  ws.send(JSON.stringify({ type: 'connected', userId: ws.userId }));
}

async function handleAuthenticatedMessage(ws: AuthenticatedWebSocket, db: Database, inferenceService: EnhancedInferenceService, baseInferenceService: MembraneInferenceService, data: unknown) {
    try {
      const raw = JSON.parse((data as Buffer).toString());

      // Handle MCPL messages (not part of WsMessageSchema)
      // M6: Intentional: Delegates bypass frozen gate.
      // Delegate WS messages (tool manifests, push events, tool responses) serve the parent
      // conversation's MCP servers. They must flow freely even when parent chat is frozen.
      // Note: Sub-agents CAN access delegate MCP tools through ToolRegistry.executeTool() —
      // delegate tools are registered in ToolRegistry via registerDelegateTools() in
      // delegate-handler.ts. This is by design (unified tool architecture).
      // Known MVP limitations for delegate tools in sub-agents:
      //   - No per-server queue (concurrent sub-agents may overload delegate)
      //   - No resource locking between parent and sub-agents
      //   - No abort propagation to delegate on sub-agent cancel
      if (raw.type === 'mcpl/pause_queue' && raw.conversationId && ws.userId) {
        // WS-5: Verify user has access to this conversation
        const conv = await db.getConversation(raw.conversationId as string, ws.userId);
        if (!conv) return;
        mcplEventQueue.pause(raw.conversationId);
        return;
      }
      if (raw.type === 'mcpl/resume_queue' && raw.conversationId && ws.userId) {
        // WS-5: Verify user has access to this conversation
        const conv = await db.getConversation(raw.conversationId as string, ws.userId);
        if (!conv) return;
        mcplEventQueue.resume(raw.conversationId);
        return;
      }
      if ((raw.type === 'mcpl/scope_change_approved' || raw.type === 'mcpl/scope_change_denied') && raw.requestId && ws.userId) {
        resolveScopeChange(
          raw.requestId as string,
          raw.type === 'mcpl/scope_change_approved',
          db,
          raw.type === 'mcpl/scope_change_approved' ? (raw.newCapabilities as string[] | undefined) : undefined,
        );
        return;
      }
      if ((raw.type === 'mcpl/scope_elevate_approved' || raw.type === 'mcpl/scope_elevate_denied') && raw.requestId && ws.userId) {
        resolveScopeElevate(
          raw.requestId as string,
          raw.type === 'mcpl/scope_elevate_approved',
          raw.remember as boolean | undefined,
          db,
        );
        return;
      }

      const message = WsMessageSchema.parse(raw);

      if (!ws.userId) {
        ws.send(JSON.stringify({ type: 'error', error: 'Not authenticated' }));
        return;
      }

      switch (message.type) {
        case 'chat':
          await handleChatMessage(ws, message, db, inferenceService, baseInferenceService);
          break;
          
        case 'regenerate':
          await handleRegenerate(ws, message, db, inferenceService, baseInferenceService);
          break;
          
        case 'edit':
          await handleEdit(ws, message, db, inferenceService, baseInferenceService);
          break;
          
        case 'delete':
          await handleDelete(ws, message, db);
          break;
          
        case 'continue':
          await handleContinue(ws, message, db, inferenceService, baseInferenceService);
          break;
          
        case 'abort':
          handleAbort(ws, message);
          break;
        
        case 'join_room':
          handleJoinRoom(ws, message);
          break;
        
        case 'leave_room':
          handleLeaveRoom(ws, message);
          break;
        
        case 'typing':
          handleTyping(ws, message, db);
          break;
        
        case 'ping':
          // Client-side keep-alive ping - respond with pong to confirm connection is alive
          // This is separate from WebSocket protocol-level ping/pong
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
          break;

        case 'checkpoint_list': {
          if (!ws.userId) { ws.close(1008, 'unauthorized'); break; }
          const msg = message as Extract<WsMessage, { type: 'checkpoint_list' }>;
          const convId = msg.conversationId;
          const reqId = msg.requestId;

          // Access check — same pattern as chat/regenerate/edit handlers
          const conversation = await db.getConversation(convId, ws.userId);
          if (!conversation) {
            ws.send(JSON.stringify({
              type: 'checkpoint_list_response',
              conversationId: convId,
              current: '',
              checkpoints: [],
              error: 'conversation_access_denied',
              ...(reqId && { requestId: reqId }),
            }));
            break;
          }

          // H8+L2: featureSet from message, or '' for legacy client requests
          const result = mcplStateManager.getCheckpoints((data as any).featureSet || '', convId);
          ws.send(JSON.stringify({
            type: 'checkpoint_list_response',
            conversationId: convId,
            current: result?.current ?? '',
            checkpoints: result?.checkpoints ?? [],
            ...(reqId && { requestId: reqId }),
          }));
          break;
        }

        case 'checkpoint_rollback': {
          if (!ws.userId) { ws.close(1008, 'unauthorized'); break; }
          const msg = message as Extract<WsMessage, { type: 'checkpoint_rollback' }>;
          const convId = msg.conversationId;
          const targetId = msg.checkpointId;
          const reqId = msg.requestId;

          // Access check — don't reveal conversation existence
          const conversation = await db.getConversation(convId, ws.userId);
          if (!conversation) {
            ws.send(JSON.stringify({
              type: 'checkpoint_rollback_response',
              conversationId: convId,
              success: false,
              error: 'conversation_access_denied',
              ...(reqId && { requestId: reqId }),
            }));
            break;
          }

          // Write-permission check — viewers cannot rollback (same pattern as chat/edit/regenerate)
          const canChat = await db.canUserChatInConversation(convId, ws.userId);
          if (!canChat) {
            ws.send(JSON.stringify({
              type: 'checkpoint_rollback_response',
              conversationId: convId,
              success: false,
              error: 'conversation_access_denied',
              ...(reqId && { requestId: reqId }),
            }));
            break;
          }

          // Atomic can+commit — eliminates TOCTOU between canRollback/commitRollback
          // H8+L2: featureSet from message, or '' for legacy client rollbacks
          const rollbackResult = mcplStateManager.tryRollback((data as any).featureSet || '', convId, targetId);

          if (!rollbackResult.success) {
            const errorMap: Record<string, string> = {
              'expired': 'checkpoint_expired',
              'unknown': 'checkpoint_unknown',
              'no_checkpoints': 'no_checkpoints',
              'rollback_failed': 'rollback_failed',
            };
            ws.send(JSON.stringify({
              type: 'checkpoint_rollback_response',
              conversationId: convId,
              success: false,
              error: errorMap[rollbackResult.error] ?? 'rollback_failed',
              ...(reqId && { requestId: reqId }),
            }));
            break;
          }

          ws.send(JSON.stringify({
            type: 'checkpoint_rollback_response',
            conversationId: convId,
            success: true,
            checkpointId: rollbackResult.checkpointId,
            ...(reqId && { requestId: reqId }),
          }));

          // Broadcast to room so other tabs/users update
          roomManager.broadcastToRoom(convId, {
            type: 'checkpoint_rolled_back',
            conversationId: convId,
            checkpointId: rollbackResult.checkpointId,
          }, ws); // exclude sender (they already handle via response)
          break;
        }

        case 'checkpoint_timeline': {
          if (!ws.userId) { ws.close(1008, 'unauthorized'); break; }
          const msg = message as Extract<WsMessage, { type: 'checkpoint_timeline' }>;
          const convId = msg.conversationId;
          const reqId = msg.requestId;

          // Read-only: getConversation (not canUserChatInConversation). Viewers can see timeline.
          const conversation = await db.getConversation(convId, ws.userId);
          if (!conversation) {
            ws.send(JSON.stringify({
              type: 'checkpoint_timeline_response',
              conversationId: convId,
              events: [],
              error: 'conversation_access_denied',
              ...(reqId && { requestId: reqId }),
            }));
            break;
          }

          // Pass conversation.userId (owner) since events live in owner's userEventStore
          const events = await db.getCheckpointTimelineEvents(convId, conversation.userId);
          ws.send(JSON.stringify({
            type: 'checkpoint_timeline_response',
            conversationId: convId,
            events,
            ...(reqId && { requestId: reqId }),
          }));
          break;
        }

        case 'checkpoint_state_at': {
          if (!ws.userId) { ws.close(1008, 'unauthorized'); break; }
          const stateAtMsg = message as Extract<WsMessage, { type: 'checkpoint_state_at' }>;
          const stateAtConvId = stateAtMsg.conversationId;
          const stateAtCheckpointId = stateAtMsg.checkpointId;
          const stateAtReqId = stateAtMsg.requestId;

          const stateAtConv = await db.getConversation(stateAtConvId, ws.userId);
          if (!stateAtConv) {
            ws.send(JSON.stringify({
              type: 'checkpoint_state_at_response',
              conversationId: stateAtConvId,
              error: 'conversation_access_denied',
              ...(stateAtReqId && { requestId: stateAtReqId }),
            }));
            break;
          }

          const stateResult = mcplStateManager.getStateAtCheckpoint(
            stateAtMsg.featureSet || '', stateAtConvId, stateAtCheckpointId,
          );
          ws.send(JSON.stringify({
            type: 'checkpoint_state_at_response',
            conversationId: stateAtConvId,
            checkpointId: stateAtCheckpointId,
            ...stateResult,
            ...(stateAtReqId && { requestId: stateAtReqId }),
          }));
          break;
        }

        // Sub-agent UI handlers
        case 'subtask_get_state': {
          if (!ws.userId) { ws.close(1008, 'unauthorized'); break; }
          const stateMsg = message as Extract<WsMessage, { type: 'subtask_get_state' }>;
          // BUG#4: Verify user has access to this conversation before returning state
          const stateConv = await db.getConversation(stateMsg.conversationId, ws.userId);
          if (!stateConv) {
            ws.send(JSON.stringify({
              type: 'subtask_state_snapshot',
              conversationId: stateMsg.conversationId,
              active: false, groupId: null, tasks: [], finalized: false, hasResults: false, queuedText: null,
            }));
            break;
          }
          if (_subAgentManager) {
            const snapshot = _subAgentManager.getStateSnapshot(stateMsg.conversationId, ws.userId);
            ws.send(JSON.stringify({
              type: 'subtask_state_snapshot',
              conversationId: stateMsg.conversationId,
              ...snapshot,
            }));
          } else {
            ws.send(JSON.stringify({
              type: 'subtask_state_snapshot',
              conversationId: stateMsg.conversationId,
              active: false,
              groupId: null,
              tasks: [],
              finalized: false,
              hasResults: false,
              queuedText: null,
            }));
          }
          break;
        }

        case 'subtask_release_queued': {
          if (!ws.userId) { ws.close(1008, 'unauthorized'); break; }
          const releaseMsg = message as Extract<WsMessage, { type: 'subtask_release_queued' }>;
          const convId = releaseMsg.conversationId;

          if (!_subAgentManager) {
            ws.send(JSON.stringify({
              type: 'subtask_queue_action_result',
              conversationId: convId,
              action: 'release',
              status: 'no_queued',
              message: 'Sub-agent system not available',
            }));
            break;
          }

          // Check if still frozen
          const blockingGroup = _subAgentManager.getBlockingGroupId(convId);
          if (blockingGroup) {
            ws.send(JSON.stringify({
              type: 'subtask_queue_action_result',
              conversationId: convId,
              action: 'release',
              status: 'still_running',
              message: 'Sub-agents are still active. Wait for finalization.',
            }));
            break;
          }

          const released = _subAgentManager.releaseQueuedMessage(convId, ws.userId);
          if (!released) {
            ws.send(JSON.stringify({
              type: 'subtask_queue_action_result',
              conversationId: convId,
              action: 'release',
              status: 'no_queued',
              message: 'No queued message found',
            }));
            break;
          }

          // Persist release event
          db.appendSubAgentEvent(convId, 'queued_user_turn_released', {
            conversationId: convId,
            userId: ws.userId,
            messageId: released.messageId,
            timestamp: Date.now(),
          }, ws.userId).catch(err =>
            console.error(`[Handler] Failed to persist queued_user_turn_released: ${err.message}`)
          );

          // Send ack
          ws.send(JSON.stringify({
            type: 'subtask_queue_action_result',
            conversationId: convId,
            action: 'release',
            status: 'ok',
          }));

          // Process the released message as a normal chat message
          // Re-invoke handleChatMessage with the queued text
          const syntheticMsg = {
            type: 'chat' as const,
            conversationId: convId,
            content: released.text,
          };
          handleChatMessage(ws, syntheticMsg as any, db, inferenceService, baseInferenceService).catch(err =>
            console.error(`[Handler] Failed to process released queued message: ${err.message}`)
          );
          break;
        }

        case 'subtask_discard_queued': {
          if (!ws.userId) { ws.close(1008, 'unauthorized'); break; }
          const discardMsg = message as Extract<WsMessage, { type: 'subtask_discard_queued' }>;
          const discardConvId = discardMsg.conversationId;

          if (!_subAgentManager) {
            ws.send(JSON.stringify({
              type: 'subtask_queue_action_result',
              conversationId: discardConvId,
              action: 'discard',
              status: 'no_queued',
              message: 'Sub-agent system not available',
            }));
            break;
          }

          const existing = _subAgentManager.getQueuedMessage(discardConvId, ws.userId);
          if (!existing) {
            ws.send(JSON.stringify({
              type: 'subtask_queue_action_result',
              conversationId: discardConvId,
              action: 'discard',
              status: 'no_queued',
              message: 'No queued message found',
            }));
            break;
          }

          _subAgentManager.cancelQueuedMessage(discardConvId, ws.userId);

          // Persist cancel event
          db.appendSubAgentEvent(discardConvId, 'queued_user_turn_cancelled', {
            conversationId: discardConvId,
            userId: ws.userId,
            messageId: existing.messageId,
            timestamp: Date.now(),
          }, ws.userId).catch(err =>
            console.error(`[Handler] Failed to persist queued_user_turn_cancelled: ${err.message}`)
          );

          ws.send(JSON.stringify({
            type: 'subtask_queue_action_result',
            conversationId: discardConvId,
            action: 'discard',
            status: 'ok',
          }));
          break;
        }

        case 'subtask_get_results': {
          if (!ws.userId) { ws.close(1008, 'unauthorized'); break; }
          const resultsMsg = message as Extract<WsMessage, { type: 'subtask_get_results' }>;
          if (!_subAgentManager) {
            ws.send(JSON.stringify({
              type: 'subtask_results_snapshot',
              groupId: resultsMsg.groupId,
              status: 'not_found',
              results: [],
            }));
            break;
          }

          const { found, results: taskResults, conversationId: resultConvId } =
            await _subAgentManager.getSubtaskResultsWithMeta(resultsMsg.groupId);

          // Access control: verify user has access to this conversation
          if (resultConvId) {
            const conv = await db.getConversation(resultConvId, ws.userId);
            if (!conv) {
              ws.send(JSON.stringify({
                type: 'subtask_results_snapshot',
                groupId: resultsMsg.groupId,
                status: 'not_found',
                results: [],
              }));
              break;
            }
          }

          ws.send(JSON.stringify({
            type: 'subtask_results_snapshot',
            groupId: resultsMsg.groupId,
            status: found ? 'ok' : 'not_found',
            results: taskResults.map(r => ({
              taskId: r.taskId,
              instruction: r.instruction,
              state: r.state,
              result: r.result?.slice(0, 4000) ?? null,
              resultTruncated: (r.result?.length ?? 0) > 4000,
              error: r.error,
              metrics: r.metrics,
            })),
          }));
          break;
        }

        default:
          ws.send(JSON.stringify({ type: 'error', error: 'Unknown message type' }));
      }
    } catch (error) {
      console.error('WebSocket message error:', error);
      safeSend(ws, {
        type: 'error',
        error: error instanceof Error ? error.message : 'Internal server error'
      });
    }
}

function handleAbort(
  ws: AuthenticatedWebSocket,
  message: { type: 'abort'; conversationId: string }
) {
  if (!ws.userId) return;
  
  const aborted = abortGeneration(ws.userId, message.conversationId);
  console.log(`[Abort] User ${ws.userId} aborted generation for conversation ${message.conversationId}: ${aborted ? 'success' : 'no active generation'}`);
  
  ws.send(JSON.stringify({
    type: 'generation_aborted',
    conversationId: message.conversationId,
    success: aborted
  }));
}

// Multi-user room handlers
function handleJoinRoom(
  ws: AuthenticatedWebSocket,
  message: { type: 'join_room'; conversationId: string }
) {
  if (!ws.userId) return;
  
  roomManager.joinRoom(message.conversationId, ws);
  
  // Send back room state
  ws.send(JSON.stringify({
    type: 'room_joined',
    conversationId: message.conversationId,
    activeUsers: roomManager.getActiveUsers(message.conversationId),
    activeAiRequest: roomManager.getActiveAiRequest(message.conversationId)
  }));
}

function handleLeaveRoom(
  ws: AuthenticatedWebSocket,
  message: { type: 'leave_room'; conversationId: string }
) {
  if (!ws.userId) return;
  
  roomManager.leaveRoom(message.conversationId, ws);
  
  ws.send(JSON.stringify({
    type: 'room_left',
    conversationId: message.conversationId
  }));
}

async function handleTyping(
  ws: AuthenticatedWebSocket,
  message: { type: 'typing'; conversationId: string; isTyping: boolean },
  db: Database
) {
  if (!ws.userId) return;
  
  // Get user info for display
  const user = await db.getUserById(ws.userId);
  const userDisplayName = user?.email?.split('@')[0] || 'Someone'; // Use username part of email
  
  // Broadcast typing status to others in the room
  roomManager.broadcastToRoom(message.conversationId, {
    type: 'user_typing',
    conversationId: message.conversationId,
    userId: ws.userId,
    userName: userDisplayName,
    isTyping: message.isTyping
  }, ws); // Exclude sender
}

async function handleChatMessage(
  ws: AuthenticatedWebSocket,
  message: Extract<WsMessage, { type: 'chat' }>,
  db: Database,
  inferenceService: EnhancedInferenceService,
  baseInferenceService: InferenceService
) {
  if (!ws.userId) return;

  // Verify conversation access and chat permission
  const conversation = await db.getConversation(message.conversationId, ws.userId);
  if (!conversation) {
    ws.send(JSON.stringify({ type: 'error', error: 'Conversation not found or access denied' }));
    return;
  }
  
  // Check if user can chat (owner or collaborator/editor)
  const canChat = await db.canUserChatInConversation(message.conversationId, ws.userId);
  if (!canChat) {
    ws.send(JSON.stringify({ type: 'error', error: 'You do not have permission to send messages in this conversation' }));
    return;
  }

  // Frozen parent gate: block new messages while sub-agents are active
  if (_subAgentManager) {
    const blockingGroupId = _subAgentManager.getBlockingGroupId(message.conversationId);
    if (blockingGroupId) {
      // Check if user already has a queued message (idempotent — resend same event)
      const existing = _subAgentManager.getQueuedMessage(message.conversationId, ws.userId);
      if (existing) {
        ws.send(JSON.stringify({
          type: 'subtask_queue_blocked',
          conversationId: message.conversationId,
          groupId: existing.groupId,
          queuedText: existing.text,
        }));
        return;
      }
      // Queue user message (per-user, per-conversation)
      // BUG 2: Single messageId for both in-memory and persisted event
      const queuedMessageId = uuidv4();
      // BUG#3: Preserve attachments so they aren't lost when message is queued
      const queuedAttachments = message.attachments?.map((att: any) => ({
        type: att.fileType ?? att.type ?? 'unknown',
        data: { fileName: att.fileName, fileType: att.fileType, content: att.content },
      }));
      _subAgentManager.queueUserMessage({
        messageId: queuedMessageId,
        conversationId: message.conversationId,
        userId: ws.userId,
        text: message.content,
        ...(queuedAttachments?.length ? { attachments: queuedAttachments } : {}),
        createdAt: Date.now(),
        groupId: blockingGroupId,
      });
      // Persist to JSONL
      db.appendSubAgentEvent(message.conversationId, 'queued_user_turn', {
        messageId: queuedMessageId,
        conversationId: message.conversationId,
        userId: ws.userId,
        text: message.content,
        ...(queuedAttachments?.length ? { attachments: queuedAttachments } : {}),
        createdAt: Date.now(),
        groupId: blockingGroupId,
      }, ws.userId).catch(err =>
        console.error(`[Handler] Failed to persist queued_user_turn: ${err.message}`)
      );
      ws.send(JSON.stringify({
        type: 'subtask_queue_blocked',
        conversationId: message.conversationId,
        groupId: blockingGroupId,
        queuedText: message.content,
      }));
      return;
    }
  }

  // Content filter check with tiered moderation
  const isResearcher = await db.userHasActiveGrantCapability(ws.userId, 'researcher');
  const isAgeVerified = await db.isUserAgeVerified(ws.userId);
  const isAdmin = await db.userHasActiveGrantCapability(ws.userId, 'admin');
  const userContext: UserContext = { isResearcher, isAgeVerified, isAdmin };
  
  // Always check content - the filter applies tiered logic based on user context
  const filterResult = await checkContent(message.content, userContext);
  if (filterResult.blocked) {
    ws.send(JSON.stringify({ 
      type: 'content_blocked',
      reason: filterResult.reason || 'Message blocked by content filter',
      categories: filterResult.categories
    }));
    return;
  }

  // Create user message with specified parent if provided
  Logger.debug('Creating user message with parentBranchId:', message.parentBranchId);
  Logger.debug('Received attachments:', message.attachments?.length || 0);
  Logger.debug('Message object keys:', Object.keys(message));
  
  // Process attachments if provided
  const attachments = message.attachments?.map(att => ({
    fileName: att.fileName,
    fileType: att.fileType,
    content: att.content,
    fileSize: att.content.length
  }));
  
  if (attachments && attachments.length > 0) {
    Logger.debug('Processing attachments:', attachments.map(a => ({ fileName: a.fileName, size: a.fileSize })));
  }
  
  // Check if we should add to an existing message or create a new one
  let userMessage: any;
  
  if (message.parentBranchId) {
    // Check if this parent branch has siblings (i.e., we're branching from within history)
    const allMessages = await db.getConversationMessages(message.conversationId, conversation.userId);
    const messageWithSiblings = allMessages.find(msg => 
      msg.branches.some(b => b.parentBranchId === message.parentBranchId)
    );
    
    if (messageWithSiblings) {
      // Add as a new branch to the existing message that contains siblings
      Logger.debug('Adding branch to existing message:', messageWithSiblings.id);
      userMessage = await db.addMessageBranch(
        messageWithSiblings.id,
        messageWithSiblings.conversationId,
        conversation.userId,
        message.content,
        'user',
        message.parentBranchId,
        undefined, // model
        message.participantId,
        attachments,
        ws.userId, // sentByUserId - actual user who sent this
        message.hiddenFromAi, // whether message is hidden from AI
        false,     // preserveActiveBranch - select this new branch
        'human_edit' // creationSource - user messages are human-authored
      );
    } else {
      // No siblings exist yet, create a new message
      Logger.debug('Creating new message (no siblings found)');
      userMessage = await db.createMessage(
        message.conversationId,
        conversation.userId,
        message.content,
        'user',
        undefined, // model
        message.parentBranchId,
        message.participantId,
        attachments,
        ws.userId, // sentByUserId - actual user who sent this
        message.hiddenFromAi, // whether message is hidden from AI
        'human_edit' // creationSource - user messages are human-authored
      );
    }
  } else {
    // No parent specified, create new message as usual
    userMessage = await db.createMessage(
      message.conversationId,
      conversation.userId,
      message.content,
      'user',
      undefined, // model
      message.parentBranchId,
      message.participantId,
      attachments,
      ws.userId, // sentByUserId - actual user who sent this
      message.hiddenFromAi, // whether message is hidden from AI
      'human_edit' // creationSource - user messages are human-authored
    );
  }
  
  Logger.debug('Created/updated user message:', userMessage.id, 'with branch:', userMessage.branches[userMessage.branches.length - 1]?.id);
  Logger.debug('User message has attachments?', userMessage.branches[userMessage.branches.length - 1]?.attachments?.length || 0);

  // Send confirmation to sender
  ws.send(JSON.stringify({
    type: 'message_created',
    message: userMessage
  }));
  
  // Broadcast user message to all other users in the room
  roomManager.broadcastToRoom(message.conversationId, {
    type: 'message_created',
    message: userMessage,
    fromUserId: ws.userId
  }, ws); // Exclude sender

  // If message is hidden from AI, don't trigger AI generation
  if (message.hiddenFromAi) {
    console.log('[Chat] Message is hidden from AI, skipping AI generation');
    return;
  }
  
  // Get sampling branches count (default 1)
  const samplingBranchCount = Math.min((message as any).samplingBranches || conversation.settings?.samplingBranches || 1, 10);
  if (samplingBranchCount > 1) {
    console.log(`[Chat] Sampling ${samplingBranchCount} response branches in parallel`);
  }

  // Get participants for the conversation
  const participants = await db.getConversationParticipants(message.conversationId, conversation.userId);
  
  // Handle response generation based on conversation format
  let responder: typeof participants[0] | undefined;
  
  if (conversation.format === 'standard') {
    // For standard format, use the assistant participant (there should only be one)
    responder = participants.find(p => p.type === 'assistant');
    if (!responder) {
      ws.send(JSON.stringify({ type: 'error', error: 'No assistant participant found' }));
      return;
    }
  } else {
    // For other formats, check if a responder was specified
    if (!message.responderId) {
      // No responder selected, just return
      return;
    }
    
    responder = participants.find(p => p.id === message.responderId);
    if (!responder || responder.type !== 'assistant') {
      ws.send(JSON.stringify({ type: 'error', error: 'Invalid responder' }));
      return;
    }
  }

  const inferenceModel = responder.model || conversation.model;

  if (!(await userHasSufficientCredits(db, conversation.userId, inferenceModel))) {
    sendInsufficientCreditsError(ws);
    return;
  }
  
  // Check if there's already an active AI request for this conversation
  const existingAiRequest = roomManager.getActiveAiRequest(message.conversationId);
  if (existingAiRequest) {
    console.log(`[Chat] AI already generating for conversation ${message.conversationId} (requested by ${existingAiRequest.userId}), skipping new request`);
    ws.send(JSON.stringify({
      type: 'ai_request_queued',
      conversationId: message.conversationId,
      reason: 'AI is already generating a response',
      requestedBy: existingAiRequest.userId
    }));
    return;
  }

  // Create assistant message placeholder with correct parent
  const userBranch = userMessage.branches[userMessage.branches.length - 1]; // Get the last branch (the one we just added)
  
  // Check if we should add to an existing message or create a new one
  let assistantMessage: Message | null;
  const allMessagesForAssistant = await db.getConversationMessages(message.conversationId, conversation.userId);
  const messageWithAssistantSiblings = allMessagesForAssistant.find(msg => 
    msg.branches.some(b => b.parentBranchId === userBranch?.id)
  );
  
  if (messageWithAssistantSiblings) {
    // Add as a new branch to the existing message
    console.log('Adding assistant branch to existing message:', messageWithAssistantSiblings.id);
    assistantMessage = await db.addMessageBranch(
      messageWithAssistantSiblings.id,
      messageWithAssistantSiblings.conversationId,
      conversation.userId,
      '',
      'assistant',
      userBranch?.id,
      responder.model || conversation.model,
      responder.id,
      undefined, // no attachments for assistant
      ws.userId, // user who triggered the generation
      undefined, // hiddenFromAi
      false,     // preserveActiveBranch - select this new branch
      'inference' // creationSource - AI generated
    );
  } else {
    // No siblings exist yet, create a new message
    assistantMessage = await db.createMessage(
      message.conversationId,
      conversation.userId,
      '',
      'assistant',
      responder.model || conversation.model,
      userBranch?.id,
      responder.id,
      undefined, // no attachments for assistant
      ws.userId, // user who triggered the generation
      undefined, // hiddenFromAi
      'inference' // creationSource - AI generated
    );
  }
  
  if (!assistantMessage) {
    console.error('Failed to create assistant message');
    ws.send(JSON.stringify({
      type: 'error',
      error: 'Failed to create assistant message'
    }));
    return;
  }
  
  const assistantBranch = assistantMessage.branches[assistantMessage.branches.length - 1]; // Get the last branch we added
  Logger.debug('Created/updated assistant message:', assistantMessage.id, 'with branch:', assistantBranch?.id);

  // Send assistant message to frontend
  ws.send(JSON.stringify({
    type: 'message_created',
    message: assistantMessage
  }));
  
  // Broadcast assistant message placeholder to other users
  roomManager.broadcastToRoom(message.conversationId, {
    type: 'message_created',
    message: assistantMessage,
    fromUserId: ws.userId
  }, ws);

  // Get conversation history using the utility function
  const allMessages = await db.getConversationMessages(message.conversationId, conversation.userId);
  
  // Build history from the parent branch and add the new user message
  const visibleHistory = buildConversationHistory(allMessages, message.parentBranchId);
  if (!visibleHistory.some(m => m.id === userMessage.id)) {
    visibleHistory.push(userMessage);
  }
  console.log('Final visible history length:', visibleHistory.length);
  
  // Filter out messages marked as hidden from AI (keep them in history for UI, but don't send to AI)
  const filteredHistory = filterHiddenFromAiMessages(visibleHistory);
  console.log('Filtered history length (excluding hiddenFromAi):', filteredHistory.length);
  
  // For prefill format, we need to include the empty assistant message too
  // so that formatMessagesForConversation knows to append the assistant's name
  const messagesForInference = conversation.format === 'prefill' 
    ? [...filteredHistory, assistantMessage]
    : filteredHistory;
  
  // Stream response from appropriate service
  try {
    Logger.websocket(`[WebSocket] Responder:`, JSON.stringify(responder, null, 2));
    Logger.websocket(`[WebSocket] Conversation model: "${conversation.model}"`);
    Logger.websocket(`[WebSocket] Determined inferenceModel: "${inferenceModel}"`);
    
    let inferenceSystemPrompt = responder.systemPrompt || conversation.systemPrompt;
    
    // For standard conversations, always use conversation settings
    // For prefill/group chat, merge participant and conversation settings
    const inferenceSettings = conversation.format === 'standard' 
      ? conversation.settings
      : {
          temperature: responder.settings?.temperature ?? conversation.settings.temperature,
          maxTokens: responder.settings?.maxTokens ?? conversation.settings.maxTokens,
          topP: responder.settings?.topP ?? conversation.settings.topP,
          topK: responder.settings?.topK ?? conversation.settings.topK,
          // Use participant thinking settings if defined, otherwise fall back to conversation
          thinking: responder.settings?.thinking ?? conversation.settings.thinking,
          // Include model-specific settings (e.g., image resolution)
          modelSpecific: responder.settings?.modelSpecific ?? conversation.settings.modelSpecific
        };
    
    // Debug: Log the settings being used
    Logger.websocket('[WebSocket] Conversation settings:', JSON.stringify(conversation.settings, null, 2));
    Logger.websocket('[WebSocket] Responder settings:', JSON.stringify(responder.settings, null, 2));
    Logger.websocket('[WebSocket] Final inference settings:', JSON.stringify(inferenceSettings, null, 2));
    
    // Log WebSocket event
    await llmLogger.logWebSocketEvent({
      event: 'chat_message',
      conversationId: conversation.id,
      messageId: message.messageId,
      participantId: message.participantId,
      responderId: responder.id,
      model: inferenceModel,
      settings: inferenceSettings,
      format: conversation.format
    });
    
    const modelLoader = ModelLoader.getInstance();
    const modelConfig = await modelLoader.getModelById(inferenceModel, conversation.userId);
    if (!modelConfig) {
      throw new Error(`Model ${inferenceModel} not found`);
    }
    
    // Validate pricing is configured BEFORE making inference call
    const pricingCheck = await validatePricingAvailable(modelConfig);
    if (!pricingCheck.valid) {
      console.error(`[Chat] Pricing validation failed for model ${inferenceModel}:`, pricingCheck.error);
      ws.send(JSON.stringify({
        type: 'error',
        error: USER_FACING_ERRORS.PRICING_NOT_CONFIGURED.message,
        details: pricingCheck.error
      }));
      // Delete the empty assistant message we created
      await db.deleteMessage(assistantMessage.id, message.conversationId, conversation.userId);
      return;
    }
    
    // Apply backroom prompt for early group chats if conditions are met
    inferenceSystemPrompt = applyBackroomPromptIfNeeded({
      conversationFormat: conversation.format,
      messageCount: filteredHistory.length,
      modelProvider: modelConfig.provider,
      modelSupportsPrefill: modelConfig.supportsPrefill,
      participantConversationMode: responder.conversationMode,
      existingSystemPrompt: inferenceSystemPrompt || '',
      cliModePrompt: conversation.cliModePrompt
    });
    
    // Notify client if replacing an existing generation
    const existingKey = getGenerationKey(conversation.userId, conversation.id);
    if (activeGenerations.has(existingKey)) {
      roomManager.broadcastToRoom(conversation.id, {
        type: 'generation_aborted',
        conversationId: conversation.id,
        reason: 'replaced_by_new_request',
      });
    }

    // Create abort controller for this generation
    const abortController = startGeneration(conversation.userId, conversation.id);

    // Track AI request in room manager for multi-user sync (atomic check-and-set)
    if (!roomManager.startAiRequest(message.conversationId, ws.userId!, assistantMessage.id)) {
      endGeneration(conversation.userId, conversation.id);
      ws.send(JSON.stringify({
        type: 'ai_request_queued',
        conversationId: message.conversationId,
        reason: 'AI is already generating a response',
      }));
      return;
    }

    // Per-participant context budgeting
    const responderPersonaContext = responder.personaContext;
    const truncatedMessages = truncateForPersonaBudget(
      messagesForInference,
      responderPersonaContext,
      inferenceSystemPrompt || '',
      inferenceSettings.maxTokens || 8192,
      modelConfig.contextWindow || 200000,
      responder.name
    );

    let generatedBranchIds: string[];
    try {
      // Run parallel inference using shared utility
      generatedBranchIds = await runParallelBranchInference({
        ws,
        db,
        inferenceService,
        conversation,
        targetMessage: assistantMessage,
        initialBranchId: assistantMessage.activeBranchId,
        parentBranchId: userBranch?.id || 'root',
        samplingBranchCount,
        modelConfig,
        model: responder.model || conversation.model,
        historyMessages: truncatedMessages,
        systemPrompt: inferenceSystemPrompt || '',
        settings: inferenceSettings,
        participants,
        responderParticipant: responder,
        participantId: responder.id,
        userContext,
        abortSignal: abortController.signal,
        creationSource: 'inference',
        conversationId: message.conversationId,
        toolOptions: buildToolOptions(conversation.userId, conversation, responder, db),
        personaContext: responderPersonaContext
      });

    // DEBUG CAPTURE: Capture debug data for the first branch after completion
    try {
      const rawRequest = baseInferenceService.lastRawRequest;
      if (rawRequest && generatedBranchIds.length > 0) {
        const firstBranchId = generatedBranchIds[0];
        const branchObj = assistantMessage.branches.find((b: any) => b.id === firstBranchId);
        if (branchObj) {
          console.log(`[DEBUG CAPTURE] Capturing debug data for branch ${firstBranchId.substring(0, 8)}...`);
          
          // Compute actual format used
          const modelSupportsPrefill = modelConfig.supportsPrefill !== false && (modelConfig.provider === 'anthropic' || modelConfig.provider === 'bedrock' || modelConfig.supportsPrefill === true);
          const participantMode = responder.conversationMode;
          const wantsPrefill = !participantMode || participantMode === 'auto' || participantMode === 'prefill';
          const actualFormat = (conversation.format === 'prefill' && modelSupportsPrefill && wantsPrefill) ? 'prefill' : 'messages';
          
          const debugRequest = {
            ...rawRequest,
            provider: modelConfig.provider,
            settings: inferenceSettings,
            conversationFormat: conversation.format,
            participantConversationMode: participantMode || 'auto',
            actualFormatUsed: actualFormat
          };
          
          const debugResponse = {
            content: branchObj.content,
            contentBlocks: branchObj.contentBlocks,
            model: branchObj.model
          };
          
          await db.updateMessageBranch(
            assistantMessage.id,
            conversation.userId,
            firstBranchId,
            { debugRequest, debugResponse }
          );
          
          console.log(`[DEBUG CAPTURE] Debug data saved for branch ${firstBranchId.substring(0, 8)}`);
          
          // Notify frontend
          const updatedMessage = await db.getMessage(assistantMessage.id, conversation.id, conversation.userId);
          if (updatedMessage) {
            ws.send(JSON.stringify({ type: 'message_edited', message: updatedMessage }));
            roomManager.broadcastToRoom(conversation.id, { type: 'message_edited', message: updatedMessage }, ws);
          }
        }
      }
    } catch (debugError) {
      console.error('[DEBUG CAPTURE] Failed to capture debug data:', debugError);
    }

    // Update conversation timestamp after all branches complete
    await db.updateConversation(conversation.id, conversation.userId, { updatedAt: new Date() });

    try {
      const needsTitle = !conversation.title || conversation.title === 'New Conversation';
      
      // Check if this is the first assistant message in the conversation
      // We check filteredHistory length (which is previous messages) + 1 (current user message)
      // If it's small (e.g., just 1 user message), it's the start.
      const isFirstExchange = filteredHistory.length <= 1;


      if (needsTitle && isFirstExchange) {
        const firstUserMessage = filteredHistory.find(m => {
          const activeBranch = m.branches.find(b => b.id === m.activeBranchId);
          return activeBranch?.role === 'user';
        });
        const firstAssistantContent = generatedBranchIds.length > 0 
          ? assistantMessage.branches.find((b: any) => b.id === generatedBranchIds[0])?.content 
          : undefined;
        if (firstUserMessage && firstAssistantContent) {
          // Get the active branch's content, not branches[0]
          const userActiveBranch = firstUserMessage.branches.find(b => b.id === firstUserMessage.activeBranchId);
          const userContent = userActiveBranch?.content?.substring(0, 500) ?? '';
          
          const titlePrompt = `Generate a short, concise title (3-6 words) for this conversation. Output only the title text, no formatting or markdown:\n\nUser: ${userContent}\n\nAssistant: ${firstAssistantContent.substring(0, 500)}`;
          // Use baseInferenceService for a raw, simple call
          // Signature: (modelId, messages, systemPrompt, settings, userId, onChunk, format, ...)
          let generatedTitle = '';
          const tempBranchId = 'temp-branch-' + Date.now();
          const tempMessage: any = {
            id: 'temp-title-msg',
            conversationId: 'temp',
            userId: conversation.userId,
            activeBranchId: tempBranchId,
            branches: [{
              id: tempBranchId,
              content: titlePrompt,
              role: 'user',
              createdAt: new Date(),
              isActive: true,
              parentBranchId: 'root'
            }],
            order: 0
          };

          await baseInferenceService.streamCompletion(
            responder.model || conversation.model,
            [tempMessage],
            'You are a helpful assistant.',
            { temperature: 0.7, maxTokens: 50 },
            conversation.userId,
            async (chunk: string) => {
              generatedTitle += chunk;
            }
          );


          const cleanTitle = generatedTitle.trim()
            .replace(/^#+\s*/, '')           // Remove markdown heading markers
            .replace(/^\*\*(.+)\*\*$/, '$1') // Remove ** only if it wraps the ENTIRE title
            .replace(/^["']|["']$/g, '')     // Remove quotes at start/end
            .substring(0, 60);


          if (cleanTitle) {
            await db.updateConversation(conversation.id, conversation.userId, { title: cleanTitle });
            
            // Notify frontend
            const updatedConv = await db.getConversation(conversation.id, conversation.userId);
            if (updatedConv) {
               ws.send(JSON.stringify({ 
                 type: 'conversation_updated', 
                 id: conversation.id,
                 updates: { 
                   title: cleanTitle,
                   updatedAt: updatedConv.updatedAt
                 }
               }));
            }
          }
        }
      }
    } catch (titleError) {
      console.error('[Auto-title] Failed to generate title:', titleError);
    }
    
    } finally {
      endGeneration(conversation.userId, conversation.id);
      roomManager.endAiRequest(message.conversationId);
    }
  } catch (error) {
    // Note: endGeneration + endAiRequest already called in finally block above

    // Check if this was an abort
    if (error instanceof Error && error.message === 'Generation aborted') {
      console.log(`[Abort] Generation was aborted for conversation ${message.conversationId}`);
      safeSend(ws, {
        type: 'stream',
        messageId: assistantMessage.id,
        branchId: assistantMessage.activeBranchId,
        content: '',
        isComplete: true,
        aborted: true
      });
      return;
    }

    console.error('Inference streaming error:', error);

    // Parse error for user-friendly messages (using centralized error messages)
    const errorMsg = error instanceof Error ? error.message : String(error);
    let friendlyError = USER_FACING_ERRORS.GENERIC_ERROR.message;
    let suggestion = USER_FACING_ERRORS.GENERIC_ERROR.suggestion;
    
    if (errorMsg.includes('Model') && errorMsg.includes('not found')) {
      friendlyError = USER_FACING_ERRORS.MODEL_NOT_FOUND.message;
      suggestion = USER_FACING_ERRORS.MODEL_NOT_FOUND.suggestion;
    } else if (errorMsg.includes('No API key')) {
      friendlyError = USER_FACING_ERRORS.NO_API_KEY.message;
      suggestion = USER_FACING_ERRORS.NO_API_KEY.suggestion;
    } else if (errorMsg.includes('Rate limit') || errorMsg.includes('rate_limit') || errorMsg.includes('429')) {
      friendlyError = USER_FACING_ERRORS.RATE_LIMIT.message;
      suggestion = USER_FACING_ERRORS.RATE_LIMIT.suggestion;
    } else if (errorMsg.includes('usage limit') || errorMsg.includes('API usage limit')) {
      // Extract the specific message from API response
      const jsonMatch = errorMsg.match(/\{.*"message"\s*:\s*"([^"]+)"/);
      friendlyError = jsonMatch ? jsonMatch[1] : 'You have reached your API usage limits.';
      suggestion = 'Check your API provider\'s billing settings to increase your limit.';
    } else if (errorMsg.includes('overloaded') || errorMsg.includes('503')) {
      friendlyError = USER_FACING_ERRORS.OVERLOADED.message;
      suggestion = USER_FACING_ERRORS.OVERLOADED.suggestion;
    } else if (errorMsg.includes('Insufficient credits')) {
      friendlyError = USER_FACING_ERRORS.INSUFFICIENT_CREDITS.message;
      suggestion = USER_FACING_ERRORS.INSUFFICIENT_CREDITS.suggestion;
    } else if (errorMsg.includes('401') || errorMsg.includes('403') || errorMsg.includes('Authentication')) {
      friendlyError = USER_FACING_ERRORS.AUTHENTICATION_FAILED.message;
      suggestion = USER_FACING_ERRORS.AUTHENTICATION_FAILED.suggestion;
    } else if (errorMsg.includes('ECONNREFUSED') || errorMsg.includes('fetch failed')) {
      friendlyError = USER_FACING_ERRORS.CONNECTION_ERROR.message;
      suggestion = USER_FACING_ERRORS.CONNECTION_ERROR.suggestion;
    } else if (errorMsg.includes('context') || errorMsg.includes('too long') || errorMsg.includes('maximum')) {
      friendlyError = USER_FACING_ERRORS.CONTEXT_TOO_LONG.message;
      suggestion = USER_FACING_ERRORS.CONTEXT_TOO_LONG.suggestion;
    } else if (errorMsg.includes('content') && (errorMsg.includes('filter') || errorMsg.includes('flag') || errorMsg.includes('policy'))) {
      friendlyError = USER_FACING_ERRORS.CONTENT_FILTERED.message;
      suggestion = USER_FACING_ERRORS.CONTENT_FILTERED.suggestion;
    } else if (errorMsg.includes('timeout') || errorMsg.includes('ETIMEDOUT')) {
      friendlyError = USER_FACING_ERRORS.REQUEST_TIMEOUT.message;
      suggestion = USER_FACING_ERRORS.REQUEST_TIMEOUT.suggestion;
    } else if (errorMsg.includes('500') || errorMsg.includes('Internal')) {
      friendlyError = USER_FACING_ERRORS.SERVER_ERROR.message;
      suggestion = USER_FACING_ERRORS.SERVER_ERROR.suggestion;
    } else if (errorMsg.includes('404')) {
      friendlyError = USER_FACING_ERRORS.ENDPOINT_NOT_FOUND.message;
      suggestion = USER_FACING_ERRORS.ENDPOINT_NOT_FOUND.suggestion;
    } else if (errorMsg.length < 100) {
      // Short error messages are usually informative, pass them through
      friendlyError = errorMsg;
      suggestion = USER_FACING_ERRORS.GENERIC_ERROR.suggestion;
    }
    
    safeSend(ws, {
      type: 'error',
      error: friendlyError,
      suggestion: suggestion || undefined
    });
  }
}

async function handleRegenerate(
  ws: AuthenticatedWebSocket,
  message: Extract<WsMessage, { type: 'regenerate' }>,
  db: Database,
  inferenceService: EnhancedInferenceService,
  baseInferenceService: InferenceService
) {
  if (!ws.userId) return;

  // First verify conversation access (handles both owner and collaboration)
  const conversation = await db.getConversation(message.conversationId, ws.userId);
  if (!conversation) {
    ws.send(JSON.stringify({ type: 'error', error: 'Conversation not found or access denied' }));
    return;
  }
  
  // Check if user can chat (owner or collaborator/editor)
  const canChat = await db.canUserChatInConversation(message.conversationId, ws.userId);
  if (!canChat) {
    ws.send(JSON.stringify({ type: 'error', error: 'You do not have permission to regenerate in this conversation' }));
    return;
  }

  // Get sampling branches count (default 1)
  const samplingBranchCount = Math.min((message as any).samplingBranches || conversation.settings?.samplingBranches || 1, 10);
  if (samplingBranchCount > 1) {
    console.log(`[Regenerate] Sampling ${samplingBranchCount} response branches in parallel`);
  }

  // Build user context for content filter
  const isResearcher = await db.userHasActiveGrantCapability(ws.userId, 'researcher');
  const isAgeVerified = await db.isUserAgeVerified(ws.userId);
  const isAdmin = await db.userHasActiveGrantCapability(ws.userId, 'admin');
  const userContext: UserContext = { isResearcher, isAgeVerified, isAdmin };

  // Use conversation.userId (the owner) to fetch message
  const msg = await db.getMessage(message.messageId, message.conversationId, conversation.userId);
  if (!msg) {
    ws.send(JSON.stringify({ type: 'error', error: 'Message not found' }));
    return;
  }

  // Find the parent branch (the user message branch that this is responding to)
  const allMessages = await db.getConversationMessages(msg.conversationId, conversation.userId);
  const targetMessageIndex = allMessages.findIndex(m => m.id === message.messageId);
  const parentUserMessage = targetMessageIndex > 0 ? allMessages[targetMessageIndex - 1] : null;
  const parentUserBranch = parentUserMessage ? parentUserMessage.branches.find(b => b.id === parentUserMessage.activeBranchId) : null;

  // Get the participant ID and parent branch from the branch we're regenerating
  const originalBranch = msg.branches.find(b => b.id === message.branchId);
  const participantId = originalBranch?.participantId;
  
  // Use the frontend-provided parentBranchId if available (reflects current visible path after branch switches)
  // Fall back to original branch's parent, then to the parent user message's active branch
  const correctParentBranchId = message.parentBranchId || originalBranch?.parentBranchId || parentUserBranch?.id || 'root';
  
  console.log('=== REGENERATE HANDLER ===');
  console.log('Frontend parentBranchId:', message.parentBranchId?.slice(0, 8) || 'not provided');
  console.log('Original branch parent:', originalBranch?.parentBranchId?.slice(0, 8) || 'none');
  console.log('Using parentBranchId:', correctParentBranchId.slice(0, 8));
  console.log('Sampling branches:', samplingBranchCount);
  
  Logger.debug('[Regenerate] Message:', message.messageId, 'Branch:', message.branchId);
  Logger.debug('[Regenerate] Original branch parent:', originalBranch?.parentBranchId);
  console.log('[Regenerate] Using parent branch:', correctParentBranchId);
  
  // Get the participant's model if in prefill mode
  let regenerateModel = conversation.model;
  if (conversation.format === 'prefill' && participantId) {
    const participants = await db.getConversationParticipants(conversation.id, conversation.userId);
    const participant = participants.find(p => p.id === participantId);
    if (participant && participant.model) {
      regenerateModel = participant.model;
    }
  }

  if (!(await userHasSufficientCredits(db, conversation.userId, regenerateModel))) {
    sendInsufficientCreditsError(ws);
    return;
  }

  // Create new branch with correct parent and model
  let updatedMessage = await db.addMessageBranch(
    message.messageId,
    message.conversationId,
    conversation.userId,
    '',
    'assistant',
    correctParentBranchId,
    regenerateModel,
    participantId,
    undefined, // no attachments
    ws.userId, // user who triggered the regeneration
    undefined, // hiddenFromAi
    false,     // preserveActiveBranch - select this new branch
    'regeneration' // creationSource - this is a regeneration
  );

  if (!updatedMessage) {
    ws.send(JSON.stringify({ type: 'error', error: 'Failed to create branch' }));
    return;
  }

  // Send the updated message with the new branch to the frontend
  const editEvent = {
    type: 'message_edited',
    message: updatedMessage
  };
  ws.send(JSON.stringify(editEvent));
  
  // Broadcast to other users in the room
  roomManager.broadcastToRoom(message.conversationId, editEvent, ws);

  // Get conversation history using the utility function
  const historyMessages = buildConversationHistory(allMessages, correctParentBranchId);
  
  // Filter out messages hidden from AI
  const filteredHistoryMessages = filterHiddenFromAiMessages(historyMessages);

  // Get participants for the conversation
  const participants = await db.getConversationParticipants(conversation.id, conversation.userId);
  
  // Determine the responder ID for streaming
  let responderId = participantId;
  if (conversation.format === 'standard') {
    // For standard format, use the assistant participant (there should only be one)
    const defaultAssistant = participants.find(p => p.type === 'assistant');
    responderId = defaultAssistant?.id;
  }
  
  // Get the participant who should respond
  let responderSettings = conversation.settings;
  let responderSystemPrompt = conversation.systemPrompt;
  let responderModel = conversation.model;
  
  if (participantId && participants.length > 0) {
    const participant = participants.find(p => p.id === participantId);
    if (participant) {
      responderModel = participant.model || conversation.model;
      responderSystemPrompt = participant.systemPrompt || conversation.systemPrompt;
      
      // For standard conversations, always use conversation settings
      // For prefill/group chat, merge participant and conversation settings
      if (conversation.format === 'standard') {
        responderSettings = conversation.settings;
      } else {
        responderSettings = {
          temperature: participant.settings?.temperature ?? conversation.settings.temperature,
          maxTokens: participant.settings?.maxTokens ?? conversation.settings.maxTokens,
          topP: participant.settings?.topP ?? conversation.settings.topP,
          topK: participant.settings?.topK ?? conversation.settings.topK,
          // Use participant thinking settings if defined, otherwise fall back to conversation
          thinking: participant.settings?.thinking ?? conversation.settings.thinking,
          // Include model-specific settings (e.g., image resolution)
          modelSpecific: participant.settings?.modelSpecific ?? conversation.settings.modelSpecific
        };
      }
    }
  }
  
  // Stream new response
  try {
    // Log WebSocket event
    await llmLogger.logWebSocketEvent({
      event: 'regenerate_message',
      conversationId: conversation.id,
      messageId: message.messageId,
      responderId: responderId,
      model: responderModel,
      settings: responderSettings,
      format: conversation.format
    });
    
    // Get the responder participant object
    const responderParticipant = responderId ? participants.find(p => p.id === responderId) : undefined;
    
    const modelLoader = ModelLoader.getInstance();
    const modelConfig = await modelLoader.getModelById(responderModel, conversation.userId);
    if (!modelConfig) {
      throw new Error(`Model ${responderModel} not found`);
    }
    
    // Validate pricing is configured BEFORE making inference call
    const pricingCheck = await validatePricingAvailable(modelConfig);
    if (!pricingCheck.valid) {
      console.error(`[Regenerate] Pricing validation failed for model ${responderModel}:`, pricingCheck.error);
      ws.send(JSON.stringify({
        type: 'error',
        error: USER_FACING_ERRORS.PRICING_NOT_CONFIGURED.message,
        details: pricingCheck.error
      }));
      return;
    }
    
    // Apply backroom prompt for early group chats if conditions are met
    responderSystemPrompt = applyBackroomPromptIfNeeded({
      conversationFormat: conversation.format,
      messageCount: filteredHistoryMessages.length,
      modelProvider: modelConfig.provider,
      modelSupportsPrefill: modelConfig.supportsPrefill,
      participantConversationMode: responderParticipant?.conversationMode,
      existingSystemPrompt: responderSystemPrompt || '',
      cliModePrompt: conversation.cliModePrompt
    });
    
    // Notify client if replacing an existing generation
    const existingKey = getGenerationKey(conversation.userId, conversation.id);
    if (activeGenerations.has(existingKey)) {
      roomManager.broadcastToRoom(conversation.id, {
        type: 'generation_aborted',
        conversationId: conversation.id,
        reason: 'replaced_by_new_request',
      });
    }

    // Create abort controller for this generation
    const abortController = startGeneration(conversation.userId, conversation.id);

    // Track AI request in room manager for multi-user sync (atomic check-and-set)
    if (!roomManager.startAiRequest(message.conversationId, ws.userId!, updatedMessage.id)) {
      endGeneration(conversation.userId, conversation.id);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'AI is already generating a response for this conversation',
      }));
      return;
    }

    let generatedBranchIds: string[];
    try {
      // Run parallel inference using shared utility
      generatedBranchIds = await runParallelBranchInference({
        ws,
        db,
        inferenceService,
        conversation,
        targetMessage: updatedMessage,
        initialBranchId: updatedMessage.activeBranchId,
        parentBranchId: correctParentBranchId,
        samplingBranchCount,
        modelConfig,
        model: regenerateModel,
        historyMessages: truncateForPersonaBudget(
          filteredHistoryMessages,
          responderParticipant?.personaContext,
          responderSystemPrompt || '',
          responderSettings?.maxTokens || 8192,
          modelConfig.contextWindow || 200000,
          responderParticipant?.name || 'unknown'
        ),
        systemPrompt: responderSystemPrompt || '',
        settings: responderSettings,
        participants,
        responderParticipant,
        participantId,
        userContext,
        abortSignal: abortController.signal,
        creationSource: 'regeneration',
        conversationId: message.conversationId,
        toolOptions: buildToolOptions(conversation.userId, conversation, responderParticipant, db),
        personaContext: responderParticipant?.personaContext
      });
    } finally {
      endGeneration(conversation.userId, conversation.id);
      roomManager.endAiRequest(message.conversationId);
    }

    // Capture debug request/response for researchers (only for first branch)
    console.log('[DEBUG CAPTURE] Starting debug data capture for regenerate...');
    try {
      // Get the raw API request that was just sent
      const rawRequest = baseInferenceService.lastRawRequest;
      console.log(`[DEBUG CAPTURE] Raw request available: ${!!rawRequest}`);

      if (rawRequest && generatedBranchIds.length > 0) {
        // Store debug data on the first regenerated branch
        const firstBranchId = generatedBranchIds[0];
        const currentBranch = updatedMessage.branches.find(b => b.id === firstBranchId);
        console.log(`[DEBUG CAPTURE] Branch ${firstBranchId}: branchObj found = ${!!currentBranch}`);

        if (currentBranch) {
          // Get the participant for mode info
          const responderParticipantForDebug = participants.find(p => p.id === participantId);
          
          // Compute actual format used (same logic as applyBackroomPromptIfNeeded)
          const modelSupportsPrefill = modelConfig.supportsPrefill !== false && (modelConfig.provider === 'anthropic' || modelConfig.provider === 'bedrock' || modelConfig.supportsPrefill === true);
          const participantMode = responderParticipantForDebug?.conversationMode;
          const wantsPrefill = !participantMode || participantMode === 'auto' || participantMode === 'prefill';
          const actualFormat = (conversation.format === 'prefill' && modelSupportsPrefill && wantsPrefill) ? 'prefill' : 'messages';
          
          // Store the raw API request with inference metadata
          const debugRequest = {
            ...rawRequest,
            provider: modelConfig.provider,
            settings: responderSettings,
            // Inference format metadata
            conversationFormat: conversation.format,
            participantConversationMode: participantMode || 'auto',
            actualFormatUsed: actualFormat
          };

          // Store the response (content is already in the branch)
          const debugResponse = {
            content: currentBranch.content,
            contentBlocks: currentBranch.contentBlocks,
            model: currentBranch.model
          };

          console.log(`[DEBUG CAPTURE] Updating message branch ${firstBranchId}...`);
          await db.updateMessageBranch(
            updatedMessage.id,
            conversation.userId,
            firstBranchId,
            {
              debugRequest,
              debugResponse
            }
          );
          console.log(`[DEBUG CAPTURE] Branch ${firstBranchId} updated successfully`);

          // Send update to frontend so bug icon appears immediately
          const refreshedMessage = await db.getMessage(updatedMessage.id, conversation.id, conversation.userId);
          if (refreshedMessage) {
            const updateEvent = {
              type: 'message_edited',
              message: refreshedMessage
            };
            ws.send(JSON.stringify(updateEvent));
            roomManager.broadcastToRoom(conversation.id, updateEvent, ws);
          }
        }
        console.log('[DEBUG CAPTURE] Debug data capture complete for regenerate');
      } else {
        console.log('[DEBUG CAPTURE] No raw request available (non-Anthropic provider?)');
      }
    } catch (debugError) {
      console.error('[DEBUG CAPTURE] Failed to capture debug data:', debugError);
      // Don't fail the whole request if debug capture fails
    }
  } catch (error) {
    // Note: endGeneration + endAiRequest already called in finally block above

    // Check if this was an abort
    if (error instanceof Error && error.message === 'Generation aborted') {
      console.log(`[Abort] Regeneration was aborted for conversation ${message.conversationId}`);
      // Send abort notification for all branches on the message
      for (const branch of updatedMessage.branches) {
        safeSend(ws, {
          type: 'stream',
          messageId: updatedMessage.id,
          branchId: branch.id,
          content: '',
          isComplete: true,
          aborted: true
        });
      }
      return;
    }

    console.error('Regeneration error:', error);
    let errorMsg = error instanceof Error ? error.message : String(error);

    // Extract meaningful error from Anthropic/API errors
    // e.g., "400 {"type":"error","error":{"message":"You have reached..."}}"
    const jsonMatch = errorMsg.match(/\{.*"message"\s*:\s*"([^"]+)"/);
    if (jsonMatch && jsonMatch[1]) {
      errorMsg = jsonMatch[1];
    }

    safeSend(ws, {
      type: 'error',
      error: errorMsg.length < 300 ? errorMsg : errorMsg.substring(0, 297) + '...'
    });
  }
}

async function handleEdit(
  ws: AuthenticatedWebSocket,
  message: Extract<WsMessage, { type: 'edit' }>,
  db: Database,
  inferenceService: EnhancedInferenceService,
  baseInferenceService: InferenceService
) {
  if (!ws.userId) return;

  // First verify conversation access (handles both owner and collaboration)
  const conversation = await db.getConversation(message.conversationId, ws.userId);
  if (!conversation) {
    ws.send(JSON.stringify({ type: 'error', error: 'Conversation not found or access denied' }));
    return;
  }
  
  // Check if user can chat (owner or collaborator/editor)
  const canChat = await db.canUserChatInConversation(message.conversationId, ws.userId);
  if (!canChat) {
    ws.send(JSON.stringify({ type: 'error', error: 'You do not have permission to edit in this conversation' }));
    return;
  }

  // Content filter check with tiered moderation
  const isResearcher = await db.userHasActiveGrantCapability(ws.userId, 'researcher');
  const isAgeVerified = await db.isUserAgeVerified(ws.userId);
  const isAdmin = await db.userHasActiveGrantCapability(ws.userId, 'admin');
  const userContext: UserContext = { isResearcher, isAgeVerified, isAdmin };
  
  // Always check content - the filter applies tiered logic based on user context
  const filterResult = await checkContent(message.content, userContext);
  if (filterResult.blocked) {
    ws.send(JSON.stringify({ 
      type: 'content_blocked',
      reason: filterResult.reason || 'Message blocked by content filter',
      categories: filterResult.categories
    }));
    return;
  }

  // Use conversation.userId (the owner) to fetch message
  const msg = await db.getMessage(message.messageId, message.conversationId, conversation.userId);
  if (!msg) {
    ws.send(JSON.stringify({ type: 'error', error: 'Message not found' }));
    return;
  }

  // Find the branch to determine role
  const branch = msg.branches.find(b => b.id === message.branchId);
  if (!branch) {
    ws.send(JSON.stringify({ type: 'error', error: 'Branch not found' }));
    return;
  }

  // Create new branch with edited content
  // The parent should be the same as the original branch's parent (the previous message)
  const updatedMessage = await db.addMessageBranch(
    message.messageId,
    message.conversationId,
    conversation.userId,
    message.content,
    branch.role,
    branch.parentBranchId, // Use the same parent as the original branch
    branch.model,
    branch.participantId, // Keep the same participant
    undefined, // no attachments
    ws.userId, // user who made the edit
    undefined, // hiddenFromAi
    false,     // preserveActiveBranch - select this new branch
    'human_edit' // creationSource - human edited this message
  );

  if (!updatedMessage) {
    ws.send(JSON.stringify({ type: 'error', error: 'Failed to create edited branch' }));
    return;
  }

  const userEditEvent = {
    type: 'message_edited',
    message: updatedMessage
  };
  ws.send(JSON.stringify(userEditEvent));
  
  // Broadcast to other users in the room
  roomManager.broadcastToRoom(message.conversationId, userEditEvent, ws);

  // If this was a user message, automatically generate an assistant response (unless skipped)
  if (branch.role === 'user' && !message.skipRegeneration) {
    // Get sampling branches count (default 1)
    const samplingBranchCount = Math.min((message as any).samplingBranches || conversation.settings?.samplingBranches || 1, 10);
    if (samplingBranchCount > 1) {
      console.log(`[Edit] Sampling ${samplingBranchCount} response branches in parallel`);
    }
    
    // Build user context for content filter
    const isResearcher = await db.userHasActiveGrantCapability(ws.userId, 'researcher');
    const isAgeVerified = await db.isUserAgeVerified(ws.userId);
    const isAdmin = await db.userHasActiveGrantCapability(ws.userId, 'admin');
    const userContext: UserContext = { isResearcher, isAgeVerified, isAdmin };
    
    // Get all messages to find the position of the edited message
    const allMessages = await db.getConversationMessages(msg.conversationId, conversation.userId);
    const editedMessageIndex = allMessages.findIndex(m => m.id === msg.id);

    // Get participants early to determine responderId
    const participants = await db.getConversationParticipants(conversation.id, conversation.userId);
    
    // Determine which assistant should respond
    let responderId: string | undefined;
    
    // Use the responderId from the message if provided (from frontend)
    if (message.responderId) {
      responderId = message.responderId;
    } else if (conversation.format === 'standard') {
      // For standard format, use the assistant participant (there should only be one)
      const defaultAssistant = participants.find(p => p.type === 'assistant');
      responderId = defaultAssistant?.id;
    } else {
      // For other formats, use the first active assistant as fallback
      const defaultAssistant = participants.find(p => p.type === 'assistant' && p.isActive);
      responderId = defaultAssistant?.id;
    }
    
    // Get the responder's model early for branch creation
    let responderModel = conversation.model;
    if (responderId && participants.length > 0) {
      const responderParticipant = participants.find(p => p.id === responderId);
      if (responderParticipant && responderParticipant.model) {
        responderModel = responderParticipant.model;
      }
    }

    if (!(await userHasSufficientCredits(db, conversation.userId, responderModel))) {
      sendInsufficientCreditsError(ws);
      return;
    }

    // Check if there's already an assistant message after this user message
    const nextMessage = editedMessageIndex + 1 < allMessages.length ? allMessages[editedMessageIndex + 1] : null;
    
    let assistantMessage: Message | null;
    
    if (nextMessage && nextMessage.branches.some(b => b.role === 'assistant')) {
      // Add a new branch to the existing assistant message
      const newBranch = await db.addMessageBranch(
        nextMessage.id,
        nextMessage.conversationId,
        conversation.userId,
        '',
        'assistant',
        updatedMessage.activeBranchId, // Parent is the edited user message's active branch
        responderModel,  // Use responder's model, not conversation model
        responderId, // Assistant participant ID
        undefined, // no attachments
        ws.userId, // user who triggered the generation
        undefined, // hiddenFromAi
        false,     // preserveActiveBranch - select this new branch
        'inference' // creationSource - AI generated after user edit
      );
      
      if (!newBranch) {
        ws.send(JSON.stringify({ type: 'error', error: 'Failed to create assistant branch' }));
        return;
      }
      
      assistantMessage = newBranch;
      
      // Send the updated message with new branch
      const assistantEditEvent = {
        type: 'message_edited',
        message: assistantMessage
      };
      ws.send(JSON.stringify(assistantEditEvent));
      
      // Broadcast to other users
      roomManager.broadcastToRoom(message.conversationId, assistantEditEvent, ws);
    } else {
      // No assistant message exists after this user message, create a new one
      // But we need to manually set the parentBranchId
      assistantMessage = await db.createMessage(
        msg.conversationId,
        conversation.userId,
        '',
        'assistant',
        responderModel,  // Use responder's model, not conversation model
        updatedMessage.activeBranchId, // Parent is the edited user message's active branch
        responderId, // Assistant participant ID
        undefined,   // no attachments
        ws.userId,   // user who triggered the generation
        undefined,   // hiddenFromAi
        'inference'  // creationSource - AI generated after user edit
      );
      
      // Send assistant message to frontend
      const createEvent = {
        type: 'message_created',
        message: assistantMessage
      };
      ws.send(JSON.stringify(createEvent));
      
      // Broadcast to other users
      roomManager.broadcastToRoom(message.conversationId, createEvent, ws);
    }
    
    // Build conversation history using the utility function
    // We need to include the edited message in place of the original
    const historyMessages = buildConversationHistory(
      allMessages, 
      updatedMessage.activeBranchId,
      { messageId: updatedMessage.id, message: updatedMessage }
    );
    
    // Filter out messages hidden from AI
    const filteredHistoryMessages = filterHiddenFromAiMessages(historyMessages);
    
    // Get the responder's settings (we already have responderModel from earlier)
    let responderSettings = conversation.settings;
    let responderSystemPrompt = conversation.systemPrompt;
    let responderParticipant: Participant | undefined;
    
    if (responderId && participants.length > 0) {
      responderParticipant = participants.find(p => p.id === responderId);
      if (responderParticipant) {
        responderSystemPrompt = responderParticipant.systemPrompt || conversation.systemPrompt;
        
        // For standard conversations, always use conversation settings
        // For prefill/group chat, merge participant and conversation settings
        if (conversation.format === 'standard') {
          responderSettings = conversation.settings;
        } else {
          responderSettings = {
            temperature: responderParticipant.settings?.temperature ?? conversation.settings.temperature,
            maxTokens: responderParticipant.settings?.maxTokens ?? conversation.settings.maxTokens,
            topP: responderParticipant.settings?.topP ?? conversation.settings.topP,
            topK: responderParticipant.settings?.topK ?? conversation.settings.topK,
            // Use participant thinking settings if defined, otherwise fall back to conversation
            thinking: responderParticipant.settings?.thinking ?? conversation.settings.thinking,
            // Include model-specific settings (e.g., image resolution)
            modelSpecific: responderParticipant.settings?.modelSpecific ?? conversation.settings.modelSpecific
          };
        }
      }
    }
    
    // Stream response
    try {
      const targetMessage = assistantMessage!;
      const targetBranchId = targetMessage.activeBranchId;
      
      // Log WebSocket event
      await llmLogger.logWebSocketEvent({
        event: 'edit_message',
        conversationId: conversation.id,
        messageId: message.messageId,
        responderId: responderId,
        model: responderModel,
        settings: responderSettings,
        format: conversation.format
      });
      
      const modelLoader = ModelLoader.getInstance();
      const modelConfig = await modelLoader.getModelById(responderModel, conversation.userId);
      if (!modelConfig) {
        throw new Error(`Model ${responderModel} not found`);
      }
      
      // Validate pricing is configured BEFORE making inference call
      const pricingCheck = await validatePricingAvailable(modelConfig);
      if (!pricingCheck.valid) {
        console.error(`[Edit] Pricing validation failed for model ${responderModel}:`, pricingCheck.error);
        ws.send(JSON.stringify({
          type: 'error',
          error: USER_FACING_ERRORS.PRICING_NOT_CONFIGURED.message,
          details: pricingCheck.error
        }));
        return;
      }
      
      // Apply backroom prompt for early group chats if conditions are met
      const responderParticipantEdit = responderId ? participants.find(p => p.id === responderId) : undefined;
      responderSystemPrompt = applyBackroomPromptIfNeeded({
        conversationFormat: conversation.format,
        messageCount: filteredHistoryMessages.length,
        modelProvider: modelConfig.provider,
        modelSupportsPrefill: modelConfig.supportsPrefill,
        participantConversationMode: responderParticipantEdit?.conversationMode,
        existingSystemPrompt: responderSystemPrompt || '',
        cliModePrompt: conversation.cliModePrompt
      });
      
      // Notify client if replacing an existing generation
      const existingKey = getGenerationKey(conversation.userId, conversation.id);
      if (activeGenerations.has(existingKey)) {
        roomManager.broadcastToRoom(conversation.id, {
          type: 'generation_aborted',
          conversationId: conversation.id,
          reason: 'replaced_by_new_request',
        });
      }

      // Create abort controller for this generation
      const abortController = startGeneration(conversation.userId, conversation.id);

      // Track AI request in room manager for multi-user sync (atomic check-and-set)
      if (!roomManager.startAiRequest(message.conversationId, ws.userId!, targetMessage.id)) {
        endGeneration(conversation.userId, conversation.id);
        ws.send(JSON.stringify({
          type: 'error',
          message: 'AI is already generating a response for this conversation',
        }));
        return;
      }

      let generatedBranchIds: string[];
      try {
        // Run parallel inference using shared utility
        generatedBranchIds = await runParallelBranchInference({
          ws,
          db,
          inferenceService,
          conversation,
          targetMessage,
          initialBranchId: targetBranchId,
          parentBranchId: updatedMessage.activeBranchId, // Parent is the edited user message
          samplingBranchCount,
          modelConfig,
          model: responderModel,
          historyMessages: truncateForPersonaBudget(
            filteredHistoryMessages,
            responderParticipant?.personaContext,
            responderSystemPrompt || '',
            responderSettings?.maxTokens || 8192,
            modelConfig.contextWindow || 200000,
            responderParticipant?.name || 'unknown'
          ),
          systemPrompt: responderSystemPrompt || '',
          settings: responderSettings,
          participants,
          responderParticipant,
          participantId: responderId,
          userContext,
          abortSignal: abortController.signal,
          creationSource: 'inference',
          conversationId: message.conversationId,
          toolOptions: buildToolOptions(conversation.userId, conversation, responderParticipant, db),
          personaContext: responderParticipant?.personaContext
        });
      } finally {
        endGeneration(conversation.userId, conversation.id);
        roomManager.endAiRequest(message.conversationId);
      }

      // Capture debug request/response for researchers
      console.log('[DEBUG CAPTURE] Starting debug data capture for edit...');
      try {
        const rawRequest = baseInferenceService.lastRawRequest;
        console.log(`[DEBUG CAPTURE] Raw request available for edit: ${!!rawRequest}`);

        if (rawRequest && targetMessage && generatedBranchIds.length > 0) {
          const firstBranchId = generatedBranchIds[0];
          const currentBranch = targetMessage.branches.find(b => b.id === firstBranchId);
          if (currentBranch) {
            // Compute actual format used
            const modelSupportsPrefill = modelConfig.supportsPrefill !== false && (modelConfig.provider === 'anthropic' || modelConfig.provider === 'bedrock' || modelConfig.supportsPrefill === true);
            const participantMode = responderParticipantEdit?.conversationMode;
            const wantsPrefill = !participantMode || participantMode === 'auto' || participantMode === 'prefill';
            const actualFormat = (conversation.format === 'prefill' && modelSupportsPrefill && wantsPrefill) ? 'prefill' : 'messages';
            
            const debugRequest = {
              ...rawRequest,
              provider: modelConfig.provider,
              settings: responderSettings,
              conversationFormat: conversation.format,
              participantConversationMode: participantMode || 'auto',
              actualFormatUsed: actualFormat
            };

            const debugResponse = {
              content: currentBranch.content,
              contentBlocks: currentBranch.contentBlocks,
              model: currentBranch.model
            };

            await db.updateMessageBranch(
              targetMessage.id,
              conversation.userId,
              firstBranchId,
              { debugRequest, debugResponse }
            );
            console.log(`[DEBUG CAPTURE] Edit branch ${firstBranchId} updated successfully`);

            // Send update to frontend
            const refreshedMessage = await db.getMessage(targetMessage.id, conversation.id, conversation.userId);
            if (refreshedMessage) {
              ws.send(JSON.stringify({ type: 'message_edited', message: refreshedMessage }));
              roomManager.broadcastToRoom(conversation.id, { type: 'message_edited', message: refreshedMessage }, ws);
            }
          }
        }
      } catch (debugError) {
        console.error('[DEBUG CAPTURE] Failed to capture debug data for edit:', debugError);
      }
    } catch (error) {
      console.error('Error generating response to edited message:', error);
      let errorMsg = error instanceof Error ? error.message : String(error);

      // Extract meaningful error from Anthropic/API errors
      const jsonMatch = errorMsg.match(/\{.*"message"\s*:\s*"([^"]+)"/);
      if (jsonMatch && jsonMatch[1]) {
        errorMsg = jsonMatch[1];
      }

      safeSend(ws, {
        type: 'error',
        error: errorMsg.length < 300 ? errorMsg : errorMsg.substring(0, 297) + '...'
      });
    }
  }
}

async function handleDelete(
  ws: AuthenticatedWebSocket,
  message: Extract<WsMessage, { type: 'delete' }>,
  db: Database
) {
  try {
    const { conversationId, messageId, branchId } = message;
    
    // Get the conversation to verify access
    const conversation = await db.getConversation(conversationId, ws.userId!);
    if (!conversation) {
      ws.send(JSON.stringify({ type: 'error', error: 'Conversation not found or access denied' }));
      return;
    }
    
    // Check if user can delete (owner or editor)
    const canDelete = await db.canUserDeleteInConversation(conversationId, ws.userId!);
    if (!canDelete) {
      ws.send(JSON.stringify({ type: 'error', error: 'You do not have permission to delete messages in this conversation' }));
      return;
    }
    
    // Delete the message branch and all its descendants
    const deleted = await db.deleteMessageBranch(messageId, conversationId, conversation.userId, branchId, ws.userId);
    
    if (deleted) {
      const deleteEvent = {
        type: 'message_deleted',
        messageId,
        branchId,
        deletedMessages: deleted
      };
      
      // Send to requester
      ws.send(JSON.stringify(deleteEvent));
      
      // Broadcast to all other users in the room
      roomManager.broadcastToRoom(conversationId, deleteEvent, ws);
    } else {
      ws.send(JSON.stringify({ type: 'error', error: 'Failed to delete message' }));
    }
  } catch (error) {
    console.error('Delete message error:', error);
    safeSend(ws, { type: 'error', error: 'Failed to delete message' });
  }
}

async function handleContinue(
  ws: AuthenticatedWebSocket,
  message: Extract<WsMessage, { type: 'continue' }>,
  db: Database,
  inferenceService: EnhancedInferenceService,
  baseInferenceService: InferenceService
) {
  if (!ws.userId) return;

  const { conversationId, messageId, parentBranchId, responderId } = message;

  try {
    // Verify conversation access
    const conversation = await db.getConversation(conversationId, ws.userId);
    if (!conversation) {
      ws.send(JSON.stringify({ type: 'error', error: 'Conversation not found or access denied' }));
      return;
    }

    const samplingBranchCount = Math.min((message as any).samplingBranches || conversation.settings?.samplingBranches || 1, 10);
    if (samplingBranchCount > 1) {
      console.log(`[Continue] Sampling ${samplingBranchCount} response branches in parallel`);
    }

    // Check if user can chat (owner or collaborator/editor)
    const canChat = await db.canUserChatInConversation(conversationId, ws.userId);
    if (!canChat) {
      ws.send(JSON.stringify({ type: 'error', error: 'You do not have permission to continue generation in this conversation' }));
      return;
    }

    // Build user context for content filter
    const isResearcher = await db.userHasActiveGrantCapability(ws.userId, 'researcher');
    const isAgeVerified = await db.isUserAgeVerified(ws.userId);
    const isAdmin = await db.userHasActiveGrantCapability(ws.userId, 'admin');
    const userContext: UserContext = { isResearcher, isAgeVerified, isAdmin };

    // Get participants
    const participants = await db.getConversationParticipants(conversationId, conversation.userId);
    
    // Determine the responder
    let responder: Participant | undefined;
    if (conversation.format === 'standard') {
      // For standard format, use the assistant participant (there should only be one)
      responder = participants.find(p => p.type === 'assistant');
    } else {
      // For other formats, use the specified responder
      responder = participants.find(p => p.id === responderId);
      if (!responder || responder.type !== 'assistant') {
        // If no valid responder specified, use first active assistant
        responder = participants.find(p => p.type === 'assistant' && p.isActive);
      }
    }

    if (!responder) {
      ws.send(JSON.stringify({ type: 'error', error: 'No assistant participant found' }));
      return;
    }

    const responderModelId = responder.model || conversation.model;

    if (!(await userHasSufficientCredits(db, conversation.userId, responderModelId))) {
      sendInsufficientCreditsError(ws);
      return;
    }

    // Get messages and determine parent
    const messages = await db.getConversationMessages(conversationId, conversation.userId);
    
    // Check if we should add to an existing message or create a new one
    let assistantMessage: Message | null;
    
    if (parentBranchId) {
      // Check if this parent branch has siblings
      const messageWithSiblings = messages.find(msg => 
        msg.branches.some(b => b.parentBranchId === parentBranchId)
      );
      
      if (messageWithSiblings) {
        // Add as a new branch to the existing message
        console.log('Continue: Adding branch to existing message:', messageWithSiblings.id);
        assistantMessage = await db.addMessageBranch(
          messageWithSiblings.id,
          messageWithSiblings.conversationId,
          conversation.userId,
          '', // empty content initially
          'assistant',
          parentBranchId,
          responderModelId,
          responder.id,
          undefined, // no attachments
          ws.userId, // user who triggered the generation
          undefined, // hiddenFromAi
          false,     // preserveActiveBranch - select this new branch
          'inference' // creationSource - AI generated (continue)
        );
      } else {
        // No siblings exist yet, create a new message
        console.log('Continue: Creating new message (no siblings found)');
        assistantMessage = await db.createMessage(
          conversationId,
          conversation.userId,
          '', // empty content initially
          'assistant',
          responderModelId,
          parentBranchId,
          responder.id,
          undefined, // no attachments
          ws.userId, // user who triggered the generation
          undefined, // hiddenFromAi
          'inference' // creationSource - AI generated (continue)
        );
      }
    } else {
      // No parent specified, create new message as usual
      assistantMessage = await db.createMessage(
        conversationId,
        conversation.userId,
        '', // empty content initially
        'assistant',
        responderModelId,
        undefined,
        responder.id,
        undefined, // no attachments
        ws.userId, // user who triggered the generation
        undefined, // hiddenFromAi
        'inference' // creationSource - AI generated (continue)
      );
    }

    if (!assistantMessage) {
      console.error('Failed to create assistant message for continue');
      ws.send(JSON.stringify({
        type: 'error',
        error: 'Failed to create assistant message'
      }));
      return;
    }

    const assistantBranch = assistantMessage.branches[assistantMessage.branches.length - 1];

    // Send initial empty message
    const continueEvent = {
      type: 'message_created',
      message: assistantMessage
    };
    ws.send(JSON.stringify(continueEvent));
    
    // Broadcast to other users
    roomManager.broadcastToRoom(conversationId, continueEvent, ws);

    // Log WebSocket event
    await llmLogger.logWebSocketEvent({
      event: 'continue',
      conversationId,
      messageId,
      participantId: responder.id,
      model: responderModelId
    });

    // Build conversation history using the utility function
    const visibleHistory = parentBranchId 
      ? buildConversationHistory(messages, parentBranchId)
      : messages; // No parent specified, use all messages (default behavior)
    
    // Filter out messages hidden from AI
    const filteredHistory = filterHiddenFromAiMessages(visibleHistory);
    
    // Include the new assistant message in the messages array for prefill formatting
    const messagesWithNewAssistant = [...filteredHistory, assistantMessage];

    // Stream the completion
    const modelId = responder.model || conversation.model;
    
    if (!modelId) {
      throw new Error('No model specified for responder or conversation');
    }
    
    const modelLoader = ModelLoader.getInstance();
    const modelConfig = await modelLoader.getModelById(modelId, conversation.userId);
    if (!modelConfig) {
      throw new Error(`Model ${modelId} not found`);
    }
    
    // Validate pricing is configured BEFORE making inference call
    const pricingCheck = await validatePricingAvailable(modelConfig);
    if (!pricingCheck.valid) {
      console.error(`[Continue] Pricing validation failed for model ${modelId}:`, pricingCheck.error);
      ws.send(JSON.stringify({
        type: 'error',
        error: USER_FACING_ERRORS.PRICING_NOT_CONFIGURED.message,
        details: pricingCheck.error
      }));
      // Delete the empty assistant message we created
      await db.deleteMessage(assistantMessage.id, conversationId, conversation.userId);
      return;
    }
    
    // Notify client if replacing an existing generation
    const existingKey = getGenerationKey(conversation.userId, conversationId);
    if (activeGenerations.has(existingKey)) {
      roomManager.broadcastToRoom(conversationId, {
        type: 'generation_aborted',
        conversationId,
        reason: 'replaced_by_new_request',
      });
    }

    // Create abort controller for this generation
    const abortController = startGeneration(conversation.userId, conversationId);

    // Track AI request in room manager (atomic check-and-set)
    if (!roomManager.startAiRequest(conversationId, ws.userId!, assistantMessage.id)) {
      endGeneration(conversation.userId, conversationId);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'AI is already generating a response for this conversation',
      }));
      return;
    }

    // Inference settings
    const inferenceSettings = conversation.format === 'standard'
      ? conversation.settings || { temperature: 1.0, maxTokens: 4096 }
        : {
            temperature: responder.settings?.temperature ?? conversation.settings?.temperature ?? 1.0,
            maxTokens: responder.settings?.maxTokens ?? conversation.settings?.maxTokens ?? 4096,
            topP: responder.settings?.topP ?? conversation.settings?.topP,
            topK: responder.settings?.topK ?? conversation.settings?.topK,
            thinking: responder.settings?.thinking ?? conversation.settings?.thinking,
            // Include model-specific settings (e.g., image resolution, response modalities)
            modelSpecific: responder.settings?.modelSpecific ?? conversation.settings?.modelSpecific
        };

    // Determine system prompt with backroom logic for early group chats
    const continueSystemPrompt = applyBackroomPromptIfNeeded({
      conversationFormat: conversation.format,
      messageCount: filteredHistory.length,
      modelProvider: modelConfig.provider,
      modelSupportsPrefill: modelConfig.supportsPrefill,
      participantConversationMode: responder.conversationMode,
      existingSystemPrompt: responder.systemPrompt || conversation.systemPrompt || '',
      cliModePrompt: conversation.cliModePrompt
    });
    
    let generatedBranchIds: string[];
    try {
      // Run parallel inference using shared utility
      generatedBranchIds = await runParallelBranchInference({
        ws,
        db,
        inferenceService,
        conversation,
        targetMessage: assistantMessage,
        initialBranchId: assistantBranch.id,
        parentBranchId: parentBranchId || 'root',
        samplingBranchCount,
        modelConfig,
        model: responder.model || conversation.model,
        historyMessages: truncateForPersonaBudget(
          messagesWithNewAssistant,
          responder.personaContext,
          continueSystemPrompt,
          inferenceSettings.maxTokens || 8192,
          modelConfig.contextWindow || 200000,
          responder.name
        ),
        systemPrompt: continueSystemPrompt,
        settings: inferenceSettings,
        participants,
        responderParticipant: responder,
        participantId: responder.id,
        userContext,
        abortSignal: abortController.signal,
        creationSource: 'inference',
        conversationId,
        toolOptions: buildToolOptions(conversation.userId, conversation, responder, db),
        personaContext: responder.personaContext
      });

      // DEBUG CAPTURE: Capture debug data for the first branch after completion
      try {
        const rawRequest = baseInferenceService.lastRawRequest;
        if (rawRequest && generatedBranchIds.length > 0) {
          const firstBranchId = generatedBranchIds[0];
          const branchObj = assistantMessage.branches.find((b: any) => b.id === firstBranchId);
          if (branchObj) {
            console.log(`[DEBUG CAPTURE] Continue: Capturing debug data for branch ${firstBranchId.substring(0, 8)}...`);
            
            const modelSupportsPrefill = modelConfig.supportsPrefill !== false && (modelConfig.provider === 'anthropic' || modelConfig.provider === 'bedrock' || modelConfig.supportsPrefill === true);
            const participantMode = responder.conversationMode;
            const wantsPrefill = !participantMode || participantMode === 'auto' || participantMode === 'prefill';
            const actualFormat = (conversation.format === 'prefill' && modelSupportsPrefill && wantsPrefill) ? 'prefill' : 'messages';
            
            const debugRequest = {
              ...rawRequest,
              provider: modelConfig.provider,
              settings: inferenceSettings,
              conversationFormat: conversation.format,
              participantConversationMode: participantMode || 'auto',
              actualFormatUsed: actualFormat
            };
            
            const debugResponse = {
              content: branchObj.content,
              contentBlocks: branchObj.contentBlocks,
              model: branchObj.model
            };
            
            await db.updateMessageBranch(assistantMessage.id, conversation.userId, firstBranchId, { debugRequest, debugResponse });
            console.log(`[DEBUG CAPTURE] Continue: Debug data saved for branch ${firstBranchId.substring(0, 8)}`);
            
            const refreshedMessage = await db.getMessage(assistantMessage.id, conversationId, conversation.userId);
            if (refreshedMessage) {
              ws.send(JSON.stringify({ type: 'message_edited', message: refreshedMessage }));
              roomManager.broadcastToRoom(conversationId, { type: 'message_edited', message: refreshedMessage }, ws);
            }
          }
        }
      } catch (debugError) {
        console.error('[DEBUG CAPTURE] Continue: Failed to capture debug data:', debugError);
      }
    
    // Send updated conversation after all complete
    const updatedConversation = await db.getConversation(conversationId, conversation.userId);
    if (updatedConversation) {
      ws.send(JSON.stringify({ type: 'conversation_updated', conversation: updatedConversation }));
    }
    
    } finally {
      endGeneration(conversation.userId, conversationId);
      roomManager.endAiRequest(conversationId);
    }

  } catch (error) {
    // Note: endGeneration + endAiRequest already called in finally block above

    // Check if this was an abort
    if (error instanceof Error && error.message === 'Generation aborted') {
      console.log(`[Abort] Continue generation was aborted for conversation ${conversationId}`);
      // Note: assistantMessage/assistantBranch may not be defined if error happened early
      safeSend(ws, {
        type: 'generation_aborted',
        conversationId: conversationId,
        aborted: true
      });
      return;
    }

    console.error('Continue generation error:', error);
    let errorMsg = error instanceof Error ? error.message : String(error);

    // Extract meaningful error from Anthropic/API errors
    const jsonMatch = errorMsg.match(/\{.*"message"\s*:\s*"([^"]+)"/);
    if (jsonMatch && jsonMatch[1]) {
      errorMsg = jsonMatch[1];
    }

    safeSend(ws, {
      type: 'error',
      error: errorMsg.length < 300 ? errorMsg : errorMsg.substring(0, 297) + '...'
    });
  }
}

// Heartbeat interval to keep connections alive
// Runs every 30 seconds, terminates connections that don't respond to ping
setInterval(() => {
  roomManager.performHeartbeat();
}, 30000).unref();

// Start delegate heartbeat — detects dead delegate WebSockets (ghost connections)
delegateManager.startHeartbeat();
