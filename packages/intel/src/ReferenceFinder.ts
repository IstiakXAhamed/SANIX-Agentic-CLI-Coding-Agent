/**
 * @file ReferenceFinder.ts
 * @description Finds references to a symbol across the workspace.
 *
 * The finder supports two modes:
 *
 *   - **LSP-backed** (precise): delegates to a running `LSPClient` for
 *     `textDocument/references`. Use when an LSP server is available.
 *   - **Regex-backed** (best-effort): scans every indexed file for
 *     whole-word occurrences of the symbol's name, classifying each
 *     hit as read / write / call / definition by its syntactic context.
 *
 * The regex mode is the fallback when no LSP server is configured and
 * is what the `IntelligenceManager` uses by default.
 */

import type { Reference, SymbolInfo } from './types.js';
import type { LSPClient } from './LSPClient.js';

/**
 * Options for `ReferenceFinder.find`.
 */
export interface FindReferencesOptions {
  /** Include the definition itself. Default `true`. */
  includeDefinition?: boolean;
  /** Restrict to these files. Default = all known files. */
  files?: string[];
  /** Max hits. Default `500`. */
  maxResults?: number;
}

/**
 * Finds references to a symbol.
 *
 * @example
 * ```ts
 * const finder = new ReferenceFinder();
 * const refs = finder.find(symbol, fileTextProvider);
 * ```
 */
export class ReferenceFinder {
  /**
   * @param lsp Optional LSP client for precise mode.
   */
  constructor(private readonly lsp?: LSPClient) {}

  /**
   * Find references.
   * @param symbol The symbol to find references to.
   * @param getFileText Function returning source text for a file path.
   * @param allFiles All files to scan (regex mode).
   * @param opts Options.
   */
  public async find(
    symbol: SymbolInfo,
    getFileText: (file: string) => string | null,
    allFiles: string[],
    opts: FindReferencesOptions = {},
  ): Promise<Reference[]> {
    if (this.lsp && this.lsp.isAlive()) {
      try {
        return await this.findViaLSP(symbol, opts);
      } catch {
        // fall through to regex
      }
    }
    return this.findViaRegex(symbol, getFileText, allFiles, opts);
  }

  /**
   * Regex-based reference search.
   */
  public findViaRegex(
    symbol: SymbolInfo,
    getFileText: (file: string) => string | null,
    allFiles: string[],
    opts: FindReferencesOptions = {},
  ): Reference[] {
    const includeDef = opts.includeDefinition ?? true;
    const max = opts.maxResults ?? 500;
    const files = opts.files ?? allFiles;
    const refs: Reference[] = [];
    const escaped = symbol.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'g');

    for (const file of files) {
      if (refs.length >= max) break;
      const text = getFileText(file);
      if (!text) continue;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (refs.length >= max) break;
        const line = lines[i];
        let m: RegExpExecArray | null;
        re.lastIndex = 0;
        while ((m = re.exec(line)) !== null) {
          const col = m.index + 1;
          const isDef = file === symbol.file && i + 1 === symbol.line;
          if (isDef && !includeDef) continue;
          refs.push({
            symbolId: symbol.id,
            file,
            line: i + 1,
            column: col,
            kind: isDef ? 'definition' : this.classify(line, m.index, symbol.name),
            text: m[0],
          });
          if (refs.length >= max) break;
        }
      }
    }
    return refs;
  }

  /**
   * LSP-backed precise reference search.
   */
  public async findViaLSP(symbol: SymbolInfo, opts: FindReferencesOptions = {}): Promise<Reference[]> {
    if (!this.lsp) return [];
    const includeDef = opts.includeDefinition ?? true;
    const uri = `file://${symbol.file}`;
    const raw = await this.lsp.references(uri, symbol.line - 1, symbol.column - 1, includeDef);
    const refs: Reference[] = [];
    for (const loc of raw as Array<Record<string, unknown>>) {
      const u = loc?.uri as string | undefined;
      const range = loc?.range as { start: { line: number; character: number } } | undefined;
      if (!u || !range) continue;
      refs.push({
        symbolId: symbol.id,
        file: u.replace(/^file:\/\//, ''),
        line: range.start.line + 1,
        column: range.start.character + 1,
        kind: 'read',
        text: '',
      });
    }
    return refs;
  }

  /**
   * Classify a reference by its syntactic context.
   */
  private classify(line: string, index: number, name: string): Reference['kind'] {
    const before = line.slice(0, index);
    const after = line.slice(index + name.length);
    // call: followed by `(`
    if (/^\s*\(/.test(after)) return 'call';
    // write: preceded by assignment
    if (/(?:^|[\s;{(])\s*(?:const|let|var|set)?\s*$/.test(before) && /\s*=/.test(after)) return 'write';
    // write: `name =`
    if (/\s*=\s*[^=]/.test(after) && !/==/.test(after)) return 'write';
    // write: `name:` in destructuring / assignment
    if (/^\s*:/.test(after)) return 'write';
    return 'read';
  }
}
