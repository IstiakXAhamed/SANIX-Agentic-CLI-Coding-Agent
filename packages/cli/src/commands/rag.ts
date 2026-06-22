/**
 * @file commands/rag.ts
 * @description `sanix rag <sub>` — Retrieval-Augmented Generation commands.
 *
 *   sanix rag ingest <path>          Ingest a file or directory.
 *   sanix rag query "<question>"     Ask a question against the RAG store.
 *   sanix rag search "<query>"       Search without generating an answer.
 *   sanix rag stats                  Show RAG store statistics.
 *   sanix rag clear                  Clear the RAG store.
 *
 * Delegates to {@link RAGPipeline} + {@link DocumentStore} +
 * {@link HybridRetriever} from `@sanix/rag`. The pipeline is wired to
 * the first available {@link IProvider} from the SANIX router so query
 * results include a generated answer.
 *
 * Graceful degradation: if `@sanix/rag` cannot be loaded, every
 * subcommand prints a clear error and exits 1.
 *
 * @packageDocumentation
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, existsSync } from 'node:fs';
import type { SanixContext } from '../bootstrap.js';

/** Parsed options for `sanix rag ingest`. */
export interface RagIngestOptions {
  glob?: string;
  recursive?: boolean;
  store?: 'memory' | 'filesystem' | 'sqlite';
}

/** Parsed options for `sanix rag query`. */
export interface RagQueryOptions {
  k?: number;
  noRerank?: boolean;
  noRewrite?: boolean;
  multiHop?: boolean;
  maxHops?: number;
  json?: boolean;
}

/** Parsed options for `sanix rag search`. */
export interface RagSearchOptions {
  k?: number;
}

/** Lazy handle to the `@sanix/rag` module. */
interface RagModule {
  RAGPipeline: new (opts: {
    store: DocumentStoreLike;
    retriever: HybridRetrieverLike;
    reranker?: unknown;
    rewriter?: unknown;
    multiHop?: unknown;
    provider?: unknown;
    maxTokens?: number;
    temperature?: number;
  }) => RagPipelineLike;
  DocumentStore: new (opts: {
    backend?: 'memory' | 'filesystem' | 'sqlite';
    dir?: string;
    path?: string;
  }) => DocumentStoreLike;
  HybridRetriever: new (opts?: unknown) => HybridRetrieverLike;
  Reranker: new (opts?: unknown) => unknown;
  QueryRewriter: new (opts?: unknown) => unknown;
  MultiHopRetriever: new (opts: {
    retriever: HybridRetrieverLike;
    provider?: unknown;
    maxHops?: number;
  }) => unknown;
}

interface DocumentStoreLike {
  add: (doc: { id: string; content: string; metadata: Record<string, unknown> }) => Promise<string[]>;
  get: (id: string) => Promise<unknown>;
  list: (opts?: { limit?: number }) => Promise<DocLike[]>;
  count: () => Promise<number>;
  delete: (id: string) => Promise<boolean>;
}

interface DocLike {
  id: string;
  content: string;
  metadata: { source?: string; title?: string; createdAt: number };
}

interface HybridRetrieverLike {
  addDocument: (doc: DocLike) => Promise<void>;
  retrieve: (
    query: string,
    opts?: { k?: number },
  ) => Promise<Array<{ doc: DocLike; score: number; components: Record<string, number> }>>;
  size: () => number;
}

interface RagPipelineLike {
  ingest: (docs: Array<{ id: string; content: string; metadata: Record<string, unknown> }>) => Promise<{ added: number; chunks: number }>;
  ingestFile: (path: string) => Promise<void>;
  ingestDirectory: (dir: string, opts?: { glob?: string }) => Promise<void>;
  query: (
    question: string,
    opts?: {
      k?: number;
      multiHop?: boolean;
      rewrite?: boolean;
      rerank?: boolean;
    },
  ) => Promise<{
    answer: string;
    sources: Array<{ doc: DocLike; score: number; snippet: string }>;
    query: string;
    durationMs: number;
    tokensUsed: number;
  }>;
}

/** Cached dynamic-import of `@sanix/rag`. */
let ragPromise: Promise<RagModule> | null = null;
let ragPipeline: RagPipelineLike | null = null;
let ragStore: DocumentStoreLike | null = null;
let ragRetriever: HybridRetrieverLike | null = null;

/**
 * Lazily dynamic-import `@sanix/rag`. Cached. Throws a friendly error
 * when the package is missing.
 */
async function loadRag(): Promise<RagModule> {
  if (!ragPromise) {
    ragPromise = (async () => {
      try {
        // Variable specifier → TypeScript skips static module resolution.
        const spec = '@sanix/rag';
        return (await import(spec)) as unknown as RagModule;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `@sanix/rag is not available (${msg}). Install it to use \`sanix rag\`.`,
        );
      }
    })();
  }
  return ragPromise;
}

/**
 * Build (or return the cached) RAG pipeline wired to the SANIX
 * ProviderRouter. The store backend is chosen via `opts.store`
 * (default: `sqlite` at `~/.sanix/rag/store.db`).
 */
async function getPipeline(
  ctx: SanixContext,
  backend: 'memory' | 'filesystem' | 'sqlite' = 'sqlite',
): Promise<RagPipelineLike> {
  if (ragPipeline) return ragPipeline;
  const mod = await loadRag();

  const storeOpts: { backend?: 'memory' | 'filesystem' | 'sqlite'; dir?: string; path?: string } = { backend };
  if (backend === 'filesystem') {
    const dir = join(homedir(), '.sanix', 'rag', 'store');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    storeOpts.dir = dir;
  } else if (backend === 'sqlite') {
    const dir = join(homedir(), '.sanix', 'rag');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    storeOpts.path = join(dir, 'store.db');
  }
  ragStore = new mod.DocumentStore(storeOpts);
  ragRetriever = new mod.HybridRetriever();

  // Pick the first available provider from the router (best-effort —
  // the pipeline still works in retrieval-only mode when no provider
  // is configured).
  const providers = ctx.router.list();
  const provider = providers[0] as unknown;

  // Wire optional reranker / rewriter / multi-hop when a provider exists.
  let reranker: unknown;
  let rewriter: unknown;
  let multiHop: unknown;
  if (provider) {
    try {
      reranker = new mod.Reranker({ method: 'cross_encoder', provider });
    } catch { /* best-effort */ }
    try {
      rewriter = new mod.QueryRewriter({ provider, methods: ['rephrase', 'decompose'] });
    } catch { /* best-effort */ }
    try {
      multiHop = new mod.MultiHopRetriever({ retriever: ragRetriever, provider, maxHops: 3 });
    } catch { /* best-effort */ }
  }

  ragPipeline = new mod.RAGPipeline({
    store: ragStore,
    retriever: ragRetriever,
    reranker,
    rewriter,
    multiHop,
    provider,
    maxTokens: 1024,
    temperature: 0.3,
  });
  return ragPipeline;
}

/**
 * Register the `sanix rag` command tree.
 *
 * @param program       - The Commander root program.
 * @param ctxProvider   - Lazy context provider (called on first action).
 */
export function registerRagCommand(
  program: Command,
  ctxProvider: () => Promise<SanixContext>,
): void {
  const rag = program
    .command('rag')
    .description('Retrieval-Augmented Generation: ingest, query, search, stats.');

  rag
    .command('ingest <path>')
    .description('Ingest a file or directory into the RAG store.')
    .option('--glob <pattern>', 'File glob (for directories, e.g. "*.md").')
    .option('--recursive', 'Recurse subdirectories (default: true).', true)
    .option(
      '--store <backend>',
      'Document store backend: memory | filesystem | sqlite (default sqlite).',
      'sqlite',
    )
    .action(async (path: string, opts: RagIngestOptions) => {
      try {
        const ctx = await ctxProvider();
        await ragIngest(ctx, path, opts);
      } catch (err) {
        fail('rag ingest', err);
      }
    });

  rag
    .command('query <question>')
    .description('Ask a question against the RAG store (retrieve + generate).')
    .option('--k <n>', 'Top-K results.', (v: string) => Number(v), 5)
    .option('--no-rerank', 'Skip the reranking stage.')
    .option('--no-rewrite', 'Skip query rewriting.')
    .option('--multi-hop', 'Enable multi-hop retrieval.')
    .option('--max-hops <n>', 'Max retrieval hops.', (v: string) => Number(v), 3)
    .option('--json', 'Emit machine-readable JSON.')
    .action(async (question: string, opts: RagQueryOptions) => {
      try {
        const ctx = await ctxProvider();
        await ragQuery(ctx, question, opts);
      } catch (err) {
        fail('rag query', err);
      }
    });

  rag
    .command('search <query>')
    .description('Search the RAG store without generating an answer.')
    .option('--k <n>', 'Top-K results.', (v: string) => Number(v), 5)
    .action(async (query: string, opts: RagSearchOptions) => {
      try {
        const ctx = await ctxProvider();
        await ragSearch(ctx, query, opts);
      } catch (err) {
        fail('rag search', err);
      }
    });

  rag
    .command('stats')
    .description('Show RAG store statistics (document count, retriever size).')
    .action(async () => {
      try {
        const ctx = await ctxProvider();
        await ragStats(ctx);
      } catch (err) {
        fail('rag stats', err);
      }
    });

  rag
    .command('clear')
    .description('Clear the RAG store (delete every document).')
    .action(async () => {
      try {
        const ctx = await ctxProvider();
        await ragClear(ctx);
      } catch (err) {
        fail('rag clear', err);
      }
    });
}

/** `sanix rag ingest <path>`. */
export async function ragIngest(
  ctx: SanixContext,
  path: string,
  opts: RagIngestOptions,
): Promise<void> {
  const pipeline = await getPipeline(ctx, opts.store ?? 'sqlite');
  const abs = resolve(path);
  let st;
  try {
    st = statSync(abs);
  } catch (err) {
    throw new Error(`Path "${abs}" not accessible: ${(err as Error).message}`);
  }
  if (st.isFile()) {
    await pipeline.ingestFile(abs);
    // eslint-disable-next-line no-console
    console.log(chalk.green(`✓ Ingested file: ${abs}`));
    return;
  }
  if (st.isDirectory()) {
    await pipeline.ingestDirectory(abs, { glob: opts.glob });
    // eslint-disable-next-line no-console
    console.log(chalk.green(`✓ Ingested directory: ${abs}${opts.glob ? ` (glob: ${opts.glob})` : ''}`));
    return;
  }
  throw new Error(`Path "${abs}" is neither a file nor a directory.`);
}

/** `sanix rag query "<question>"`. */
export async function ragQuery(
  ctx: SanixContext,
  question: string,
  opts: RagQueryOptions,
): Promise<void> {
  const pipeline = await getPipeline(ctx);
  const k = opts.k ?? 5;
  const result = await pipeline.query(question, {
    k,
    multiHop: opts.multiHop === true,
    rewrite: opts.noRewrite !== true,
    rerank: opts.noRerank !== true,
  });
  void opts.maxHops; // multi-hop max is configured at pipeline construction.

  if (opts.json) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // eslint-disable-next-line no-console
  console.log(chalk.hex('#00D4FF')(`\nAnswer:\n`));
  // eslint-disable-next-line no-console
  console.log(result.answer);
  // eslint-disable-next-line no-console
  console.log(chalk.hex('#FFB347')(`\nSources (${result.sources.length}):`));
  for (let i = 0; i < result.sources.length; i++) {
    const s = result.sources[i]!;
    const title = s.doc.metadata.title ?? s.doc.metadata.source ?? s.doc.id;
    // eslint-disable-next-line no-console
    console.log(`  [${i + 1}] ${chalk.cyan(title)} ${chalk.dim(`(score ${s.score.toFixed(3)})`)}`);
    // eslint-disable-next-line no-console
    console.log(chalk.dim(`      ${s.snippet.slice(0, 100).replace(/\s+/g, ' ')}…`));
  }
  // eslint-disable-next-line no-console
  console.log(chalk.dim(`\nquery took ${result.durationMs}ms, ${result.tokensUsed} tokens`));
}

/** `sanix rag search "<query>"`. */
export async function ragSearch(
  ctx: SanixContext,
  query: string,
  opts: RagSearchOptions,
): Promise<void> {
  await getPipeline(ctx); // ensures retriever is initialized
  if (!ragRetriever) throw new Error('RAG retriever not initialized.');
  const k = opts.k ?? 5;
  const hits = await ragRetriever.retrieve(query, { k });
  if (hits.length === 0) {
    // eslint-disable-next-line no-console
    console.log(chalk.dim(`No matches for "${query}".`));
    return;
  }
  // eslint-disable-next-line no-console
  console.log(chalk.hex('#00D4FF')(`Search results for "${query}" (${hits.length}):\n`));
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i]!;
    const title = h.doc.metadata.title ?? h.doc.metadata.source ?? h.doc.id;
    // eslint-disable-next-line no-console
    console.log(`  [${i + 1}] ${chalk.cyan(title)} ${chalk.dim(`(score ${h.score.toFixed(3)})`)}`);
    // eslint-disable-next-line no-console
    console.log(chalk.dim(`      ${h.doc.content.slice(0, 100).replace(/\s+/g, ' ')}…`));
  }
}

/** `sanix rag stats`. */
export async function ragStats(ctx: SanixContext): Promise<void> {
  await getPipeline(ctx);
  if (!ragStore || !ragRetriever) throw new Error('RAG store not initialized.');
  const docs = await ragStore.count();
  const indexed = ragRetriever.size();
  // eslint-disable-next-line no-console
  console.log(chalk.hex('#00D4FF')('RAG store statistics:\n'));
  // eslint-disable-next-line no-console
  console.log(`  Documents stored : ${chalk.green(String(docs))}`);
  // eslint-disable-next-line no-console
  console.log(`  Documents indexed: ${chalk.green(String(indexed))}`);
  // eslint-disable-next-line no-console
  console.log(`  Retriever arms   : ${chalk.dim('bm25 + keyword (+ vector when embeddings available)')}`);
}

/** `sanix rag clear`. */
export async function ragClear(ctx: SanixContext): Promise<void> {
  await getPipeline(ctx);
  if (!ragStore) throw new Error('RAG store not initialized.');
  const docs = await ragStore.list({ limit: 10_000 });
  for (const d of docs) {
    await ragStore.delete(d.id);
  }
  // eslint-disable-next-line no-console
  console.log(chalk.green(`✓ Cleared ${docs.length} documents from the RAG store.`));
}

/** Print a red error and set exit code 1. */
function fail(cmd: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error(chalk.red(`\n✗ sanix ${cmd} failed: ${msg}\n`));
  process.exitCode = 1;
}
