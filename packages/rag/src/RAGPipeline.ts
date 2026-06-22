/**
 * @file RAGPipeline.ts
 * @description End-to-end RAG pipeline wiring the document store,
 * retriever, reranker, query rewriter, multi-hop retriever, and LLM
 * provider into a single ingest → retrieve → rerank → generate flow.
 *
 * ## Lifecycle events
 *
 * The pipeline extends `EventEmitter3` and emits the following
 * events (callers can subscribe via `pipeline.on('query:start', ...)`):
 *
 *   - `ingest:start`     — `{ docs: Document[]; path?: string }`
 *   - `ingest:complete`  — `{ added: number; chunks: number }`
 *   - `query:start`      — `{ question: string; opts }`
 *   - `retrieve:complete`— `{ scored: ScoredDoc[]; rewrittenQueries? }`
 *   - `rerank:complete`  — `{ scored: ScoredDoc[] }`
 *   - `generate:start`   — `{ prompt: string; sources: Document[] }`
 *   - `generate:complete`— `{ answer: string; tokensUsed: number }`
 *
 * ## Graceful degradation
 *
 * Every optional component (reranker, rewriter, multi-hop, provider)
 * is checked before use. If absent, the pipeline skips that stage
 * and continues:
 *
 *   - No `provider` → `query()` returns the retrieved sources with an
 *     empty answer and a clear "no provider configured" note.
 *   - No `reranker` → retrieval results are passed to the LLM
 *     unmodified.
 *   - No `rewriter` → the original query is used directly.
 *   - No `multiHop` (or `opts.multiHop: false`) → single-shot
 *     retrieval.
 *
 * @packageDocumentation
 */

import { EventEmitter } from 'eventemitter3';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import { nanoid } from 'nanoid';
import type { IProvider, LLMMessage } from '@sanix/providers';
import type { Document, ScoredDoc } from './types.js';
import { DocumentStore } from './DocumentStore.js';
import type { HybridRetriever } from './HybridRetriever.js';
import type { Reranker } from './Reranker.js';
import type { QueryRewriter, RewrittenQuery } from './QueryRewriter.js';
import type {
  MultiHopRetriever,
  MultiHopResult,
} from './MultiHopRetriever.js';
import { CitationExtractor, type Citation } from './CitationExtractor.js';

/** Pipeline event map — strongly typed EventEmitter3 payloads. */
export interface RAGPipelineEvents {
  'ingest:start': (payload: { docs: Document[]; path?: string }) => void;
  'ingest:complete': (payload: { added: number; chunks: number }) => void;
  'query:start': (payload: {
    question: string;
    opts: QueryOptions;
  }) => void;
  'retrieve:complete': (payload: {
    scored: ScoredDoc[];
    rewrittenQueries?: string[];
    hops?: MultiHopResult['hops'];
  }) => void;
  'rerank:complete': (payload: { scored: ScoredDoc[] }) => void;
  'generate:start': (payload: {
    prompt: string;
    sources: Document[];
  }) => void;
  'generate:complete': (payload: {
    answer: string;
    tokensUsed: number;
  }) => void;
}

/** Constructor options. */
export interface RAGPipelineOptions {
  /** Document store (required). */
  store: DocumentStore;
  /** Hybrid retriever (required). */
  retriever: HybridRetriever;
  /** Optional reranker. */
  reranker?: Reranker;
  /** Optional query rewriter. */
  rewriter?: QueryRewriter;
  /** Optional multi-hop retriever. */
  multiHop?: MultiHopRetriever;
  /** LLM provider for answer generation. */
  provider?: IProvider;
  /** System prompt prepended to every generation call. */
  systemPrompt?: string;
  /** Max tokens for the LLM's answer. Default 1024. */
  maxTokens?: number;
  /** LLM temperature for generation. Default 0.3. */
  temperature?: number;
  /**
   * Max chars of each retrieved doc to include in the LLM context.
   * Default 2000.
   */
  maxDocChars?: number;
}

/** Query options. */
export interface QueryOptions {
  /** Number of top docs to retrieve. Default 5. */
  k?: number;
  /** Use multi-hop retrieval (if configured). Default false. */
  multiHop?: boolean;
  /** Rewrite the query before retrieval (if configured). Default false. */
  rewrite?: boolean;
  /** Rerank retrieved docs (if configured). Default false. */
  rerank?: boolean;
}

/** RAG query result. */
export interface RAGResult {
  /** The LLM's generated answer. */
  answer: string;
  /** Source docs with scores and snippets. */
  sources: Array<{ doc: Document; score: number; snippet: string }>;
  /** The original query. */
  query: string;
  /** Rewritten queries (if rewriting was enabled). */
  rewrittenQueries?: string[];
  /** Multi-hop trace (if multi-hop was enabled). */
  hops?: MultiHopResult['hops'];
  /** Citations extracted from the answer. */
  citations?: Citation[];
  /** Wall-clock duration of the query in ms. */
  durationMs: number;
  /** Total tokens used by the LLM across all calls. */
  tokensUsed: number;
}

/** Default system prompt instructs the LLM to cite sources. */
export const DEFAULT_RAG_SYSTEM_PROMPT =
  'You are a retrieval-augmented assistant. Answer the user\'s question ' +
  'using ONLY the provided sources. If the sources do not contain enough ' +
  'information, say so explicitly. Use [1], [2] etc. to cite sources by ' +
  'their 1-based index in the provided list. Be concise and accurate.';

/**
 * End-to-end RAG pipeline.
 *
 * @example
 * ```ts
 * const pipeline = new RAGPipeline({
 *   store, retriever, provider: claudeProvider,
 *   reranker: new Reranker({ method: 'cross_encoder', provider }),
 * });
 * pipeline.on('query:start', ({ question }) => console.log('Q:', question));
 * await pipeline.ingest(docs);
 * const result = await pipeline.query('How does JWT auth work?', {
 *   k: 5, rerank: true, rewrite: true,
 * });
 * console.log(result.answer, result.citations);
 * ```
 */
export class RAGPipeline extends EventEmitter<RAGPipelineEvents> {
  private readonly store: DocumentStore;
  private readonly retriever: HybridRetriever;
  private readonly reranker?: Reranker;
  private readonly rewriter?: QueryRewriter;
  private readonly multiHop?: MultiHopRetriever;
  private readonly provider?: IProvider;
  private readonly systemPrompt: string;
  private readonly maxTokens: number;
  private readonly temperature: number;
  private readonly maxDocChars: number;
  private readonly citationExtractor = new CitationExtractor();

  constructor(opts: RAGPipelineOptions) {
    super();
    this.store = opts.store;
    this.retriever = opts.retriever;
    this.reranker = opts.reranker;
    this.rewriter = opts.rewriter;
    this.multiHop = opts.multiHop;
    this.provider = opts.provider;
    this.systemPrompt = opts.systemPrompt ?? DEFAULT_RAG_SYSTEM_PROMPT;
    this.maxTokens = opts.maxTokens ?? 1024;
    this.temperature = opts.temperature ?? 0.3;
    this.maxDocChars = opts.maxDocChars ?? 2000;
  }

  // ─── Ingestion ──────────────────────────────────────────────────────

  /**
   * Ingest an array of documents: chunk each one (via the store) and
   * index the chunks into the retriever. Returns the number of
   * documents and chunks added.
   *
   * @example
   * ```ts
   * await pipeline.ingest([{ id: 'd1', content, metadata }]);
   * ```
   */
  async ingest(docs: Document[]): Promise<{ added: number; chunks: number }> {
    this.emit('ingest:start', { docs });
    let added = 0;
    let chunks = 0;
    for (const doc of docs) {
      const ids = await this.store.add(doc);
      added++;
      // Index every stored doc (parent + chunks) into the retriever.
      for (const id of ids) {
        const stored = await this.store.get(id);
        if (!stored) continue;
        // Skip the parent if chunks were created — the parent's full
        // content is the union of its chunks, so indexing both would
        // double-count. If no chunks were created (ids.length === 1),
        // the parent IS the only doc and we index it.
        if (ids.length > 1 && id === ids[0]) continue;
        await this.retriever.addDocument(stored);
        chunks++;
      }
    }
    this.emit('ingest:complete', { added, chunks });
    return { added, chunks };
  }

  /**
   * Ingest a single file. Detects type (markdown / code / text / pdf
   * via `@sanix/tools`'s `DocumentReaderTool`, lazy-loaded) and reads
   * it into a string. Falls back to plain UTF-8 `readFile` for
   * unrecognized extensions.
   *
   * @example
   * ```ts
   * await pipeline.ingestFile('./docs/auth.md');
   * ```
   */
  async ingestFile(path: string): Promise<void> {
    this.emit('ingest:start', { docs: [], path });
    const content = await readFileSafe(path);
    const doc: Document = {
      id: nanoid(),
      content,
      metadata: {
        source: path,
        title: basename(path),
        createdAt: Date.now(),
        language: detectLanguage(extname(path)),
      },
    };
    await this.ingest([doc]);
  }

  /**
   * Ingest every file in a directory (optionally filtered by glob).
   * Recursively walks subdirectories. Files that cannot be read are
   * silently skipped.
   *
   * @example
   * ```ts
   * await pipeline.ingestDirectory('./docs', { glob: '*.md' });
   * ```
   */
  async ingestDirectory(
    dir: string,
    opts: { glob?: string } = {},
  ): Promise<void> {
    const globRe = opts.glob ? globToRegex(opts.glob) : null;
    const files = await walk(dir);
    for (const f of files) {
      if (globRe && !globRe.test(f)) continue;
      try {
        await this.ingestFile(f);
      } catch {
        // Skip unreadable files.
      }
    }
  }

  // ─── Query ──────────────────────────────────────────────────────────

  /**
   * Answer a question with retrieval-augmented generation.
   *
   * Flow:
   *   1. (Optional) rewrite the query.
   *   2. Retrieve (single-hop or multi-hop).
   *   3. (Optional) rerank.
   *   4. Build a prompt with the sources and the question.
   *   5. Call the LLM.
   *   6. Extract citations from the answer.
   *
   * @example
   * ```ts
   * const result = await pipeline.query('How does auth work?', {
   *   k: 5, rerank: true, rewrite: true,
   * });
   * console.log(result.answer);
   * ```
   */
  async query(
    question: string,
    opts: QueryOptions = {},
  ): Promise<RAGResult> {
    const start = Date.now();
    this.emit('query:start', { question, opts });
    let tokensUsed = 0;

    // 1. Rewrite (optional).
    let rewrittenQueries: string[] | undefined;
    let query = question;
    if (opts.rewrite && this.rewriter) {
      const rewrites: RewrittenQuery[] = await this.rewriter.rewrite(question);
      rewrittenQueries = rewrites.map((r) => r.text);
      query = rewrites[0]?.text ?? question;
    }

    // 2. Retrieve.
    let scored: ScoredDoc[] = [];
    let hops: MultiHopResult['hops'] | undefined;
    if (opts.multiHop && this.multiHop) {
      const result = await this.multiHop.retrieve(question, { k: opts.k });
      scored = result.finalDocs;
      hops = result.hops;
    } else {
      // If we have rewritten queries, retrieve for each and merge.
      if (rewrittenQueries && rewrittenQueries.length > 1) {
        const merged = new Map<string, ScoredDoc>();
        for (const rq of rewrittenQueries) {
          const hits = await this.retriever.retrieve(rq, { k: opts.k ?? 5 });
          for (const h of hits) {
            const existing = merged.get(h.doc.id);
            if (!existing || h.score > existing.score) {
              merged.set(h.doc.id, h);
            }
          }
        }
        scored = Array.from(merged.values()).sort(
          (a, b) => b.score - a.score,
        );
        if (opts.k) scored = scored.slice(0, opts.k * 2);
      } else {
        scored = await this.retriever.retrieve(query, { k: opts.k ?? 5 });
      }
    }
    this.emit('retrieve:complete', { scored, rewrittenQueries, hops });

    // 3. Rerank (optional).
    if (opts.rerank && this.reranker) {
      scored = await this.reranker.rerank(question, scored);
      this.emit('rerank:complete', { scored });
    }

    // 4. Build prompt + call LLM.
    const sources = scored.map((s) => s.doc);
    const { prompt, contextText } = buildPrompt(
      this.systemPrompt,
      question,
      scored,
      this.maxDocChars,
    );
    this.emit('generate:start', { prompt: contextText, sources });

    let answer = '';
    if (this.provider) {
      const messages: LLMMessage[] = [
        { role: 'system', content: this.systemPrompt },
        { role: 'user', content: contextText },
      ];
      const res = await this.provider.chat({
        messages,
        temperature: this.temperature,
        maxTokens: this.maxTokens,
      });
      answer = res.content;
      tokensUsed = res.usage.inputTokens + res.usage.outputTokens;
    } else {
      answer =
        '[no provider configured — retrieval-only mode. Sources are listed below.]';
    }
    this.emit('generate:complete', { answer, tokensUsed });

    // 5. Extract citations.
    const citations = this.citationExtractor.extract(answer, sources);

    // 6. Assemble result.
    const result: RAGResult = {
      answer,
      sources: scored.map((s) => ({
        doc: s.doc,
        score: s.score,
        snippet: s.doc.content.slice(0, 200),
      })),
      query: question,
      rewrittenQueries,
      hops,
      citations,
      durationMs: Date.now() - start,
      tokensUsed,
    };
    void prompt;
    return result;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Build the LLM prompt: a single user message containing the source
 * list (with `[1]`, `[2]` markers) and the question. Returns both the
 * full message-array-ready `prompt` (for logging) and the
 * `contextText` (the actual user message content).
 */
function buildPrompt(
  systemPrompt: string,
  question: string,
  scored: ScoredDoc[],
  maxDocChars: number,
): { prompt: string; contextText: string } {
  void systemPrompt;
  const parts: string[] = ['Sources:'];
  for (let i = 0; i < scored.length; i++) {
    const s = scored[i]!;
    const text =
      s.doc.content.length > maxDocChars
        ? s.doc.content.slice(0, maxDocChars - 1) + '…'
        : s.doc.content;
    parts.push(`[${i + 1}] ${text}`);
  }
  parts.push('');
  parts.push(`Question: ${question}`);
  parts.push('');
  parts.push(
    'Answer (cite sources with [n] markers; if the answer is not in the sources, say so):',
  );
  const contextText = parts.join('\n');
  return { prompt: contextText, contextText };
}

/**
 * Read a file as UTF-8 text. For `.pdf`, `.docx`, and other binary
 * document formats, attempts to use `@sanix/tools`'s
 * `DocumentReaderTool` (lazy dynamic import). Falls back to plain
 * `readFile` if the tools package is unavailable or the tool fails.
 */
async function readFileSafe(path: string): Promise<string> {
  const ext = extname(path).toLowerCase();
  // Binary document formats → try @sanix/tools.
  if (ext === '.pdf' || ext === '.docx') {
    try {
      const tools = (await import('@sanix/tools')) as unknown as {
        DocumentReaderTool: new () => {
          execute: (
            input: { path: string; format?: string },
            ctx: unknown,
          ) => Promise<{
            ok: boolean;
            output?: { text: string; metadata?: Record<string, unknown> };
            error?: string;
          }>;
        };
      };
      const reader = new tools.DocumentReaderTool();
      // The tool's actual `ToolContext` shape has more fields than we
      // have here; we pass a minimal context with just `cwd`. The
      // DocumentReaderTool only reads `cwd` from the context.
      const ctx = { cwd: process.cwd() } as unknown;
      const res = await reader.execute({ path, format: 'auto' }, ctx);
      if (res.ok && res.output?.text) return res.output.text;
    } catch {
      // Fall through to plain read.
    }
  }
  return readFile(path, 'utf-8');
}

/** Map a file extension to an ISO 639-1 language code (for code files). */
function detectLanguage(ext: string): string | undefined {
  const map: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.py': 'python',
    '.go': 'go',
    '.rs': 'rust',
    '.java': 'java',
    '.kt': 'kotlin',
    '.rb': 'ruby',
    '.php': 'php',
    '.c': 'c',
    '.cpp': 'cpp',
    '.cs': 'csharp',
    '.swift': 'swift',
    '.md': 'markdown',
  };
  return map[ext.toLowerCase()];
}

/** Convert a simple glob (e.g. `*.md`, `docs/*.ts`) to a RegExp. */
function globToRegex(glob: string): RegExp {
  const re = glob
    .split('/')
    .map((seg) =>
      seg
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.'),
    )
    .join('/');
  return new RegExp(re + '$');
}

/** Recursively walk `dir`, returning every file path under it. */
async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await walk(full)));
    } else if (e.isFile()) {
      // Skip obviously-binary files we can't read.
      try {
        const st = await stat(full);
        if (st.size > 10 * 1024 * 1024) continue; // >10MB
        out.push(full);
      } catch {
        // Skip stat-failed files.
      }
    }
  }
  return out;
}
