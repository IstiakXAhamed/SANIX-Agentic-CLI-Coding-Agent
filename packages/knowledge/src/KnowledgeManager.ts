/**
 * @file KnowledgeManager.ts
 * @description Top-level facade that combines {@link GraphStore},
 * {@link EntityExtractor}, {@link GraphBuilder}, {@link KnowledgeIndex},
 * {@link GraphQueryDSL}, and {@link GraphVisualizer} into a single
 * easy-to-use class that emits lifecycle events via {@link EventEmitter3}.
 *
 * ## Events
 *
 *   - `ingest:start`       — payload: `{ text: string; source?: string }`
 *   - `ingest:complete`    — payload: `IngestResult`
 *   - `query:start`        — payload: `{ question: string }`
 *   - `query:complete`     — payload: `QueryResult`
 *   - `entity:added`       — payload: `Entity`
 *   - `entity:merged`      — payload: `{ target: Entity; sourceId: string }`
 *   - `relationship:added` — payload: `Relationship`
 *
 * @packageDocumentation
 */

import { EventEmitter } from 'eventemitter3';
import { readdir, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import type { IProvider } from '@sanix/providers';
import { GraphStore } from './GraphStore.js';
import { EntityExtractor } from './EntityExtractor.js';
import { GraphBuilder } from './GraphBuilder.js';
import { KnowledgeIndex } from './KnowledgeIndex.js';
import { GraphQueryDSL } from './GraphQueryDSL.js';
import { GraphVisualizer } from './GraphVisualizer.js';
import type {
  Entity,
  EntityType,
  GraphQueryResult,
  GraphStats,
  IngestResult,
  QueryResult,
  Relationship,
  Subgraph,
} from './types.js';

// ─── Constructor options ───────────────────────────────────────────────────

/**
 * Embedding provider interface used by {@link KnowledgeManager}. Mirrors
 * the shape used by the {@link GraphBuilder} and {@link KnowledgeIndex}.
 */
export interface EmbeddingProviderLike {
  /** Embed a single text; return null on failure. */
  embed(text: string): Promise<Float32Array | null>;
}

/**
 * Options for {@link KnowledgeManager.constructor}.
 */
export interface KnowledgeManagerOptions {
  /**
   * SQLite path for the graph store. May use `~` shorthand. Ignored when
   * `inMemory` is true. Default: `~/.sanix/knowledge/graph.db`.
   */
  dbPath?: string;
  /** When true, open the graph store in memory. Default: false. */
  inMemory?: boolean;
  /**
   * LLM provider for the entity extractor. When omitted, the extractor
   * falls back to regex-only extraction.
   */
  provider?: IProvider;
  /**
   * Embedding provider for entity descriptions (used by both the
   * GraphBuilder and the KnowledgeIndex). When omitted, semantic search
   * is disabled.
   */
  embeddingProvider?: EmbeddingProviderLike;
  /**
   * Extraction method: 'llm' | 'regex' | 'hybrid'. Default: 'hybrid'
   * (falls back to 'regex' when no provider is supplied).
   */
  method?: 'llm' | 'regex' | 'hybrid';
  /**
   * Restrict the extractor to these entity types. Default: all 11
   * canonical types.
   */
  entityTypes?: EntityType[];
}

// ─── Event map ────────────────────────────────────────────────────────────

/**
 * Event map for {@link KnowledgeManager}. Each key is an event name;
 * each value is the payload type.
 */
export interface KnowledgeManagerEvents {
  'ingest:start': { text: string; source?: string };
  'ingest:complete': IngestResult;
  'query:start': { question: string };
  'query:complete': QueryResult;
  'entity:added': Entity;
  'entity:merged': { target: Entity; sourceId: string };
  'relationship:added': Relationship;
}

// ─── KnowledgeManager ─────────────────────────────────────────────────────

/**
 * Top-level facade. Combines the graph store, extractor, builder, index,
 * DSL, and visualizer into one easy-to-use class that emits lifecycle
 * events.
 *
 * @example
 * ```ts
 * const km = new KnowledgeManager({
 *   provider: anthropicProvider,
 *   embeddingProvider: EmbeddingProvider.getInstance(),
 * });
 * km.on('ingest:complete', (r) => console.log('ingested:', r));
 * await km.ingest('Alice works at Acme Corp. She created the HNSW module.');
 * const result = await km.query('Who created the HNSW module?');
 * console.log(result.answer);
 * console.log(await km.visualize(entityId, 2, 'mermaid'));
 * ```
 */
export class KnowledgeManager extends EventEmitter<KnowledgeManagerEvents> {
  private readonly store: GraphStore;
  private readonly extractor: EntityExtractor;
  private readonly builder: GraphBuilder;
  private readonly index: KnowledgeIndex;
  private readonly dsl: GraphQueryDSL;
  private readonly visualizer: GraphVisualizer;

  /**
   * @param opts - Constructor options. See {@link KnowledgeManagerOptions}.
   */
  constructor(opts: KnowledgeManagerOptions = {}) {
    super();
    this.store = new GraphStore({
      dbPath: opts.dbPath,
      inMemory: opts.inMemory,
    });
    this.store.open();
    this.extractor = new EntityExtractor({
      provider: opts.provider,
      method: opts.method,
      entityTypes: opts.entityTypes,
    });
    this.builder = new GraphBuilder(this.store, this.extractor, {
      embeddingProvider: opts.embeddingProvider,
      mergeOnAlias: true,
    });
    this.index = new KnowledgeIndex(this.store, {
      embeddingProvider: opts.embeddingProvider,
    });
    this.dsl = new GraphQueryDSL();
    this.visualizer = new GraphVisualizer();
  }

  /**
   * The underlying {@link GraphStore}. Exposed for callers that need
   * direct CRUD access (e.g. the dashboard).
   */
  getStore(): GraphStore {
    return this.store;
  }

  /**
   * The underlying {@link EntityExtractor}. Exposed for callers that
   * want to extract without ingesting.
   */
  getExtractor(): EntityExtractor {
    return this.extractor;
  }

  /**
   * The underlying {@link KnowledgeIndex}. Exposed for callers that want
   * direct hybrid-search access.
   */
  getIndex(): KnowledgeIndex {
    return this.index;
  }

  /**
   * The underlying {@link GraphQueryDSL}. Exposed for callers that want
   * to parse DSL queries without executing them.
   */
  getDSL(): GraphQueryDSL {
    return this.dsl;
  }

  /**
   * The underlying {@link GraphVisualizer}. Exposed for callers that want
   * to render subgraphs in custom formats.
   */
  getVisualizer(): GraphVisualizer {
    return this.visualizer;
  }

  // ─── Ingest ─────────────────────────────────────────────────────────────

  /**
   * Ingest `text`: extract entities + relationships, store them, and
   * update the keyword + vector indexes. Emits `ingest:start` and
   * `ingest:complete`.
   *
   * @param text - The text to ingest.
   * @param source - Optional provenance string. Default: 'unknown'.
   * @returns Counts of entities/relationships added + merged, and duration.
   */
  async ingest(text: string, source?: string): Promise<IngestResult> {
    this.emit('ingest:start', { text, source });
    const result = await this.builder.ingest(text, { source });
    // Update FTS + vector indexes for newly-added entities.
    this.refreshIndexes();
    this.emit('ingest:complete', result);
    return result;
  }

  /**
   * Ingest a file's contents. Emits the same events as {@link ingest}.
   *
   * @param path - Path to the file.
   * @returns Counts of entities/relationships added + merged, and duration.
   */
  async ingestFile(path: string): Promise<IngestResult> {
    this.emit('ingest:start', { text: `<file:${path}>`, source: path });
    const result = await this.builder.ingestFile(path);
    this.refreshIndexes();
    this.emit('ingest:complete', result);
    return result;
  }

  /**
   * Ingest a directory's files. Emits `ingest:start` once per file +
   * `ingest:complete` once per file.
   *
   * @param path - Directory to walk.
   * @param opts - Optional glob filter (file extension, e.g. `'.md'`) +
   *               per-file source/confidence.
   * @returns Per-file ingest results.
   */
  async ingestDirectory(
    path: string,
    opts?: { glob?: string; source?: string; confidence?: number },
  ): Promise<IngestResult[]> {
    // Walk + ingest file-by-file, emitting per-file events.
    const results: IngestResult[] = [];
    const files = await walkFiles(path, opts?.glob);
    for (const f of files) {
      this.emit('ingest:start', { text: `<file:${f}>`, source: f });
      const r = await this.builder.ingestFile(f, {
        source: opts?.source,
        confidence: opts?.confidence,
      });
      results.push(r);
      this.emit('ingest:complete', r);
    }
    this.refreshIndexes();
    return results;
  }

  /**
   * Merge two entities (delegating to the {@link GraphBuilder}).
   * Emits `entity:merged`.
   *
   * @param targetId - The entity to merge INTO.
   * @param sourceId - The entity to merge FROM (will be deleted).
   */
  async mergeEntities(targetId: string, sourceId: string): Promise<void> {
    await this.builder.mergeEntities(targetId, sourceId);
    const target = this.store.getEntity(targetId);
    if (target) {
      this.emit('entity:merged', { target, sourceId });
    }
    this.refreshIndexes();
  }

  // ─── Query ──────────────────────────────────────────────────────────────

  /**
   * Semantic + graph search for `question`. Emits `query:start` and
   * `query:complete`.
   *
   * @param question - Natural-language question.
   * @param opts - Search options: `k` (top-k, default 5) and `depth`
   *               (graph expansion, default 1).
   * @returns Answer text + matched entities/relationships/subgraph/sources.
   */
  async query(
    question: string,
    opts: { k?: number; depth?: number } = {},
  ): Promise<QueryResult> {
    this.emit('query:start', { question });
    const k = opts.k ?? 5;
    const depth = opts.depth ?? 1;
    const search = await this.index.search(question, { k, depth });
    const entities: Entity[] = search.entities.map((e) => {
      // Strip the score + matchedVia from the ScoredEntity for the
      // public QueryResult.entities shape.
      const { score: _s, matchedVia: _m, ...rest } = e;
      void _s;
      void _m;
      return rest;
    });
    const relationships = search.relationships;
    const subgraph: Subgraph = search.subgraph;
    const sources = Array.from(
      new Set(entities.map((e) => e.source).filter(Boolean)),
    );
    const answer = this.synthesizeAnswer(question, entities, relationships);
    const result: QueryResult = {
      answer,
      entities,
      relationships,
      subgraph,
      sources,
    };
    this.emit('query:complete', result);
    return result;
  }

  /**
   * Execute a Cypher-like DSL query. Emits no events (use
   * {@link query} for natural-language questions).
   *
   * @example
   * ```ts
   * const r = await km.executeDSL(
   *   "MATCH (n:Person)-[:WORKS_AT]->(o:Organization) WHERE o.name = 'Acme' RETURN n"
   * );
   * ```
   */
  async executeDSL(query: string): Promise<GraphQueryResult> {
    const parsed = this.dsl.parse(query);
    return this.dsl.execute(parsed, this.store);
  }

  /**
   * Visualize the neighborhood of `entityId` in the chosen format.
   *
   * @param entityId - The root entity id.
   * @param depth - Neighborhood depth (1 or 2). Default: 1.
   * @param format - Output format. Default: 'mermaid'.
   * @returns The visualization as a string.
   */
  async visualize(
    entityId: string,
    depth: number = 1,
    format: 'dot' | 'mermaid' | 'ascii' | 'json' = 'mermaid',
  ): Promise<string> {
    const sub = this.store.getSubgraph(entityId, depth);
    switch (format) {
      case 'dot':
        return this.visualizer.toDot(sub);
      case 'mermaid':
        return this.visualizer.toMermaid(sub);
      case 'ascii':
        return this.visualizer.toAscii(sub);
      case 'json':
        return this.visualizer.toJSON(sub);
    }
  }

  /**
   * Aggregate statistics about the knowledge graph.
   */
  stats(): GraphStats {
    const typeDistribution = this.fullTypeDistribution();
    const relationshipTypeDistribution =
      this.store.countRelationshipsByType();
    const entityCount = this.store.countEntities();
    const relationshipCount = this.store.countRelationships();
    const components = this.store.clusterByConnectedComponents();
    const avgDegree =
      entityCount === 0 ? 0 : (2 * relationshipCount) / entityCount;
    return {
      entityCount,
      relationshipCount,
      typeDistribution,
      relationshipTypeDistribution,
      avgDegree,
      connectedComponents: components.length,
    };
  }

  /**
   * Close the underlying SQLite handle. Safe to call multiple times.
   */
  close(): void {
    this.store.close();
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  /**
   * Refresh the FTS + vector indexes after an ingest. Cheap if nothing
   * changed (rebuilds FTS from scratch; vector index is lazily updated).
   */
  private refreshIndexes(): void {
    this.index.reindex();
    // Vector index sync is async + may be slow; fire-and-forget.
    void this.index.syncVectorIndex().catch(() => {
      // Swallow — vector index is best-effort.
    });
  }

  /**
   * Build a `Record<EntityType, number>` covering ALL canonical types
   * (zero-filled for absent types) so the consumer's UI doesn't have to
   * handle missing keys.
   */
  private fullTypeDistribution(): Record<EntityType, number> {
    const all: Record<EntityType, number> = {
      person: 0,
      organization: 0,
      concept: 0,
      event: 0,
      location: 0,
      document: 0,
      code: 0,
      tool: 0,
      project: 0,
      technology: 0,
      custom: 0,
    };
    const counts = this.store.countByType();
    for (const k of Object.keys(counts) as EntityType[]) {
      all[k] = counts[k] ?? 0;
    }
    return all;
  }

  /**
   * Synthesize a natural-language answer from the matched entities +
   * relationships. Pure template-based — no LLM call (the LLM is the
   * caller's responsibility if they want a fancier synthesis).
   */
  private synthesizeAnswer(
    question: string,
    entities: Entity[],
    relationships: Relationship[],
  ): string {
    if (entities.length === 0) {
      return `I couldn't find anything in the knowledge graph about "${question}".`;
    }
    const top = entities[0]!;
    const lines: string[] = [];
    lines.push(
      `Based on the knowledge graph, the most relevant entity for "${question}" is ${top.name} (${top.type}).`,
    );
    if (top.description) {
      lines.push(top.description);
    }
    if (entities.length > 1) {
      const others = entities
        .slice(1, 4)
        .map((e) => `${e.name} (${e.type})`)
        .join(', ');
      lines.push(`Related entities: ${others}.`);
    }
    if (relationships.length > 0) {
      const relSummary = relationships
        .slice(0, 3)
        .map((r) => {
          const src = entities.find((e) => e.id === r.source);
          const tgt = entities.find((e) => e.id === r.target);
          return `${src?.name ?? r.source} --${r.type}--> ${tgt?.name ?? r.target}`;
        })
        .join('; ');
      lines.push(`Relationships: ${relSummary}.`);
    }
    return lines.join(' ');
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Recursively walk `dir`, returning the list of files matching `glob`
 * (extension filter, e.g. `'.md'`). Returns absolute paths. Used by
 * {@link KnowledgeManager.ingestDirectory}.
 */
async function walkFiles(
  dir: string,
  glob: string | undefined,
): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [dir];
  const maxBytes = 1024 * 1024; // 1 MiB safety cap.
  while (stack.length > 0) {
    const curr = stack.pop()!;
    let entries;
    try {
      entries = await readdir(curr);
    } catch {
      continue;
    }
    for (const name of entries) {
      const p = join(curr, name);
      let s;
      try {
        s = await stat(p);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        stack.push(p);
      } else if (s.isFile() && s.size <= maxBytes) {
        if (glob) {
          if (extname(name).toLowerCase() === glob.toLowerCase()) {
            out.push(p);
          }
        } else {
          out.push(p);
        }
      }
    }
  }
  return out;
}
