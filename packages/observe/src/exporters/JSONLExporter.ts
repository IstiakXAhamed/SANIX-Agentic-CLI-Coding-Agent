/**
 * @file JSONLExporter.ts
 * @description Appends finalized spans to `~/.sanix/traces.jsonl` (one
 * JSON object per line). Idempotent on failure — if the write fails, the
 * spans are dropped (no retry) but the exporter never throws.
 *
 * @packageDocumentation
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Exporter, JSONLExporterOptions, SerializedSpan } from '../types.js';

/**
 * Default file path (`~/.sanix/traces.jsonl`).
 */
function defaultPath(): string {
  return path.join(os.homedir(), '.sanix', 'traces.jsonl');
}

/**
 * Create a JSONL exporter that appends spans to a file.
 *
 * @param opts - Optional `{ filePath? }`. Default `~/.sanix/traces.jsonl`.
 * @returns An {@link Exporter}.
 */
export function createJSONLExporter(
  opts: JSONLExporterOptions = {},
): Exporter {
  const filePath = opts.filePath ?? defaultPath();
  const queue: SerializedSpan[] = [];
  let writing = false;

  async function flush(): Promise<void> {
    if (writing || queue.length === 0) return;
    writing = true;
    const batch = queue.splice(0, queue.length);
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const lines = batch.map((s) => JSON.stringify(s)).join('\n') + '\n';
      await fs.appendFile(filePath, lines, 'utf8');
    } catch (err) {
      // Re-enqueue the batch on failure so we don't lose spans silently.
      queue.unshift(...batch);
      // eslint-disable-next-line no-console
      console.error(
        `[sanix/observe/jsonl] failed to write ${batch.length} spans to ${filePath}:`,
        err,
      );
    } finally {
      writing = false;
      if (queue.length > 0) void flush();
    }
  }

  return {
    name: 'jsonl',
    async export(spans: SerializedSpan[]): Promise<void> {
      if (spans.length === 0) return;
      queue.push(...spans);
      await flush();
    },
    flush,
  };
}
