/**
 * MCPL Inference Routing
 *
 * JSON config-driven routing for inference requests.
 * Different conversations/delegates can route to different models/providers.
 *
 * Design:
 *   - Config file: ./config/inference-routing.json
 *   - Periodic reload (30s mtime check, no fs.watch for Docker/NFS reliability)
 *   - First-match-wins rule evaluation (like nginx/Apache)
 *   - featureSet is the PRIMARY routing key per spec
 *   - Uses matchesPattern() from mcpl-wildcard for wildcard matching
 *   - Parse error → keep previous config, log error (never crash)
 *   - Default: useConversationModel → resolve() returns null, caller uses conversation model
 *   - Model validation: rules with unknown models are skipped at load time
 */

import { readFile, stat } from 'fs/promises';
import { join, resolve } from 'path';
import { matchesPattern } from '../services/mcpl-wildcard.js';
import { ModelLoader } from './model-loader.js';

// =============================================================================
// Types
// =============================================================================

export interface InferenceRoute {
  provider: string;
  model: string;
}

export interface RoutingRule {
  match: {
    featureSet?: string;    // PRIMARY routing key (per spec). Wildcard via matchesPattern()
    delegateId?: string;    // supports wildcard via matchesPattern()
    serverId?: string;      // supports wildcard via matchesPattern()
    tag?: string;           // future use
  };
  route: InferenceRoute;
}

interface DefaultRouteConfig {
  useConversationModel?: boolean;  // true → resolve() returns null
  provider?: string;
  model?: string;
}

interface RoutingConfig {
  rules: RoutingRule[];
  default: DefaultRouteConfig;
}

// =============================================================================
// InferenceRouter
// =============================================================================

export class InferenceRouter {
  private rules: RoutingRule[] = [];
  private defaultConfig: DefaultRouteConfig;
  private reloadInterval: ReturnType<typeof setInterval> | null = null;
  private configPath: string;
  private lastConfigMtime: number = 0;

  constructor(configPath?: string) {
    // Default: ./config/inference-routing.json relative to project root
    this.configPath = configPath || resolve(
      join(process.cwd(), 'config', 'inference-routing.json')
    );
    // Default: use conversation model (resolve() returns null)
    this.defaultConfig = {
      useConversationModel: true,
    };
  }

  /**
   * Load config from disk. Called on startup + periodic reload.
   * Parse error → keep previous config, log error.
   * Unknown models in rules → skip rule with warning.
   */
  async loadConfig(): Promise<void> {
    try {
      const content = await readFile(this.configPath, 'utf-8');
      const config = JSON.parse(content) as RoutingConfig;

      // Validate basic structure
      if (!config.default) {
        console.warn('[InferenceRouter] Invalid config: missing default, keeping previous');
        return;
      }

      // Validate default — must have either useConversationModel or provider+model
      if (!config.default.useConversationModel && (!config.default.provider || !config.default.model)) {
        console.warn('[InferenceRouter] Invalid config: default must have useConversationModel or provider+model, keeping previous');
        return;
      }

      // Validate rules — skip rules with unknown models
      const modelLoader = ModelLoader.getInstance();
      const validRules: RoutingRule[] = [];
      for (const rule of (config.rules || [])) {
        if (!rule.route?.model || !rule.route?.provider) {
          console.warn(`[InferenceRouter] Skipping rule with missing route: ${JSON.stringify(rule.match)}`);
          continue;
        }
        const model = await modelLoader.getModelById(rule.route.model);
        if (!model) {
          console.warn(`[InferenceRouter] Unknown model "${rule.route.model}" in rule matching ${JSON.stringify(rule.match)}, skipping`);
          continue;
        }
        validRules.push(rule);
      }

      this.rules = validRules;
      this.defaultConfig = config.default;

      // Update mtime
      const s = await stat(this.configPath);
      this.lastConfigMtime = s.mtimeMs;

      const defaultDesc = this.defaultConfig.useConversationModel
        ? 'useConversationModel'
        : `${this.defaultConfig.provider}/${this.defaultConfig.model}`;
      console.log(`[InferenceRouter] Loaded config: ${this.rules.length} rules, default: ${defaultDesc}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        console.log('[InferenceRouter] No config file found, using defaults');
      } else {
        console.warn('[InferenceRouter] Failed to load config, keeping previous:', err instanceof Error ? err.message : err);
      }
    }
  }

  /**
   * Start periodic config reload (checks mtime before re-reading).
   * Default interval: 30 seconds.
   */
  startPeriodicReload(intervalMs = 30_000): void {
    if (this.reloadInterval) return;

    this.reloadInterval = setInterval(async () => {
      try {
        const s = await stat(this.configPath);
        if (s.mtimeMs > this.lastConfigMtime) {
          console.log('[InferenceRouter] Config file changed, reloading...');
          await this.loadConfig();
        }
      } catch {
        // File missing or inaccessible — keep current config
      }
    }, intervalMs);

    console.log(`[InferenceRouter] Periodic reload started (${intervalMs}ms interval)`);
  }

  /**
   * Resolve route for a request.
   *
   * featureSet is the PRIMARY match key (per spec).
   * Rules evaluated in order — FIRST MATCH WINS (like nginx/Apache).
   * User is responsible for ordering rules by specificity.
   *
   * Returns null when default is useConversationModel — caller should use conversation.model.
   */
  resolve(context: {
    featureSet?: string;
    delegateId: string;
    serverId: string;
    tags?: string[];
  }): InferenceRoute | null {
    for (const rule of this.rules) {
      if (this.matchesRule(rule, context)) {
        return rule.route;
      }
    }

    // Default: useConversationModel → return null (caller uses conversation model)
    if (this.defaultConfig.useConversationModel) {
      return null;
    }

    // Explicit default route
    return {
      provider: this.defaultConfig.provider!,
      model: this.defaultConfig.model!,
    };
  }

  /**
   * Get current rules count (for stats).
   */
  getRulesCount(): number {
    return this.rules.length;
  }

  /**
   * Cleanup: stop periodic reload.
   */
  stop(): void {
    if (this.reloadInterval) {
      clearInterval(this.reloadInterval);
      this.reloadInterval = null;
      console.log('[InferenceRouter] Periodic reload stopped');
    }
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  /**
   * Check if a rule matches the given context.
   * All specified match keys must match (AND semantics).
   */
  private matchesRule(
    rule: RoutingRule,
    context: { featureSet?: string; delegateId: string; serverId: string; tags?: string[] }
  ): boolean {
    const { match } = rule;

    // featureSet match (PRIMARY key)
    if (match.featureSet) {
      if (!context.featureSet || !matchesPattern(match.featureSet, context.featureSet)) {
        return false;
      }
    }

    // delegateId match
    if (match.delegateId) {
      if (!matchesPattern(match.delegateId, context.delegateId)) {
        return false;
      }
    }

    // serverId match
    if (match.serverId) {
      if (!matchesPattern(match.serverId, context.serverId)) {
        return false;
      }
    }

    // tag match (future use)
    if (match.tag) {
      if (!context.tags || !context.tags.includes(match.tag)) {
        return false;
      }
    }

    return true;
  }
}

// Singleton instance
export const inferenceRouter = new InferenceRouter();
