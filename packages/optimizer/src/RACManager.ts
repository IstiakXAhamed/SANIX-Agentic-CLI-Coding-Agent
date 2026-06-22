/**
 * @file RACManager.ts
 * @description Retrieval-Augmented Context manager. Given a user query,
 * retrieves relevant chunks from up to four sources and ranks them via
 * the {@link AttentionSelector}:
 *
 *   - **files** — walks the workspace, scores files by query overlap
 *     (lazy: globs for likely-relevant files first, doesn't index the
 *     whole repo).
 *   - **memory** — delegates to a caller-supplied recall callback (the
 *     `MemoryRouter.recall` shape).
 *   - **web** — optional, calls a caller-supplied `webSearch` callback.
 *   - **mcp** — lists MCP tool descriptions (caller-supplied), scores
 *     by query overlap.
 *
 * Each source is wrapped in a try/catch so a failure in one (e.g.
 * web search is rate-limited) doesn't break the others.
 *
 * @packageDocumentation
 */

import { tokenizer as defaultTokenizer } from './ExactTokenizer.js';
import type { ExactTokenizer } from './ExactTokenizer.js';
import { AttentionSelector, type ScoreableItem } from './AttentionSelector.js';

/**
 * The retrieval sources the manager can query.
 */
export type RetrievalSource = 'files' | 'memory' | 'web' | 'mcp';

/**
 * A retrieved chunk. Mirrors the shape the {@link AttentionSelector}
 * consumes (it's a {@link ScoreableItem} with source-tagged metadata).
 */
export interface RetrievedChunk {
  /** Which source produced this chunk. */
  source: RetrievalSource;
  /** The chunk's text content. */
  content: string;
  /** Token count for `content`. */
  tokens: number;
  /** Relevance score (0..1, from {@link AttentionSelector}). */
  score: number;
  /** Free-form metadata (file path, memory tier, url, tool name, ...). */
  metadata: Record<string, unknown>;
}

/**
 * A callback that recalls memories matching a query. Mirrors the
 * `MemoryRouter.recall` shape so callers can pass `router.recall.bind(router)`.
 */
export type MemoryRecallFn = (
  query: string,
  limit?: number,
) => Promise<
  Array<{
    content: string;
    score: number;
    tier?: string;
    metadata?: Record<string, unknown>;
  }>
>;

/**
 * A callback that performs a web search. Returns an array of results
 * (title + url + snippet).
 */
export type WebSearchFn = (
  query: string,
  limit?: number,
) => Promise<
  Array<{
    title: string;
    url: string;
    snippet: string;
  }>
>;

/**
 * A callback that lists MCP tool descriptions. Returns an array of
 * tools the manager can score against the query.
 */
export type McpListToolsFn = () => Promise<
  Array<{
    name: string;
    description: string;
    server?: string;
  }>
>;

/**
 * A callback that walks the workspace and returns candidate file paths
 * (the manager will then read + score them). Mirrors a glob-style
 * interface so callers can plug in `fast-glob` or a custom walker.
 */
export type FileGlobFn = (
  query: string,
  cwd: string,
) => Promise<string[]>;

/**
 * A callback that reads a file's contents. Separated from {@link FileGlobFn}
 * so the manager can lazy-read only the top-scored files (avoids
 * reading 1000 files when only 5 are likely relevant).
 */
export type FileReadFn = (path: string) => Promise<string | null>;

/**
 * Options for {@link RACManager.retrieve}.
 */
export interface RetrieveOptions {
  /** Maximum total tokens the retrieved chunks may occupy. Default 4000. */
  maxTokens?: number;
  /** Which sources to query. Default: all four. */
  sources?: RetrievalSource[];
  /** Override the memory recall callback (else the constructor's is used). */
  memoryRecall?: MemoryRecallFn;
  /** Override the web search callback (else the constructor's is used). */
  webSearch?: WebSearchFn;
  /** Override the MCP list-tools callback (else the constructor's is used). */
  mcpListTools?: McpListToolsFn;
  /** Override the file glob callback (else the constructor's is used). */
  fileGlob?: FileGlobFn;
  /** Override the file read callback (else the constructor's is used). */
  fileRead?: FileReadFn;
  /** Workspace root for file globbing. Default `process.cwd()`. */
  cwd?: string;
  /** Max files to read+score. Default 10. */
  maxFiles?: number;
  /** Max web results to retrieve. Default 5. */
  maxWebResults?: number;
  /** Max MCP tools to return. Default 10. */
  maxMcpTools?: number;
  /** Max memories to retrieve. Default 10. */
  maxMemories?: number;
}

/**
 * Defaults for {@link RetrieveOptions}.
 */
const DEFAULTS = {
  maxTokens: 4000,
  sources: ['files', 'memory', 'web', 'mcp'] as RetrievalSource[],
  cwd: process.cwd(),
  maxFiles: 10,
  maxWebResults: 5,
  maxMcpTools: 10,
  maxMemories: 10,
} as const;

/**
 * Tokenize text into lowercase word tokens for overlap scoring.
 */
function wordTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_]+/i)
      .filter((t) => t.length > 1),
  );
}

/**
 * Jaccard overlap between two token sets.
 */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * A simple default file globber: walks the cwd (up to a depth limit)
 * and returns paths whose basename contains any query token. This is
 * intentionally naive — callers with a real index should plug in a
 * `FileGlobFn` that uses ripgrep / a proper search index.
 */
async function defaultFileGlob(query: string, cwd: string): Promise<string[]> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const queryTokens = [...wordTokens(query)];
  if (queryTokens.length === 0) return [];

  const out: string[] = [];
  const MAX_DEPTH = 5;
  const MAX_FILES = 200;

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      // Skip common noise directories.
      if (e.isDirectory() && /^(node_modules|\.git|dist|build|\.next)$/.test(e.name)) {
        continue;
      }
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full, depth + 1);
      } else {
        // Score by basename overlap with the query.
        const basename = e.name.toLowerCase();
        if (queryTokens.some((t) => basename.includes(t))) {
          out.push(full);
        }
      }
    }
  }

  await walk(cwd, 0);
  return out;
}

/**
 * Default file reader: utf-8 text, capped at 100KB (avoids loading
 * huge generated files into memory).
 */
async function defaultFileRead(filePath: string): Promise<string | null> {
  const fs = await import('node:fs/promises');
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return content.length > 100_000 ? content.slice(0, 100_000) : content;
  } catch {
    return null;
  }
}

/**
 * Retrieval-Augmented Context manager.
 *
 * @example
 * ```ts
 * const mgr = new RACManager({
 *   memoryRecall: (q, n) => router.recall({ query: q, limit: n }),
 *   webSearch: braveSearch,
 *   mcpListTools: () => mcpClient.listTools(),
 * });
 * const chunks = await mgr.retrieve('how does auth work?');
 * for (const c of chunks) console.log(c.source, c.score, c.content.slice(0, 80));
 * ```
 */
export class RACManager {
  private readonly selector: AttentionSelector;
  private readonly tokenizer: ExactTokenizer;
  private readonly defaultMemoryRecall: MemoryRecallFn | undefined;
  private readonly defaultWebSearch: WebSearchFn | undefined;
  private readonly defaultMcpListTools: McpListToolsFn | undefined;
  private readonly defaultFileGlob: FileGlobFn;
  private readonly defaultFileRead: FileReadFn;

  /**
   * @param opts Optional default callbacks. Any callback not supplied
   *   here can still be passed per-call via {@link RetrieveOptions}.
   *   The only callback with a built-in default is `fileGlob` /
   *   `fileRead` (a naive walker + utf-8 reader).
   */
  constructor(opts: {
    memoryRecall?: MemoryRecallFn;
    webSearch?: WebSearchFn;
    mcpListTools?: McpListToolsFn;
    fileGlob?: FileGlobFn;
    fileRead?: FileReadFn;
    tokenizer?: ExactTokenizer;
  } = {}) {
    this.tokenizer = opts.tokenizer ?? defaultTokenizer;
    this.selector = new AttentionSelector(this.tokenizer);
    this.defaultMemoryRecall = opts.memoryRecall;
    this.defaultWebSearch = opts.webSearch;
    this.defaultMcpListTools = opts.mcpListTools;
    this.defaultFileGlob = opts.fileGlob ?? defaultFileGlob;
    this.defaultFileRead = opts.fileRead ?? defaultFileRead;
  }

  /**
   * Retrieve relevant chunks from the configured sources, ranked by
   * the {@link AttentionSelector}.
   *
   * Each source is queried in parallel; failures in one source don't
   * affect the others. The combined results are then ranked and
   * truncated to `maxTokens`.
   *
   * @example
   * ```ts
   * const chunks = await mgr.retrieve('auth login', {
   *   maxTokens: 2000,
   *   sources: ['files', 'memory'],
   * });
   * ```
   */
  async retrieve(query: string, opts: RetrieveOptions = {}): Promise<RetrievedChunk[]> {
    const maxTokens = opts.maxTokens ?? DEFAULTS.maxTokens;
    const sources = opts.sources ?? DEFAULTS.sources;
    const cwd = opts.cwd ?? DEFAULTS.cwd;
    const maxFiles = opts.maxFiles ?? DEFAULTS.maxFiles;
    const maxWebResults = opts.maxWebResults ?? DEFAULTS.maxWebResults;
    const maxMcpTools = opts.maxMcpTools ?? DEFAULTS.maxMcpTools;
    const maxMemories = opts.maxMemories ?? DEFAULTS.maxMemories;

    // Gather chunks from each source in parallel. Each source is
    // wrapped in try/catch so a failure doesn't break the others.
    const tasks: Promise<RetrievedChunk[]>[] = [];
    if (sources.includes('files')) {
      tasks.push(this.retrieveFiles(query, cwd, maxFiles, opts));
    }
    if (sources.includes('memory')) {
      const fn = opts.memoryRecall ?? this.defaultMemoryRecall;
      if (fn) tasks.push(this.retrieveMemory(query, maxMemories, fn));
    }
    if (sources.includes('web')) {
      const fn = opts.webSearch ?? this.defaultWebSearch;
      if (fn) tasks.push(this.retrieveWeb(query, maxWebResults, fn));
    }
    if (sources.includes('mcp')) {
      const fn = opts.mcpListTools ?? this.defaultMcpListTools;
      if (fn) tasks.push(this.retrieveMcp(query, maxMcpTools, fn));
    }

    const results = await Promise.all(tasks);
    const all = results.flat();

    // Rank via the AttentionSelector. We convert each chunk to a
    // ScoreableItem, then convert the picked items back to RetrievedChunks.
    const items: ScoreableItem[] = all.map((c) => ({
      id: `${c.source}:${c.metadata.path ?? c.metadata.url ?? c.metadata.name ?? c.content.slice(0, 40)}`,
      content: c.content,
      tokens: c.tokens,
      importance: c.score, // seed importance with the source's own score
      metadata: { source: c.source, ...c.metadata },
    }));

    const picked = await this.selector.select(query, items, maxTokens);
    return picked.map((item) => ({
      source: item.metadata!.source as RetrievalSource,
      content: item.content,
      tokens: item.tokens ?? this.tokenizer.count(item.content),
      score: item.importance ?? 0.5,
      metadata: item.metadata ?? {},
    }));
  }

  /**
   * Retrieve file chunks. Globs for candidate files, reads the top N,
   * splits each into ~512-token chunks, scores each chunk against the
   * query.
   */
  private async retrieveFiles(
    query: string,
    cwd: string,
    maxFiles: number,
    opts: RetrieveOptions,
  ): Promise<RetrievedChunk[]> {
    const glob = opts.fileGlob ?? this.defaultFileGlob;
    const read = opts.fileRead ?? this.defaultFileRead;
    try {
      const paths = await glob(query, cwd);
      const top = paths.slice(0, maxFiles);
      const queryTokens = wordTokens(query);
      const out: RetrievedChunk[] = [];
      for (const p of top) {
        const content = await read(p);
        if (!content) continue;
        // Split into ~512-token chunks (rough: 4 chars/token → 2048 chars).
        const CHUNK_CHARS = 2048;
        for (let i = 0; i < content.length; i += CHUNK_CHARS) {
          const chunk = content.slice(i, i + CHUNK_CHARS);
          const score = jaccard(queryTokens, wordTokens(chunk));
          if (score === 0) continue;
          out.push({
            source: 'files',
            content: chunk,
            tokens: this.tokenizer.count(chunk),
            score,
            metadata: { path: p, offset: i },
          });
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  /**
   * Retrieve memory chunks via the caller-supplied recall callback.
   */
  private async retrieveMemory(
    query: string,
    limit: number,
    fn: MemoryRecallFn,
  ): Promise<RetrievedChunk[]> {
    try {
      const results = await fn(query, limit);
      return results.map((r) => ({
        source: 'memory' as const,
        content: r.content,
        tokens: this.tokenizer.count(r.content),
        score: r.score,
        metadata: { tier: r.tier, ...(r.metadata ?? {}) },
      }));
    } catch {
      return [];
    }
  }

  /**
   * Retrieve web chunks via the caller-supplied web-search callback.
   */
  private async retrieveWeb(
    query: string,
    limit: number,
    fn: WebSearchFn,
  ): Promise<RetrievedChunk[]> {
    try {
      const results = await fn(query, limit);
      return results.map((r) => ({
        source: 'web' as const,
        content: `${r.title}\n${r.snippet}`,
        tokens: this.tokenizer.count(`${r.title}\n${r.snippet}`),
        score: 0.5, // web results don't come with a score; neutral default
        metadata: { url: r.url, title: r.title },
      }));
    } catch {
      return [];
    }
  }

  /**
   * Retrieve MCP tool-description chunks via the caller-supplied
   * list-tools callback.
   */
  private async retrieveMcp(
    query: string,
    limit: number,
    fn: McpListToolsFn,
  ): Promise<RetrievedChunk[]> {
    try {
      const tools = await fn();
      const queryTokens = wordTokens(query);
      const scored = tools
        .map((t) => ({
          tool: t,
          score: jaccard(queryTokens, wordTokens(`${t.name} ${t.description}`)),
        }))
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
      return scored.map((s) => ({
        source: 'mcp' as const,
        content: `${s.tool.name}: ${s.tool.description}`,
        tokens: this.tokenizer.count(`${s.tool.name}: ${s.tool.description}`),
        score: s.score,
        metadata: { name: s.tool.name, server: s.tool.server },
      }));
    } catch {
      return [];
    }
  }
}
