import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { Database } from '../index.js';

/**
 * Tests for UI State Migration from JSON to Event-Sourced storage
 *
 * These tests verify:
 * 1. Migration correctly reads JSON files and creates events
 * 2. Migration is idempotent (safe to run multiple times)
 * 3. Migration validates data and handles errors gracefully
 */

const TEST_DATA_DIR = './data-test-migration';

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

// Helper to set up conversation events (messages with branches)
async function setupConversationEvents(conversationId: string, messages: Array<{id: string, branches: Array<{id: string}>}>) {
  const eventsDir = path.join(TEST_DATA_DIR, 'conversations', conversationId.substring(0, 2), conversationId.substring(2, 4));
  await fs.mkdir(eventsDir, { recursive: true });

  const events = messages.map(msg => ({
    timestamp: new Date().toISOString(),
    type: 'message_created',
    data: {
      id: msg.id,
      conversationId,
      branches: msg.branches.map(b => ({
        id: b.id,
        content: 'test content',
        role: 'user',
        createdAt: new Date().toISOString()
      }))
    }
  }));

  const content = events.map(e => JSON.stringify(e)).join('\n') + '\n';
  await fs.writeFile(path.join(eventsDir, `${conversationId}.jsonl`), content);
}

// Helper to create shared JSON state file
async function createSharedStateFile(conversationId: string, state: { activeBranches: Record<string, string> }) {
  const stateDir = path.join(TEST_DATA_DIR, 'conversation-state', conversationId.substring(0, 2));
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    path.join(stateDir, `${conversationId}.json`),
    JSON.stringify(state, null, 2)
  );
}

// Helper to create user JSON state file
async function createUserStateFile(conversationId: string, userId: string, state: any) {
  const stateDir = path.join(TEST_DATA_DIR, 'user-conversation-state', conversationId.substring(0, 2), conversationId);
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    path.join(stateDir, `${userId}.json`),
    JSON.stringify(state, null, 2)
  );
}

describe('UI State Migration', () => {
  beforeEach(async () => {
    try {
      await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
    } catch (e) {
      // Ignore
    }
    await fs.mkdir(TEST_DATA_DIR, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
    } catch (e) {
      // Ignore
    }
  });

  describe('Shared State Migration (activeBranches)', () => {
    it('should migrate activeBranches to active_branch_changed events', async () => {
      const CONV_ID = 'ab12cd34-test-conv-1';
      const MSG_ID = 'msg-001';
      const BRANCH_ID = 'branch-001';

      // Setup: Create conversation events and JSON state
      await setupConversationEvents(CONV_ID, [
        { id: MSG_ID, branches: [{ id: BRANCH_ID }, { id: 'branch-002' }] }
      ]);
      await createSharedStateFile(CONV_ID, {
        activeBranches: { [MSG_ID]: BRANCH_ID }
      });

      // Run migration
      const db = await createTestDatabase();
      await db.init();
      await (db as any).migrateUIStateFromJSON();

      // Verify: Load conversation and check activeBranchId
      // We need to manually replay conversation events to verify
      const events = await (db as any).conversationEventStore.loadEvents(CONV_ID);
      const activeBranchEvent = events.find((e: any) =>
        e.type === 'active_branch_changed' && e.data.messageId === MSG_ID
      );

      expect(activeBranchEvent).toBeDefined();
      expect(activeBranchEvent.data.branchId).toBe(BRANCH_ID);
      expect(activeBranchEvent.data.isMigration).toBe(true);

      await db.close();
    });

    it('should skip migration if marker already exists (idempotency)', async () => {
      const CONV_ID = 'ab12cd34-test-conv-2';

      await setupConversationEvents(CONV_ID, [
        { id: 'msg-1', branches: [{ id: 'branch-1' }] }
      ]);
      await createSharedStateFile(CONV_ID, {
        activeBranches: { 'msg-1': 'branch-1' }
      });

      // First migration
      const db1 = await createTestDatabase();
      await db1.init();
      await (db1 as any).migrateUIStateFromJSON();

      const summary1 = (db1 as any).migrationSummary;
      expect(summary1.shared.migratedCount).toBe(1);
      expect(summary1.shared.skippedCount).toBe(0);

      await db1.close();

      // Second migration (should skip)
      const db2 = await createTestDatabase();
      await db2.init();
      await (db2 as any).migrateUIStateFromJSON();

      const summary2 = (db2 as any).migrationSummary;
      expect(summary2.shared.migratedCount).toBe(0);
      expect(summary2.shared.skippedCount).toBe(1);

      await db2.close();
    });

    it('should handle missing message gracefully', async () => {
      const CONV_ID = 'ab12cd34-test-conv-3';

      // Setup: JSON references non-existent message
      await setupConversationEvents(CONV_ID, [
        { id: 'existing-msg', branches: [{ id: 'branch-1' }] }
      ]);
      await createSharedStateFile(CONV_ID, {
        activeBranches: { 'non-existent-msg': 'branch-x' }
      });

      const db = await createTestDatabase();
      await db.init();
      await (db as any).migrateUIStateFromJSON();

      const summary = (db as any).migrationSummary;
      expect(summary.errors.missingMessages).toBe(1);

      await db.close();
    });

    it('should fallback to first branch if specified branch not found', async () => {
      const CONV_ID = 'ab12cd34-test-conv-4';
      const MSG_ID = 'msg-1';
      const EXISTING_BRANCH = 'existing-branch';

      await setupConversationEvents(CONV_ID, [
        { id: MSG_ID, branches: [{ id: EXISTING_BRANCH }] }
      ]);
      await createSharedStateFile(CONV_ID, {
        activeBranches: { [MSG_ID]: 'non-existent-branch' }
      });

      const db = await createTestDatabase();
      await db.init();
      await (db as any).migrateUIStateFromJSON();

      const summary = (db as any).migrationSummary;
      expect(summary.errors.missingBranches).toBe(1);
      expect(summary.errors.fallbacksApplied).toBe(1);

      // Verify fallback was applied
      const events = await (db as any).conversationEventStore.loadEvents(CONV_ID);
      const activeBranchEvent = events.find((e: any) =>
        e.type === 'active_branch_changed' && e.data.messageId === MSG_ID
      );
      expect(activeBranchEvent.data.branchId).toBe(EXISTING_BRANCH);

      await db.close();
    });
  });

  describe('User State Migration', () => {
    it('should migrate all user state fields', async () => {
      const CONV_ID = 'ab12cd34-test-conv-5';
      const USER_ID = 'user-123';

      await createUserStateFile(CONV_ID, USER_ID, {
        speakingAs: 'participant-1',
        selectedResponder: 'participant-2',
        isDetached: true,
        detachedBranches: { 'msg-1': 'branch-1' },
        readBranchIds: ['branch-a', 'branch-b'],
        lastReadAt: '2024-01-01T00:00:00Z'
      });

      const db = await createTestDatabase();
      await db.init();
      await (db as any).migrateUIStateFromJSON();

      // Verify state was migrated
      const state = await db.getUserConversationState(CONV_ID, USER_ID);
      expect(state.speakingAs).toBe('participant-1');
      expect(state.selectedResponder).toBe('participant-2');
      expect(state.isDetached).toBe(true);
      expect(state.detachedBranches?.['msg-1']).toBe('branch-1');
      expect(state.readBranchIds).toContain('branch-a');
      expect(state.readBranchIds).toContain('branch-b');

      await db.close();
    });

    it('should skip user migration if marker already exists', async () => {
      const CONV_ID = 'ab12cd34-test-conv-6';
      const USER_ID = 'user-456';

      await createUserStateFile(CONV_ID, USER_ID, {
        speakingAs: 'participant-x'
      });

      // First migration
      const db1 = await createTestDatabase();
      await db1.init();
      await (db1 as any).migrateUIStateFromJSON();

      expect((db1 as any).migrationSummary.user.migratedCount).toBe(1);
      await db1.close();

      // Second migration
      const db2 = await createTestDatabase();
      await db2.init();
      await (db2 as any).migrateUIStateFromJSON();

      expect((db2 as any).migrationSummary.user.migratedCount).toBe(0);
      expect((db2 as any).migrationSummary.user.skippedCount).toBe(1);
      await db2.close();
    });

    it('should handle corrupted JSON gracefully', async () => {
      const CONV_ID = 'ab12cd34-test-conv-7';
      const USER_ID = 'user-789';

      // Create corrupted JSON
      const stateDir = path.join(TEST_DATA_DIR, 'user-conversation-state', CONV_ID.substring(0, 2), CONV_ID);
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(path.join(stateDir, `${USER_ID}.json`), '{ invalid json }');

      const db = await createTestDatabase();
      await db.init();
      await (db as any).migrateUIStateFromJSON();

      expect((db as any).migrationSummary.errors.jsonParseErrors).toBe(1);

      await db.close();
    });
  });

  describe('Branch Index Builder', () => {
    it('should correctly track message creation', async () => {
      const CONV_ID = 'ab12test-branch-index-1';

      await setupConversationEvents(CONV_ID, [
        { id: 'msg-1', branches: [{ id: 'b1' }, { id: 'b2' }] },
        { id: 'msg-2', branches: [{ id: 'b3' }] }
      ]);

      const db = await createTestDatabase();
      await db.init();

      const index = await (db as any).buildBranchIndexForMigration(CONV_ID);

      expect(index.get('msg-1')?.has('b1')).toBe(true);
      expect(index.get('msg-1')?.has('b2')).toBe(true);
      expect(index.get('msg-2')?.has('b3')).toBe(true);

      await db.close();
    });

    it('should handle message_branch_added events', async () => {
      const CONV_ID = 'ab12test-branch-index-2';

      // Create events file manually to include branch_added
      const eventsDir = path.join(TEST_DATA_DIR, 'conversations', CONV_ID.substring(0, 2), CONV_ID.substring(2, 4));
      await fs.mkdir(eventsDir, { recursive: true });

      const events = [
        {
          timestamp: new Date().toISOString(),
          type: 'message_created',
          data: { id: 'msg-1', conversationId: CONV_ID, branches: [{ id: 'b1', content: '', role: 'user', createdAt: new Date().toISOString() }] }
        },
        {
          timestamp: new Date().toISOString(),
          type: 'message_branch_added',
          data: { messageId: 'msg-1', branch: { id: 'b2', content: '', role: 'assistant', createdAt: new Date().toISOString() } }
        }
      ];

      await fs.writeFile(
        path.join(eventsDir, `${CONV_ID}.jsonl`),
        events.map(e => JSON.stringify(e)).join('\n') + '\n'
      );

      const db = await createTestDatabase();
      await db.init();

      const index = await (db as any).buildBranchIndexForMigration(CONV_ID);

      expect(index.get('msg-1')?.has('b1')).toBe(true);
      expect(index.get('msg-1')?.has('b2')).toBe(true);

      await db.close();
    });

    it('should handle message_branch_deleted events', async () => {
      const CONV_ID = 'ab12test-branch-index-3';

      const eventsDir = path.join(TEST_DATA_DIR, 'conversations', CONV_ID.substring(0, 2), CONV_ID.substring(2, 4));
      await fs.mkdir(eventsDir, { recursive: true });

      const events = [
        {
          timestamp: new Date().toISOString(),
          type: 'message_created',
          data: { id: 'msg-1', conversationId: CONV_ID, branches: [{ id: 'b1', content: '', role: 'user', createdAt: new Date().toISOString() }, { id: 'b2', content: '', role: 'user', createdAt: new Date().toISOString() }] }
        },
        {
          timestamp: new Date().toISOString(),
          type: 'message_branch_deleted',
          data: { messageId: 'msg-1', branchId: 'b1' }
        }
      ];

      await fs.writeFile(
        path.join(eventsDir, `${CONV_ID}.jsonl`),
        events.map(e => JSON.stringify(e)).join('\n') + '\n'
      );

      const db = await createTestDatabase();
      await db.init();

      const index = await (db as any).buildBranchIndexForMigration(CONV_ID);

      expect(index.get('msg-1')?.has('b1')).toBe(false);
      expect(index.get('msg-1')?.has('b2')).toBe(true);

      await db.close();
    });

    it('should handle message_deleted events', async () => {
      const CONV_ID = 'ab12test-branch-index-4';

      const eventsDir = path.join(TEST_DATA_DIR, 'conversations', CONV_ID.substring(0, 2), CONV_ID.substring(2, 4));
      await fs.mkdir(eventsDir, { recursive: true });

      const events = [
        {
          timestamp: new Date().toISOString(),
          type: 'message_created',
          data: { id: 'msg-1', conversationId: CONV_ID, branches: [{ id: 'b1', content: '', role: 'user', createdAt: new Date().toISOString() }] }
        },
        {
          timestamp: new Date().toISOString(),
          type: 'message_deleted',
          data: { messageId: 'msg-1', conversationId: CONV_ID }
        }
      ];

      await fs.writeFile(
        path.join(eventsDir, `${CONV_ID}.jsonl`),
        events.map(e => JSON.stringify(e)).join('\n') + '\n'
      );

      const db = await createTestDatabase();
      await db.init();

      const index = await (db as any).buildBranchIndexForMigration(CONV_ID);

      expect(index.has('msg-1')).toBe(false);

      await db.close();
    });
  });
});
