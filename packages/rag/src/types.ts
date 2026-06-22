/**
 * @file types.ts
 * @description Core shared types for `@sanix/rag`. Defines the `Document`
 * shape used everywhere (document store, retrievers, reranker, pipeline)
 * plus a few small interfaces that surface across module boundaries.
 *
 * @packageDocumentation
 */

/**
 * Metadata attached to a {@link Document}. Carries provenance (source,
 * title, url, language, tags) plus arbitrary extension fields.
 */
export interface DocumentMetadata {
  /** Where the document came from (file path, URL, "manual", etc.). */
  source: string;
  /** Optional human-readable title. Boosted × 3 in keyword search. */
  title?: string;
  /** Optional canonical URL. */
  url?: string;
  /** Optional ISO 639-1 language code (e.g. 'en', 'fr'). */
  language?: string;
  /** Optional tags. Boosted × 2 in keyword search. */
  tags?: string[];
  /** Epoch-ms when the document was created. */
  createdAt: number;
  /**
   * Set on chunk documents to point back at the parent {@link Document.id}.
   * Parent documents (those inserted directly via `DocumentStore.add`)
   * leave this undefined.
   */
  parentDocId?: string;
  /** Chunk ordinal within the parent document (0-based). */
  chunkIndex?: number;
  /** Arbitrary extension fields. */
  [key: string]: unknown;
}

/**
 * The canonical RAG document shape.
 *
 * A document is the unit of retrieval. Long source documents are split
 * by the `SemanticChunker` into multiple chunk documents (each with
 * `metadata.parentDocId` set); short documents may pass through
 * unchanged.
 */
export interface Document {
  /** Unique id (typically a nanoid). */
  id: string;
  /** The document's text content. */
  content: string;
  /** Provenance + extension metadata. */
  metadata: DocumentMetadata;
  /**
   * Optional precomputed embedding vector. Present when the document
   * has been embedded by an upstream component (the document store
   * does not embed by itself — embedding is the retriever's job so
   * it can pick its own model).
   */
  embedding?: Float32Array;
}

/**
 * A document scored by a retriever. Carries the final score plus the
 * per-method component scores so callers can introspect why a doc
 * ranked where it did.
 */
export interface ScoredDoc {
  /** The retrieved document. */
  doc: Document;
  /** Final fused score (already weighted). Higher = more relevant. */
  score: number;
  /**
   * Which retrieval method produced this result. For a hybrid
   * retriever, `'hybrid'` indicates the result was fused from
   * multiple arms; the per-arm scores are in `components`. After a
   * reranker runs, the method is updated to the reranker's strategy
   * (`'cross_encoder'`, `'llm'`, `'mono_t5'`, or `'none'`).
   */
  method:
    | 'vector'
    | 'bm25'
    | 'keyword'
    | 'hybrid'
    | 'cross_encoder'
    | 'llm'
    | 'mono_t5'
    | 'none';
  /** Per-arm raw (pre-fusion) scores. Missing arms = not consulted. */
  components: {
    vector?: number;
    bm25?: number;
    keyword?: number;
  };
}

/**
 * A filter predicate applied to candidate documents during retrieval.
 * Returning `true` keeps the document; `false` drops it. Used to scope
 * retrieval by source, tag, language, etc.
 *
 * @example
 * ```ts
 * const onlyDocs = (d: Document) => d.metadata.source.endsWith('.md');
 * retriever.retrieve('auth', { k: 10, filter: onlyDocs });
 * ```
 */
export type DocumentFilter = (doc: Document) => boolean;
