/**
 * @file ConsoleExporter.ts
 * @description Pretty-prints finalized spans to stdout as an ASCII tree.
 *
 * @example
 * ```
 * agent:run (12.4s) [ok]  agent.id=agent-12345  agent.goal=...
 * ├─ iteration:0 (3.1s) [ok]  iteration=0
 * │  ├─ llm:chat (2.9s) [ok]  llm.model=claude-...  llm.tokens.input=1024
 * │  └─ tool:read_file (180ms) [ok]  tool.name=read_file
 * ├─ iteration:1 (8.7s) [ok]  iteration=1
 * │  └─ llm:chat (8.5s) [ok]  llm.model=claude-...
 * └─ iteration:2 (520ms) [ok]  iteration=2
 *    └─ llm:chat (510ms) [ok]  llm.model=claude-...
 * ```
 *
 * @packageDocumentation
 */

import type { ConsoleExporterOptions, Exporter, SerializedSpan } from '../types.js';

/**
 * Create a console exporter that pretty-prints spans as an ASCII tree.
 *
 * @param opts - Optional `{ stream? }`. Default stream is `process.stdout`.
 * @returns An {@link Exporter}.
 *
 * @example
 * ```ts
 * const exporter = createExporter('console');
 * tracer.on('span:end', async () => {
 *   await exporter.export(tracer.serialize().filter(s => s.endTime));
 * });
 * ```
 */
export function createConsoleExporter(
  opts: ConsoleExporterOptions = {},
): Exporter {
  const stream = opts.stream ?? process.stdout;
  return {
    name: 'console',
    async export(spans: SerializedSpan[]): Promise<void> {
      if (spans.length === 0) return;
      const lines = renderTree(spans);
      for (const line of lines) stream.write(line + '\n');
    },
    async flush(): Promise<void> {
      /* no-op — console exporter is unbuffered */
    },
  };
}

/**
 * Render a list of spans as an ASCII tree. Returns one string per line
 * (without trailing newlines — the caller adds them).
 */
function renderTree(spans: SerializedSpan[]): string[] {
  const byId = new Map(spans.map((s) => [s.id, s]));
  const childrenOf = new Map<string | undefined, SerializedSpan[]>();
  for (const s of spans) {
    const parent = s.parentId && byId.has(s.parentId) ? s.parentId : undefined;
    const list = childrenOf.get(parent) ?? [];
    list.push(s);
    childrenOf.set(parent, list);
  }
  const roots = childrenOf.get(undefined) ?? [];
  const out: string[] = [];
  for (const root of roots) {
    out.push(...renderNode(root, '', true, childrenOf));
  }
  return out;
}

/**
 * Render a single node + its subtree.
 */
function renderNode(
  node: SerializedSpan,
  prefix: string,
  isLast: boolean,
  childrenOf: Map<string | undefined, SerializedSpan[]>,
): string[] {
  const connector = isLast ? '└─ ' : '├─ ';
  const duration =
    node.durationMs !== undefined ? formatDuration(node.durationMs) : '?';
  const attrs = renderAttrs(node);
  const line = `${prefix}${connector}${node.name} (${duration}) [${node.status}]${attrs}`;
  const out: string[] = [line];
  const kids = childrenOf.get(node.id) ?? [];
  const childPrefix = prefix + (isLast ? '   ' : '│  ');
  kids.forEach((kid, i) => {
    out.push(
      ...renderNode(kid, childPrefix, i === kids.length - 1, childrenOf),
    );
  });
  return out;
}

/**
 * Format a duration in ms as a human-readable string.
 */
function formatDuration(ms: number): string {
  if (ms < 1) return `${ms.toFixed(2)}ms`;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Render the attribute portion of a span line (`  k1=v1  k2=v2`).
 * Omits attributes that are too long (>120 chars) or empty.
 */
function renderAttrs(node: SerializedSpan): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(node.attributes)) {
    const vs = typeof v === 'string' ? v : JSON.stringify(v);
    if (vs.length === 0 || vs.length > 120) continue;
    parts.push(`${k}=${vs}`);
  }
  if (parts.length === 0) return '';
  return '  ' + parts.join('  ');
}
