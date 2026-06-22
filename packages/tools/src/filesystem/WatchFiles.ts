/**
 * @file WatchFiles tool — observes one or more paths for filesystem events
 * over a bounded time window, then returns the captured events.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { watch, type FSWatcher } from 'node:fs';
import {
  type SanixTool,
  type ToolContext,
  type ToolResult,
  type ToolPermission,
  z,
  resolvePath,
  okResult,
  errResult,
} from '../types.js';

/** Input schema for the `watch_files` tool. */
export const WatchFilesInputSchema = z.object({
  paths: z.array(z.string().min(1)).min(1),
  events: z.array(z.enum(['create', 'modify', 'delete'])).min(1),
  durationMs: z.number().int().positive().max(60_000),
});

/** Output schema for the `watch_files` tool. */
export const WatchFilesOutputSchema = z.object({
  events: z.array(
    z.object({
      path: z.string(),
      event: z.string(),
      timestamp: z.number(),
    }),
  ),
});

export type WatchFilesInput = z.infer<typeof WatchFilesInputSchema>;
export type WatchFilesOutput = z.infer<typeof WatchFilesOutputSchema>;

interface CapturedEvent {
  path: string;
  event: string;
  timestamp: number;
}

/** Map Node's `rename`/`change` event names to our create/modify/delete. */
function translateEvent(nodeEvent: string): 'create' | 'modify' | 'delete' | null {
  if (nodeEvent === 'rename') return 'create'; // ambiguous — caller can refine
  if (nodeEvent === 'change') return 'modify';
  return null;
}

/**
 * WatchFilesTool — observe filesystem events for a bounded duration.
 *
 * @example
 * ```ts
 * const res = await new WatchFilesTool().execute(
 *   { paths: ['src'], events: ['modify'], durationMs: 5000 },
 *   ctx,
 * );
 * ```
 */
export class WatchFilesTool implements SanixTool<WatchFilesInput, WatchFilesOutput> {
  readonly name = 'watch_files';
  readonly description =
    'Watch one or more paths for filesystem events over a bounded duration (max 60s). Returns captured events.';
  readonly inputSchema = WatchFilesInputSchema;
  readonly outputSchema = WatchFilesOutputSchema;
  readonly permissions: ToolPermission[] = ['filesystem:read'];
  readonly maxTokensInput = 512;
  readonly maxTokensOutput = 16_000;

  async execute(
    input: WatchFilesInput,
    context: ToolContext,
  ): Promise<ToolResult<WatchFilesOutput>> {
    const start = Date.now();
    const events: CapturedEvent[] = [];
    const watchers: FSWatcher[] = [];
    const allowed = new Set(input.events);

    try {
      for (const p of input.paths) {
        const abs = resolvePath(p, context.cwd);
        try {
          const stat = await fs.stat(abs);
          if (!stat.isDirectory()) continue;
          const w = watch(
            abs,
            { recursive: true, persistent: false },
            (eventType, filename) => {
              if (!filename) return;
              const translated = translateEvent(eventType);
              if (!translated || !allowed.has(translated)) return;
              events.push({
                path: path.join(abs, filename),
                event: translated,
                timestamp: Date.now(),
              });
            },
          );
          watchers.push(w);
        } catch {
          // path missing or not a directory — skip
        }
      }

      if (watchers.length === 0) {
        return errResult<WatchFilesOutput>(
          'watch_files: no valid directories to watch',
          Date.now() - start,
        );
      }

      // Wait for the requested duration or until the abort signal fires.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, input.durationMs);
        context.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        });
      });

      // Close all watchers.
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          /* ignore */
        }
      }

      return okResult<WatchFilesOutput>({ events }, Date.now() - start);
    } catch (err) {
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          /* ignore */
        }
      }
      const msg = err instanceof Error ? err.message : String(err);
      return errResult<WatchFilesOutput>(
        `watch_files failed: ${msg}`,
        Date.now() - start,
      );
    }
  }

  formatForContext(result: WatchFilesOutput): string {
    if (result.events.length === 0) return 'no events captured';
    return result.events
      .map((e) => `[${new Date(e.timestamp).toISOString()}] ${e.event} ${e.path}`)
      .join('\n');
  }
}
