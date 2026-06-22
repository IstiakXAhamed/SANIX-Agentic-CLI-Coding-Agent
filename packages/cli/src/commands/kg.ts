/**
 * @file commands/kg.ts
 * @description `sanix kg <sub>` — knowledge graph subcommands.
 *
 *   sanix kg ingest <path>                       Ingest file/dir into the graph.
 *   sanix kg query "<question>"                  Semantic + graph search.
 *   sanix kg dsl "<cypher-like query>"           Execute GraphQueryDSL query.
 *   sanix kg visualize <entityId>                Visualize a subgraph.
 *   sanix kg stats                               Graph statistics.
 *   sanix kg list-entities                       List all entities.
 *   sanix kg find <name>                         Find entities by name.
 *
 * Delegates to {@link KnowledgeManager} from `@sanix/knowledge`. The
 * manager is wired with the first available {@link IProvider} for LLM-
 * based entity extraction.
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

/** Parsed options for `sanix kg ingest`. */
export interface KgIngestOptions {
  source?: string;
  method?: 'llm' | 'regex' | 'hybrid';
  glob?: string;
}

/** Parsed options for `sanix kg query`. */
export interface KgQueryOptions {
  k?: number;
  depth?: number;
}

/** Parsed options for `sanix kg visualize`. */
export interface KgVisualizeOptions {
  depth?: number;
  format?: 'dot' | 'mermaid' | 'ascii' | 'json';
}

/** Parsed options for `sanix kg list-entities`. */
export interface KgListOptions {
  type?: string;
  limit?: number;
}

/** Parsed options for `sanix kg find`. */
export interface KgFindOptions {
  type?: string;
}

/** Lazy handle to the `@sanix/knowledge` module. */
interface KnowledgeModule {
  KnowledgeManager: new (opts: {
    dbPath?: string;
    inMemory?: boolean;
    provider?: unknown;
    method?: 'llm' | 'regex' | 'hybrid';
  }) => KnowledgeManagerLike;
}

interface KnowledgeManagerLike {
  ingest: (text: string, source?: string) => Promise<IngestResultLike>;
  ingestFile: (path: string) => Promise<IngestResultLike>;
  ingestDirectory: (
    path: string,
    opts?: { glob?: string; source?: string },
  ) => Promise<IngestResultLike[]>;
  query: (
    question: string,
    opts?: { k?: number; depth?: number },
  ) => Promise<QueryResultLike>;
  executeDSL: (query: string) => Promise<DslResultLike>;
  visualize: (
    entityId: string,
    depth?: number,
    format?: 'dot' | 'mermaid' | 'ascii' | 'json',
  ) => Promise<string>;
  stats: () => GraphStatsLike;
  getStore: () => {
    listEntities: (filter?: {
      type?: string;
      nameContains?: string;
      limit?: number;
      offset?: number;
    }) => EntityLike[];
  };
  close: () => void;
}

interface IngestResultLike {
  entitiesAdded: number;
  relationshipsAdded: number;
  entitiesMerged: number;
  durationMs: number;
}

interface QueryResultLike {
  answer: string;
  entities: EntityLike[];
  relationships: RelationshipLike[];
  sources: string[];
}

interface DslResultLike {
  rows: unknown[];
  rowCount: number;
}

interface EntityLike {
  id: string;
  type: string;
  name: string;
  aliases: string[];
  description?: string;
  source: string;
  confidence: number;
}

interface RelationshipLike {
  id: string;
  type: string;
  source: string;
  target: string;
}

interface GraphStatsLike {
  entityCount: number;
  relationshipCount: number;
  typeDistribution: Record<string, number>;
  relationshipTypeDistribution: Record<string, number>;
  avgDegree: number;
  connectedComponents: number;
}

/** Cached dynamic-import of `@sanix/knowledge`. */
let knowledgePromise: Promise<KnowledgeModule> | null = null;
let knowledgeManager: KnowledgeManagerLike | null = null;

/**
 * Lazily dynamic-import `@sanix/knowledge`. Cached. Throws a friendly
 * error if the package is missing.
 */
async function loadKnowledge(): Promise<KnowledgeModule> {
  if (!knowledgePromise) {
    knowledgePromise = (async () => {
      try {
        // Variable specifier → TypeScript skips static module resolution.
        const spec = '@sanix/knowledge';
        return (await import(spec)) as unknown as KnowledgeModule;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `@sanix/knowledge is not available (${msg}). Install it to use \`sanix kg\`.`,
        );
      }
    })();
  }
  return knowledgePromise;
}

/**
 * Build (or return the cached) `KnowledgeManager` wired to the SANIX
 * ProviderRouter. The SQLite store lives at `~/.sanix/knowledge/graph.db`.
 */
async function getManager(
  ctx: SanixContext,
  method: 'llm' | 'regex' | 'hybrid' = 'hybrid',
): Promise<KnowledgeManagerLike> {
  if (knowledgeManager) return knowledgeManager;
  const mod = await loadKnowledge();

  const dir = join(homedir(), '.sanix', 'knowledge');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'graph.db');

  // Pick the first available provider — needed for `llm` / `hybrid`
  // extraction. The manager degrades to regex-only when no provider.
  const providers = ctx.router.list();
  const provider = providers[0] as unknown;

  knowledgeManager = new mod.KnowledgeManager({
    dbPath,
    provider,
    method,
  });
  return knowledgeManager;
}

/**
 * Register the `sanix kg` command tree.
 *
 * @param program       - The Commander root program.
 * @param ctxProvider   - Lazy context provider (called on first action).
 */
export function registerKgCommand(
  program: Command,
  ctxProvider: () => Promise<SanixContext>,
): void {
  const kg = program
    .command('kg')
    .description('Knowledge graph: ingest, query, DSL, visualize, stats.');

  kg
    .command('ingest <path>')
    .description('Ingest a file or directory into the knowledge graph.')
    .option('--source <name>', 'Source label (e.g. file path or URL).')
    .option(
      '--method <m>',
      'Extraction method: llm | regex | hybrid (default hybrid).',
      'hybrid',
    )
    .option('--glob <pattern>', 'File glob (for directories).')
    .action(async (path: string, opts: KgIngestOptions) => {
      try {
        const ctx = await ctxProvider();
        await kgIngest(ctx, path, opts);
      } catch (err) {
        fail('kg ingest', err);
      }
    });

  kg
    .command('query <question>')
    .description('Semantic + graph search for a natural-language question.')
    .option('--k <n>', 'Top-K entities (default 10).', (v: string) => Number(v), 10)
    .option('--depth <n>', 'Graph expansion depth (default 2).', (v: string) => Number(v), 2)
    .action(async (question: string, opts: KgQueryOptions) => {
      try {
        const ctx = await ctxProvider();
        await kgQuery(ctx, question, opts);
      } catch (err) {
        fail('kg query', err);
      }
    });

  kg
    .command('dsl <query>')
    .description(
      'Execute a Cypher-like GraphQueryDSL query, e.g. ' +
        '"MATCH (n:Person)-[:WORKS_AT]->(o) WHERE o.name=\'Acme\' RETURN n".',
    )
    .action(async (query: string) => {
      try {
        const ctx = await ctxProvider();
        await kgDsl(ctx, query);
      } catch (err) {
        fail('kg dsl', err);
      }
    });

  kg
    .command('visualize <entityId>')
    .description('Visualize the subgraph around an entity.')
    .option('--depth <n>', 'Neighborhood depth (default 2).', (v: string) => Number(v), 2)
    .option(
      '--format <fmt>',
      'Output format: dot | mermaid | ascii | json (default mermaid).',
      'mermaid',
    )
    .action(async (entityId: string, opts: KgVisualizeOptions) => {
      try {
        const ctx = await ctxProvider();
        await kgVisualize(ctx, entityId, opts);
      } catch (err) {
        fail('kg visualize', err);
      }
    });

  kg
    .command('stats')
    .description('Show knowledge graph statistics.')
    .action(async () => {
      try {
        const ctx = await ctxProvider();
        await kgStats(ctx);
      } catch (err) {
        fail('kg stats', err);
      }
    });

  kg
    .command('list-entities')
    .description('List all entities in the graph.')
    .option('--type <EntityType>', 'Filter by entity type.')
    .option('--limit <n>', 'Max entities to list (default 50).', (v: string) => Number(v), 50)
    .action(async (opts: KgListOptions) => {
      try {
        const ctx = await ctxProvider();
        await kgListEntities(ctx, opts);
      } catch (err) {
        fail('kg list-entities', err);
      }
    });

  kg
    .command('find <name>')
    .description('Find entities by name (case-insensitive substring match).')
    .option('--type <EntityType>', 'Filter by entity type.')
    .action(async (name: string, opts: KgFindOptions) => {
      try {
        const ctx = await ctxProvider();
        await kgFind(ctx, name, opts);
      } catch (err) {
        fail('kg find', err);
      }
    });
}

/** `sanix kg ingest <path>`. */
export async function kgIngest(
  ctx: SanixContext,
  path: string,
  opts: KgIngestOptions,
): Promise<void> {
  const mgr = await getManager(ctx, opts.method ?? 'hybrid');
  const abs = resolve(path);
  let st;
  try {
    st = statSync(abs);
  } catch (err) {
    throw new Error(`Path "${abs}" not accessible: ${(err as Error).message}`);
  }
  if (st.isFile()) {
    const r = await mgr.ingestFile(abs);
    printIngestResult(abs, r);
    return;
  }
  if (st.isDirectory()) {
    const results = await mgr.ingestDirectory(abs, { glob: opts.glob, source: opts.source });
    let totalAdded = 0;
    let totalMerged = 0;
    for (const r of results) {
      totalAdded += r.entitiesAdded + r.relationshipsAdded;
      totalMerged += r.entitiesMerged;
    }
    // eslint-disable-next-line no-console
    console.log(
      chalk.green(`✓ Ingested ${results.length} files from ${abs}`) +
        chalk.dim(` (${totalAdded} added, ${totalMerged} merged)`),
    );
    return;
  }
  throw new Error(`Path "${abs}" is neither a file nor a directory.`);
}

/** `sanix kg query "<question>"`. */
export async function kgQuery(
  ctx: SanixContext,
  question: string,
  opts: KgQueryOptions,
): Promise<void> {
  const mgr = await getManager(ctx);
  const result = await mgr.query(question, {
    k: opts.k ?? 10,
    depth: opts.depth ?? 2,
  });
  // eslint-disable-next-line no-console
  console.log(chalk.hex('#00D4FF')(`\nAnswer:\n`));
  // eslint-disable-next-line no-console
  console.log(result.answer);

  if (result.entities.length > 0) {
    // eslint-disable-next-line no-console
    console.log(chalk.hex('#FFB347')(`\nEntities (${result.entities.length}):`));
    for (const e of result.entities.slice(0, 10)) {
      // eslint-disable-next-line no-console
      console.log(`  ${chalk.cyan(e.name)} ${chalk.dim(`[${e.type}]`)} ${chalk.dim(`(conf ${e.confidence.toFixed(2)})`)}`);
    }
  }
  if (result.relationships.length > 0) {
    // eslint-disable-next-line no-console
    console.log(chalk.hex('#FFB347')(`\nRelationships (${result.relationships.length}):`));
    for (const r of result.relationships.slice(0, 10)) {
      // eslint-disable-next-line no-console
      console.log(chalk.dim(`  ${r.source} --${r.type}--> ${r.target}`));
    }
  }
}

/** `sanix kg dsl "<query>"`. */
export async function kgDsl(ctx: SanixContext, query: string): Promise<void> {
  const mgr = await getManager(ctx);
  const result = await mgr.executeDSL(query);
  // eslint-disable-next-line no-console
  console.log(chalk.hex('#00D4FF')(`DSL query: ${query}\n`));
  // eslint-disable-next-line no-console
  console.log(chalk.green(`Rows: ${result.rowCount}`));
  if (result.rowCount > 0) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result.rows, null, 2));
  }
}

/** `sanix kg visualize <entityId>`. */
export async function kgVisualize(
  ctx: SanixContext,
  entityId: string,
  opts: KgVisualizeOptions,
): Promise<void> {
  const mgr = await getManager(ctx);
  const format = opts.format ?? 'mermaid';
  const depth = opts.depth ?? 2;
  const out = await mgr.visualize(entityId, depth, format);
  // eslint-disable-next-line no-console
  console.log(out);
}

/** `sanix kg stats`. */
export async function kgStats(ctx: SanixContext): Promise<void> {
  const mgr = await getManager(ctx);
  const s = mgr.stats();
  // eslint-disable-next-line no-console
  console.log(chalk.hex('#00D4FF')('Knowledge graph statistics:\n'));
  // eslint-disable-next-line no-console
  console.log(`  Entities              : ${chalk.green(String(s.entityCount))}`);
  // eslint-disable-next-line no-console
  console.log(`  Relationships         : ${chalk.green(String(s.relationshipCount))}`);
  // eslint-disable-next-line no-console
  console.log(`  Avg degree            : ${chalk.dim(s.avgDegree.toFixed(2))}`);
  // eslint-disable-next-line no-console
  console.log(`  Connected components  : ${chalk.dim(String(s.connectedComponents))}`);

  const types = Object.entries(s.typeDistribution).filter(([, n]) => n > 0);
  if (types.length > 0) {
    // eslint-disable-next-line no-console
    console.log(chalk.hex('#FFB347')('\n  Entity types:'));
    for (const [t, n] of types.sort((a, b) => b[1] - a[1])) {
      // eslint-disable-next-line no-console
      console.log(`    ${t.padEnd(16)} ${chalk.cyan(String(n))}`);
    }
  }
}

/** `sanix kg list-entities`. */
export async function kgListEntities(
  ctx: SanixContext,
  opts: KgListOptions,
): Promise<void> {
  const mgr = await getManager(ctx);
  const entities = mgr.getStore().listEntities({
    type: opts.type,
    limit: opts.limit ?? 50,
  });
  if (entities.length === 0) {
    // eslint-disable-next-line no-console
    console.log(chalk.dim('No entities in the graph. Run `sanix kg ingest <path>` first.'));
    return;
  }
  // eslint-disable-next-line no-console
  console.log(chalk.hex('#00D4FF')(`Entities (${entities.length}):\n`));
  for (const e of entities) {
    // eslint-disable-next-line no-console
    console.log(`  ${chalk.cyan(e.name.padEnd(28))} ${chalk.dim(`[${e.type}]`.padEnd(14))} ${chalk.dim(e.id.slice(0, 8))}`);
  }
}

/** `sanix kg find <name>`. */
export async function kgFind(
  ctx: SanixContext,
  name: string,
  opts: KgFindOptions,
): Promise<void> {
  const mgr = await getManager(ctx);
  const entities = mgr.getStore().listEntities({
    type: opts.type,
    nameContains: name,
    limit: 50,
  });
  if (entities.length === 0) {
    // eslint-disable-next-line no-console
    console.log(chalk.dim(`No entities matched "${name}".`));
    return;
  }
  // eslint-disable-next-line no-console
  console.log(chalk.hex('#00D4FF')(`Matches for "${name}" (${entities.length}):\n`));
  for (const e of entities) {
    // eslint-disable-next-line no-console
    console.log(`  ${chalk.cyan(e.name.padEnd(28))} ${chalk.dim(`[${e.type}]`.padEnd(14))} ${chalk.dim(e.id.slice(0, 8))}`);
    if (e.description) {
      // eslint-disable-next-line no-console
      console.log(chalk.dim(`      ${e.description.slice(0, 100)}`));
    }
  }
}

/** Print a single ingest result. */
function printIngestResult(path: string, r: IngestResultLike): void {
  // eslint-disable-next-line no-console
  console.log(
    chalk.green(`✓ Ingested ${path}`) +
    chalk.dim(` (${r.entitiesAdded} entities, ${r.relationshipsAdded} relationships, ${r.entitiesMerged} merged, ${r.durationMs}ms)`),
  );
}

/** Print a red error and set exit code 1. */
function fail(cmd: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error(chalk.red(`\n✗ sanix ${cmd} failed: ${msg}\n`));
  process.exitCode = 1;
}
