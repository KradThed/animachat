import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { Database } from '../index.js';
import { UIEventLog } from '../ui-event-log.js';

/**
 * Tests for Active Branch Event Sourcing
 *
 * These tests verify that active branch selection is correctly persisted
 * via events in the conversation event store.
 */

const TEST_DATA_DIR = './data-test-active-branch';

// Helper to create a fresh Database with test paths
async function createTestDatabase(): Promise<Database> {
  const db = new Database();
  (db as any).eventStore.filePath = path.join(TEST_DATA_DIR, 'mainEvents.jsonl');
  (db as any).userEventStore.baseDir = path.join(TEST_DATA_DIR, 'users');
  (db as any).conversationEventStore.baseDir = path.join(TEST_DATA_DIR, 'conversations');
  (db as any).uiStateStore.sharedBaseDir = path.join(TEST_DATA_DIR, 'conversation-state');
  (db as any).uiStateStore.userBaseDir = path.join(TEST_DATA_DIR, 'user-conversation-state');
  (db as any).uiEventLog.basePath = path.join(TEST_DATA_DIR, 'conversations');
  return db;
}

describe('Active Branch Events', () => {
  let db: Database;
  const TEST_USER_EMAIL = 'test-ab@example.com';

  beforeEach(async () => {
    try {
      await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
    } catch (e) {
      // Ignore
    }
    await fs.mkdir(TEST_DATA_DIR, { recursive: true });

    db = await createTestDatabase();
    await db.init();
  });

  afterEach(async () => {
    await db.close();
    try {
      await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
    } catch (e) {
      // Ignore
    }
  });

  describe('setActiveBranch()', () => {
    it('should create active_branch_changed event in UIEventLog', async () => {
      // Create a user and conversation with a message that has multiple branches
      const user = await db.createUser(TEST_USER_EMAIL, 'password123', 'Test User');
      const conv = await db.createConversation(user.id, 'Test Conversation', 'test-model');

      // Add a message (creates first branch automatically)
      const message = await db.createMessage(
        conv.id,
        user.id,
        'First branch content',
        'user'
      );

      // Add a second branch to the message
      const updatedMessage = await db.addMessageBranch(
        message.id,
        conv.id,
        user.id,
        'Second branch content',
        'user'
      );

      expect(updatedMessage).not.toBeNull();
      const secondBranch = updatedMessage!.branches[updatedMessage!.branches.length - 1];

      // Set active branch to the second one
      const success = await db.setActiveBranch(
        message.id,
        conv.id,
        user.id,
        secondBranch.id
      );

      expect(success).toBe(true);

      // Verify event was written to UIEventLog (.ui.jsonl)
      const uiFilePath = path.join(TEST_DATA_DIR, 'conversations',
        conv.id.substring(0, 2), conv.id.substring(2, 4), `${conv.id}.ui.jsonl`);
      const content = await fs.readFile(uiFilePath, 'utf-8');
      const uiEvents = content.trim().split('\n').map((l: string) => JSON.parse(l));
      const activeBranchEvent = uiEvents.find((e: any) =>
        e.type === 'active_branch_changed' && e.data.messageId === message.id
      );

      expect(activeBranchEvent).toBeDefined();
      expect(activeBranchEvent.data.branchId).toBe(secondBranch.id);
    });

    it('should return false for non-existent message', async () => {
      const user = await db.createUser(TEST_USER_EMAIL, 'password123', 'Test User');
      const conv = await db.createConversation(user.id, 'Test Conversation', 'test-model');

      const success = await db.setActiveBranch(
        'non-existent-message',
        conv.id,
        user.id,
        'some-branch'
      );

      expect(success).toBe(false);
    });

    it('should return false for non-existent branch', async () => {
      const user = await db.createUser(TEST_USER_EMAIL, 'password123', 'Test User');
      const conv = await db.createConversation(user.id, 'Test Conversation', 'test-model');

      const message = await db.createMessage(
        conv.id,
        user.id,
        'Test content',
        'user'
      );

      const success = await db.setActiveBranch(
        message.id,
        conv.id,
        user.id,
        'non-existent-branch'
      );

      expect(success).toBe(false);
    });
  });

  describe('Active Branch Persistence', () => {
    it('should update activeBranchId on message after setActiveBranch', async () => {
      // Create user, conversation, and message with branches
      const user = await db.createUser(TEST_USER_EMAIL, 'password123', 'Test User');
      const conv = await db.createConversation(user.id, 'Test Conversation', 'test-model');

      const message = await db.createMessage(
        conv.id,
        user.id,
        'First branch',
        'user'
      );

      const updatedMessage = await db.addMessageBranch(
        message.id,
        conv.id,
        user.id,
        'Second branch',
        'user'
      );

      const secondBranch = updatedMessage!.branches[updatedMessage!.branches.length - 1];

      // Set active branch
      await db.setActiveBranch(message.id, conv.id, user.id, secondBranch.id);

      // Load messages and verify active branch (same db instance)
      // Note: Conversation objects don't have messages - use getConversationMessages
      const messages = await db.getConversationMessages(conv.id, user.id);
      expect(messages.length).toBeGreaterThan(0);

      const loadedMessage = messages.find(m => m.id === message.id);
      expect(loadedMessage).toBeDefined();
      expect(loadedMessage!.activeBranchId).toBe(secondBranch.id);
    });

    it('should apply last active branch when switching multiple times', async () => {
      const user = await db.createUser(TEST_USER_EMAIL, 'password123', 'Test User');
      const conv = await db.createConversation(user.id, 'Test Conversation', 'test-model');

      const message = await db.createMessage(
        conv.id,
        user.id,
        'First branch',
        'user'
      );

      const msg2 = await db.addMessageBranch(
        message.id, conv.id, user.id,
        'Second branch', 'user'
      );
      expect(msg2).not.toBeNull();
      const branch2 = msg2!.branches[msg2!.branches.length - 1];

      const msg3 = await db.addMessageBranch(
        message.id, conv.id, user.id,
        'Third branch', 'user'
      );
      expect(msg3).not.toBeNull();
      const branch3 = msg3!.branches[msg3!.branches.length - 1];

      // Switch branches multiple times
      const result1 = await db.setActiveBranch(message.id, conv.id, user.id, branch2.id);
      expect(result1).toBe(true);
      const result2 = await db.setActiveBranch(message.id, conv.id, user.id, branch3.id);
      expect(result2).toBe(true);
      const result3 = await db.setActiveBranch(message.id, conv.id, user.id, branch2.id);
      expect(result3).toBe(true);

      // Verify the active branch is the last one set
      // Note: Conversation objects don't have messages - use getConversationMessages
      const messages = await db.getConversationMessages(conv.id, user.id);
      expect(messages.length).toBeGreaterThan(0);

      const loadedMessage = messages.find(m => m.id === message.id);
      expect(loadedMessage).toBeDefined();

      // Should be branch2 (the last one set)
      expect(loadedMessage!.activeBranchId).toBe(branch2.id);
    });
  });

  describe('changedByUserId tracking', () => {
    it('should include changedByUserId in event when provided', async () => {
      const user = await db.createUser(TEST_USER_EMAIL, 'password123', 'Test User');
      const conv = await db.createConversation(user.id, 'Test Conversation', 'test-model');

      const message = await db.createMessage(
        conv.id,
        user.id,
        'Test content',
        'user'
      );

      const updatedMessage = await db.addMessageBranch(
        message.id, conv.id, user.id,
        'Second branch', 'user'
      );
      const branch2 = updatedMessage!.branches[updatedMessage!.branches.length - 1];

      const changerUserId = 'another-user-id';
      await db.setActiveBranch(message.id, conv.id, user.id, branch2.id, changerUserId);

      // Verify changedByUserId was written to UIEventLog (.ui.jsonl)
      const uiFilePath = path.join(TEST_DATA_DIR, 'conversations',
        conv.id.substring(0, 2), conv.id.substring(2, 4), `${conv.id}.ui.jsonl`);
      const content = await fs.readFile(uiFilePath, 'utf-8');
      const uiEvents = content.trim().split('\n').map((l: string) => JSON.parse(l));
      const activeBranchEvent = uiEvents.find((e: any) =>
        e.type === 'active_branch_changed' && e.data.branchId === branch2.id
      );

      expect(activeBranchEvent).toBeDefined();
      expect(activeBranchEvent.changedByUserId).toBe(changerUserId);
    });
  });
});

/**
 * UIEventLog standalone tests (no Database needed)
 */
const UI_LOG_TEST_DIR = './data-test-ui-event-log';

describe('UIEventLog Compaction', () => {
  let uiLog: UIEventLog;

  beforeEach(async () => {
    try { await fs.rm(UI_LOG_TEST_DIR, { recursive: true, force: true }); } catch {}
    await fs.mkdir(UI_LOG_TEST_DIR, { recursive: true });
    uiLog = new UIEventLog(UI_LOG_TEST_DIR);
  });

  afterEach(async () => {
    try { await fs.rm(UI_LOG_TEST_DIR, { recursive: true, force: true }); } catch {}
  });

  it('should compact file to only latest state per messageId', async () => {
    const convId = 'ab12cd34-test-compact';

    // Write 100 events for 3 messages (switching back and forth)
    for (let i = 0; i < 100; i++) {
      const msgIndex = i % 3;
      await uiLog.setActiveBranch(convId, `msg-${msgIndex}`, `branch-${i}`);
    }

    // Check file has 100 lines before compact
    const filePath = path.join(UI_LOG_TEST_DIR, 'ab', '12', `${convId}.ui.jsonl`);
    const beforeContent = await fs.readFile(filePath, 'utf-8');
    const beforeLines = beforeContent.trim().split('\n').filter(l => l.trim());
    expect(beforeLines.length).toBe(100);

    // Compact
    await uiLog.compact(convId);

    // After compact: only 3 lines (one per unique messageId)
    const afterContent = await fs.readFile(filePath, 'utf-8');
    const afterLines = afterContent.trim().split('\n').filter(l => l.trim());
    expect(afterLines.length).toBe(3);

    // Each line should have the LAST branchId for that messageId
    const events = afterLines.map(l => JSON.parse(l));
    const msg0 = events.find((e: any) => e.data.messageId === 'msg-0');
    const msg1 = events.find((e: any) => e.data.messageId === 'msg-1');
    const msg2 = events.find((e: any) => e.data.messageId === 'msg-2');

    // Last write for msg-0: i=99 (99%3=0) → branch-99
    expect(msg0.data.branchId).toBe('branch-99');
    // Last write for msg-1: i=97 (97%3=1) → branch-97
    expect(msg1.data.branchId).toBe('branch-97');
    // Last write for msg-2: i=98 (98%3=2) → branch-98
    expect(msg2.data.branchId).toBe('branch-98');
  });

  it('should auto-compact after threshold writes when file exceeds size limit', async () => {
    const convId = 'ef56gh78-test-autocompact';

    // COMPACT_CHECK_INTERVAL = 50, COMPACT_THRESHOLD_BYTES = 50KB
    // Need each event > 1KB so 50 events > 50KB
    // JSON overhead: {"type":"active_branch_changed","ts":1234567890,"data":{"messageId":"msg-X","branchId":"..."}}
    // ~110 bytes overhead + branchId length
    const longBranchId = 'b'.repeat(1100); // ~1.2KB per event → 50 events ≈ 60KB > 50KB

    for (let i = 0; i < 55; i++) {
      await uiLog.setActiveBranch(convId, `msg-${i % 2}`, `${longBranchId}-${i}`);
    }

    // At write 50: check triggers, file ~60KB > 50KB threshold → compact
    // Compact reduces to 2 lines (2 unique messageIds), then writes 51-55 add 5 more
    const filePath = path.join(UI_LOG_TEST_DIR, 'ef', '56', `${convId}.ui.jsonl`);
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(l => l.trim());

    expect(lines.length).toBeLessThan(55);
    expect(lines.length).toBe(7); // 2 (compacted) + 5 (post-compact)
  });
});
