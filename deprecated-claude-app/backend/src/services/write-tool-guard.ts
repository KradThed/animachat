/**
 * Write Tool Guard
 *
 * Wraps tool execution with write locks from ResourceCoordinator.
 * Only write tools (writeFile, deleteFile, etc.) acquire locks.
 * Read tools pass through without locking.
 *
 * Tool name format: "{delegateName}__{toolName}" (e.g. "filesystem__write_file").
 * Lock key format: "{userId}:{delegateName}:{normalizedPath}".
 */

import path from 'path';
import type { ResourceCoordinator } from './resource-coordinator.js';
import type { ToolCall, ToolResult } from '../tools/tool-registry.js';

// =============================================================================
// Write tool detection
// =============================================================================

/** Base names (after __ separator) that are write operations. */
const WRITE_TOOL_BASE_NAMES = new Set([
  'write_file', 'writeFile',
  'append_file', 'appendFile',
  'create_file', 'createFile',
  'delete_file', 'deleteFile',
  'rename_file', 'renameFile',
  'move_file', 'moveFile',
  'edit_file', 'editFile',
  'patch_file', 'patchFile',
]);

/** Path argument names to check (in priority order). */
const PATH_ARG_NAMES = ['path', 'filePath', 'file_path', 'oldPath', 'old_path', 'source'];

function getBaseName(toolName: string): string {
  const sep = toolName.indexOf('__');
  return sep >= 0 ? toolName.slice(sep + 2) : toolName;
}

function getDelegateName(toolName: string): string {
  const sep = toolName.indexOf('__');
  return sep >= 0 ? toolName.slice(0, sep) : 'local';
}

function isWriteTool(toolName: string): boolean {
  return WRITE_TOOL_BASE_NAMES.has(getBaseName(toolName));
}

function extractPath(input: Record<string, unknown>): string | null {
  for (const argName of PATH_ARG_NAMES) {
    const val = input[argName];
    if (typeof val === 'string' && val.length > 0) {
      return path.normalize(val);
    }
  }
  return null;
}

// =============================================================================
// Guard factory
// =============================================================================

/**
 * Wrap a raw executeToolCall with write locks.
 * Only sub-agent tool calls go through this — parent chat is sequential.
 */
export function createGuardedExecuteTool(
  userId: string,
  coordinator: ResourceCoordinator,
  rawExecute: (toolCall: ToolCall) => Promise<ToolResult>,
): (toolCall: ToolCall) => Promise<ToolResult> {
  return async (toolCall: ToolCall): Promise<ToolResult> => {
    if (!isWriteTool(toolCall.name)) {
      // Read tool or unknown — no lock
      return rawExecute(toolCall);
    }

    const resourcePath = extractPath(toolCall.input ?? {});
    if (!resourcePath) {
      // Can't determine path — execute without lock, log warning
      console.warn(
        `[WriteToolGuard] Can't extract path from ${toolCall.name}`,
        Object.keys(toolCall.input ?? {}),
      );
      return rawExecute(toolCall);
    }

    const delegateName = getDelegateName(toolCall.name);
    const lockKey = `${userId}:${delegateName}:${resourcePath}`;

    return coordinator.withLock(lockKey, () => rawExecute(toolCall));
  };
}
