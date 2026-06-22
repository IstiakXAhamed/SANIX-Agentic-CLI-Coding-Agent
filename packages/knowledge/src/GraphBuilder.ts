/**
 * @file GraphBuilder.ts
 * @description Wires the {@link EntityExtractor} to the {@link GraphStore}.
 * Takes raw text/documents, extracts entities + relationships, resolves
 * aliases against existing entities (merging instead of duplicating), and
 * optionally embeds entity descriptions for semantic search.
 *
 * ## Alias resolution
 *
 * When an extracted entity's name (case-insensitive) matches an existing
 * entity's name or alias, the new entity is **merged** into the existing
 * one: aliases from the new entity are appended, properties are shallow-
 * merged (new wins), confidence is max'd, description is replaced if empty
 * on the existing side, and source is appended to a `sources` array in
 * properties.
 *
 * ## Transactions
 *
 * Multi-entity ingests are wrapped in a single SQLite transaction so the
 * graph is never left in a half-written state if extraction partially
 * fails.
 *
 * @packageDocumentation
 */

import { readFile } from 'node:fs/promises';
import { readdir, stat } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import { nanoid } from 'nanoid';
import type { GraphStore } from './GraphStore.js';
import { newEntityId, newRelationshipId } from './GraphStore.js';
import type { EntityExtractor } from './EntityExtractor.js';
import type {
  Entity,
  ExtractedEntity,
  ExtractedRelationship,
  IngestResult,
} from './types.js';

// ─── Constructor options ───────────────────────────────────────────────────

/**
 * Embedding provider interface used by {@link GraphBuilder}. Mirrors
 * `@sanix/core`'s `EmbeddingProvider` shape (returns `Float32Array | null`)
 * so callers can pass the singleton directly.
 */
export interface EmbeddingProviderLike {
  /** Embed a single text; return null on failure. */
  embed(text: string): Promise<Float32Array | null>;
}

/**
 * Options for {@link GraphBuilder.constructor}.
 */
export interface GraphBuilderOptions {
  /**
   * Optional embedding provider. When supplied, entity descriptions are
   * embedded on ingest and stored alongside the entity for semantic search.
   */
  embeddingProvider?: EmbeddingProviderLike;
  /**
   * When true, merge extracted entities into existing ones whose alias
   * matches (case-insensitive). Default: true.
   */
  mergeOnAlias?: boolean;
}

// ─── Ingest options ────────────────────────────────────────────────────────

/**
 * Options for {@link GraphBuilder.ingest}.
 */
export interface IngestOptions {
  /** Provenance string attached to ingested entities. */
  source?: string;
  /** Base confidence (0..1) for extracted entities. Default: 0.7. */
  confidence?: number;
}

/**
 * Options for {@link GraphBuilder.ingestDirectory}.
 */
export interface IngestDirectoryOptions extends IngestOptions {
  /**
   * Glob filter for file extensions, e.g. `'.md'` or `'.txt'`. When
   * omitted, all files are read. (Note: this is a simple extension match,
   * not a full glob implementation.)
   */
  glob?: string;
  /** Skip files larger than this many bytes. Default: 1 MiB. */
  maxFileBytes?: number;
}

// ─── GraphBuilder ─────────────────────────────────────────────────────────

/**
 * Wires the entity extractor to the graph store. Handles alias resolution,
 * embedding, and file/directory batch ingest.
 *
 * @example
 * ```ts
 * const store = new GraphStore({ inMemory: true });
 * const extractor = new EntityExtractor({ provider });
 * const builder = new GraphBuilder(store, extractor, { embeddingProvider });
 * const result = await builder.ingest('Alice works at Acme.', {
 *   source: 'demo.txt',
 * });
 * console.log(result.entitiesAdded, result.relationshipsAdded);
 * ```
 */
export class GraphBuilder {
  private readonly store: GraphStore;
  private readonly extractor: EntityExtractor;
  private readonly embeddingProvider?: EmbeddingProviderLike;
  private readonly mergeOnAlias: boolean;

  /**
   * @param store - The graph store to write into.
   * @param extractor - The entity extractor to read from.
   * @param opts - Optional behavior flags. See {@link GraphBuilderOptions}.
   */
  constructor(
    store: GraphStore,
    extractor: EntityExtractor,
    opts: GraphBuilderOptions = {},
  ) {
    this.store = store;
    this.extractor = extractor;
    this.embeddingProvider = opts.embeddingProvider;
    this.mergeOnAlias = opts.mergeOnAlias ?? true;
  }

  /**
   * Ingest `text`: extract entities + relationships, resolve aliases, and
   * write to the store (transactionally). Optionally embed entity
   * descriptions for semantic search.
   *
   * @returns Counts of entities/relationships added + merged, and duration.
   */
  async ingest(
    text: string,
    opts: IngestOptions = {},
  ): Promise<IngestResult> {
    const start = Date.now();
    const source = opts.source ?? 'unknown';
    const confidence = opts.confidence ?? 0.7;

    const extraction = await this.extractor.extract(text, {
      source,
      confidence,
    });

    let entitiesAdded = 0;
    let relationshipsAdded = 0;
    let entitiesMerged = 0;

    // Resolve extracted entities to existing-or-new entities, return a
    // name -> Entity map for relationship endpoint resolution.
    const nameToEntity = new Map<string, Entity>();
    // Track all newly created entities in this ingest for embedding.
    const toEmbed: Entity[] = [];

    this.store.transaction(() => {
      for (const extracted of extraction.entities) {
        const resolved = this.resolveEntity(extracted, source, confidence);
        if (resolved.merged) {
          entitiesMerged++;
          // Even merged entities may need an embedding refresh.
          if (this.embeddingProvider && resolved.entity.description) {
            toEmbed.push(resolved.entity);
          }
        } else {
          entitiesAdded++;
          if (this.embeddingProvider && resolved.entity.description) {
            toEmbed.push(resolved.entity);
          }
        }
        // Index by canonical name (lower) + aliases.
        nameToEntity.set(
          resolved.entity.name.toLowerCase(),
          resolved.entity,
        );
        for (const a of resolved.entity.aliases) {
          nameToEntity.set(a.toLowerCase(), resolved.entity);
        }
      }

      // Resolve + add relationships.
      for (const r of extraction.relationships) {
        const added = this.resolveRelationship(
          r,
          nameToEntity,
          source,
          confidence,
        );
        if (added) relationshipsAdded++;
      }
    });

    // Embed outside the transaction to avoid holding the DB lock during
    // network/model calls.
    if (this.embeddingProvider && toEmbed.length > 0) {
      await this.embedEntities(toEmbed);
    }

    return {
      entitiesAdded,
      relationshipsAdded,
      entitiesMerged,
      durationMs: Date.now() - start,
    };
  }

  /**
   * Read the file at `path` and ingest its contents. The file's basename
   * is used as the default `source`.
   */
  async ingestFile(path: string, opts: IngestOptions = {}): Promise<IngestResult> {
    const content = await readFile(path, 'utf-8');
    const source = opts.source ?? basename(path);
    return this.ingest(content, { ...opts, source });
  }

  /**
   * Recursively walk `dirPath` and ingest every matching file.
   *
   * @returns Aggregate {@link IngestResult} summing all per-file ingests.
   */
  async ingestDirectory(
    dirPath: string,
    opts: IngestDirectoryOptions = {},
  ): Promise<IngestResult> {
    const start = Date.now();
    const glob = opts.glob;
    const maxFileBytes = opts.maxFileBytes ?? 1024 * 1024;
    const files = await walkDir(dirPath, glob, maxFileBytes);
    let entitiesAdded = 0;
    let relationshipsAdded = 0;
    let entitiesMerged = 0;
    for (const f of files) {
      const r = await this.ingestFile(f, opts);
      entitiesAdded += r.entitiesAdded;
      relationshipsAdded += r.relationshipsAdded;
      entitiesMerged += r.entitiesMerged;
    }
    return {
      entitiesAdded,
      relationshipsAdded,
      entitiesMerged,
      durationMs: Date.now() - start,
    };
  }

  /**
   * Merge `sourceId` into `targetId`: target absorbs source's aliases,
   * properties (shallow merge, source wins), evidence, and all
   * relationships are re-pointed to target. Then source is deleted.
   *
   * @example
   * ```ts
   * await builder.mergeEntities('ent-alice', 'ent-alice-smith');
   * ```
   */
  async mergeEntities(targetId: string, sourceId: string): Promise<void> {
    if (targetId === sourceId) return;
    const target = this.store.getEntity(targetId);
    const source = this.store.getEntity(sourceId);
    if (!target || !source) return;

    this.store.transaction(() => {
      // 1. Re-point all relationships referencing source → target.
      const sourceRels = this.store.getRelationships(sourceId, {
        direction: 'both',
      });
      for (const r of sourceRels) {
        if (r.source === sourceId && r.target === targetId) {
          // Self-loop after merge — drop.
          this.store.deleteRelationship(r.id);
          continue;
        }
        if (r.target === sourceId && r.source === targetId) {
          this.store.deleteRelationship(r.id);
          continue;
        }
        const newSource = r.source === sourceId ? targetId : r.source;
        const newTarget = r.target === sourceId ? targetId : r.target;
        this.store.addRelationship({
          ...r,
          source: newSource,
          target: newTarget,
          updatedAt: Date.now(),
        });
      }
      // 2. Merge aliases + properties + description.
      const mergedAliases = Array.from(
        new Set([
          ...target.aliases,
          source.name,
          ...source.aliases.filter((a) => a !== target.name),
        ]),
      );
      const mergedProperties: Record<string, unknown> = {
        ...target.properties,
        ...source.properties,
        sources: Array.from(
          new Set([
            ...asStringArray(target.properties['sources']),
            ...asStringArray(source.properties['sources']),
            target.source,
            source.source,
          ]),
        ),
      };
      const mergedDescription =
        target.description ?? source.description ?? undefined;
      const mergedConfidence = Math.max(target.confidence, source.confidence);
      this.store.addEntity({
        ...target,
        aliases: mergedAliases,
        properties: mergedProperties,
        description: mergedDescription,
        confidence: mergedConfidence,
        updatedAt: Date.now(),
      });
      // 3. Delete source.
      this.store.deleteEntity(sourceId);
    });
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  /**
   * Resolve an extracted entity against existing entities. If the name or
   * any alias matches an existing entity (case-insensitive), merge into
   * it; otherwise create a new entity.
   *
   * @returns The resolved entity + a `merged` flag.
   */
  private resolveEntity(
    extracted: ExtractedEntity,
    source: string,
    confidence: number,
  ): { entity: Entity; merged: boolean } {
    const existing = this.mergeOnAlias
      ? this.store.getEntityByAlias(extracted.name, extracted.type) ??
        this.store.getEntityByAlias(extracted.name)
      : undefined;
    if (existing) {
      const merged = this.mergeIntoExisting(existing, extracted, source);
      this.store.addEntity(merged);
      return { entity: merged, merged: true };
    }
    // Create new entity.
    const entity: Entity = {
      id: newEntityId(),
      type: extracted.type,
      name: extracted.name,
      aliases: extracted.aliases ?? [],
      description: extracted.description,
      properties: {
        ...extracted.properties,
        sources: [source],
      },
      source,
      confidence: confidenceFromProps(extracted.properties, confidence),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.store.addEntity(entity);
    return { entity, merged: false };
  }

  /**
   * Merge an extracted entity into an existing entity. Returns the updated
   * entity (caller is responsible for persisting).
   */
  private mergeIntoExisting(
    existing: Entity,
    extracted: ExtractedEntity,
    source: string,
  ): Entity {
    const mergedAliases = Array.from(
      new Set([
        ...existing.aliases,
        ...((extracted.aliases ?? []).filter(
          (a) => a.toLowerCase() !== existing.name.toLowerCase(),
        )),
      ]),
    );
    const mergedProperties: Record<string, unknown> = {
      ...existing.properties,
      ...extracted.properties,
      sources: Array.from(
        new Set([
          ...asStringArray(existing.properties['sources']),
          source,
          existing.source,
        ]),
      ),
    };
    const mergedDescription =
      existing.description ?? extracted.description ?? undefined;
    const mergedConfidence = Math.max(
      existing.confidence,
      confidenceFromProps(extracted.properties, existing.confidence),
    );
    return {
      ...existing,
      aliases: mergedAliases,
      properties: mergedProperties,
      description: mergedDescription,
      confidence: mergedConfidence,
      updatedAt: Date.now(),
    };
  }

  /**
   * Resolve a relationship's source/target names against the
   * `nameToEntity` map, then add it to the store. Returns true if added.
   */
  private resolveRelationship(
    r: ExtractedRelationship,
    nameToEntity: Map<string, Entity>,
    source: string,
    confidence: number,
  ): boolean {
    const src = nameToEntity.get(r.source.toLowerCase());
    const tgt = nameToEntity.get(r.target.toLowerCase());
    if (!src || !tgt) return false;
    if (src.id === tgt.id) return false; // skip self-loops
    // De-dupe: skip if an identical (source, target, type) relationship
    // already exists.
    const existing = this.store
      .getRelationships(src.id, { direction: 'out', type: r.type })
      .some((x) => x.target === tgt.id);
    if (existing) return false;
    this.store.addRelationship({
      id: newRelationshipId(),
      type: r.type,
      source: src.id,
      target: tgt.id,
      properties: r.properties ?? {},
      confidence,
      evidence: r.evidence ?? [],
      source_meta: source,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return true;
  }

  /**
   * Embed the descriptions of `entities` (in parallel batches of 8) and
   * persist the embeddings back to the store.
   */
  private async embedEntities(entities: Entity[]): Promise<void> {
    if (!this.embeddingProvider) return;
    const batchSize = 8;
    for (let i = 0; i < entities.length; i += batchSize) {
      const batch = entities.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map(async (e) => {
          const text =
            e.description ?? `${e.name} (${e.type})`;
          const emb = await this.embeddingProvider!.embed(text);
          return [e.id, emb] as const;
        }),
      );
      for (const [id, emb] of results) {
        if (emb) {
          const e = this.store.getEntity(id);
          if (e) {
            this.store.addEntity({ ...e, embedding: emb });
          }
        }
      }
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Recursively walk `dir`, returning the list of files matching `glob`
 * (extension filter) and under `maxBytes`. Returns absolute paths.
 */
async function walkDir(
  dir: string,
  glob: string | undefined,
  maxBytes: number,
): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [dir];
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

/**
 * Coerce an unknown property value into a string array (for the `sources`
 * list). Non-array values are dropped.
 */
function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.filter((x): x is string => typeof x === 'string');
  }
  return [];
}

/**
 * Pull a `_confidence` value from extracted-entity properties (set by the
 * extractor), falling back to the supplied default.
 */
function confidenceFromProps(
  props: Record<string, unknown> | undefined,
  fallback: number,
): number {
  const c = props?.['_confidence'];
  if (typeof c === 'number' && c >= 0 && c <= 1) return c;
  return fallback;
}
