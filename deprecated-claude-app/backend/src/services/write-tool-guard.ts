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

/** Path argument names to check (in priority order). BUG T-3: expanded from 6 to cover common MCP conventions. */
const PATH_ARG_NAMES = [
  'path', 'filePath', 'file_path',
  'oldPath', 'old_path', 'source',
  'filename', 'fileName', 'file_name',
  'target', 'targetPath', 'target_path',
  'destination', 'destinationPath', 'destination_path',
  'uri', 'contentPath', 'content_path',
  'outputPath', 'output_path', 'output',
];

/** BUG T-4: Destination argument names for rename/move operations. */
const DEST_ARG_NAMES = [
  'newPath', 'new_path', 'destination', 'destPath', 'dest_path',
  'target', 'targetPath', 'target_path', 'to',
];

/** BUG T-4: Tool base names that operate on source + destination paths. */
const RENAME_MOVE_BASES = new Set([
  'rename_file', 'renameFile', 'move_file', 'moveFile',
]);

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

/** BUG T-4: Extract destination path for rename/move operations. */
function extractDestPath(input: Record<string, unknown>): string | null {
  for (const argName of DEST_ARG_NAMES) {
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
    const delegateName = getDelegateName(toolCall.name);

    if (!resourcePath) {
      // BUG T-3: Can't determine path — use coarse tool-level lock instead of no lock
      const coarseLockKey = `${userId}:${delegateName}:__no_path__${getBaseName(toolCall.name)}`;
      console.warn(
        `[WriteToolGuard] Can't extract path from ${toolCall.name} — using tool-level lock`,
        Object.keys(toolCall.input ?? {}),
      );
      return coordinator.withLock(coarseLockKey, () => rawExecute(toolCall));
    }

    const lockKey = `${userId}:${delegateName}:${resourcePath}`;

    // BUG T-4: For rename/move, also lock the destination path
    const baseName = getBaseName(toolCall.name);
    if (RENAME_MOVE_BASES.has(baseName)) {
      const destPath = extractDestPath(toolCall.input ?? {});
      if (destPath) {
        const destKey = `${userId}:${delegateName}:${destPath}`;
        // Acquire both locks in sorted order to prevent deadlock
        const [first, second] = [lockKey, destKey].sort();
        return coordinator.withLock(first, () =>
          coordinator.withLock(second, () => rawExecute(toolCall))
        );
      }
    }

    return coordinator.withLock(lockKey, () => rawExecute(toolCall));
  };
}
