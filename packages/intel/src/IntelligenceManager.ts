/**
 * @file IntelligenceManager.ts
 * @description Top-level orchestrator for `@sanix/intel`.
 *
 * Wires together the `CodeIndexer`, `SymbolExtractor`, `CallGraphBuilder`,
 * `ReferenceFinder`, `TypeHierarchyBuilder`, `CodeSearch`, and (optionally)
 * the `LSPClient` into a single facade. Consumers typically only touch
 * this class:
 *
 * ```ts
 * const mgr = new IntelligenceManager({ root: '/workspace' });
 * await mgr.index();
 * const graph = mgr.callGraph();
 * const refs = await mgr.findReferences(symbolId);
 * const hits = mgr.search('foo');
 * ```
 *
 * When LSP servers are configured, reference-finding and type-hierarchy
 * queries are upgraded to precise mode; otherwise they fall back to
 * regex-based heuristics.
 */

import { readFile } from 'node:fs/promises';
import { LSPClient } from './LSPClient.js';
import { SymbolExtractor } from './SymbolExtractor.js';
import { CallGraphBuilder } from './CallGraphBuilder.js';
import { ReferenceFinder } from './ReferenceFinder.js';
import { TypeHierarchyBuilder } from './TypeHierarchyBuilder.js';
import { CodeIndexer } from './CodeIndexer.js';
import { CodeSearch } from './CodeSearch.js';
import type {
  CallGraph,
  IndexResult,
  IntelligenceManagerOptions,
  IntelligenceSnapshot,
  Reference,
  SearchHit,
  SearchOptions,
  SupportedLanguage,
  SymbolInfo,
  TypeHierarchy,
} from './types.js';

/**
 * Top-level code-intelligence facade.
 */
export class IntelligenceManager {
  private readonly opts: Required<Pick<IntelligenceManagerOptions, 'root' | 'include' | 'exclude' | 'concurrency'>> &
    Pick<IntelligenceManagerOptions, 'lspServers'>;
  private readonly indexer: CodeIndexer;
  private readonly extractor = new SymbolExtractor();
  private readonly callGraphBuilder = new CallGraphBuilder();
  private readonly referenceFinder: ReferenceFinder;
  private readonly typeHierarchyBuilder = new TypeHierarchyBuilder();
  private readonly search = new CodeSearch();
  private readonly lspClients = new Map<SupportedLanguage, LSPClient>();
  private callGraphCache: CallGraph | null = null;
  private typeHierarchy: TypeHierarchy | null = null;
  private textCache = new Map<string, string>();

  /**
   * @param opts Construction options.
   */
  constructor(opts: IntelligenceManagerOptions) {
    this.opts = {
      root: opts.root,
      include: opts.include ?? ['**/*.{ts,tsx,js,jsx,py,go,rs,java}'],
      exclude: opts.exclude ?? ['**/node_modules/**', '**/dist/**', '**/.git/**', '**/build/**'],
      concurrency: opts.concurrency ?? 8,
      lspServers: opts.lspServers ?? {},
    };
    this.indexer = new CodeIndexer(this.opts.root);
    this.referenceFinder = new ReferenceFinder();
  }

  /**
   * Index the workspace. Also builds the call graph and type hierarchy
   * and populates the code-search index.
   */
  public async index(): Promise<IndexResult> {
    const result = await this.indexer.indexWorkspace({
      include: this.opts.include,
      exclude: this.opts.exclude,
      concurrency: this.opts.concurrency,
    });
    const symbols = this.indexer.allSymbols();
    this.textCache.clear();
    const getText = (file: string): string | null => this.textCache.get(file) ?? null;
    // Pre-load text for graph + hierarchy building.
    for (const sym of symbols) {
      if (!this.textCache.has(sym.file)) {
        try {
          const text = await readFile(sym.file, 'utf8');
          this.textCache.set(sym.file, text);
        } catch {
          this.textCache.set(sym.file, '');
        }
      }
    }
    this.callGraphCache = this.callGraphBuilder.build(symbols, getText);
    this.typeHierarchy = this.typeHierarchyBuilder.build(symbols, getText);
    // Populate code search.
    this.search.clear();
    for (const [file, text] of this.textCache) {
      this.search.index(file, text, this.indexer.symbolsForFile(file));
    }
    return {
      ...result,
      edges: this.callGraphCache.edges.length,
      types: this.typeHierarchy.nodes.size,
    };
  }

  /**
   * Start any configured LSP servers (one per language).
   */
  public async startLSP(): Promise<void> {
    for (const [lang, cfg] of Object.entries(this.opts.lspServers ?? {})) {
      if (!cfg) continue;
      const language = lang as SupportedLanguage;
      if (this.lspClients.has(language)) continue;
      const client = new LSPClient(cfg);
      try {
        await client.start(this.opts.root);
        this.lspClients.set(language, client);
      } catch {
        // server unavailable — remain in regex mode
      }
    }
  }

  /**
   * Stop all LSP servers.
   */
  public async stopLSP(): Promise<void> {
    for (const client of this.lspClients.values()) {
      try { await client.shutdown(); } catch { /* ignore */ }
    }
    this.lspClients.clear();
  }

  /**
   * All extracted symbols.
   */
  public symbols(): SymbolInfo[] {
    return this.indexer.allSymbols();
  }

  /**
   * Find a symbol by id.
   */
  public symbol(id: string): SymbolInfo | null {
    return this.symbols().find((s) => s.id === id) ?? null;
  }

  /**
   * Find symbols by name (case-insensitive substring).
   */
  public symbolsByName(name: string): SymbolInfo[] {
    const lower = name.toLowerCase();
    return this.symbols().filter((s) => s.name.toLowerCase().includes(lower));
  }

  /**
   * Return the cached call graph (builds it lazily if missing).
   */
  public async callGraph_(): Promise<CallGraph> {
    if (this.callGraphCache) return this.callGraphCache;
    await this.index();
    return this.callGraphCache!;
  }

  /** Call graph accessor (sync; throws if not indexed). */
  public callGraph(): CallGraph {
    if (!this.callGraphCache) throw new Error('IntelligenceManager not indexed — call index() first');
    return this.callGraphCache;
  }

  /**
   * Return the cached type hierarchy.
   */
  public typeHierarchy_(): TypeHierarchy {
    if (!this.typeHierarchy) throw new Error('IntelligenceManager not indexed — call index() first');
    return this.typeHierarchy;
  }

  /**
   * Find references to a symbol.
   */
  public async findReferences(symbolId: string, includeDeclaration = true): Promise<Reference[]> {
    const sym = this.symbol(symbolId);
    if (!sym) return [];
    return this.referenceFinder.find(
      sym,
      (f) => this.textCache.get(f) ?? null,
      this.indexer.indexedFiles(),
      { includeDefinition: includeDeclaration, files: this.indexer.indexedFiles() },
    );
  }

  /**
   * Code search.
   */
  public searchCode(query: string, opts: SearchOptions = {}): SearchHit[] {
    return this.search.search(query, opts);
  }

  /**
   * Fuzzy code search.
   */
  public fuzzySearch(query: string, opts: SearchOptions = {}): SearchHit[] {
    return this.search.fuzzy(query, opts);
  }

  /**
   * Direct callees of a symbol.
   */
  public callees(symbolId: string): string[] {
    if (!this.callGraphCache) return [];
    return this.callGraphBuilder.callees(this.callGraphCache, symbolId);
  }

  /**
   * Direct callers of a symbol.
   */
  public callers(symbolId: string): string[] {
    if (!this.callGraphCache) return [];
    return this.callGraphBuilder.callers(this.callGraphCache, symbolId);
  }

  /**
   * All subtypes of a type.
   */
  public subtypes(symbolId: string): SymbolInfo[] {
    if (!this.typeHierarchy) return [];
    return this.typeHierarchyBuilder
      .subtypes(this.typeHierarchy, symbolId)
      .map((n) => this.symbol(n.symbolId))
      .filter((s): s is SymbolInfo => s !== null);
  }

  /**
   * All supertypes of a type.
   */
  public supertypes(symbolId: string): SymbolInfo[] {
    if (!this.typeHierarchy) return [];
    return this.typeHierarchyBuilder
      .supertypes(this.typeHierarchy, symbolId)
      .map((n) => this.symbol(n.symbolId))
      .filter((s): s is SymbolInfo => s !== null);
  }

  /**
   * Serialize the index for caching.
   */
  public snapshot(): IntelligenceSnapshot {
    return this.indexer.snapshot();
  }

  /**
   * Restore from a snapshot (does NOT rebuild the call graph / hierarchy).
   */
  public restoreSnapshot(snapshot: IntelligenceSnapshot): void {
    this.indexer.restoreSnapshot(snapshot);
    this.callGraphCache = null;
    this.typeHierarchy = null;
    this.textCache.clear();
  }

  /**
   * The extractor (for direct use by callers).
   */
  public getExtractor(): SymbolExtractor {
    return this.extractor;
  }

  /**
   * The indexer (for incremental updates).
   */
  public getIndexer(): CodeIndexer {
    return this.indexer;
  }
}
