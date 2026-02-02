/**
 * Webhook Server
 *
 * Express HTTP server that receives external events (GitLab, GitHub, etc.)
 * and forwards them as trigger_inference messages to the Animachat server.
 */

import express from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { randomUUID } from 'crypto';
import type { DelegateConnection } from './connection.js';
import type { WebhookEndpoint } from './types.js';

// =============================================================================
// Types
// =============================================================================

interface ParsedPayload {
  context: Record<string, unknown>;
  systemMessage: string;
}

// =============================================================================
// WebhookServer
// =============================================================================

export class WebhookServer {
  private app: express.Application;
  private httpServer: ReturnType<typeof this.app.listen> | null = null;
  private connection: DelegateConnection;

  constructor(connection: DelegateConnection) {
    this.connection = connection;
    this.app = express();
    this.app.use(express.json({ limit: '1mb' }));
    this.app.use(express.text({ type: 'text/*', limit: '1mb' }));
  }

  /**
   * Start the webhook HTTP server.
   */
  start(port: number, endpoints: WebhookEndpoint[]): void {
    // Health check
    this.app.get('/health', (_req, res) => {
      res.json({ status: 'ok', endpoints: endpoints.length });
    });

    // Register each configured endpoint
    for (const endpoint of endpoints) {
      this.registerEndpoint(endpoint);
    }

    this.httpServer = this.app.listen(port, () => {
      console.log(`[Webhooks] Listening on port ${port}`);
      for (const ep of endpoints) {
        console.log(`[Webhooks]   ${ep.source}: POST ${ep.path}`);
      }
    });
  }

  /**
   * Stop the webhook server.
   */
  stop(): void {
    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
      console.log('[Webhooks] Server stopped');
    }
  }

  // --------------------------------------------------------------------------
  // Private
  // --------------------------------------------------------------------------

  private registerEndpoint(endpoint: WebhookEndpoint): void {
    this.app.post(endpoint.path, (req, res) => {
      // Signature verification
      if (endpoint.secret) {
        const valid = this.verifySignature(
          endpoint.source,
          endpoint.secret,
          typeof req.body === 'string' ? req.body : JSON.stringify(req.body),
          req.headers as Record<string, string>
        );
        if (!valid) {
          console.warn(`[Webhooks] Signature verification failed for ${endpoint.source}`);
          res.status(401).json({ error: 'Invalid signature' });
          return;
        }
      }

      // Check if delegate is connected
      if (!this.connection.isConnected) {
        console.warn(`[Webhooks] Received ${endpoint.source} event but not connected to server`);
        res.status(503).json({ error: 'Delegate not connected' });
        return;
      }

      // Parse payload
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const parsed = this.parsePayload(
        endpoint.source,
        body,
        req.headers as Record<string, string>
      );

      // Send trigger
      const triggerId = randomUUID();
      this.connection.sendTriggerInference({
        triggerId,
        source: `${endpoint.source}_webhook`,
        conversationId: endpoint.conversation_id,
        participantId: endpoint.participant_id,
        context: parsed.context,
        systemMessage: parsed.systemMessage,
      });

      console.log(`[Webhooks] Forwarded ${endpoint.source} event as trigger ${triggerId}`);
      res.json({ accepted: true, triggerId });
    });
  }

  private parsePayload(
    source: string,
    body: Record<string, unknown>,
    headers: Record<string, string>
  ): ParsedPayload {
    switch (source) {
      case 'gitlab':
        return this.parseGitLabPayload(body, headers);
      case 'github':
        return this.parseGitHubPayload(body, headers);
      default:
        return this.parseGenericPayload(source, body);
    }
  }

  private parseGitLabPayload(
    body: Record<string, unknown>,
    headers: Record<string, string>
  ): ParsedPayload {
    const eventType = headers['x-gitlab-event'] || 'unknown';
    const project = body.project as Record<string, unknown> | undefined;
    const projectName = project?.name || 'unknown';

    // Push event
    if (eventType === 'Push Hook') {
      const ref = (body.ref as string || '').replace('refs/heads/', '');
      const commits = body.commits as Array<Record<string, unknown>> || [];
      const commitSummaries = commits.slice(0, 5).map(c => ({
        id: (c.id as string || '').substring(0, 8),
        message: c.message,
        author: (c.author as Record<string, unknown>)?.name,
      }));

      return {
        context: {
          event: 'push',
          project: projectName,
          branch: ref,
          commits: commitSummaries,
          totalCommits: body.total_commits_count,
          pusher: (body.user_name as string) || 'unknown',
        },
        systemMessage:
          `GitLab push event: ${commits.length} commit(s) pushed to ${ref} in ${projectName} ` +
          `by ${body.user_name || 'unknown'}. Review the changes and provide feedback.`,
      };
    }

    // Merge Request event
    if (eventType === 'Merge Request Hook') {
      const attrs = body.object_attributes as Record<string, unknown> || {};
      return {
        context: {
          event: 'merge_request',
          project: projectName,
          title: attrs.title,
          description: attrs.description,
          sourceBranch: attrs.source_branch,
          targetBranch: attrs.target_branch,
          state: attrs.state,
          action: attrs.action,
          url: attrs.url,
          author: (body.user as Record<string, unknown>)?.name,
        },
        systemMessage:
          `GitLab merge request event in ${projectName}: "${attrs.title}" ` +
          `(${attrs.source_branch} → ${attrs.target_branch}). ` +
          `Action: ${attrs.action}. Review and provide feedback.`,
      };
    }

    // Fallback
    return {
      context: { event: eventType, project: projectName, raw: body },
      systemMessage: `GitLab ${eventType} in ${projectName}. Analyze and respond.`,
    };
  }

  private parseGitHubPayload(
    body: Record<string, unknown>,
    headers: Record<string, string>
  ): ParsedPayload {
    const eventType = headers['x-github-event'] || 'unknown';
    const repo = body.repository as Record<string, unknown> | undefined;
    const repoName = (repo?.full_name as string) || 'unknown';

    // Push event
    if (eventType === 'push') {
      const ref = (body.ref as string || '').replace('refs/heads/', '');
      const commits = body.commits as Array<Record<string, unknown>> || [];
      const commitSummaries = commits.slice(0, 5).map(c => ({
        id: (c.id as string || '').substring(0, 8),
        message: c.message,
        author: (c.author as Record<string, unknown>)?.name,
      }));

      return {
        context: {
          event: 'push',
          repo: repoName,
          branch: ref,
          commits: commitSummaries,
          pusher: (body.pusher as Record<string, unknown>)?.name || 'unknown',
        },
        systemMessage:
          `GitHub push: ${commits.length} commit(s) to ${ref} in ${repoName}. ` +
          `Review the changes and provide feedback.`,
      };
    }

    // Pull Request event
    if (eventType === 'pull_request') {
      const pr = body.pull_request as Record<string, unknown> || {};
      const head = pr.head as Record<string, unknown> || {};
      const base = pr.base as Record<string, unknown> || {};
      return {
        context: {
          event: 'pull_request',
          repo: repoName,
          action: body.action,
          title: pr.title,
          body: pr.body,
          sourceBranch: head.ref,
          targetBranch: base.ref,
          url: pr.html_url,
          author: (pr.user as Record<string, unknown>)?.login,
        },
        systemMessage:
          `GitHub PR in ${repoName}: "${pr.title}" (${head.ref} → ${base.ref}). ` +
          `Action: ${body.action}. Review and provide feedback.`,
      };
    }

    // Fallback
    return {
      context: { event: eventType, repo: repoName, action: body.action, raw: body },
      systemMessage: `GitHub ${eventType} in ${repoName}. Analyze and respond.`,
    };
  }

  private parseGenericPayload(
    source: string,
    body: Record<string, unknown>
  ): ParsedPayload {
    return {
      context: { source, payload: body },
      systemMessage:
        `External event received from ${source}. ` +
        `Analyze the payload and respond appropriately.`,
    };
  }

  private verifySignature(
    source: string,
    secret: string,
    body: string,
    headers: Record<string, string>
  ): boolean {
    try {
      if (source === 'gitlab') {
        // GitLab uses a simple token comparison via X-Gitlab-Token header
        const token = headers['x-gitlab-token'];
        if (!token) return false;
        return token === secret;
      }

      if (source === 'github') {
        // GitHub uses HMAC-SHA256 via X-Hub-Signature-256 header
        const signature = headers['x-hub-signature-256'];
        if (!signature) return false;

        const expected = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
        const expectedBuf = Buffer.from(expected);
        const signatureBuf = Buffer.from(signature);

        if (expectedBuf.length !== signatureBuf.length) return false;
        return timingSafeEqual(expectedBuf, signatureBuf);
      }

      // For unknown sources, skip verification
      return true;
    } catch (error) {
      console.error(`[Webhooks] Signature verification error:`, error);
      return false;
    }
  }
}
