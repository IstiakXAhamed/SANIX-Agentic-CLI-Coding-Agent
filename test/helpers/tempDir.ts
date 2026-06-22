/**
 * @file tempDir.ts
 * @description Test helper that creates a fresh temp directory, runs the
 * test inside it, and cleans it up afterwards — even if the test throws.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Create a fresh temp directory, pass its path to `fn`, then recursively
 * delete it on completion (success or failure). Returns whatever `fn`
 * returns.
 *
 * @example
 * ```ts
 * await withTempDir(async (dir) => {
 *   await fs.writeFile(join(dir, 'a.txt'), 'hello');
 *   // ...
 * });
 * ```
 */
export async function withTempDir<T>(
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'sanix-test-'));
  try {
    return await fn(dir);
  } finally {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; ignore.
    }
  }
}
