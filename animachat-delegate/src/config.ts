/**
 * Config loader - reads and validates delegate configuration from YAML.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import YAML from 'yaml';
import { DelegateConfigSchema, type DelegateConfig } from './types.js';

/**
 * Resolve environment variable references in strings.
 * Replaces ${VAR_NAME} with the value of process.env.VAR_NAME.
 */
function resolveEnvVars(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{(\w+)\}/g, (_, varName) => {
      return process.env[varName] || '';
    });
  }
  if (Array.isArray(value)) {
    return value.map(resolveEnvVars);
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = resolveEnvVars(v);
    }
    return result;
  }
  return value;
}

/**
 * Load and validate config from a YAML file path.
 */
export function loadConfig(configPath: string): DelegateConfig {
  const resolved = resolve(configPath);

  if (!existsSync(resolved)) {
    throw new Error(`Config file not found: ${resolved}`);
  }

  const raw = readFileSync(resolved, 'utf-8');
  const parsed = YAML.parse(raw);

  // Resolve environment variables
  const withEnv = resolveEnvVars(parsed);

  // Validate
  const result = DelegateConfigSchema.safeParse(withEnv);
  if (!result.success) {
    const errors = result.error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid config:\n${errors}`);
  }

  return result.data;
}

/**
 * Find config file from common locations.
 */
export function findConfigPath(explicit?: string): string {
  if (explicit) return explicit;

  const candidates = [
    './delegate.yaml',
    './delegate.yml',
    './config/delegate.yaml',
    './config/delegate.yml',
  ];

  for (const candidate of candidates) {
    if (existsSync(resolve(candidate))) {
      return candidate;
    }
  }

  throw new Error(
    'No config file found. Create delegate.yaml or specify with --config.\n' +
    'See config/delegate.example.yaml for an example.'
  );
}
