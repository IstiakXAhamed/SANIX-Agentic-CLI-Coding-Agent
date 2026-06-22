/**
 * @file types.ts
 * @description Core type definitions for `@sanix/knowledge`. Defines the
 * entity/relationship graph model, subgraph + query result envelopes, and
 * the various option bags consumed by the GraphStore, EntityExtractor,
 * GraphBuilder, KnowledgeIndex, and KnowledgeManager.
 *
 * The model is intentionally simple: a knowledge graph is a set of
 * {@link Entity} nodes connected by typed, directed {@link Relationship}
 * edges. Entities carry an optional embedding (for semantic search);
 * relationships carry an evidence trail (text snippets that support them).
 *
 * @packageDocumentation
 */

// ─── Entity model ─────────────────────────────────────────────────────────

/**
 * Every entity in the knowledge graph has one of these types. The `custom`
 * bucket is a catch-all for types the extractor invents on the fly (e.g.
 * a domain-specific entity like 'gene' or 'circuit').
 */
export type EntityType =
  | 'person'
  | 'organization'
  | 'concept'
  | 'event'
  | 'location'
  | 'document'
  | 'code'
  | 'tool'
  | 'project'
  | 'technology'
  | 'custom';

/**
 * A node in the knowledge graph. Entities are the "nouns" — people,
 * organizations, concepts, code symbols, documents, etc.
 *
 * Entities are uniquely identified by `id` (a nanoid). Name collisions are
 * resolved at insertion time via alias matching (see {@link GraphBuilder});
 * i.e. two entities with the same name and type are merged rather than
 * duplicated.
 */
export interface Entity {
  /** Unique id (nanoid). */
  id: string;
  /** Entity type (drives visualization color + DSL filtering). */
  type: EntityType;
  /** Canonical display name. */
  name: string;
  /** Alternate names / abbreviations (case-insensitive match on ingest). */
  aliases: string[];
  /** Optional human-readable description (used for embedding + display). */
  description?: string;
  /** Arbitrary typed metadata (Zod-validated at extraction time). */
  properties: Record<string, unknown>;
  /** Where this entity was learned from (file path, URL, conversation id, …). */
  source: string;
  /** Extraction confidence in `[0, 1]`. */
  confidence: number;
  /** Creation time (epoch ms). */
  createdAt: number;
  /** Last-update time (epoch ms). */
  updatedAt: number;
  /** Optional semantic embedding (Float32Array; stored as BLOB in SQLite). */
  embedding?: Float32Array;
}

// ─── Relationship model ───────────────────────────────────────────────────

/**
 * A directed edge in the knowledge graph: `source -> target` of type `type`.
 *
 * Common types: `works_at`, `created`, `depends_on`, `located_in`,
 * `part_of`, `related_to`, `uses`, `mentions`. The `type` is a free-form
 * string so the extractor can invent new edge labels as needed.
 */
export interface Relationship {
  /** Unique id (nanoid). */
  id: string;
  /** Edge label, e.g. 'works_at', 'depends_on'. */
  type: string;
  /** Source entity id. */
  source: string;
  /** Target entity id. */
  target: string;
  /** Arbitrary typed metadata. */
  properties: Record<string, unknown>;
  /** Extraction confidence in `[0, 1]`. */
  confidence: number;
  /** Text snippets that support this relationship (provenance trail). */
  evidence: string[];
  /** Where this relationship was learned from. */
  source_meta: string;
  /** Creation time (epoch ms). */
  createdAt: number;
  /** Last-update time (epoch ms). */
  updatedAt: number;
}

// ─── Graph envelopes ──────────────────────────────────────────────────────

/**
 * A node decorated with its degree (number of incident relationships).
 * Returned by graph-traversal queries where degree is useful for ranking.
 */
export interface GraphNode {
  /** The underlying entity. */
  entity: Entity;
  /** Number of relationships touching this entity (in + out). */
  degree: number;
}

/**
 * A directed edge decorated with its resolved source/target entities.
 * Returned by graph-traversal queries so callers don't have to do a
 * second lookup.
 */
export interface GraphEdge {
  /** The underlying relationship. */
  relationship: Relationship;
  /** The source entity (resolved). */
  sourceEntity: Entity;
  /** The target entity (resolved). */
  targetEntity: Entity;
}

/**
 * A neighborhood subgraph: the set of nodes + edges reachable from a
 * root entity within `depth` hops.
 */
export interface Subgraph {
  /** All nodes in the subgraph (root + neighbors). */
  nodes: GraphNode[];
  /** All edges in the subgraph. */
  edges: GraphEdge[];
  /** The traversal depth that produced this subgraph. */
  depth: number;
  /** The entity id the subgraph is rooted at. */
  rootEntityId: string;
}

/**
 * The result of a graph query (DSL or programmatic). `matched` is the
 * raw list of nodes/edges that satisfied the query; `subgraph` (optional)
 * is the neighborhood context; `aggregations` (optional) is a counts map;
 * `explanation` is a human-readable description of what was done.
 */
export interface GraphQueryResult {
  /** Matched nodes and/or edges. */
  matched: Array<GraphNode | GraphEdge>;
  /** Optional neighborhood subgraph (populated by `MATCH` queries). */
  subgraph?: Subgraph;
  /** Optional aggregation counts (e.g. by entity type). */
  aggregations?: Record<string, number>;
  /** Human-readable explanation (used for debugging + agent context). */
  explanation: string;
}

// ─── Extraction ───────────────────────────────────────────────────────────

/**
 * A minimal entity shape produced by the extractor before it has been
 * assigned an id / timestamps by the {@link GraphStore}. The
 * {@link GraphBuilder} converts these to full {@link Entity} objects on
 * ingest.
 */
export interface ExtractedEntity {
  type: EntityType;
  name: string;
  aliases?: string[];
  description?: string;
  properties?: Record<string, unknown>;
}

/**
 * A minimal relationship shape produced by the extractor before it has
 * been assigned an id / timestamps. `source` and `target` are entity
 * **names** (not ids) at extraction time; the {@link GraphBuilder}
 * resolves them to ids against the store.
 */
export interface ExtractedRelationship {
  type: string;
  source: string;
  target: string;
  evidence?: string[];
  properties?: Record<string, unknown>;
}

/**
 * Result of {@link EntityExtractor.extract}. Contains the extracted
 * entities + relationships (as either Extracted* or full Entity/Relationship
 * objects, depending on whether the caller pre-allocated ids), plus a list
 * of `unresolved` entity names referenced by relationships but not present
 * in the `entities` array.
 */
export interface ExtractionResult {
  /** Extracted entities (raw shape or full entity). */
  entities: Array<Entity | ExtractedEntity>;
  /** Extracted relationships (raw shape or full relationship). */
  relationships: Array<Relationship | ExtractedRelationship>;
  /** Entity names mentioned by relationships but missing from `entities`. */
  unresolved: string[];
}

// ─── Search ───────────────────────────────────────────────────────────────

/**
 * A single search hit. The entity is annotated with a relevance `score`
 * in `[0, 1]` and a `matchedVia` channel so the caller knows whether the
 * match came from keyword (FTS), semantic (embedding), or graph traversal.
 */
export interface ScoredEntity extends Entity {
  /** Relevance score in `[0, 1]`. */
  score: number;
  /** Which search channel produced this hit. */
  matchedVia: 'keyword' | 'semantic' | 'graph';
}

/**
 * Result of {@link KnowledgeIndex.search}. Top entities by hybrid score,
 * plus their incident relationships and a neighborhood subgraph for
 * downstream context expansion.
 */
export interface SearchResult {
  /** Top entities, hybrid-ranked. */
  entities: ScoredEntity[];
  /** Relationships among the top entities. */
  relationships: Relationship[];
  /** Neighborhood subgraph rooted at the top entity. */
  subgraph: Subgraph;
}

// ─── Manager-level envelopes ──────────────────────────────────────────────

/**
 * Result of {@link KnowledgeManager.ingest}. Counts of entities/relationships
 * added + merged, plus total ingest duration in milliseconds.
 */
export interface IngestResult {
  /** Number of new entities created. */
  entitiesAdded: number;
  /** Number of new relationships created. */
  relationshipsAdded: number;
  /** Number of entities merged into existing ones (alias / name collision). */
  entitiesMerged: number;
  /** Total ingest duration in milliseconds. */
  durationMs: number;
}

/**
 * Result of {@link KnowledgeManager.query}. Synthesizes an `answer` string
 * from the matched entities/relationships + subgraph, plus the list of
 * source strings the answer was derived from.
 */
export interface QueryResult {
  /** Natural-language answer synthesized from the matched subgraph. */
  answer: string;
  /** Entities that contributed to the answer. */
  entities: Entity[];
  /** Relationships that contributed to the answer. */
  relationships: Relationship[];
  /** Neighborhood subgraph used to generate the answer. */
  subgraph: Subgraph;
  /** Provenance: source strings on the matched entities. */
  sources: string[];
}

/**
 * Aggregate statistics about the knowledge graph, computed by
 * {@link KnowledgeManager.stats}.
 */
export interface GraphStats {
  /** Total entity count. */
  entityCount: number;
  /** Total relationship count. */
  relationshipCount: number;
  /** Entity count by type. */
  typeDistribution: Record<EntityType, number>;
  /** Relationship count by type. */
  relationshipTypeDistribution: Record<string, number>;
  /** Average entity degree (in + out). */
  avgDegree: number;
  /** Number of connected components (1 = fully connected). */
  connectedComponents: number;
}
