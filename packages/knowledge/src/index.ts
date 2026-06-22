/**
 * @file index.ts
 * @description Public entry point for `@sanix/knowledge`. Re-exports the
 * full surface of the SANIX knowledge graph package:
 *
 *   - **types**           — Entity, Relationship, Subgraph, GraphQueryResult,
 *     GraphNode, GraphEdge, EntityType, ExtractionResult, SearchResult,
 *     IngestResult, QueryResult, GraphStats, …
 *   - **GraphStore**      — SQLite-backed graph storage (entity + relationship
 *     CRUD, subgraph/shortest-path/find-paths traversal, aggregations).
 *   - **EntityExtractor** — LLM / regex / hybrid entity extraction with
 *     Zod-validated structured output + LRU cache.
 *   - **GraphBuilder**    — Wires extractor + store; handles alias resolution,
 *     embedding, file/directory batch ingest, entity merging.
 *   - **GraphQueryDSL**   — Simplified Cypher-like query language: tokenizer,
 *     parser, executor. Supports MATCH, WHERE, RETURN, ORDER BY, LIMIT,
 *     and variable-length paths (`*1..3`).
 *   - **GraphVisualizer** — DOT, Mermaid, ASCII, and D3 JSON output.
 *   - **KnowledgeIndex**  — Hybrid keyword (FTS5) + semantic (HNSW) + graph
 *     traversal search.
 *   - **KnowledgeManager** — Top-level facade extending EventEmitter3.
 *     Combines all of the above with ingest / query / executeDSL /
 *     visualize / stats methods + lifecycle events.
 *
 * Importing paths:
 *   import { KnowledgeManager, GraphStore } from '@sanix/knowledge';
 *   import { GraphQueryDSL, DSLParseError } from '@sanix/knowledge';
 *   import { ENTITY_COLORS } from '@sanix/knowledge';
 *
 * @packageDocumentation
 */

// ── Types ────────────────────────────────────────────────────────────────
export type {
  EntityType,
  Entity,
  Relationship,
  GraphNode,
  GraphEdge,
  Subgraph,
  GraphQueryResult,
  ExtractedEntity,
  ExtractedRelationship,
  ExtractionResult,
  ScoredEntity,
  SearchResult,
  IngestResult,
  QueryResult,
  GraphStats,
} from './types.js';

// ── GraphStore ───────────────────────────────────────────────────────────
export {
  GraphStore,
  newEntityId,
  newRelationshipId,
  type GraphStoreOptions,
  type EntityFilter,
  type GetRelationshipsOptions,
  type FindPathsOptions,
} from './GraphStore.js';

// ── EntityExtractor ──────────────────────────────────────────────────────
export {
  EntityExtractor,
  type EntityExtractorOptions,
} from './EntityExtractor.js';

// ── GraphBuilder ─────────────────────────────────────────────────────────
export {
  GraphBuilder,
  type GraphBuilderOptions,
  type EmbeddingProviderLike as GraphBuilderEmbeddingProviderLike,
  type IngestOptions,
  type IngestDirectoryOptions,
} from './GraphBuilder.js';

// ── GraphQueryDSL ────────────────────────────────────────────────────────
export {
  GraphQueryDSL,
  DSLParseError,
  type NodePattern,
  type EdgePattern,
  type PatternElement,
  type Comparison,
  type Condition,
  type Literal,
  type ReturnItem,
  type OrderItem,
  type ParsedQuery,
} from './GraphQueryDSL.js';

// ── GraphVisualizer ──────────────────────────────────────────────────────
export {
  GraphVisualizer,
  ENTITY_COLORS,
  ENTITY_SHAPES,
  colorForType,
  shapeForType,
  edgeToRelationship,
  nodeToEntity,
} from './GraphVisualizer.js';

// ── KnowledgeIndex ───────────────────────────────────────────────────────
export {
  KnowledgeIndex,
  type KnowledgeIndexOptions,
  type EmbeddingProviderLike as KnowledgeIndexEmbeddingProviderLike,
  type SearchOptions,
} from './KnowledgeIndex.js';

// ── KnowledgeManager ─────────────────────────────────────────────────────
export {
  KnowledgeManager,
  type KnowledgeManagerOptions,
  type EmbeddingProviderLike as KnowledgeManagerEmbeddingProviderLike,
  type KnowledgeManagerEvents,
} from './KnowledgeManager.js';
