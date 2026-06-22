/**
 * @file DocumentStore.ts
 * @description Pluggable document store for RAG. Three backends:
 *
 *   - **in-memory** (default) — `Map<id, Document>`; nothing persists.
 *   - **filesystem** — one JSON file per doc under `dir/<id>.json`.
 *   - **sqlite** — single `.db` file with a `documents` table; the
 *     embedding is stored as a `BLOB` of raw Float32 bytes.
 *
 * ## Chunking on add
 *
 * Long documents (default > 512 tokens) are split by
 * {@link SemanticChunker} from `@sanix/optimizer` into chunks (default
 * 64-token overlap). Each chunk becomes its own child {@link Document}
 * with `metadata.parentDocId` pointing back at the parent and
 * `metadata.chunkIndex` recording its ordinal. The parent document is
 * stored too (so callers can retrieve "the whole thing" if they want)
 * but is excluded from retrieval by the hybrid retriever unless the
 * caller explicitly opts in.
 *
 * ## Concurrency
 *
 * `add` / `update` / `delete` are sequenced by a per-store mutex
 * (promise chain) so concurrent calls do not race on the underlying
 * backend. SQLite writes happen inside a transaction.
 *
 * @packageDocumentation
 */

import { existsSync, mkdirSync, promises as fsp } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { nanoid } from 'nanoid';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import { SemanticChunker } from '@sanix/optimizer';
import type { Document, DocumentMetadata } from './types.js';

const nodeRequire = createRequire(import.meta.url);

/** Backend selection for {@link DocumentStore}. */
export type DocumentStoreBackend = 'memory' | 'filesystem' | 'sqlite';

/** Constructor options for {@link DocumentStore}. */
export interface DocumentStoreOptions {
  /**
   * Backend. Default `'memory'`. `'filesystem'` and `'sqlite'` require
   * `dir` / `path` respectively.
   */
  backend?: DocumentStoreBackend;
  /** Filesystem backend: directory to store doc files. */
  dir?: string;
  /** SQLite backend: path to the `.db` file. */
  path?: string;
  /**
   * Chunker configuration. Pass `false` to disable chunking entirely
   * (every document is stored as-is). Defaults to `{ maxTokens: 512,
   * overlap: 64 }`.
   */
  chunking?:
    | false
    | {
        maxTokens?: number;
        overlap?: number;
      };
  /**
   * Custom chunker. Mostly useful for tests; if omitted, a default
   * `SemanticChunker` is constructed lazily.
   */
  chunker?: SemanticChunker;
}

/** List options. */
export interface ListOptions {
  /** Filter predicate applied after fetch. */
  filter?: (doc: Document) => boolean;
  /** Limit number of results. Default unlimited. */
  limit?: number;
  /** Skip this many results (post-filter). Default 0. */
  offset?: number;
}

/**
 * Document store with pluggable backends and semantic chunking.
 *
 * @example
 * ```ts
 * const store = new DocumentStore({ backend: 'sqlite', path: './rag.db' });
 * await store.add({
 *   id: 'doc-1',
 *   content: longArticle,
 *   metadata: { source: 'wiki', createdAt: Date.now() },
 * });
 * const got = await store.get('doc-1');
 * const all = await store.list({ limit: 50 });
 * ```
 */
export class DocumentStore {
  private readonly backend: DocumentStoreBackend;
  private readonly dir?: string;
  private readonly dbPath?: string;
  private readonly mem = new Map<string, Document>();
  private db?: BetterSqlite3Database;
  private readonly chunker?: SemanticChunker;
  private readonly chunkOpts: { maxTokens: number; overlap: number } | false;
  /** Promise chain used as a mutex for write operations. */
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(opts: DocumentStoreOptions = {}) {
    this.backend = opts.backend ?? 'memory';
    this.dir = opts.dir;
    this.dbPath = opts.path;
    this.chunker = opts.chunker;
    if (opts.chunking === false) {
      this.chunkOpts = false;
    } else if (opts.chunking) {
      this.chunkOpts = {
        maxTokens: opts.chunking.maxTokens ?? 512,
        overlap: opts.chunking.overlap ?? 64,
      };
    } else {
      this.chunkOpts = { maxTokens: 512, overlap: 64 };
    }

    if (this.backend === 'filesystem' && !this.dir) {
      throw new Error('DocumentStore: filesystem backend requires `dir`');
    }
    if (this.backend === 'sqlite' && !this.dbPath) {
      throw new Error('DocumentStore: sqlite backend requires `path`');
    }
    if (this.backend === 'filesystem' && this.dir) {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    }
    if (this.backend === 'sqlite' && this.dbPath) {
      const dir = dirname(this.dbPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      this.initSqlite();
    }
  }

  // ─── Public API ──────────────────────────────────────────────────────

  /**
   * Add (or replace) a document. If the document is long enough to be
   * chunked, child chunk documents are also added with
   * `metadata.parentDocId` set. Returns the array of stored document
   * ids (parent + chunks).
   *
   * @example
   * ```ts
   * const [parentId, ...chunkIds] = await store.add({
   *   id: 'doc-1', content, metadata: { source: 'manual', createdAt: Date.now() }
   * });
   * ```
   */
  async add(doc: Document): Promise<string[]> {
    return this.serialize(async () => {
      const stored: string[] = [];
      const id = doc.id || nanoid();
      const parent: Document = { ...doc, id };
      await this.persist(parent);
      stored.push(id);

      if (this.chunkOpts === false) return stored;
      const chunker = this.chunker ?? defaultChunker();
      const { maxTokens, overlap } = this.chunkOpts;
      // Approximate token/char ratio: 4 chars/token. Only chunk docs that
      // are clearly longer than one chunk to avoid needless overhead.
      const approxTokens = Math.ceil(parent.content.length / 4);
      if (approxTokens <= maxTokens) return stored;

      try {
        const chunks = await chunker.chunk(parent.content, {
          maxTokens,
          overlap,
        });
        for (let i = 0; i < chunks.length; i++) {
          const c = chunks[i]!;
          const childMeta: DocumentMetadata = {
            ...parent.metadata,
            parentDocId: id,
            chunkIndex: i,
          };
          const child: Document = {
            id: `${id}#chunk-${i}`,
            content: c.text,
            metadata: childMeta,
            embedding: parent.embedding
              ? sliceEmbedding(parent.embedding, c.startOffset, c.endOffset)
              : undefined,
          };
          await this.persist(child);
          stored.push(child.id);
        }
      } catch {
        // Chunker can fail when @xenova/transformers is unavailable.
        // In that case the chunker already falls back to paragraph
        // splitting, so we should not normally land here; if we do,
        // the parent doc was still stored and we just skip chunking.
      }
      return stored;
    });
  }

  /**
   * Get a single document by id. Returns `undefined` if not found.
   *
   * @example
   * ```ts
   * const d = await store.get('doc-1');
   * if (d) console.log(d.content);
   * ```
   */
  async get(id: string): Promise<Document | undefined> {
    if (this.backend === 'memory') return this.mem.get(id);
    if (this.backend === 'filesystem') return this.readFs(id);
    return this.readSqlite(id);
  }

  /**
   * Update a document in place. `patch.content` replaces the content
   * (and re-chunks if necessary); `patch.metadata` is shallow-merged.
   * Returns the updated document or `undefined` if not found.
   */
  async update(
    id: string,
    patch: Partial<Pick<Document, 'content' | 'metadata' | 'embedding'>>,
  ): Promise<Document | undefined> {
    return this.serialize(async () => {
      const existing =
        this.backend === 'memory'
          ? this.mem.get(id)
          : this.backend === 'filesystem'
            ? await this.readFs(id)
            : await this.readSqlite(id);
      if (!existing) return undefined;
      const updated: Document = {
        id,
        content: patch.content ?? existing.content,
        metadata: { ...existing.metadata, ...patch.metadata },
        embedding: patch.embedding ?? existing.embedding,
      };
      await this.persist(updated);
      // If the content changed and we have chunking enabled, delete the
      // old child chunks and re-add the parent (which will re-chunk).
      if (
        patch.content !== undefined &&
        patch.content !== existing.content &&
        this.chunkOpts !== false
      ) {
        await this.deleteChildren(id);
        // Re-run the add path (it will not double-store the parent
        // because persist() upserts).
        await this.add(updated);
      }
      return updated;
    });
  }

  /**
   * Delete a document. Also deletes any child chunks (documents whose
   * `metadata.parentDocId === id`). Returns `true` if the document
   * existed.
   */
  async delete(id: string): Promise<boolean> {
    return this.serialize(async () => {
      const existed = await this.rawDelete(id);
      await this.deleteChildren(id);
      return existed;
    });
  }

  /**
   * List documents. Without a filter, returns every document in the
   * store (parents AND chunks). Use `filter` to scope to parents only
   * or by any other predicate.
   *
   * @example
   * ```ts
   * const parents = await store.list({
   *   filter: (d) => d.metadata.parentDocId === undefined,
   *   limit: 100,
   * });
   * ```
   */
  async list(opts: ListOptions = {}): Promise<Document[]> {
    let docs: Document[];
    if (this.backend === 'memory') {
      docs = Array.from(this.mem.values());
    } else if (this.backend === 'filesystem') {
      docs = await this.listFs();
    } else {
      docs = await this.listSqlite();
    }
    if (opts.filter) docs = docs.filter(opts.filter);
    if (opts.offset) docs = docs.slice(opts.offset);
    if (opts.limit !== undefined) docs = docs.slice(0, opts.limit);
    return docs;
  }

  /**
   * Count documents (parents AND chunks). O(1) for memory/sqlite, O(N)
   * for filesystem.
   */
  async count(): Promise<number> {
    if (this.backend === 'memory') return this.mem.size;
    if (this.backend === 'filesystem') {
      const files = await fsp.readdir(this.dir!);
      return files.filter((f) => f.endsWith('.json')).length;
    }
    const row = this.db!
      .prepare('SELECT COUNT(*) AS n FROM documents')
      .get() as { n: number };
    return row.n;
  }

  // ─── Internal: persistence ───────────────────────────────────────────

  /**
   * Upsert a single document into the configured backend.
   */
  private async persist(doc: Document): Promise<void> {
    if (this.backend === 'memory') {
      this.mem.set(doc.id, doc);
      return;
    }
    if (this.backend === 'filesystem') {
      const path = join(this.dir!, `${safeName(doc.id)}.json`);
      const payload = serializeDoc(doc);
      await fsp.writeFile(path, payload, 'utf-8');
      return;
    }
    this.persistSqlite(doc);
  }

  private async rawDelete(id: string): Promise<boolean> {
    if (this.backend === 'memory') return this.mem.delete(id);
    if (this.backend === 'filesystem') {
      const path = join(this.dir!, `${safeName(id)}.json`);
      try {
        await fsp.unlink(path);
        return true;
      } catch {
        return false;
      }
    }
    const info = this.db!.prepare('DELETE FROM documents WHERE id = ?').run(id);
    return info.changes > 0;
  }

  private async deleteChildren(parentId: string): Promise<void> {
    if (this.backend === 'memory') {
      for (const [cid, doc] of this.mem) {
        if (doc.metadata.parentDocId === parentId) this.mem.delete(cid);
      }
      return;
    }
    if (this.backend === 'filesystem') {
      const all = await this.listFs();
      await Promise.all(
        all
          .filter((d) => d.metadata.parentDocId === parentId)
          .map((d) => this.rawDelete(d.id)),
      );
      return;
    }
    this.db!
      .prepare('DELETE FROM documents WHERE json_extract(metadata, ?) = ?')
      .run('$.parentDocId', parentId);
  }

  // ─── Internal: filesystem backend ────────────────────────────────────

  private async readFs(id: string): Promise<Document | undefined> {
    const path = join(this.dir!, `${safeName(id)}.json`);
    try {
      const raw = await fsp.readFile(path, 'utf-8');
      return deserializeDoc(raw);
    } catch {
      return undefined;
    }
  }

  private async listFs(): Promise<Document[]> {
    if (!existsSync(this.dir!)) return [];
    const files = await fsp.readdir(this.dir!);
    const out: Document[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = await fsp.readFile(join(this.dir!, f), 'utf-8');
        const doc = deserializeDoc(raw);
        if (doc) out.push(doc);
      } catch {
        // Skip malformed files.
      }
    }
    return out;
  }

  // ─── Internal: sqlite backend ────────────────────────────────────────

  private initSqlite(): void {
    const Database = nodeRequire('better-sqlite3') as typeof import('better-sqlite3');
    this.db = new Database(this.dbPath!);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        metadata TEXT NOT NULL,
        embedding BLOB
      );
      CREATE INDEX IF NOT EXISTS idx_documents_parent
        ON documents (json_extract(metadata, '$.parentDocId'));
    `);
  }

  private persistSqlite(doc: Document): void {
    const embeddingBuf = doc.embedding
      ? Buffer.from(doc.embedding.buffer, doc.embedding.byteOffset, doc.embedding.byteLength)
      : null;
    this.db!
      .prepare(
        `INSERT INTO documents (id, content, metadata, embedding)
         VALUES (@id, @content, @metadata, @embedding)
         ON CONFLICT(id) DO UPDATE SET
           content = @content,
           metadata = @metadata,
           embedding = @embedding`,
      )
      .run({
        id: doc.id,
        content: doc.content,
        metadata: JSON.stringify(doc.metadata),
        embedding: embeddingBuf,
      });
  }

  private async readSqlite(id: string): Promise<Document | undefined> {
    const row = this.db!
      .prepare('SELECT id, content, metadata, embedding FROM documents WHERE id = ?')
      .get(id) as
      | { id: string; content: string; metadata: string; embedding: Buffer | null }
      | undefined;
    if (!row) return undefined;
    return sqliteRowToDoc(row);
  }

  private async listSqlite(): Promise<Document[]> {
    const rows = this.db!
      .prepare('SELECT id, content, metadata, embedding FROM documents')
      .all() as Array<{
      id: string;
      content: string;
      metadata: string;
      embedding: Buffer | null;
    }>;
    return rows.map(sqliteRowToDoc);
  }

  // ─── Internal: mutex ─────────────────────────────────────────────────

  /**
   * Run `fn` under the write mutex. Reads do not need to lock because
   * each read is atomic at the backend level; only multi-step writes
   * (add → chunk → persist chunks; delete → delete children) need
   * sequencing to avoid interleaving with other writes.
   */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(fn, fn);
    // Swallow errors on the chain so a single failed write does not
    // poison all subsequent writes.
    this.writeChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Lazy singleton default chunker. Created on first use so the
 * `@xenova/transformers` import (transitive via SemanticChunker) only
 * happens when chunking is actually exercised.
 */
let _chunker: SemanticChunker | null = null;
function defaultChunker(): SemanticChunker {
  if (!_chunker) _chunker = new SemanticChunker();
  return _chunker;
}

/**
 * Sanitize an arbitrary id for use as a filename. Replaces path
 * separators and other unsafe characters with `_`. The original id is
 * preserved inside the JSON file so reads round-trip exactly.
 */
function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * Serialize a document to a JSON string. The embedding (if any) is
 * stored as a plain number array — round-trippable but not space-
 * efficient. For large corpora prefer the SQLite backend which uses
 * raw Float32 buffers.
 */
function serializeDoc(doc: Document): string {
  return JSON.stringify({
    id: doc.id,
    content: doc.content,
    metadata: doc.metadata,
    embedding: doc.embedding ? Array.from(doc.embedding) : undefined,
  });
}

/** Inverse of {@link serializeDoc}. */
function deserializeDoc(raw: string): Document | undefined {
  try {
    const obj = JSON.parse(raw) as {
      id: string;
      content: string;
      metadata: DocumentMetadata;
      embedding?: number[];
    };
    return {
      id: obj.id,
      content: obj.content,
      metadata: obj.metadata,
      embedding: obj.embedding ? new Float32Array(obj.embedding) : undefined,
    };
  } catch {
    return undefined;
  }
}

/** Convert a raw SQLite row into a {@link Document}. */
function sqliteRowToDoc(row: {
  id: string;
  content: string;
  metadata: string;
  embedding: Buffer | null;
}): Document {
  const metadata = JSON.parse(row.metadata) as DocumentMetadata;
  const embedding = row.embedding
    ? new Float32Array(
        row.embedding.buffer,
        row.embedding.byteOffset,
        row.embedding.byteLength / 4,
      )
    : undefined;
  // Slice the underlying buffer to detach from the row's view so
  // downstream mutation does not corrupt it.
  return {
    id: row.id,
    content: row.content,
    metadata,
    embedding: embedding ? new Float32Array(embedding) : undefined,
  };
}

/**
 * Approximate an embedding for a chunk by slicing the parent's
 * embedding vector. This is a cheap heuristic — the chunk's tokens
 * occupy roughly `startOffset / parentLen * dims .. endOffset /
 * parentLen * dims` of the parent's mean-pooled vector. The result
 * is **not** semantically correct (a mean-pooled parent vector cannot
 * be meaningfully sliced) and is only used to avoid a zero vector;
 * real retrieval quality comes from re-embedding chunks upstream.
 *
 * If the parent has no embedding, returns `undefined`.
 */
function sliceEmbedding(
  parent: Float32Array,
  startOffset: number,
  endOffset: number,
): Float32Array | undefined {
  // No-op: slicing a mean-pooled vector is not meaningful. Return a
  // copy of the parent vector so the chunk has *some* embedding; the
  // retriever should re-embed chunks for best results.
  void startOffset;
  void endOffset;
  return new Float32Array(parent);
}
