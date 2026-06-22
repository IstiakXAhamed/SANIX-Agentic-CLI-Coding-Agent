/**
 * @file index.ts
 * @description Barrel re-export for `@sanix/intel`.
 *
 * @packageDocumentation
 */

export {
  IntelligenceManager,
} from './IntelligenceManager.js';

export {
  LSPClient,
  LSPError,
  languageFromExtension,
  nextRequestId,
} from './LSPClient.js';

export {
  SymbolExtractor,
  type ExtractOptions,
} from './SymbolExtractor.js';

export {
  CallGraphBuilder,
  type CallGraphBuildOptions,
} from './CallGraphBuilder.js';

export {
  ReferenceFinder,
  type FindReferencesOptions,
} from './ReferenceFinder.js';

export {
  TypeHierarchyBuilder,
  type TypeHierarchyBuildOptions,
} from './TypeHierarchyBuilder.js';

export {
  CodeIndexer,
  type IndexWorkspaceOptions,
} from './CodeIndexer.js';

export {
  CodeSearch,
} from './CodeSearch.js';

export {
  minimatch,
  globToRegex,
} from './util/minimatch.js';

export type {
  SupportedLanguage,
  SymbolKind,
  SymbolInfo,
  CallEdge,
  CallGraph,
  Reference,
  TypeNode,
  TypeHierarchy,
  SearchHit,
  SearchOptions,
  LSPServerConfig,
  LSPDocument,
  IndexResult,
  IntelligenceSnapshot,
  IntelligenceManagerOptions,
} from './types.js';
