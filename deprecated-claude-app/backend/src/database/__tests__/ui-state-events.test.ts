import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { Database } from '../index.js';

/**
 * Tests for UI State Event Sourcing
 *
 * These tests verify that UI state is correctly persisted via events
 * and survives server restarts.
 */

const TEST_DATA_DIR = './data-test';
const TEST_USER_ID = 'test-user-ui-state';
const TEST_CONVERSATION_ID = 'test-conv-ui-state';
const TEST_MESSAGE_ID = 'test-msg-ui-state';
const TEST_BRANCH_ID_1 = 'test-branch-1';
const TEST_BRANCH_ID_2 = 'test-branch-2';
const TEST_PARTICIPANT_ID = 'test-participant-1';

describe('UI State Events', () => {
  let db: Database;

  beforeEach(async () => {
    // Clean up test data directory
    try {
      await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
    } catch (e) {
      // Ignore if doesn't exist
    }

    // Create fresh database with test data directory
    db = new Database();
    // Override data paths for testing
    (db as any).eventStore.filePath = path.join(TEST_DATA_DIR, 'mainEvents.jsonl');
    (db as any).userEventStore.baseDir = path.join(TEST_DATA_DIR, 'users');
    (db as any).conversationEventStore.baseDir = path.join(TEST_DATA_DIR, 'conversations');
    (db as any).uiStateStore.sharedBaseDir = path.join(TEST_DATA_DIR, 'conversation-state');
    (db as any).uiStateStore.userBaseDir = path.join(TEST_DATA_DIR, 'user-conversation-state');

    await db.init();
  });

  afterEach(async () => {
    await db.close();
    // Clean up
    try {
      await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
    } catch (e) {
      // Ignore
    }
  });

  describe('User Speaking As', () => {
    it('should persist speakingAs via event', async () => {
      // Set speaking as
      await db.setUserSpeakingAs(TEST_CONVERSATION_ID, TEST_USER_ID, TEST_PARTICIPANT_ID);

      // Verify in-memory state
      const state = await db.getUserConversationState(TEST_CONVERSATION_ID, TEST_USER_ID);
      expect(state.speakingAs).toBe(TEST_PARTICIPANT_ID);
    });

    it('should clear speakingAs when set to undefined', async () => {
      // Set and then clear
      await db.setUserSpeakingAs(TEST_CONVERSATION_ID, TEST_USER_ID, TEST_PARTICIPANT_ID);
      await db.setUserSpeakingAs(TEST_CONVERSATION_ID, TEST_USER_ID, undefined);

      const state = await db.getUserConversationState(TEST_CONVERSATION_ID, TEST_USER_ID);
      expect(state.speakingAs).toBeUndefined();
    });
  });

  describe('User Selected Responder', () => {
    it('should persist selectedResponder via event', async () => {
      await db.setUserSelectedResponder(TEST_CONVERSATION_ID, TEST_USER_ID, TEST_PARTICIPANT_ID);

      const state = await db.getUserConversationState(TEST_CONVERSATION_ID, TEST_USER_ID);
      expect(state.selectedResponder).toBe(TEST_PARTICIPANT_ID);
    });
  });

  describe('User Detached Mode', () => {
    it('should persist isDetached via event', async () => {
      await db.setUserDetached(TEST_CONVERSATION_ID, TEST_USER_ID, true);

      const state = await db.getUserConversationState(TEST_CONVERSATION_ID, TEST_USER_ID);
      expect(state.isDetached).toBe(true);
    });

    it('should clear detachedBranches when re-attaching', async () => {
      // Detach and set a branch
      await db.setUserDetached(TEST_CONVERSATION_ID, TEST_USER_ID, true);
      await db.setUserDetachedBranch(TEST_CONVERSATION_ID, TEST_USER_ID, TEST_MESSAGE_ID, TEST_BRANCH_ID_1);

      // Re-attach
      await db.setUserDetached(TEST_CONVERSATION_ID, TEST_USER_ID, false);

      const state = await db.getUserConversationState(TEST_CONVERSATION_ID, TEST_USER_ID);
      expect(state.isDetached).toBe(false);
      expect(state.detachedBranches).toEqual({});
    });
  });

  describe('User Detached Branch', () => {
    it('should persist detachedBranch via event', async () => {
      await db.setUserDetachedBranch(TEST_CONVERSATION_ID, TEST_USER_ID, TEST_MESSAGE_ID, TEST_BRANCH_ID_1);

      const state = await db.getUserConversationState(TEST_CONVERSATION_ID, TEST_USER_ID);
      expect(state.detachedBranches?.[TEST_MESSAGE_ID]).toBe(TEST_BRANCH_ID_1);
    });

    it('should update detachedBranch for same message', async () => {
      await db.setUserDetachedBranch(TEST_CONVERSATION_ID, TEST_USER_ID, TEST_MESSAGE_ID, TEST_BRANCH_ID_1);
      await db.setUserDetachedBranch(TEST_CONVERSATION_ID, TEST_USER_ID, TEST_MESSAGE_ID, TEST_BRANCH_ID_2);

      const state = await db.getUserConversationState(TEST_CONVERSATION_ID, TEST_USER_ID);
      expect(state.detachedBranches?.[TEST_MESSAGE_ID]).toBe(TEST_BRANCH_ID_2);
    });
  });

  describe('Branches Read Tracking', () => {
    it('should persist readBranchIds via event', async () => {
      await db.markBranchesAsRead(TEST_CONVERSATION_ID, TEST_USER_ID, [TEST_BRANCH_ID_1, TEST_BRANCH_ID_2]);

      const readIds = await db.getReadBranchIds(TEST_CONVERSATION_ID, TEST_USER_ID);
      expect(readIds).toContain(TEST_BRANCH_ID_1);
      expect(readIds).toContain(TEST_BRANCH_ID_2);
    });

    it('should accumulate readBranchIds (set union)', async () => {
      await db.markBranchesAsRead(TEST_CONVERSATION_ID, TEST_USER_ID, [TEST_BRANCH_ID_1]);
      await db.markBranchesAsRead(TEST_CONVERSATION_ID, TEST_USER_ID, [TEST_BRANCH_ID_2]);

      const readIds = await db.getReadBranchIds(TEST_CONVERSATION_ID, TEST_USER_ID);
      expect(readIds).toHaveLength(2);
      expect(readIds).toContain(TEST_BRANCH_ID_1);
      expect(readIds).toContain(TEST_BRANCH_ID_2);
    });

    it('should not duplicate readBranchIds', async () => {
      await db.markBranchesAsRead(TEST_CONVERSATION_ID, TEST_USER_ID, [TEST_BRANCH_ID_1]);
      await db.markBranchesAsRead(TEST_CONVERSATION_ID, TEST_USER_ID, [TEST_BRANCH_ID_1]);

      const readIds = await db.getReadBranchIds(TEST_CONVERSATION_ID, TEST_USER_ID);
      expect(readIds).toHaveLength(1);
    });

    it('should set lastReadAt timestamp', async () => {
      const before = new Date();
      await db.markBranchesAsRead(TEST_CONVERSATION_ID, TEST_USER_ID, [TEST_BRANCH_ID_1]);
      const after = new Date();

      const state = await db.getUserConversationState(TEST_CONVERSATION_ID, TEST_USER_ID);
      expect(state.lastReadAt).toBeDefined();

      const readAt = new Date(state.lastReadAt!);
      expect(readAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(readAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });
  });

  describe('State Isolation', () => {
    it('should isolate state between users', async () => {
      const USER_2 = 'test-user-2';

      await db.setUserSpeakingAs(TEST_CONVERSATION_ID, TEST_USER_ID, 'participant-a');
      await db.setUserSpeakingAs(TEST_CONVERSATION_ID, USER_2, 'participant-b');

      const state1 = await db.getUserConversationState(TEST_CONVERSATION_ID, TEST_USER_ID);
      const state2 = await db.getUserConversationState(TEST_CONVERSATION_ID, USER_2);

      expect(state1.speakingAs).toBe('participant-a');
      expect(state2.speakingAs).toBe('participant-b');
    });

    it('should isolate state between conversations', async () => {
      const CONV_2 = 'test-conv-2';

      await db.setUserSpeakingAs(TEST_CONVERSATION_ID, TEST_USER_ID, 'participant-a');
      await db.setUserSpeakingAs(CONV_2, TEST_USER_ID, 'participant-b');

      const state1 = await db.getUserConversationState(TEST_CONVERSATION_ID, TEST_USER_ID);
      const state2 = await db.getUserConversationState(CONV_2, TEST_USER_ID);

      expect(state1.speakingAs).toBe('participant-a');
      expect(state2.speakingAs).toBe('participant-b');
    });
  });
});

describe('State Persistence Across Restart', () => {
  const TEST_DATA_DIR_PERSIST = './data-test-persist';

  afterEach(async () => {
    try {
      await fs.rm(TEST_DATA_DIR_PERSIST, { recursive: true, force: true });
    } catch (e) {
      // Ignore
    }
  });

  it('should persist UI state across database restart', async () => {
    // First database instance
    const db1 = new Database();
    (db1 as any).eventStore.filePath = path.join(TEST_DATA_DIR_PERSIST, 'mainEvents.jsonl');
    (db1 as any).userEventStore.baseDir = path.join(TEST_DATA_DIR_PERSIST, 'users');
    (db1 as any).conversationEventStore.baseDir = path.join(TEST_DATA_DIR_PERSIST, 'conversations');
    (db1 as any).uiStateStore.sharedBaseDir = path.join(TEST_DATA_DIR_PERSIST, 'conversation-state');
    (db1 as any).uiStateStore.userBaseDir = path.join(TEST_DATA_DIR_PERSIST, 'user-conversation-state');

    await db1.init();

    // Set some state
    await db1.setUserSpeakingAs('conv-1', 'user-1', 'participant-x');
    await db1.setUserDetached('conv-1', 'user-1', true);
    await db1.markBranchesAsRead('conv-1', 'user-1', ['branch-a', 'branch-b']);

    // Close first instance
    await db1.close();

    // Create second database instance (simulating restart)
    const db2 = new Database();
    (db2 as any).eventStore.filePath = path.join(TEST_DATA_DIR_PERSIST, 'mainEvents.jsonl');
    (db2 as any).userEventStore.baseDir = path.join(TEST_DATA_DIR_PERSIST, 'users');
    (db2 as any).conversationEventStore.baseDir = path.join(TEST_DATA_DIR_PERSIST, 'conversations');
    (db2 as any).uiStateStore.sharedBaseDir = path.join(TEST_DATA_DIR_PERSIST, 'conversation-state');
    (db2 as any).uiStateStore.userBaseDir = path.join(TEST_DATA_DIR_PERSIST, 'user-conversation-state');

    await db2.init();

    // Verify state was restored
    const state = await db2.getUserConversationState('conv-1', 'user-1');
    expect(state.speakingAs).toBe('participant-x');
    expect(state.isDetached).toBe(true);

    const readIds = await db2.getReadBranchIds('conv-1', 'user-1');
    expect(readIds).toContain('branch-a');
    expect(readIds).toContain('branch-b');

    await db2.close();
  });
});
