/**
 * @file index.ts
 * @description Barrel re-export for `@sanix/rag`. Surface:
 *
 *   - **Types**: `Document`, `DocumentMetadata`, `ScoredDoc`,
 *     `DocumentFilter`
 *   - **Document store**: `DocumentStore`, `DocumentStoreBackend`,
 *     `DocumentStoreOptions`, `ListOptions`
 *   - **BM25 index**: `BM25Index`, `BM25Hit`, `BM25Options`, `tokenize`
 *   - **Keyword index**: `KeywordIndex`, `KeywordHit`,
 *     `KeywordIndexOptions`, `DEFAULT_FIELD_BOOSTS`
 *   - **Hybrid retriever**: `HybridRetriever`, `HybridRetrieverOptions`,
 *     `RetrieveOptions`, `DEFAULT_HYBRID_WEIGHTS`
 *   - **Reranker**: `Reranker`, `RerankMethod`, `RerankerOptions`,
 *     `RerankOptions`
 *   - **Query rewriter**: `QueryRewriter`, `QueryRewriteMethod`,
 *     `RewrittenQuery`, `QueryRewriterOptions`, `RewriteContext`
 *   - **Multi-hop retriever**: `MultiHopRetriever`, `MultiHop`,
 *     `MultiHopResult`, `MultiHopRetrieverOptions`
 *   - **RAG pipeline**: `RAGPipeline`, `RAGPipelineOptions`,
 *     `RAGPipelineEvents`, `QueryOptions`, `RAGResult`,
 *     `DEFAULT_RAG_SYSTEM_PROMPT`
 *   - **Citation extractor**: `CitationExtractor`, `Citation`
 *
 * Import paths:
 *   import { RAGPipeline, DocumentStore, HybridRetriever } from '@sanix/rag';
 *
 * @packageDocumentation
 */

// ─── Shared types ─────────────────────────────────────────────────────────
export type {
  Document,
  DocumentMetadata,
  ScoredDoc,
  DocumentFilter,
} from './types.js';

// ─── Document store ───────────────────────────────────────────────────────
export {
  DocumentStore,
  type DocumentStoreBackend,
  type DocumentStoreOptions,
  type ListOptions,
} from './DocumentStore.js';

// ─── BM25 index ───────────────────────────────────────────────────────────
export {
  BM25Index,
  type BM25Hit,
  type BM25Options,
  tokenize,
} from './BM25Index.js';

// ─── Keyword index ────────────────────────────────────────────────────────
export {
  KeywordIndex,
  type KeywordHit,
  type KeywordIndexOptions,
  DEFAULT_FIELD_BOOSTS,
} from './KeywordIndex.js';

// ─── Hybrid retriever ─────────────────────────────────────────────────────
export {
  HybridRetriever,
  type HybridRetrieverOptions,
  type RetrieveOptions,
  DEFAULT_HYBRID_WEIGHTS,
} from './HybridRetriever.js';

// ─── Reranker ─────────────────────────────────────────────────────────────
export {
  Reranker,
  type RerankMethod,
  type RerankerOptions,
  type RerankOptions,
} from './Reranker.js';

// ─── Query rewriter ───────────────────────────────────────────────────────
export {
  QueryRewriter,
  type QueryRewriteMethod,
  type RewrittenQuery,
  type QueryRewriterOptions,
  type RewriteContext,
} from './QueryRewriter.js';

// ─── Multi-hop retriever ──────────────────────────────────────────────────
export {
  MultiHopRetriever,
  type MultiHop,
  type MultiHopResult,
  type MultiHopRetrieverOptions,
} from './MultiHopRetriever.js';

// ─── RAG pipeline ─────────────────────────────────────────────────────────
export {
  RAGPipeline,
  type RAGPipelineOptions,
  type RAGPipelineEvents,
  type QueryOptions,
  type RAGResult,
  DEFAULT_RAG_SYSTEM_PROMPT,
} from './RAGPipeline.js';

// ─── Citation extractor ───────────────────────────────────────────────────
export {
  CitationExtractor,
  type Citation,
} from './CitationExtractor.js';
