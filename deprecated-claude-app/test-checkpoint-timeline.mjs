#!/usr/bin/env node
/**
 * test-checkpoint-timeline.mjs
 *
 * Connects as a delegate via WebSocket, performs MCPL handshake,
 * and sends state mutations to trigger checkpoint creation.
 * Use this to test the Checkpoint Timeline view in the UI.
 *
 * Prerequisites:
 *   1. Backend running on localhost:3010
 *   2. A user account + JWT token (or dak_ API key)
 *   3. A conversation ID to target
 *
 * Usage:
 *   node test-checkpoint-timeline.mjs --token <JWT> --conversationId <UUID>
 *   node test-checkpoint-timeline.mjs --apiKey dak_xxx --conversationId <UUID>
 *
 * Quick start (uses default dev JWT secret):
 *   node test-checkpoint-timeline.mjs --userId <your-user-id> --conversationId <UUID>
 *
 * What it does:
 *   - Connects as delegate "checkpoint-tester"
 *   - Sends mcpl/hello → receives mcpl/ack (ReliableChannel established)
 *   - Sends 25 state mutations via mcpl/state_set (triggers ~2 checkpoints at interval=10)
 *   - Then does a mcpl/state_patch (triggers more mutations)
 *   - Waits, then queries checkpoint_list to verify
 *   - Open CheckpointPanel → Timeline tab in UI to see events
 */

import { WebSocket } from 'ws';
import jwt from 'jsonwebtoken';

// =============================================================================
// Configuration
// =============================================================================

const BACKEND_URL = process.env.BACKEND_URL || 'ws://localhost:3010';
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const DELEGATE_ID = 'checkpoint-tester';
const MCPL_PROTOCOL_VERSION = '1.0';

// Parse CLI args
const args = parseArgs(process.argv.slice(2));

const conversationId = args.conversationId;
if (!conversationId) {
  console.error('❌ Missing --conversationId <UUID>');
  console.error('');
  console.error('Usage:');
  console.error('  node test-checkpoint-timeline.mjs --userId <id> --conversationId <UUID>');
  console.error('  node test-checkpoint-timeline.mjs --token <JWT> --conversationId <UUID>');
  console.error('  node test-checkpoint-timeline.mjs --apiKey dak_xxx --conversationId <UUID>');
  process.exit(1);
}

// Resolve auth token
let authToken = args.token;
let apiKey = args.apiKey;

if (!authToken && !apiKey) {
  const userId = args.userId;
  if (!userId) {
    console.error('❌ Missing auth. Provide one of: --token, --apiKey, --userId');
    process.exit(1);
  }
  // Generate JWT from userId using default dev secret
  authToken = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '1h' });
  console.log(`🔑 Generated JWT for userId: ${userId}`);
}

// =============================================================================
// ReliableChannel (client-side, minimal)
// =============================================================================

class ClientReliableChannel {
  constructor(ws) {
    this.ws = ws;
    this.outSeq = 0;
    this.inSeq = 0;
    this.lastAckedSeq = 0;
    this.messageHandler = null;
    this.bareAckTimer = null;
  }

  /** Send a message wrapped in RC frame */
  send(message) {
    const seq = ++this.outSeq;
    const frame = { seq, ack: this.inSeq, payload: message };
    this.ws.send(JSON.stringify(frame));

    // Cancel pending bare ack (piggybacked)
    if (this.bareAckTimer) {
      clearTimeout(this.bareAckTimer);
      this.bareAckTimer = null;
    }
  }

  /** Handle raw incoming message (JSON-parsed) */
  handleIncoming(raw) {
    // Non-frame message → pass through (pre-RC messages like delegate_auth_result)
    if (typeof raw.seq !== 'number') {
      this.messageHandler?.(raw);
      return;
    }

    const frame = raw;

    // Process ack
    if (frame.ack > this.lastAckedSeq) {
      this.lastAckedSeq = frame.ack;
    }

    // Bare ack (seq=0) or no payload → done
    if (frame.seq === 0 || !frame.payload) return;

    // Duplicate → ignore
    if (frame.seq <= this.inSeq) return;

    // In-order delivery
    if (frame.seq === this.inSeq + 1) {
      this.inSeq = frame.seq;
      this.messageHandler?.(frame.payload);
      this.scheduleBareAck();
    }
    // Out-of-order: for this test script, we skip reordering (unlikely in localhost)
  }

  scheduleBareAck() {
    if (this.bareAckTimer) return;
    this.bareAckTimer = setTimeout(() => {
      this.bareAckTimer = null;
      try {
        this.ws.send(JSON.stringify({ seq: 0, ack: this.inSeq }));
      } catch { /* closing */ }
    }, 50);
  }

  onMessage(handler) {
    this.messageHandler = handler;
  }
}

// =============================================================================
// Main Flow
// =============================================================================

async function main() {
  console.log('');
  console.log('🧪 Checkpoint Timeline Test Script');
  console.log('===================================');
  console.log(`Backend:        ${BACKEND_URL}`);
  console.log(`Delegate ID:    ${DELEGATE_ID}`);
  console.log(`Conversation:   ${conversationId}`);
  console.log(`Auth method:    ${apiKey ? 'API Key' : 'JWT'}`);
  console.log('');

  // Build WS URL
  const wsUrl = new URL(BACKEND_URL);
  wsUrl.searchParams.set('delegateId', DELEGATE_ID);
  if (apiKey) {
    wsUrl.searchParams.set('apiKey', apiKey);
  } else {
    wsUrl.searchParams.set('token', authToken);
  }

  console.log('📡 Connecting to WebSocket...');
  const ws = new WebSocket(wsUrl.toString());

  // ReliableChannel instance (created after mcpl/ack)
  let rc = null;
  let sessionId = null;

  // Promise wrappers for sequential flow
  const waitForAuth = createDeferred();
  const waitForAck = createDeferred();

  ws.on('open', () => {
    console.log('✅ WebSocket connected');
  });

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      console.error('⚠️  Malformed message:', data.toString().slice(0, 200));
      return;
    }

    // Before RC is established, messages are bare JSON
    if (!rc) {
      handlePreRcMessage(msg);
    } else {
      rc.handleIncoming(msg);
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`🔌 WebSocket closed (${code}: ${reason?.toString() || 'no reason'})`);
    process.exit(code === 1000 ? 0 : 1);
  });

  ws.on('error', (err) => {
    console.error('❌ WebSocket error:', err.message);
    process.exit(1);
  });

  // ---- Pre-RC message handler ----
  function handlePreRcMessage(msg) {
    switch (msg.type) {
      case 'delegate_auth_result':
        if (msg.success) {
          console.log(`✅ Authenticated (userId: ${msg.userId}, session: ${msg.sessionId})`);
          sessionId = msg.sessionId;
          waitForAuth.resolve();
        } else {
          console.error(`❌ Auth failed: ${msg.error}`);
          waitForAuth.reject(new Error(msg.error));
        }
        break;

      default:
        // Could be RC-framed mcpl/ack (the first framed response after hello)
        if (typeof msg.seq === 'number' && msg.payload?.type === 'mcpl/ack') {
          // Server sends mcpl/ack as first RC frame
          const ack = msg.payload;
          console.log(`✅ MCPL handshake complete (session: ${ack.sessionId})`);
          console.log(`   Capabilities: ${ack.negotiatedCapabilities?.join(', ') || 'none'}`);

          // Initialize RC now
          rc = new ClientReliableChannel(ws);
          rc.inSeq = msg.seq; // acknowledge this first frame
          rc.scheduleBareAck();

          rc.onMessage((innerMsg) => {
            handleRcMessage(innerMsg);
          });

          waitForAck.resolve(ack);
        } else {
          console.log('📩 Pre-RC message:', msg.type || JSON.stringify(msg).slice(0, 100));
        }
    }
  }

  // ---- Post-RC message handler ----
  const pendingResponses = new Map(); // requestId → deferred

  function handleRcMessage(msg) {
    const type = msg.type;
    // Check for pending requestId-based responses
    if (msg.requestId && pendingResponses.has(msg.requestId)) {
      pendingResponses.get(msg.requestId).resolve(msg);
      pendingResponses.delete(msg.requestId);
      return;
    }
    console.log(`📩 RC message: ${type}`, JSON.stringify(msg).slice(0, 200));
  }

  function sendRcAndWait(message, timeoutMs = 10000) {
    const deferred = createDeferred();
    pendingResponses.set(message.requestId, deferred);

    rc.send(message);

    const timer = setTimeout(() => {
      pendingResponses.delete(message.requestId);
      deferred.reject(new Error(`Timeout waiting for response to ${message.type} (requestId: ${message.requestId})`));
    }, timeoutMs);

    return deferred.promise.finally(() => clearTimeout(timer));
  }

  // ---- Sequential flow ----

  // 1. Wait for auth
  await waitForAuth.promise;

  // 2. Send mcpl/hello (BARE, before RC)
  console.log('');
  console.log('🤝 Sending mcpl/hello...');
  ws.send(JSON.stringify({
    type: 'mcpl/hello',
    protocolVersion: MCPL_PROTOCOL_VERSION,
    capabilities: [],
    delegateId: DELEGATE_ID,
    delegateName: 'Checkpoint Tester',
  }));

  // 3. Wait for mcpl/ack (handled in handlePreRcMessage)
  await waitForAck.promise;

  // 4. Send state mutations to trigger checkpoints
  console.log('');
  console.log('📝 Sending state mutations (CHECKPOINT_INTERVAL=10)...');
  console.log('');

  const TOTAL_MUTATIONS = 25;
  const BATCH_DELAY_MS = 100; // ms between mutations

  for (let i = 1; i <= TOTAL_MUTATIONS; i++) {
    const state = {
      counter: i,
      lastUpdated: new Date().toISOString(),
      testData: `mutation-${i}`,
      nested: {
        value: i * 10,
        label: `Step ${i} of ${TOTAL_MUTATIONS}`,
      },
    };

    rc.send({
      type: 'mcpl/state_set',
      requestId: `state-set-${i}`,
      conversationId,
      state,
    });

    // Log checkpoint boundaries
    if (i % 10 === 0) {
      console.log(`  ✅ Mutation ${i}/${TOTAL_MUTATIONS} — 🔖 CHECKPOINT should trigger here`);
    } else if (i % 5 === 0) {
      console.log(`  📝 Mutation ${i}/${TOTAL_MUTATIONS}`);
    }

    await sleep(BATCH_DELAY_MS);
  }

  console.log('');
  console.log(`✅ Sent ${TOTAL_MUTATIONS} state_set mutations`);

  // 5. Send a few state_patch mutations (different mutation type)
  console.log('');
  console.log('🔧 Sending state_patch mutations...');

  for (let i = 1; i <= 5; i++) {
    const response = await sendRcAndWait({
      type: 'mcpl/state_patch',
      requestId: `patch-${i}`,
      conversationId,
      patch: [
        { op: 'replace', path: '/counter', value: TOTAL_MUTATIONS + i },
        { op: 'add', path: `/patch_${i}`, value: `Applied patch ${i}` },
      ],
    });

    const status = response.success ? '✅' : '❌';
    console.log(`  ${status} Patch ${i}/5 — ${response.success ? 'success' : response.error}`);
    await sleep(BATCH_DELAY_MS);
  }

  console.log('');
  console.log(`✅ Sent 5 state_patch mutations (total: ${TOTAL_MUTATIONS + 5})`);

  // 6. Wait a moment for persistence
  console.log('');
  console.log('⏳ Waiting 2s for event persistence...');
  await sleep(2000);

  // 7. Query checkpoint list to verify
  console.log('');
  console.log('📋 Querying checkpoint list...');

  const checkpointList = await sendRcAndWait({
    type: 'mcpl/checkpoint_list',
    requestId: 'verify-checkpoints',
    conversationId,
  });

  console.log(`   Current node: ${checkpointList.current || '(none)'}`);
  console.log(`   Total checkpoints: ${checkpointList.checkpoints?.length || 0}`);

  if (checkpointList.checkpoints?.length > 0) {
    console.log('');
    console.log('   Checkpoint tree:');
    for (const cp of checkpointList.checkpoints) {
      const marker = cp.isCurrent ? ' ← CURRENT' : '';
      const label = cp.label ? ` "${cp.label}"` : '';
      const parent = cp.parent ? ` (parent: ${cp.parent})` : ' (root)';
      console.log(`     ${cp.id}${label}${parent} — ${cp.mutationCount ?? '?'} mutations${marker}`);
    }
  }

  // 8. Done!
  console.log('');
  console.log('========================================');
  console.log('✅ Test complete!');
  console.log('');
  console.log('Now open the UI:');
  console.log(`  1. Navigate to conversation ${conversationId}`);
  console.log('  2. Open the Checkpoint Panel (branch icon in header)');
  console.log('  3. Click the Timeline tab (clock icon)');
  console.log('  4. You should see checkpoint events listed newest-first');
  console.log('');
  console.log('To trigger more checkpoints, run this script again.');
  console.log('========================================');

  // Clean disconnect
  ws.close(1000, 'test complete');
}

// =============================================================================
// Utilities
// =============================================================================

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--') && i + 1 < argv.length) {
      const key = arg.slice(2);
      result[key] = argv[++i];
    }
  }
  return result;
}

function createDeferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// =============================================================================
// Run
// =============================================================================

main().catch((err) => {
  console.error('');
  console.error('❌ Fatal error:', err.message);
  process.exit(1);
});
