/**
 * @file CodeIndexer.ts
 * @description Walks a workspace directory, extracts symbols per file,
 * and maintains an in-memory index keyed by file + symbol id.
 *
 * The indexer:
 *   - Respects include / exclude globs.
 *   - Detects language by extension; skips unsupported files.
 *   - Re-indexes only changed files when `indexFile` is called with
 *     a known path (mtime-based incremental update).
 *   - Emits a serializable `IntelligenceSnapshot` for caching.
 */

import { readdir, stat, readFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { minimatch } from './util/minimatch.js';
import { SymbolExtractor } from './SymbolExtractor.js';
import type {
  IndexResult,
  IntelligenceSnapshot,
  SupportedLanguage,
  SymbolInfo,
} from './types.js';

interface IndexedFile {
  file: string;
  language: SupportedLanguage;
  mtimeMs: number;
  symbols: SymbolInfo[];
}

/**
 * Options for `CodeIndexer.indexWorkspace`.
 */
export interface IndexWorkspaceOptions {
  /** Globs to include. Default matches ts, tsx, js, jsx, py, go, rs, java. */
  include?: string[];
  /** Globs to exclude. Default excludes node_modules, dist, .git, build. */
  exclude?: string[];
  /** Max parallel file reads. Default `8`. */
  concurrency?: number;
  /** Force re-index even if mtime is unchanged. */
  force?: boolean;
}

/**
 * Indexes a workspace's source files into symbols.
 *
 * @example
 * ```ts
 * const indexer = new CodeIndexer('/workspace');
 * const result = await indexer.indexWorkspace();
 * const symbols = indexer.symbolsForFile('/workspace/src/foo.ts');
 * ```
 */
export class CodeIndexer {
  private readonly files = new Map<string, IndexedFile>();
  private readonly extractor = new SymbolExtractor();

  /**
   * @param root Absolute workspace root.
   */
  constructor(private readonly root: string) {}

  /**
   * Index the entire workspace.
   */
  public async indexWorkspace(opts: IndexWorkspaceOptions = {}): Promise<IndexResult> {
    const started = Date.now();
    const include = opts.include ?? ['**/*.{ts,tsx,js,jsx,py,go,rs,java}'];
    const exclude = opts.exclude ?? ['**/node_modules/**', '**/dist/**', '**/.git/**', '**/build/**'];
    const allFiles = await this.walk(this.root, include, exclude);
    let symbols = 0;
    const concurrency = Math.max(1, opts.concurrency ?? 8);
    const queue = [...allFiles];
    const workers: Promise<void>[] = [];
    for (let w = 0; w < concurrency; w++) {
      workers.push(this.worker(queue, opts.force ?? false));
    }
    await Promise.all(workers);
    for (const f of this.files.values()) symbols += f.symbols.length;
    return {
      files: this.files.size,
      symbols,
      edges: 0,
      types: 0,
      durationMs: Date.now() - started,
    };
  }

  /**
   * Index (or re-index) a single file.
   */
  public async indexFile(file: string, force = false): Promise<SymbolInfo[]> {
    const abs = this.resolve(file);
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(abs);
    } catch {
      this.files.delete(abs);
      return [];
    }
    const existing = this.files.get(abs);
    if (!force && existing && existing.mtimeMs === st.mtimeMs) return existing.symbols;
    const text = await readFile(abs, 'utf8');
    const language = this.extractor.detectLanguage(abs);
    if (!language) {
      this.files.delete(abs);
      return [];
    }
    const symbols = this.extractor.extract(abs, text, { language });
    this.files.set(abs, { file: abs, language, mtimeMs: st.mtimeMs, symbols });
    return symbols;
  }

  /**
   * Remove a file from the index.
   */
  public removeFile(file: string): void {
    this.files.delete(this.resolve(file));
  }

  /**
   * All indexed symbols across the workspace.
   */
  public allSymbols(): SymbolInfo[] {
    const out: SymbolInfo[] = [];
    for (const f of this.files.values()) out.push(...f.symbols);
    return out;
  }

  /**
   * Symbols for a single file.
   */
  public symbolsForFile(file: string): SymbolInfo[] {
    return this.files.get(this.resolve(file))?.symbols ?? [];
  }

  /**
   * All indexed file paths (absolute).
   */
  public files_(): string[] {
    return [...this.files.keys()];
  }

  /** All indexed files (alias to avoid `files` collision with private map). */
  public indexedFiles(): string[] {
    return [...this.files.keys()];
  }

  /**
   * Get the source text of an indexed file.
   */
  public async getFileText(file: string): Promise<string | null> {
    const abs = this.resolve(file);
    try {
      return await readFile(abs, 'utf8');
    } catch {
      return null;
    }
  }

  /**
   * Serialize the index for caching.
   */
  public snapshot(): IntelligenceSnapshot {
    return {
      createdAt: new Date().toISOString(),
      root: this.root,
      symbols: this.allSymbols(),
      edges: [],
      types: [],
      files: [...this.files.values()].map((f) => ({ file: f.file, symbols: f.symbols.length, language: f.language })),
    };
  }

  /**
   * Restore an index from a snapshot.
   */
  public restoreSnapshot(snapshot: IntelligenceSnapshot): void {
    this.files.clear();
    const byFile = new Map<string, SymbolInfo[]>();
    for (const sym of snapshot.symbols) {
      const list = byFile.get(sym.file) ?? [];
      list.push(sym);
      byFile.set(sym.file, list);
    }
    for (const f of snapshot.files) {
      this.files.set(f.file, {
        file: f.file,
        language: f.language,
        mtimeMs: 0,
        symbols: byFile.get(f.file) ?? [],
      });
    }
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  private resolve(file: string): string {
    return file.startsWith(this.root) ? file : join(this.root, file);
  }

  private async worker(queue: string[], force: boolean): Promise<void> {
    while (queue.length) {
      const file = queue.shift();
      if (!file) break;
      await this.indexFile(file, force);
    }
  }

  private async walk(dir: string, include: string[], exclude: string[]): Promise<string[]> {
    const out: string[] = [];
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = relative(this.root, full).split(sep).join('/');
      if (entry.isDirectory()) {
        if (exclude.some((g) => minimatch(rel + '/', g))) continue;
        out.push(...await this.walk(full, include, exclude));
      } else if (entry.isFile()) {
        if (exclude.some((g) => minimatch(rel, g))) continue;
        if (include.some((g) => minimatch(rel, g))) out.push(full);
      }
    }
    return out;
  }
}
