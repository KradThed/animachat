import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { Database } from '../index.js';

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
    it('should create active_branch_changed event in conversation store', async () => {
      // Create a user and conversation with a message that has multiple branches
      const user = await db.createUser(TEST_USER_EMAIL, 'password123');
      const conv = await db.createConversation(user.id, 'Test Conversation');

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

      // Verify event was written
      const events = await (db as any).conversationEventStore.loadEvents(conv.id);
      const activeBranchEvent = events.find((e: any) =>
        e.type === 'active_branch_changed' && e.data.messageId === message.id
      );

      expect(activeBranchEvent).toBeDefined();
      expect(activeBranchEvent.data.branchId).toBe(secondBranch.id);
    });

    it('should return false for non-existent message', async () => {
      const user = await db.createUser(TEST_USER_EMAIL, 'password123');
      const conv = await db.createConversation(user.id, 'Test Conversation');

      const success = await db.setActiveBranch(
        'non-existent-message',
        conv.id,
        user.id,
        'some-branch'
      );

      expect(success).toBe(false);
    });

    it('should return false for non-existent branch', async () => {
      const user = await db.createUser(TEST_USER_EMAIL, 'password123');
      const conv = await db.createConversation(user.id, 'Test Conversation');

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
      const user = await db.createUser(TEST_USER_EMAIL, 'password123');
      const conv = await db.createConversation(user.id, 'Test Conversation');

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
      const user = await db.createUser(TEST_USER_EMAIL, 'password123');
      const conv = await db.createConversation(user.id, 'Test Conversation');

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
      const user = await db.createUser(TEST_USER_EMAIL, 'password123');
      const conv = await db.createConversation(user.id, 'Test Conversation');

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

      const events = await (db as any).conversationEventStore.loadEvents(conv.id);
      const activeBranchEvent = events.find((e: any) =>
        e.type === 'active_branch_changed' && e.data.branchId === branch2.id
      );

      expect(activeBranchEvent.data.changedByUserId).toBe(changerUserId);
    });
  });
});
