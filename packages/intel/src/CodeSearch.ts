/**
 * @file CodeSearch.ts
 * @description Fast in-memory code search over indexed files.
 *
 * Supports literal / regex / whole-word matching with file-glob
 * include/exclude filters and a symbol-name boost (matches inside a
 * symbol *name* rank higher than matches in the body).
 *
 * The searcher is deliberately synchronous and pure — it operates on
 * a pre-loaded map of `file → text` so it can be called from hot
 * paths (autocomplete, hover) without I/O.
 */

import { minimatch } from './util/minimatch.js';
import type { SearchHit, SearchOptions, SymbolInfo } from './types.js';

/**
 * In-memory code search.
 *
 * @example
 * ```ts
 * const search = new CodeSearch();
 * search.index('/app/foo.ts', 'export function bar() {}');
 * const hits = search.search('bar');
 * ```
 */
export class CodeSearch {
  private readonly texts = new Map<string, string>();
  private readonly symbolIndex = new Map<string, SymbolInfo[]>();

  /**
   * Index a file's text.
   */
  public index(file: string, text: string, symbols: SymbolInfo[] = []): void {
    this.texts.set(file, text);
    this.symbolIndex.set(file, symbols);
  }

  /**
   * Remove a file from the index.
   */
  public remove(file: string): void {
    this.texts.delete(file);
    this.symbolIndex.delete(file);
  }

  /**
   * Search the index.
   */
  public search(query: string, opts: SearchOptions = {}): SearchHit[] {
    if (!query) return [];
    const caseSensitive = opts.caseSensitive ?? false;
    const isRegex = opts.regex ?? false;
    const wholeWord = opts.wholeWord ?? false;
    const max = opts.maxResults ?? 100;
    const boost = opts.boostSymbols ?? true;
    const include = opts.include ?? ['**/*'];
    const exclude = opts.exclude ?? [];

    let pattern: RegExp;
    try {
      const q = isRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const ww = wholeWord ? `\\b${q}\\b` : q;
      pattern = new RegExp(ww, caseSensitive ? 'g' : 'gi');
    } catch {
      return [];
    }

    const hits: SearchHit[] = [];
    for (const [file, text] of this.texts) {
      const rel = file;
      if (!include.some((g) => minimatch(rel, g))) continue;
      if (exclude.some((g) => minimatch(rel, g))) continue;
      const lines = text.split(/\r?\n/);
      const symbols = this.symbolIndex.get(file) ?? [];
      const nameSet = new Set<string>();
      if (boost) for (const s of symbols) nameSet.add(s.name.toLowerCase());

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        pattern.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = pattern.exec(line)) !== null) {
          const isNameHit = boost && nameSet.has(m[0].toLowerCase());
          hits.push({
            file,
            line: i + 1,
            column: m.index + 1,
            match: m[0],
            context: line.length > 200 ? line.slice(0, 200) : line,
            score: isNameHit ? 100 : 50,
          });
          if (m.index === pattern.lastIndex) pattern.lastIndex++;
          if (hits.length >= max) {
            hits.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.line - b.line);
            return hits;
          }
        }
      }
    }
    hits.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.line - b.line);
    return hits;
  }

  /**
   * Fuzzy search — token-set match. Each query token must appear
   * (in order) in the line, allowing gaps.
   */
  public fuzzy(query: string, opts: SearchOptions = {}): SearchHit[] {
    if (!query) return [];
    const tokens = query.trim().split(/\s+/).map((t) =>
      t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    );
    if (tokens.length === 0) return [];
    const pattern = new RegExp(tokens.join('.*?'), opts.caseSensitive ? 'g' : 'gi');
    const max = opts.maxResults ?? 100;
    const hits: SearchHit[] = [];
    for (const [file, text] of this.texts) {
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        pattern.lastIndex = 0;
        const m = pattern.exec(lines[i]);
        if (m) {
          hits.push({
            file,
            line: i + 1,
            column: m.index + 1,
            match: m[0],
            context: lines[i].length > 200 ? lines[i].slice(0, 200) : lines[i],
            score: 30 + Math.max(0, 20 - (m[0].length - query.length)),
          });
          if (hits.length >= max) {
            hits.sort((a, b) => b.score - a.score);
            return hits;
          }
        }
      }
    }
    hits.sort((a, b) => b.score - a.score);
    return hits;
  }

  /**
   * Clear the index.
   */
  public clear(): void {
    this.texts.clear();
    this.symbolIndex.clear();
  }
}
