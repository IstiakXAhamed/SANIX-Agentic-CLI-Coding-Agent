/**
 * @file memory/EpisodicMemory.ts
 * @description Tier-2 memory: past session summaries in SQLite
 * (`better-sqlite3`) with semantic recall via `@xenova/transformers`
 * embeddings (lazy-loaded through {@link EmbeddingProvider}).
 *
 * Schema (per spec §3):
 *   sessions(
 *     id TEXT PRIMARY KEY,
 *     goal TEXT NOT NULL,
 *     plan_json TEXT NOT NULL,
 *     started_at TEXT NOT NULL,
 *     ended_at TEXT,
 *     success INTEGER NOT NULL,        -- 0 or 1
 *     lessons_json TEXT NOT NULL,      -- JSON array of strings
 *     embedding_blob BLOB              -- 384 * Float32 = 1536 bytes
 *   )
 *
 * Recall is multi-criteria: semantic similarity (cosine on the embedding),
 * project scope, time range, and success/failure filter. Results are
 * blended by `0.6 * semantic + 0.3 * recency + 0.1 * importance` and
 * returned to the MemoryRouter.
 *
 * @packageDocumentation
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type {
  IMemoryTier,
  MemoryItem,
  RecallQuery,
  ScoredMemoryItem,
} from './types.js';
import {
  EmbeddingProvider,
  cosineSimilarity,
  EMBEDDING_DIM,
} from './EmbeddingProvider.js';

/**
 * A session record (logical shape, before SQLite serialization).
 */
export interface SessionRecord {
  /** Unique session id (nanoid). */
  id: string;
  /** The session's goal. */
  goal: string;
  /** The plan JSON (stringified `Plan`). */
  planJson: string;
  /** ISO timestamp the session started. */
  startedAt: string;
  /** ISO timestamp the session ended (null while in-progress). */
  endedAt: string | null;
  /** True if the session succeeded. */
  success: boolean;
  /** Lessons learned (JSON-stringified array of strings). */
  lessonsJson: string;
  /** Project identifier (for scoping). */
  project?: string;
  /** 384-dim embedding of the goal + plan summary. */
  embedding?: number[];
}

/**
 * Options for {@link EpisodicMemory.constructor}.
 */
export interface EpisodicMemoryOptions {
  /** SQLite path (may use `~`). Default: config.memory.sqlitePath. */
  dbPath?: string;
  /** Days before a session is prunable. Default: 90. */
  maxAgeDays?: number;
}

/** Row shape as read from SQLite (everything is TEXT/BLOB there). */
interface SessionRow {
  id: string;
  goal: string;
  plan_json: string;
  started_at: string;
  ended_at: string | null;
  success: number;
  lessons_json: string;
  embedding_blob: Buffer | null;
  project: string | null;
}

/**
 * Tier-2 episodic memory.
 *
 * @example
 * ```ts
 * const em = new EpisodicMemory({ dbPath: '~/.sanix/memory/episodic.db' });
 * await em.storeSession({
 *   id: nanoid(),
 *   goal: 'Refactor auth module',
 *   planJson: '{}',
 *   startedAt: new Date().toISOString(),
 *   endedAt: new Date().toISOString(),
 *   success: true,
 *   lessonsJson: '[]',
 *   project: 'sanix',
 * });
 * const hits = await em.recall({ query: 'auth', project: 'sanix', successOnly: true });
 * ```
 */
export class EpisodicMemory implements IMemoryTier {
  readonly tier = 'episodic' as const;

  private readonly dbPath: string;
  private readonly maxAgeDays: number;
  private db: Database.Database | null = null;
  private readonly embeddingProvider: EmbeddingProvider;

  constructor(opts: EpisodicMemoryOptions = {}) {
    this.dbPath = resolveHome(opts.dbPath ?? '~/.sanix/memory/episodic.db');
    this.maxAgeDays = opts.maxAgeDays ?? 90;
    this.embeddingProvider = EmbeddingProvider.getInstance();
  }

  /**
   * Open (or create) the SQLite database and ensure the schema exists. Idempotent.
   */
  private open(): Database.Database {
    if (this.db) return this.db;
    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const db = new Database(this.dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id            TEXT PRIMARY KEY,
        goal          TEXT NOT NULL,
        plan_json     TEXT NOT NULL,
        started_at    TEXT NOT NULL,
        ended_at      TEXT,
        success       INTEGER NOT NULL,
        lessons_json  TEXT NOT NULL,
        embedding_blob BLOB,
        project       TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
      CREATE INDEX IF NOT EXISTS idx_sessions_success ON sessions(success);
    `);
    this.db = db;
    return db;
  }

  /**
   * Persist a session record. The embedding is computed lazily from the
   * goal + plan summary; if the embedding provider is unavailable, the
   * record is stored without one (recall falls back to keyword match).
   */
  async storeSession(session: SessionRecord): Promise<void> {
    const db = this.open();
    let embedding = session.embedding;
    if (!embedding) {
      const text = `${session.goal} ${summarizePlan(session.planJson)}`;
      embedding = (await this.embeddingProvider.embed(text)) ?? undefined;
    }
    const blob = embedding ? float32ToBuffer(embedding) : null;
    db.prepare(
      `INSERT OR REPLACE INTO sessions
        (id, goal, plan_json, started_at, ended_at, success, lessons_json, embedding_blob, project)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      session.id,
      session.goal,
      session.planJson,
      session.startedAt,
      session.endedAt,
      session.success ? 1 : 0,
      session.lessonsJson,
      blob,
      session.project ?? null,
    );
  }

  /**
   * Store a session derived from a `MemoryItem` (used by the MemoryRouter).
   * The item must have `tier === 'episodic'` and session fields in metadata.
   * Satisfies the `IMemoryTier.store(item)` contract.
   */
  async store(item: MemoryItem): Promise<void> {
    if (item.tier !== 'episodic') return;
    const m = item.metadata;
    const session: SessionRecord = {
      id: item.metadata.sessionId ?? item.id,
      goal: item.content,
      planJson: (m.planJson as string) ?? '{}',
      startedAt: (m.startedAt as string) ?? item.createdAt,
      endedAt: (m.endedAt as string) ?? new Date().toISOString(),
      success: Boolean(m.success ?? false),
      lessonsJson: (m.lessonsJson as string) ?? '[]',
      project: m.project,
      embedding: item.embedding,
    };
    await this.storeSession(session);
  }

  /**
   * Recall sessions matching the query. Multi-criteria blend:
   *   score = 0.6 * semantic + 0.3 * recency + 0.1 * importance
   * Sessions without embeddings fall back to keyword match for the semantic
   * component (score 0.0 if no keyword overlap).
   */
  async recall(query: RecallQuery): Promise<ScoredMemoryItem[]> {
    const db = this.open();
    const limit = query.limit ?? 10;

    // Build SQL filter.
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.project) {
      where.push('project = ?');
      params.push(query.project);
    }
    if (query.since) {
      where.push('started_at >= ?');
      params.push(query.since);
    }
    if (query.until) {
      where.push('started_at <= ?');
      params.push(query.until);
    }
    if (query.successOnly) {
      where.push('success = 1');
    }
    if (query.failureOnly) {
      where.push('success = 0');
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const rows = db
      .prepare(`SELECT * FROM sessions ${whereSql} ORDER BY started_at DESC LIMIT ?`)
      .all(...params, limit * 5) as SessionRow[];

    if (rows.length === 0) return [];

    // Compute query embedding once (if available).
    let queryVec: number[] | null = null;
    if (query.queryEmbedding) {
      queryVec = query.queryEmbedding;
    } else {
      queryVec = await this.embeddingProvider.embed(query.query);
    }

    const now = Date.now();
    const scored: ScoredMemoryItem[] = [];
    for (const row of rows) {
      const session = rowToSession(row);
      let semantic = 0;
      let explanation = '';
      if (queryVec && session.embedding) {
        semantic = cosineSimilarity(queryVec, session.embedding);
        explanation = `cos=${semantic.toFixed(3)}`;
      } else {
        // Keyword fallback.
        const q = query.query.toLowerCase();
        const text = (session.goal + ' ' + session.lessonsJson).toLowerCase();
        const overlap = q.split(/\s+/).filter((t) => t.length > 0 && text.includes(t)).length;
        semantic = overlap > 0 ? 0.2 + 0.1 * overlap : 0;
        explanation = `kw=${semantic.toFixed(3)}`;
      }
      const ageDays = (now - new Date(session.startedAt).getTime()) / 86_400_000;
      const recency = Math.max(0, 1 - ageDays / this.maxAgeDays);
      const importance = session.success ? 0.8 : 0.4;
      const score = 0.6 * semantic + 0.3 * recency + 0.1 * importance;

      if (score < (query.minRelevance ?? 0)) continue;

      scored.push({
        item: sessionToMemoryItem(session),
        score,
        tier: 'episodic',
        explanation: `${explanation} rec=${recency.toFixed(2)} imp=${importance.toFixed(2)}`,
      });
    }

    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /**
   * Recall sessions by raw SQL filter (escape hatch for power users / TUI
   * commands). Returns SessionRecords directly (not MemoryItems).
   */
  recallRaw(opts: {
    project?: string;
    since?: string;
    until?: string;
    successOnly?: boolean;
    failureOnly?: boolean;
    limit?: number;
  } = {}): SessionRecord[] {
    const db = this.open();
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.project) {
      where.push('project = ?');
      params.push(opts.project);
    }
    if (opts.since) {
      where.push('started_at >= ?');
      params.push(opts.since);
    }
    if (opts.until) {
      where.push('started_at <= ?');
      params.push(opts.until);
    }
    if (opts.successOnly) where.push('success = 1');
    if (opts.failureOnly) where.push('success = 0');
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const rows = db
      .prepare(`SELECT * FROM sessions ${whereSql} ORDER BY started_at DESC LIMIT ?`)
      .all(...params, opts.limit ?? 100) as SessionRow[];
    return rows.map(rowToSession);
  }

  /**
   * Prune sessions older than `olderThanDays`. Returns the count removed.
   *
   * @example
   * ```ts
   * const removed = await em.prune(90);
   * console.log(`Pruned ${removed} stale sessions.`);
   * ```
   */
  async prune(olderThanDays: number): Promise<number> {
    const db = this.open();
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
    const info = db.prepare('DELETE FROM sessions WHERE started_at < ?').run(cutoff);
    return info.changes;
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
}

// ─── Internal helpers ───────────────────────────────────────────────────────

/**
 * Expand a leading `~` to the home directory (mirrors `@sanix/config`'s
 * helper so we don't create a cross-package dep here).
 */
function resolveHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/** Convert a Float32Array-friendly number[] to a Buffer for SQLite BLOB. */
function float32ToBuffer(vec: number[]): Buffer {
  const arr = new Float32Array(vec);
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

/** Convert a SQLite BLOB back to a number[] (Float32). */
function bufferToFloat32(buf: Buffer): number[] {
  const arr = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  return Array.from(arr);
}

/** Coerce a SQLite row into a SessionRecord. */
function rowToSession(row: SessionRow): SessionRecord {
  const embedding = row.embedding_blob
    ? bufferToFloat32(row.embedding_blob)
    : undefined;
  // Validate embedding dimensionality; bad rows get undefined.
  if (embedding && embedding.length !== EMBEDDING_DIM) {
    return {
      id: row.id,
      goal: row.goal,
      planJson: row.plan_json,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      success: row.success === 1,
      lessonsJson: row.lessons_json,
      project: row.project ?? undefined,
    };
  }
  return {
    id: row.id,
    goal: row.goal,
    planJson: row.plan_json,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    success: row.success === 1,
    lessonsJson: row.lessons_json,
    project: row.project ?? undefined,
    embedding,
  };
}

/** Convert a SessionRecord into a MemoryItem for the router. */
function sessionToMemoryItem(session: SessionRecord): MemoryItem {
  return {
    id: session.id,
    tier: 'episodic',
    type: 'session_summary',
    content: session.goal,
    metadata: {
      sessionId: session.id,
      project: session.project,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      success: session.success,
      lessonsJson: session.lessonsJson,
    },
    createdAt: session.startedAt,
    importance: session.success ? 0.8 : 0.4,
    embedding: session.embedding,
  };
}

/** Best-effort plan summary for embedding (extracts goal + task titles). */
function summarizePlan(planJson: string): string {
  try {
    const plan = JSON.parse(planJson) as {
      understanding?: string;
      tasks?: Array<{ title?: string }>;
    };
    const understanding = plan.understanding ?? '';
    const titles = (plan.tasks ?? []).map((t) => t.title ?? '').join(' ');
    return `${understanding} ${titles}`.trim();
  } catch {
    return '';
  }
}
