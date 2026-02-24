import express from 'express';
import compression from 'compression';
import { clearOpenRouterLog } from './utils/openrouterLogger.js';

// Clean up old OpenRouter request logs on startup
clearOpenRouterLog();
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { createServer as createHttpServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { authRouter } from './routes/auth.js';
import { conversationRouter } from './routes/conversations.js';
import { modelRouter } from './routes/models.js';
import { customModelsRouter } from './routes/custom-models.js';
import { participantRouter } from './routes/participants.js';
import { importRouter } from './routes/import.js';
import { systemRouter } from './routes/system.js';
import { createPromptRouter } from './routes/prompt.js';
import { createShareRouter } from './routes/shares.js';
import { publicModelRouter } from './routes/public-models.js';
import { ModelLoader } from './config/model-loader.js';
import { createBookmarksRouter } from './routes/bookmarks.js';
import { createInvitesRouter } from './routes/invites.js';
import { adminRouter } from './routes/admin.js';
import { collaborationRouter } from './routes/collaboration.js';
import { personaRouter } from './routes/personas.js';
import avatarRouter from './routes/avatars.js';
import blobRouter from './routes/blobs.js';
import siteConfigRouter from './routes/site-config.js';
import { toolsRouter } from './routes/tools.js';
import { delegatesRouter } from './routes/delegates.js';
import { websocketHandler, startEvictionTimer } from './websocket/handler.js';
// Import server tools for side-effect registration
import './tools/server-tools.js';
import { Database } from './database/index.js';
import { initBlobStore } from './database/blob-store.js';
import { authenticateToken } from './middleware/auth.js';
import { OpenRouterService } from './services/openrouter.js';
import { updateOpenRouterModelsCache, setOpenRouterRefreshCallback } from './services/pricing-cache.js';

dotenv.config();

const app = express();

// Initialize database
const db = new Database();

// HTTPS configuration
const USE_HTTPS = process.env.USE_HTTPS === 'true';
const PORT = process.env.PORT || 3010;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;

// Create appropriate server
let server: ReturnType<typeof createHttpServer> | ReturnType<typeof createHttpsServer>;
if (USE_HTTPS) {
  // Check for SSL certificate files
  const certPath = process.env.SSL_CERT_PATH || path.join(process.cwd(), 'certs', 'cert.pem');
  const keyPath = process.env.SSL_KEY_PATH || path.join(process.cwd(), 'certs', 'key.pem');
  const caPath = process.env.SSL_CA_PATH || path.join(process.cwd(), 'certs', 'ca.pem');

  if (!existsSync(certPath) || !existsSync(keyPath)) {
    console.error('SSL certificate files not found! Please ensure the following files exist:');
    console.error(`  - Certificate: ${certPath}`);
    console.error(`  - Private Key: ${keyPath}`);
    console.error('\nFor development, you can generate self-signed certificates with:');
    console.error('  npm run generate-cert');
    process.exit(1);
  }

  // HTTPS options
  const httpsOptions: any = {
    cert: readFileSync(certPath),
    key: readFileSync(keyPath)
  };

  // Include CA bundle if it exists
  if (existsSync(caPath)) {
    httpsOptions.ca = readFileSync(caPath);
  }

  server = createHttpsServer(httpsOptions, app);
} else {
  server = createHttpServer(app);
}

const wss = new WebSocketServer({ 
  server,
  // Enable per-message deflate compression for large messages
  perMessageDeflate: {
    zlibDeflateOptions: {
      // Use maximum compression level for slow connections
      level: 6, // 1-9, higher = more compression but slower
    },
    zlibInflateOptions: {
      chunkSize: 10 * 1024
    },
    // Compress messages larger than 1KB
    threshold: 1024,
    // Don't limit concurrent decompression
    concurrencyLimit: 10,
  }
});
console.log('[WebSocket] Per-message deflate compression enabled (threshold: 1KB)');

// Middleware
// Enable gzip/deflate compression for HTTP responses
app.use(compression({
  // Compress responses larger than 1KB
  threshold: 1024,
  // Compression level (1-9, higher = more compression)
  level: 6,
  // Don't compress if client doesn't support it
  filter: (req, res) => {
    if (req.headers['x-no-compression']) {
      return false;
    }
    return compression.filter(req, res);
  }
}));
console.log('[HTTP] Gzip compression enabled (threshold: 1KB)');

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Routes
app.use('/api/auth', authRouter(db));
app.use('/api/public/models', publicModelRouter());
app.use('/api/conversations', authenticateToken, conversationRouter(db));
// Mount custom models BEFORE general models to prevent /:id catching /custom
app.use('/api/models/custom', authenticateToken, customModelsRouter(db));
app.use('/api/models', authenticateToken, modelRouter(db));
app.use('/api/participants', authenticateToken, participantRouter(db));
app.use('/api/import', authenticateToken, importRouter(db));
app.use('/api/prompt', createPromptRouter(db));
app.use('/api/shares', createShareRouter(db));
app.use('/api/bookmarks', createBookmarksRouter(db));
app.use('/api/invites', createInvitesRouter(db));
app.use('/api/admin', adminRouter(db));
app.use('/api/collaboration', collaborationRouter(db));
app.use('/api/personas', authenticateToken, personaRouter(db));
app.use('/api/avatars', authenticateToken, avatarRouter);
app.use('/api/blobs', blobRouter); // No auth - blobs are served by ID (content-addressed)
app.use('/api/system', systemRouter());
app.use('/api/site-config', siteConfigRouter); // No auth - public site configuration
app.use('/api/tools', authenticateToken, toolsRouter({ db })); // Tool registry, delegate status, API keys
app.use('/api/delegates', delegatesRouter(db)); // Delegate entities, PKCE auth, keys (auth per-route)

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Analytics endpoint for stuck generation debugging
app.post('/api/analytics/stuck-generation', authenticateToken, (req: any, res) => {
  try {
    const data = req.body;
    const userId = req.userId;
    
    // Log the stuck generation report
    console.log('=== STUCK GENERATION REPORT ===');
    console.log('User ID:', userId);
    console.log('Timestamp:', data.timestamp);
    console.log('Streaming started:', data.streamingStartTime);
    console.log('Elapsed (ms):', data.elapsedMs);
    console.log('Conversation ID:', data.conversationId);
    console.log('Streaming Message ID:', data.streamingMessageId);
    console.log('First token received:', data.firstTokenReceived);
    console.log('WebSocket connected:', data.wsConnected);
    console.log('User Agent:', data.userAgent);
    console.log('URL:', data.currentUrl);
    console.log('Console logs (last 100):');
    if (data.consoleLogs && Array.isArray(data.consoleLogs)) {
      data.consoleLogs.forEach((log: string) => console.log('  ', log));
    }
    console.log('=== END STUCK GENERATION REPORT ===');
    
    res.json({ success: true, message: 'Report received' });
  } catch (error) {
    console.error('Error processing stuck generation report:', error);
    res.status(500).json({ error: 'Failed to process report' });
  }
});

// WebSocket handling
wss.on('connection', (ws, req) => {
  websocketHandler(ws, req, db);
});

// INF-4+5: Periodically evict idle conversations to prevent memory leaks
startEvictionTimer(db);

// Start server
async function startServer() {
  try {
    // Initialize database
    await db.init();
    console.log('Database initialized');

    // Initialize blob storage for images
    await initBlobStore();
    console.log('BlobStore initialized');
    
    // Initialize ModelLoader with database
    const modelLoader = ModelLoader.getInstance();
    modelLoader.setDatabase(db);
    console.log('ModelLoader initialized with database');

    // Initialize MCPL services with database
    const { mcplEventQueue } = await import('./services/mcpl-event-queue.js');
    mcplEventQueue.setDatabase(db);
    const { mcplInferenceBroker } = await import('./services/mcpl-inference-broker.js');
    mcplInferenceBroker.setDatabase(db);
    const { registerMcplManagementTools } = await import('./tools/mcpl-management-tools.js');
    registerMcplManagementTools(db);
    const { mcplStateManager } = await import('./services/mcpl-state-manager.js');
    mcplStateManager.setDatabase(db);
    const { mcplHookManager } = await import('./services/mcpl-hook-manager.js');

    // Wire replay callback for inference budget (dependency inversion — no circular imports)
    let warnedMissingUserId = false;
    db.onReplayEvent('inference_request_completed', (data) => {
      if (!data._userId) {
        if (!warnedMissingUserId) {
          console.warn('[Replay] inference_request_completed without userId — skipping rate limit restore');
          warnedMissingUserId = true;
        }
        return;
      }
      const ts = new Date(data.timestamp).getTime();
      if (ts > Date.now() - 60 * 60 * 1000) {
        mcplInferenceBroker.addCompletedTimestamp(data._userId, ts);
      }
    });

    // Wire replay callback for scope policies (dependency inversion)
    const { setScopePolicy } = await import('./delegate/delegate-handler.js');
    db.onReplayEvent('scope_policy_updated', (data) => {
      if (data._userId && data.delegateId && data.policy) {
        setScopePolicy(data._userId, data.delegateId, data.policy);
      }
    });

    db.onReplayEvent('checkpoint_tree_updated', (data) => {
      // Replay rebuilds tree structure + state snapshots (approach a)
      mcplStateManager.replayCheckpointEvent(data);
    });

    console.log('MCPL services initialized with database');

    // Initialize sub-agent system
    const { BranchEventStore } = await import('./database/branch-event-store.js');
    const {
      LLMClientAdapter,
      SubAgentContextBuilder,
      SubAgentManager,
      NotificationBus,
      SystemTurnTrigger,
      registerSubAgentTools,
    } = await import('./sub-agents/index.js');

    const branchStore = new BranchEventStore();
    await branchStore.init();
    _branchStore = branchStore;

    // H4: LLM client adapter wraps the enhanced inference service
    // Use MembraneInferenceService (same as handler.ts) for native tool support
    const { EnhancedInferenceService } = await import('./services/enhanced-inference.js');
    const { MembraneInferenceService } = await import('./services/membrane-inference.js');
    const { ContextManager } = await import('./services/context-manager.js');
    const baseInference = new MembraneInferenceService(db);
    const contextManager = ContextManager.getInstance();
    contextManager.setDatabase(db);
    const enhancedInference = new EnhancedInferenceService(baseInference, contextManager);
    const llmClient = new LLMClientAdapter(enhancedInference);

    // Context builder
    const contextBuilder = new SubAgentContextBuilder(db, branchStore);

    // Notification bus
    const { roomManager } = await import('./websocket/room-manager.js');
    const notificationBus = new NotificationBus();
    notificationBus.bridgeToWebSocket(roomManager);

    // System turn trigger
    const systemTurnTrigger = new SystemTurnTrigger(db, llmClient, roomManager);
    notificationBus.bridgeToInferenceTrigger(systemTurnTrigger);

    // Resource coordinator for write tool locking (prevents concurrent file corruption)
    const { ResourceCoordinator } = await import('./services/resource-coordinator.js');
    const resourceCoordinator = new ResourceCoordinator();
    _resourceCoordinator = resourceCoordinator;

    // Sub-agent manager (BUG 4: pass mcplHookManager for sub-agent inference hooks)
    const subAgentManager = new SubAgentManager(
      llmClient, contextBuilder, branchStore, notificationBus, db,
      resourceCoordinator, mcplHookManager,
    );
    await subAgentManager.recoverOrphanedTasks();
    // SA-2: recoverStaleGroups moved to per-conversation recovery in loadConversation().
    // At startup, groups Map is empty (conversations not yet loaded), so global recovery finds nothing.

    // Register sub-agent tools
    registerSubAgentTools(subAgentManager);

    // Wire frozen parent gate to handler
    const { setSubAgentManager } = await import('./websocket/handler.js');
    setSubAgentManager(subAgentManager);

    // Round 5: Wire SubAgentManager for lifecycle event routing during conversation replay
    db.setSubAgentManager(subAgentManager);

    console.log('Sub-agent system initialized');

    // Pre-populate OpenRouter pricing cache and register lazy refresh callback
    const openRouterService = new OpenRouterService(db);
    
    // Register refresh callback for lazy loading if cache is empty
    setOpenRouterRefreshCallback(async () => {
      const models = await openRouterService.listModels();
      updateOpenRouterModelsCache(models);
    });
    
    try {
      console.log('Pre-populating OpenRouter pricing cache...');
      const openRouterModels = await openRouterService.listModels();
      updateOpenRouterModelsCache(openRouterModels);
      console.log(`✅ OpenRouter pricing cache ready with ${openRouterModels.length} models`);
    } catch (error: any) {
      console.error('⚠️ PRICING WARNING: Failed to pre-populate OpenRouter pricing cache.');
      console.error('   OpenRouter models will be fetched on-demand when needed.');
      console.error('   This usually means OPENROUTER_API_KEY is not set or invalid.');
      console.error('   Error:', error?.message || error);
    }
    
    const listenPort = Number(USE_HTTPS ? HTTPS_PORT : PORT);
    const protocol = USE_HTTPS ? 'HTTPS' : 'HTTP';
    
    const HOST = process.env.HOST || '0.0.0.0';
    server.listen(listenPort, HOST, () => {
      console.log(`${protocol} Server running on ${HOST}:${listenPort}`);
      console.log(`${USE_HTTPS ? 'Secure WebSocket (WSS)' : 'WebSocket'} server ready`);
      if (USE_HTTPS) {
        console.log(`API endpoint: https://${HOST}:${listenPort}/api`);
        console.log(`WebSocket endpoint: wss://${HOST}:${listenPort}`);
      } else {
        console.log(`API endpoint: http://${HOST}:${listenPort}/api`);
        console.log(`WebSocket endpoint: ws://${HOST}:${listenPort}`);
      }
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
// References for shutdown (set during startServer)
let _branchStore: { close(): Promise<void> } | null = null;
let _resourceCoordinator: { destroy(): void } | null = null;

async function gracefulShutdown(signal: string) {
  console.log(`${signal} received. Shutting down gracefully...`);
  _resourceCoordinator?.destroy();
  await _branchStore?.close();
  await db.close();
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

startServer();
