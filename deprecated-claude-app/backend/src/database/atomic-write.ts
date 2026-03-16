import fs from 'fs/promises';

/**
 * Safer atomic-style JSON write for Windows (NTFS).
 * Uses unique temp path to avoid concurrent-write collisions.
 * Backup + rollback pattern from ui-event-log.ts:272.
 *
 * Fixes crash corruption (bare fs.writeFile → truncated JSON).
 * Does NOT fix concurrent writer races (read-modify-write without CAS).
 */
export async function atomicWriteJSON(filePath: string, data: unknown): Promise<void> {
  const tmpPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  const bakPath = `${filePath}.bak`;

  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2));

  try {
    try { await fs.unlink(bakPath); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    try { await fs.rename(filePath, bakPath); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    try {
      await fs.rename(tmpPath, filePath);
    } catch (e) {
      try { await fs.rename(bakPath, filePath); } catch {}
      try { await fs.unlink(tmpPath); } catch {}
      throw e;
    }
    try { await fs.unlink(bakPath); } catch {}
  } catch (e) {
    try { await fs.unlink(tmpPath); } catch {}
    throw e;
  }
}
