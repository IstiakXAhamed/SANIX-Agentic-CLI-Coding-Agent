/**
 * @file GraphStore.ts
 * @description SQLite-backed knowledge graph storage. Stores entities
 * (nodes) and relationships (edges) in two tables with appropriate indexes,
 * with no native graph DB dependency. Traversal queries (subgraph,
 * shortest-path, find-paths) are implemented in TypeScript over the
 * in-memory adjacency map that's built lazily from the SQLite rows.
 *
 * ## Schema
 *
 * ```sql
 * CREATE TABLE entities (
 *   id          TEXT PRIMARY KEY,
 *   type        TEXT NOT NULL,
 *   name        TEXT NOT NULL,
 *   aliases     TEXT NOT NULL,      -- JSON array of strings
 *   description TEXT,
 *   properties  TEXT NOT NULL,      -- JSON object
 *   source      TEXT NOT NULL,
 *   confidence  REAL NOT NULL,
 *   created_at  INTEGER NOT NULL,
 *   updated_at  INTEGER NOT NULL,
 *   embedding   BLOB                -- Float32Array buffer (optional)
 * );
 * CREATE TABLE relationships (
 *   id          TEXT PRIMARY KEY,
 *   type        TEXT NOT NULL,
 *   source      TEXT NOT NULL,      -- entity id
 *   target      TEXT NOT NULL,      -- entity id
 *   properties  TEXT NOT NULL,      -- JSON object
 *   confidence  REAL NOT NULL,
 *   evidence    TEXT NOT NULL,      -- JSON array of strings
 *   source_meta TEXT NOT NULL,
 *   created_at  INTEGER NOT NULL,
 *   updated_at  INTEGER NOT NULL
 * );
 * ```
 *
 * Indexes on `entities(name)`, `entities(type)`, `relationships(source)`,
 * `relationships(target)`, `relationships(type)`.
 *
 * ## Embeddings
 *
 * Embeddings are stored as BLOBs (raw `Float32Array` buffer). On read they
 * are reconstructed into `Float32Array` instances.
 *
 * ## Transactions
 *
 * Multi-entity ingests should call {@link GraphStore.transaction} (or use
 * the {@link GraphStore.withTransaction} helper) to wrap their writes in a
 * single SQLite transaction for atomicity + performance.
 *
 * @packageDocumentation
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { nanoid } from 'nanoid';
import type {
  Entity,
  EntityType,
  GraphEdge,
  GraphNode,
  Relationship,
  Subgraph,
} from './types.js';

// ─── Constructor options ───────────────────────────────────────────────────

/**
 * Options for {@link GraphStore.constructor}.
 */
export interface GraphStoreOptions {
  /**
   * SQLite file path. May use `~` shorthand. Ignored when `inMemory` is
   * true. Default: `~/.sanix/knowledge/graph.db`.
   */
  dbPath?: string;
  /** When true, open an in-memory database (`:memory:`). Default: false. */
  inMemory?: boolean;
}

// ─── Filter bags ───────────────────────────────────────────────────────────

/**
 * Filter for {@link GraphStore.listEntities}. All conditions are AND'd.
 */
export interface EntityFilter {
  /** Filter by entity type. */
  type?: EntityType;
  /** Filter by source string (exact match). */
  source?: string;
  /** Minimum confidence (inclusive). */
  minConfidence?: number;
  /** Maximum confidence (inclusive). */
  maxConfidence?: number;
  /** Substring match on name (case-insensitive). */
  nameContains?: string;
  /** Limit number of returned rows. Default: unlimited. */
  limit?: number;
  /** Skip the first N rows. Default: 0. */
  offset?: number;
}

/**
 * Options for {@link GraphStore.getRelationships}.
 */
export interface GetRelationshipsOptions {
  /** Direction relative to `entityId`. Default: 'both'. */
  direction?: 'in' | 'out' | 'both';
  /** Filter by relationship type. */
  type?: string;
  /** Limit number of returned rows. Default: unlimited. */
  limit?: number;
}

/**
 * Options for {@link GraphStore.findPaths}.
 */
export interface FindPathsOptions {
  /** Max number of paths to return. Default: 5. */
  maxPaths?: number;
  /** Max hops per path. Default: 5. */
  maxDepth?: number;
}

// ─── Row shapes (as read from SQLite) ─────────────────────────────────────

interface EntityRow {
  id: string;
  type: string;
  name: string;
  aliases: string;
  description: string | null;
  properties: string;
  source: string;
  confidence: number;
  created_at: number;
  updated_at: number;
  embedding: Buffer | null;
}

interface RelationshipRow {
  id: string;
  type: string;
  source: string;
  target: string;
  properties: string;
  confidence: number;
  evidence: string;
  source_meta: string;
  created_at: number;
  updated_at: number;
}

// ─── GraphStore ───────────────────────────────────────────────────────────

/**
 * SQLite-backed knowledge graph storage.
 *
 * Provides CRUD over entities + relationships, plus graph-traversal
 * queries (subgraph, shortest-path, find-paths) and aggregations
 * (count-by-type, most-connected, connected-components).
 *
 * @example
 * ```ts
 * const store = new GraphStore({ inMemory: true });
 * const alice = store.addEntity({
 *   id: nanoid(), type: 'person', name: 'Alice',
 *   aliases: [], properties: {}, source: 'demo', confidence: 0.9,
 *   createdAt: Date.now(), updatedAt: Date.now(),
 * });
 * const acme = store.addEntity({
 *   id: nanoid(), type: 'organization', name: 'Acme',
 *   aliases: [], properties: {}, source: 'demo', confidence: 0.9,
 *   createdAt: Date.now(), updatedAt: Date.now(),
 * });
 * store.addRelationship({
 *   id: nanoid(), type: 'works_at', source: alice.id, target: acme.id,
 *   properties: {}, confidence: 0.9, evidence: ['Alice works at Acme'],
 *   source_meta: 'demo', createdAt: Date.now(), updatedAt: Date.now(),
 * });
 * const sub = store.getSubgraph(alice.id, 2);
 * console.log(sub.nodes.length, sub.edges.length);
 * ```
 */
export class GraphStore {
  private readonly dbPath: string;
  private readonly inMemory: boolean;
  private db: Database.Database | null = null;

  /**
   * @param opts - Constructor options. See {@link GraphStoreOptions}.
   */
  constructor(opts: GraphStoreOptions = {}) {
    this.inMemory = opts.inMemory ?? false;
    this.dbPath = opts.dbPath ?? '~/.sanix/knowledge/graph.db';
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Open (or create) the SQLite database and ensure the schema exists.
   * Idempotent — safe to call multiple times.
   *
   * @returns The underlying `better-sqlite3` Database handle.
   */
  open(): Database.Database {
    if (this.db) return this.db;
    const path = this.inMemory ? ':memory:' : resolveHome(this.dbPath);
    if (!this.inMemory) {
      const dir = dirname(path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    const db = new Database(path);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        id          TEXT PRIMARY KEY,
        type        TEXT NOT NULL,
        name        TEXT NOT NULL,
        aliases     TEXT NOT NULL,
        description TEXT,
        properties  TEXT NOT NULL,
        source      TEXT NOT NULL,
        confidence  REAL NOT NULL,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        embedding   BLOB
      );
      CREATE TABLE IF NOT EXISTS relationships (
        id          TEXT PRIMARY KEY,
        type        TEXT NOT NULL,
        source      TEXT NOT NULL,
        target      TEXT NOT NULL,
        properties  TEXT NOT NULL,
        confidence  REAL NOT NULL,
        evidence    TEXT NOT NULL,
        source_meta TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        FOREIGN KEY (source) REFERENCES entities(id) ON DELETE CASCADE,
        FOREIGN KEY (target) REFERENCES entities(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
      CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
      CREATE INDEX IF NOT EXISTS idx_rel_source ON relationships(source);
      CREATE INDEX IF NOT EXISTS idx_rel_target ON relationships(target);
      CREATE INDEX IF NOT EXISTS idx_rel_type ON relationships(type);
    `);
    this.db = db;
    return db;
  }

  /**
   * Close the underlying SQLite handle. Safe to call multiple times.
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /**
   * Run `fn` inside a SQLite transaction. If `fn` throws, the transaction
   * is rolled back and the error re-thrown. Nested calls reuse the
   * outermost transaction (better-sqlite3's `transaction()` is re-entrant).
   *
   * @example
   * ```ts
   * store.transaction(() => {
   *   store.addEntity(e1);
   *   store.addEntity(e2);
   *   store.addRelationship(r);
   * }); // all three writes commit atomically
   * ```
   */
  transaction<T>(fn: () => T): T {
    const db = this.open();
    const wrap = db.transaction(fn);
    return wrap();
  }

  /** Alias for {@link transaction} (matches the spec's naming). */
  withTransaction<T>(fn: () => T): T {
    return this.transaction(fn);
  }

  // ─── Entity CRUD ────────────────────────────────────────────────────────

  /**
   * Insert (or replace) an entity. Embeddings are stored as BLOBs.
   *
   * @returns The inserted entity (with embedding intact).
   */
  addEntity(e: Entity): Entity {
    const db = this.open();
    const aliasesJson = JSON.stringify(e.aliases);
    const propsJson = JSON.stringify(e.properties);
    const desc = e.description ?? null;
    const emb = e.embedding ? float32ToBuffer(e.embedding) : null;
    db.prepare(
      `INSERT OR REPLACE INTO entities
        (id, type, name, aliases, description, properties, source, confidence, created_at, updated_at, embedding)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      e.id,
      e.type,
      e.name,
      aliasesJson,
      desc,
      propsJson,
      e.source,
      e.confidence,
      e.createdAt,
      e.updatedAt,
      emb,
    );
    return e;
  }

  /**
   * Fetch an entity by id. Returns `undefined` if not found.
   */
  getEntity(id: string): Entity | undefined {
    const db = this.open();
    const row = db
      .prepare('SELECT * FROM entities WHERE id = ?')
      .get(id) as EntityRow | undefined;
    return row ? rowToEntity(row) : undefined;
  }

  /**
   * Fetch an entity by name (case-insensitive). Optionally filter by type.
   * Returns the first match or `undefined`.
   */
  getEntityByName(name: string, type?: EntityType): Entity | undefined {
    const db = this.open();
    const sql = type
      ? 'SELECT * FROM entities WHERE lower(name) = lower(?) AND type = ? LIMIT 1'
      : 'SELECT * FROM entities WHERE lower(name) = lower(?) LIMIT 1';
    const row = (type
      ? db.prepare(sql).get(name.toLowerCase(), type)
      : db.prepare(sql).get(name.toLowerCase())) as EntityRow | undefined;
    return row ? rowToEntity(row) : undefined;
  }

  /**
   * Find an entity whose name or any alias matches `name` (case-insensitive).
   * Used by the {@link GraphBuilder} for alias-based merging.
   */
  getEntityByAlias(name: string, type?: EntityType): Entity | undefined {
    const lower = name.toLowerCase();
    const candidates = this.listEntities({
      type,
      limit: 100000,
    });
    for (const e of candidates) {
      if (e.name.toLowerCase() === lower) return e;
      if (e.aliases.some((a) => a.toLowerCase() === lower)) return e;
    }
    return undefined;
  }

  /**
   * Patch an entity. Only the supplied fields are updated; `updatedAt` is
   * bumped to `Date.now()`.
   *
   * @returns The updated entity, or `undefined` if not found.
   */
  updateEntity(
    id: string,
    patch: Partial<Omit<Entity, 'id' | 'createdAt'>>,
  ): Entity | undefined {
    const existing = this.getEntity(id);
    if (!existing) return undefined;
    const updated: Entity = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: Date.now(),
    };
    this.addEntity(updated);
    return updated;
  }

  /**
   * Delete an entity by id. Cascades to all relationships that reference
   * it (per the foreign-key constraint).
   *
   * @returns `true` if an entity was deleted.
   */
  deleteEntity(id: string): boolean {
    const db = this.open();
    const info = db.prepare('DELETE FROM entities WHERE id = ?').run(id);
    return info.changes > 0;
  }

  /**
   * List entities matching the supplied filter. Results are ordered by
   * `createdAt DESC` (most recent first).
   */
  listEntities(filter: EntityFilter = {}): Entity[] {
    const db = this.open();
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.type) {
      where.push('type = ?');
      params.push(filter.type);
    }
    if (filter.source) {
      where.push('source = ?');
      params.push(filter.source);
    }
    if (filter.minConfidence !== undefined) {
      where.push('confidence >= ?');
      params.push(filter.minConfidence);
    }
    if (filter.maxConfidence !== undefined) {
      where.push('confidence <= ?');
      params.push(filter.maxConfidence);
    }
    if (filter.nameContains) {
      where.push('lower(name) LIKE ?');
      params.push(`%${filter.nameContains.toLowerCase()}%`);
    }
    let sql = 'SELECT * FROM entities';
    if (where.length > 0) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY created_at DESC';
    if (filter.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(filter.limit);
      if (filter.offset !== undefined) {
        sql += ' OFFSET ?';
        params.push(filter.offset);
      }
    }
    const rows = db.prepare(sql).all(...params) as EntityRow[];
    return rows.map(rowToEntity);
  }

  // ─── Relationship CRUD ──────────────────────────────────────────────────

  /**
   * Insert (or replace) a relationship.
   *
   * @returns The inserted relationship.
   */
  addRelationship(r: Relationship): Relationship {
    const db = this.open();
    const propsJson = JSON.stringify(r.properties);
    const evidenceJson = JSON.stringify(r.evidence);
    db.prepare(
      `INSERT OR REPLACE INTO relationships
        (id, type, source, target, properties, confidence, evidence, source_meta, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      r.id,
      r.type,
      r.source,
      r.target,
      propsJson,
      r.confidence,
      evidenceJson,
      r.source_meta,
      r.createdAt,
      r.updatedAt,
    );
    return r;
  }

  /**
   * Fetch a relationship by id. Returns `undefined` if not found.
   */
  getRelationship(id: string): Relationship | undefined {
    const db = this.open();
    const row = db
      .prepare('SELECT * FROM relationships WHERE id = ?')
      .get(id) as RelationshipRow | undefined;
    return row ? rowToRelationship(row) : undefined;
  }

  /**
   * Fetch relationships incident on `entityId`, filtered by direction + type.
   *
   * @param entityId - The entity id to query around.
   * @param opts - Direction (`in` / `out` / `both`) + optional type filter.
   */
  getRelationships(
    entityId: string,
    opts: GetRelationshipsOptions = {},
  ): Relationship[] {
    const db = this.open();
    const direction = opts.direction ?? 'both';
    const where: string[] = [];
    const params: unknown[] = [];
    if (direction === 'out') {
      where.push('source = ?');
      params.push(entityId);
    } else if (direction === 'in') {
      where.push('target = ?');
      params.push(entityId);
    } else {
      where.push('(source = ? OR target = ?)');
      params.push(entityId, entityId);
    }
    if (opts.type) {
      where.push('type = ?');
      params.push(opts.type);
    }
    let sql = 'SELECT * FROM relationships WHERE ' + where.join(' AND ');
    sql += ' ORDER BY created_at DESC';
    if (opts.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(opts.limit);
    }
    const rows = db.prepare(sql).all(...params) as RelationshipRow[];
    return rows.map(rowToRelationship);
  }

  /**
   * Delete a relationship by id.
   *
   * @returns `true` if a relationship was deleted.
   */
  deleteRelationship(id: string): boolean {
    const db = this.open();
    const info = db.prepare('DELETE FROM relationships WHERE id = ?').run(id);
    return info.changes > 0;
  }

  // ─── Graph traversal ────────────────────────────────────────────────────

  /**
   * Get all entities within `depth` hops of `entityId` (BFS).
   *
   * @returns Map of `entityId -> hopDistance` (the root is at distance 0).
   */
  getNeighbors(entityId: string, depth: number): Map<string, number> {
    const result = new Map<string, number>();
    result.set(entityId, 0);
    if (depth <= 0) return result;
    const visited = new Set<string>([entityId]);
    let frontier: string[] = [entityId];
    for (let d = 1; d <= depth; d++) {
      const next: string[] = [];
      for (const node of frontier) {
        const rels = this.getRelationships(node, { direction: 'both' });
        for (const r of rels) {
          const other = r.source === node ? r.target : r.source;
          if (!visited.has(other)) {
            visited.add(other);
            result.set(other, d);
            next.push(other);
          }
        }
      }
      if (next.length === 0) break;
      frontier = next;
    }
    return result;
  }

  /**
   * Build a {@link Subgraph} rooted at `rootId`, expanding out to `depth`
   * hops. Edges are included only when both endpoints are in the subgraph.
   */
  getSubgraph(rootId: string, depth: number): Subgraph {
    const neighborDistances = this.getNeighbors(rootId, depth);
    const entityIds = new Set(neighborDistances.keys());
    const nodes: GraphNode[] = [];
    for (const id of entityIds) {
      const entity = this.getEntity(id);
      if (!entity) continue;
      const degree = this.getRelationships(id, { direction: 'both' }).length;
      nodes.push({ entity, degree });
    }
    // Edges among the subgraph's nodes.
    const edges: GraphEdge[] = [];
    const seenRelIds = new Set<string>();
    for (const id of entityIds) {
      const rels = this.getRelationships(id, { direction: 'both' });
      for (const r of rels) {
        if (seenRelIds.has(r.id)) continue;
        if (!entityIds.has(r.source) || !entityIds.has(r.target)) continue;
        seenRelIds.add(r.id);
        const sourceEntity = this.getEntity(r.source);
        const targetEntity = this.getEntity(r.target);
        if (!sourceEntity || !targetEntity) continue;
        edges.push({ relationship: r, sourceEntity, targetEntity });
      }
    }
    return {
      nodes,
      edges,
      depth,
      rootEntityId: rootId,
    };
  }

  /**
   * Find the shortest path (in hops) between `fromId` and `toId` using BFS.
   *
   * @returns The list of entity ids along the path (inclusive of endpoints),
   *          or `undefined` if no path exists.
   */
  shortestPath(fromId: string, toId: string): string[] | undefined {
    if (fromId === toId) return [fromId];
    const queue: string[] = [fromId];
    const visited = new Set<string>([fromId]);
    const parent = new Map<string, string | null>([[fromId, null]]);
    while (queue.length > 0) {
      const curr = queue.shift()!;
      const rels = this.getRelationships(curr, { direction: 'both' });
      for (const r of rels) {
        const next = r.source === curr ? r.target : r.source;
        if (visited.has(next)) continue;
        visited.add(next);
        parent.set(next, curr);
        if (next === toId) {
          // Reconstruct path.
          const path: string[] = [next];
          let p: string | null = curr;
          while (p !== null) {
            path.unshift(p);
            p = parent.get(p) ?? null;
          }
          return path;
        }
        queue.push(next);
      }
    }
    return undefined;
  }

  /**
   * Find up to `opts.maxPaths` distinct paths between `fromId` and `toId`,
   * each of length at most `opts.maxDepth` hops. Uses iterative DFS with
   * cycle avoidance.
   */
  findPaths(fromId: string, toId: string, opts: FindPathsOptions = {}): string[][] {
    const maxPaths = opts.maxPaths ?? 5;
    const maxDepth = opts.maxDepth ?? 5;
    const results: string[][] = [];
    const path: string[] = [fromId];
    const visited = new Set<string>([fromId]);

    const dfs = (current: string, depth: number): void => {
      if (results.length >= maxPaths) return;
      if (current === toId && path.length > 1) {
        results.push([...path]);
        return;
      }
      if (depth >= maxDepth) return;
      const rels = this.getRelationships(current, { direction: 'both' });
      for (const r of rels) {
        const next = r.source === current ? r.target : r.source;
        if (visited.has(next)) continue;
        visited.add(next);
        path.push(next);
        dfs(next, depth + 1);
        path.pop();
        visited.delete(next);
        if (results.length >= maxPaths) return;
      }
    };

    if (fromId === toId) {
      return [[fromId]];
    }
    dfs(fromId, 0);
    return results;
  }

  // ─── Aggregations ───────────────────────────────────────────────────────

  /**
   * Count entities grouped by type.
   *
   * @returns Map of `EntityType -> count`.
   */
  countByType(): Record<EntityType, number> {
    const db = this.open();
    const rows = db
      .prepare('SELECT type, COUNT(*) as n FROM entities GROUP BY type')
      .all() as Array<{ type: string; n: number }>;
    const result = {} as Record<EntityType, number>;
    for (const r of rows) {
      result[r.type as EntityType] = r.n;
    }
    return result;
  }

  /**
   * Top-N entities by degree (number of incident relationships).
   *
   * @param n - Number of entities to return.
   */
  mostConnected(n: number): GraphNode[] {
    const db = this.open();
    // Compute degree via a UNION of source + target counts.
    const rows = db
      .prepare(
        `SELECT entity_id, SUM(cnt) AS degree FROM (
           SELECT source AS entity_id, COUNT(*) AS cnt FROM relationships GROUP BY source
           UNION ALL
           SELECT target AS entity_id, COUNT(*) AS cnt FROM relationships GROUP BY target
         ) GROUP BY entity_id
         ORDER BY degree DESC
         LIMIT ?`,
      )
      .all(n) as Array<{ entity_id: string; degree: number }>;
    const nodes: GraphNode[] = [];
    for (const row of rows) {
      const entity = this.getEntity(row.entity_id);
      if (entity) {
        nodes.push({ entity, degree: row.degree });
      }
    }
    return nodes;
  }

  /**
   * Cluster entities into connected components (undirected). Returns a list
   * of components, each a list of entity ids.
   */
  clusterByConnectedComponents(): string[][] {
    const db = this.open();
    const entityRows = db.prepare('SELECT id FROM entities').all() as Array<{
      id: string;
    }>;
    const allIds = new Set(entityRows.map((r) => r.id));
    const adj = new Map<string, Set<string>>();
    for (const id of allIds) adj.set(id, new Set());
    const relRows = db
      .prepare('SELECT source, target FROM relationships')
      .all() as Array<{ source: string; target: string }>;
    for (const r of relRows) {
      const s = adj.get(r.source);
      const t = adj.get(r.target);
      if (s) s.add(r.target);
      if (t) t.add(r.source);
    }
    const visited = new Set<string>();
    const components: string[][] = [];
    for (const id of allIds) {
      if (visited.has(id)) continue;
      const comp: string[] = [];
      const queue: string[] = [id];
      visited.add(id);
      while (queue.length > 0) {
        const curr = queue.shift()!;
        comp.push(curr);
        const neighbors = adj.get(curr);
        if (!neighbors) continue;
        for (const n of neighbors) {
          if (!visited.has(n)) {
            visited.add(n);
            queue.push(n);
          }
        }
      }
      components.push(comp);
    }
    return components;
  }

  /**
   * Total entity count.
   */
  countEntities(): number {
    const db = this.open();
    const row = db.prepare('SELECT COUNT(*) AS n FROM entities').get() as {
      n: number;
    };
    return row.n;
  }

  /**
   * Total relationship count.
   */
  countRelationships(): number {
    const db = this.open();
    const row = db
      .prepare('SELECT COUNT(*) AS n FROM relationships')
      .get() as { n: number };
    return row.n;
  }

  /**
   * Distribution of relationship types.
   */
  countRelationshipsByType(): Record<string, number> {
    const db = this.open();
    const rows = db
      .prepare('SELECT type, COUNT(*) AS n FROM relationships GROUP BY type')
      .all() as Array<{ type: string; n: number }>;
    const result: Record<string, number> = {};
    for (const r of rows) result[r.type] = r.n;
    return result;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Expand a leading `~` to the home directory. Mirrors `@sanix/config`'s
 * helper so we don't create a cross-package runtime dep.
 */
function resolveHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/** Convert a Float32Array to a Buffer for SQLite BLOB storage. */
function float32ToBuffer(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/** Convert a SQLite BLOB back to a Float32Array. */
function bufferToFloat32(buf: Buffer): Float32Array {
  // Copy into a new ArrayBuffer to avoid alignment issues with the
  // better-sqlite3 returned Buffer's underlying pool.
  const copy = new ArrayBuffer(buf.byteLength);
  new Uint8Array(copy).set(buf);
  return new Float32Array(copy);
}

/** Coerce a SQLite entity row into a full {@link Entity}. */
function rowToEntity(row: EntityRow): Entity {
  let aliases: string[] = [];
  try {
    aliases = JSON.parse(row.aliases) as string[];
  } catch {
    aliases = [];
  }
  let properties: Record<string, unknown> = {};
  try {
    properties = JSON.parse(row.properties) as Record<string, unknown>;
  } catch {
    properties = {};
  }
  const embedding = row.embedding ? bufferToFloat32(row.embedding) : undefined;
  return {
    id: row.id,
    type: row.type as EntityType,
    name: row.name,
    aliases,
    description: row.description ?? undefined,
    properties,
    source: row.source,
    confidence: row.confidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    embedding,
  };
}

/** Coerce a SQLite relationship row into a full {@link Relationship}. */
function rowToRelationship(row: RelationshipRow): Relationship {
  let evidence: string[] = [];
  try {
    evidence = JSON.parse(row.evidence) as string[];
  } catch {
    evidence = [];
  }
  let properties: Record<string, unknown> = {};
  try {
    properties = JSON.parse(row.properties) as Record<string, unknown>;
  } catch {
    properties = {};
  }
  return {
    id: row.id,
    type: row.type,
    source: row.source,
    target: row.target,
    properties,
    confidence: row.confidence,
    evidence,
    source_meta: row.source_meta,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Generate a new entity id (nanoid). Exported so callers don't have to
 * import nanoid directly when constructing entities for
 * {@link GraphStore.addEntity}.
 *
 * @example
 * ```ts
 * const e: Entity = {
 *   id: newEntityId(),
 *   type: 'concept', name: 'HNSW', aliases: ['HNSWIndex'],
 *   properties: {}, source: 'paper', confidence: 0.9,
 *   createdAt: Date.now(), updatedAt: Date.now(),
 * };
 * store.addEntity(e);
 * ```
 */
export function newEntityId(): string {
  return nanoid();
}

/**
 * Generate a new relationship id (nanoid).
 *
 * @example
 * ```ts
 * const r: Relationship = {
 *   id: newRelationshipId(),
 *   type: 'depends_on', source: a.id, target: b.id,
 *   properties: {}, confidence: 0.8, evidence: ['a depends on b'],
 *   source_meta: 'demo', createdAt: Date.now(), updatedAt: Date.now(),
 * };
 * store.addRelationship(r);
 * ```
 */
export function newRelationshipId(): string {
  return nanoid();
}
