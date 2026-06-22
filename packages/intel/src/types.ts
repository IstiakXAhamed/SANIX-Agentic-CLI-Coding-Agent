/**
 * @file types.ts
 * @description Shared types for `@sanix/intel` — code intelligence
 * primitives consumed by the symbol extractor, call-graph builder,
 * reference finder, type-hierarchy builder, code indexer, code
 * searcher, and the orchestrating `IntelligenceManager`.
 *
 * @packageDocumentation
 */

/**
 * A supported source language for symbol extraction. The extractor
 * ships with hand-tuned regex grammars for these six families; any
 * other language is rejected with a clear error so callers don't
 * silently get an empty symbol table.
 */
export type SupportedLanguage =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'go'
  | 'rust'
  | 'java';

/**
 * The category of a symbol extracted from source. Mirrors the LSP
 * `SymbolKind` enum but trimmed to the kinds the regex extractor can
 * reliably detect.
 */
export type SymbolKind =
  | 'function'
  | 'class'
  | 'method'
  | 'interface'
  | 'type'
  | 'enum'
  | 'variable'
  | 'constant'
  | 'namespace'
  | 'module';

/**
 * A single symbol extracted from a source file. Line/column are
 * 1-based to match LSP and most editor conventions.
 */
export interface SymbolInfo {
  /** Stable id — `file:kind:name:line`. */
  id: string;
  /** Absolute or workspace-relative path of the source file. */
  file: string;
  /** Symbol name (e.g. `extractSymbols`, `MyClass`, `MAX_RETRIES`). */
  name: string;
  /** Container name if nested (e.g. class for a method), else `null`. */
  containerName: string | null;
  /** Coarse kind used for ranking and rendering. */
  kind: SymbolKind;
  /** 1-based line where the declaration starts. */
  line: number;
  /** 1-based column where the declaration starts. */
  column: number;
  /** 1-based line of the declaration's end (last line of body). */
  endLine: number;
  /** One-line signature (params + return type) when extractable. */
  signature: string | null;
  /** Leading docstring / JSDoc / doc-comment, trimmed. */
  docstring: string | null;
  /** Visibility modifier when applicable (`public`/`private`/etc.). */
  visibility: 'public' | 'private' | 'protected' | 'internal' | 'package' | null;
  /** True when the symbol is declared `static`. */
  isStatic: boolean;
  /** True when the symbol is declared `async`. */
  isAsync: boolean;
  /** True when the symbol is exported from its module. */
  isExported: boolean;
}

/**
 * An edge in the call graph: `caller → callee`. Both endpoints are
 * symbol ids. `callType` distinguishes a direct invocation from an
 * indirect (polymorphic / dynamic) reference.
 */
export interface CallEdge {
  caller: string;
  callee: string;
  /** File:line where the call site appears. */
  callSite: string;
  callType: 'direct' | 'indirect' | 'virtual';
}

/**
 * The full call graph for an indexed workspace.
 */
export interface CallGraph {
  /** All symbol ids that act as nodes (functions / methods). */
  nodes: string[];
  /** Directed edges `caller → callee`. */
  edges: CallEdge[];
  /** Reverse adjacency for fast "who calls X" lookups. */
  reverseAdjacency: Map<string, string[]>;
  /** Forward adjacency for fast "what does X call" lookups. */
  forwardAdjacency: Map<string, string[]>;
}

/**
 * A reference to a symbol found by the `ReferenceFinder`.
 */
export interface Reference {
  /** Symbol id of the referenced definition. */
  symbolId: string;
  /** File where the reference appears. */
  file: string;
  /** 1-based line of the reference. */
  line: number;
  /** 1-based column of the reference. */
  column: number;
  /** Kind of reference — read, write, call, or definition. */
  kind: 'read' | 'write' | 'call' | 'definition';
  /** The textual span of the reference. */
  text: string;
}

/**
 * A node in a type hierarchy.
 */
export interface TypeNode {
  /** Symbol id of the type. */
  symbolId: string;
  /** Display name of the type. */
  name: string;
  /** Qualified name including namespace, when known. */
  qualifiedName: string | null;
  /** Kind — `class`, `interface`, `enum`, `type`, `struct`. */
  kind: 'class' | 'interface' | 'enum' | 'type' | 'struct';
  /** File where the type is declared. */
  file: string;
  /** Line of the declaration. */
  line: number;
  /** Symbol ids of direct supertypes. */
  parents: string[];
  /** Symbol ids of direct subtypes. */
  children: string[];
}

/**
 * The full type hierarchy for an indexed workspace.
 */
export interface TypeHierarchy {
  /** All type nodes keyed by symbol id. */
  nodes: Map<string, TypeNode>;
  /** Root ids (types with no parents). */
  roots: string[];
}

/**
 * A single search hit from `CodeSearch`.
 */
export interface SearchHit {
  /** File of the hit. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** 1-based column of the match start. */
  column: number;
  /** The matched text. */
  match: string;
  /** The full line of context. */
  context: string;
  /** 0–100 relevance score (symbol-name match > body match). */
  score: number;
}

/**
 * Options for `CodeSearch.search`.
 */
export interface SearchOptions {
  /** Case-sensitive match. Default `false`. */
  caseSensitive?: boolean;
  /** Treat `query` as a regex. Default `false` (literal substring). */
  regex?: boolean;
  /** Whole-word match. Default `false`. */
  wholeWord?: boolean;
  /** Restrict to these file globs. Default = all indexed files. */
  include?: string[];
  /** Exclude these file globs. */
  exclude?: string[];
  /** Max hits to return. Default `100`. */
  maxResults?: number;
  /** Include symbol-name matches with boosted score. Default `true`. */
  boostSymbols?: boolean;
}

/**
 * Options for the `IntelligenceManager` constructor.
 */
export interface IntelligenceManagerOptions {
  /** Absolute workspace root. */
  root: string;
  /** File globs to include when indexing. */
  include?: string[];
  /** File globs to exclude. */
  exclude?: string[];
  /** Map language id → LSP server command. Empty = regex-only mode. */
  lspServers?: Partial<Record<SupportedLanguage, LSPServerConfig>>;
  /** Max parallel file reads during indexing. Default `8`. */
  concurrency?: number;
}

/**
 * Configuration for a single LSP server.
 */
export interface LSPServerConfig {
  /** Shell command + args to launch the server. */
  command: string;
  args?: string[];
  /** Env vars for the server process. */
  env?: Record<string, string>;
  /** File extensions the server handles (e.g. `['.ts', '.tsx']`). */
  extensions: string[];
  /** Init options passed to the server. */
  initOptions?: Record<string, unknown>;
}

/**
 * A document opened in an LSP session.
 */
export interface LSPDocument {
  uri: string;
  languageId: SupportedLanguage;
  version: number;
  text: string;
}

/**
 * Result of indexing a workspace.
 */
export interface IndexResult {
  /** Number of files indexed. */
  files: number;
  /** Number of symbols extracted. */
  symbols: number;
  /** Number of call edges built. */
  edges: number;
  /** Number of type-hierarchy nodes. */
  types: number;
  /** Wall-clock duration in ms. */
  durationMs: number;
}

/**
 * Snapshot of the intelligence index — serializable for caching.
 */
export interface IntelligenceSnapshot {
  /** ISO timestamp when the snapshot was taken. */
  createdAt: string;
  /** Workspace root. */
  root: string;
  /** All extracted symbols. */
  symbols: SymbolInfo[];
  /** All call edges. */
  edges: CallEdge[];
  /** All type nodes. */
  types: TypeNode[];
  /** All files indexed, with their symbol counts. */
  files: Array<{ file: string; symbols: number; language: SupportedLanguage }>;
}
