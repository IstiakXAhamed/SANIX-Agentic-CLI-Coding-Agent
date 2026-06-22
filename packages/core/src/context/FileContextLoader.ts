/**
 * @file context/FileContextLoader.ts
 * @description Smart file / repo ingestion. Loads files with optional
 * AST-aware section extraction (line-based with regex matching for
 * `function|class|const X` blocks — full tree-sitter AST is deferred to
 * `@sanix/tools/CodeIndexer`). Loads directories via `glob` and respects
 * `.gitignore` via the `ignore` package.
 *
 * @packageDocumentation
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { glob } from 'glob';
import ignore from 'ignore';
import { EOL } from 'node:os';

/**
 * Options for {@link FileContextLoader.loadFile}.
 */
export interface LoadFileOptions {
  /** Optional symbol filter (e.g. 'MyClass', 'myFunction'). When set, only
   * the matching function/class/const block is returned. */
  symbol?: string;
  /** Max lines to read. Default: unlimited. */
  maxLines?: number;
  /** Encoding. Default 'utf-8'. */
  encoding?: BufferEncoding;
}

/**
 * A loaded file's content + metadata.
 */
export interface LoadedFile {
  /** Absolute path. */
  path: string;
  /** File content (possibly truncated / symbol-filtered). */
  content: string;
  /** Number of lines in the original file. */
  totalLines: number;
  /** Number of lines actually returned (after filtering). */
  returnedLines: number;
  /** True if the content was symbol-filtered. */
  symbolFiltered: boolean;
  /** True if the content was line-truncated. */
  truncated: boolean;
}

/**
 * Smart file / repo ingestion.
 *
 * @example
 * ```ts
 * const loader = new FileContextLoader('/path/to/repo');
 * const file = loader.loadFile('src/index.ts', { symbol: 'main' });
 * const files = await loader.loadDirectory('src', '**\/*.ts');
 * const repo = await loader.loadRepo();  // respects .gitignore
 * ```
 */
export class FileContextLoader {
  private readonly rootDir: string;

  /**
   * @param rootDir - The project root for resolving relative paths and for
   *                  `loadRepo()` / `loadDirectory()`. Defaults to cwd.
   */
  constructor(rootDir: string = process.cwd()) {
    this.rootDir = isAbsolute(rootDir) ? rootDir : join(process.cwd(), rootDir);
  }

  /**
   * Load a single file. With `opts.symbol`, returns only the matching
   * `function|class|const X` block (regex-based — full AST extraction is
   * deferred to `@sanix/tools/CodeIndexer`).
   *
   * @param path - Absolute or relative (to rootDir) path.
   * @param opts - Load options.
   * @throws {Error} if the file does not exist or is not a file.
   */
  loadFile(path: string, opts: LoadFileOptions = {}): LoadedFile {
    const abs = this.resolve(path);
    if (!existsSync(abs)) throw new Error(`File not found: ${abs}`);
    const stat = statSync(abs);
    if (!stat.isFile()) throw new Error(`Not a file: ${abs}`);

    const encoding = opts.encoding ?? 'utf-8';
    const raw = readFileSync(abs, encoding);
    const lines = raw.split(/\r?\n/);
    const totalLines = lines.length;

    // Symbol filter: extract the matching block.
    if (opts.symbol) {
      const block = extractSymbolBlock(raw, opts.symbol);
      if (block !== null) {
        const blockLines = block.split(/\r?\n/).length;
        return {
          path: abs,
          content: block,
          totalLines,
          returnedLines: blockLines,
          symbolFiltered: true,
          truncated: false,
        };
      }
      // Symbol not found — fall through to full load with a note.
    }

    // Line truncation.
    let content = raw;
    let truncated = false;
    let returnedLines = totalLines;
    if (opts.maxLines !== undefined && totalLines > opts.maxLines) {
      content = `${lines.slice(0, opts.maxLines).join(EOL)}\n... (${totalLines - opts.maxLines} more lines truncated)`;
      returnedLines = opts.maxLines;
      truncated = true;
    }

    return {
      path: abs,
      content,
      totalLines,
      returnedLines,
      symbolFiltered: false,
      truncated,
    };
  }

  /**
   * Load all files in a directory matching a glob pattern. Returns a map of
   * absolute path → LoadedFile. Respects `.gitignore` if one exists in
   * `rootDir` (or any ancestor).
   *
   * @param dir - Directory (relative to rootDir or absolute).
   * @param pattern - Glob pattern (e.g. `**\/*.ts`). Default: `**\/*`.
   * @param opts - Per-file load options (applied to every matched file).
   */
  async loadDirectory(
    dir: string,
    pattern: string = '**/*',
    opts: LoadFileOptions = {},
  ): Promise<Map<string, LoadedFile>> {
    const absDir = this.resolve(dir);
    if (!existsSync(absDir)) {
      throw new Error(`Directory not found: ${absDir}`);
    }
    const ig = this.loadGitignore(absDir);
    const fullPattern = join(absDir, pattern).replace(/\\/g, '/');
    const matches = await glob(fullPattern, {
      nodir: true,
      dot: false,
      ignore: ['**/node_modules/**', '**/.git/**'],
    });

    const result = new Map<string, LoadedFile>();
    for (const match of matches) {
      const rel = relative(absDir, match);
      if (ig.ignores(rel)) continue;
      try {
        const loaded = this.loadFile(match, opts);
        result.set(match, loaded);
      } catch {
        // Skip unreadable files (binary, permission denied, etc.).
      }
    }
    return result;
  }

  /**
   * Load an entire repo — all files under `rootDir` that aren't gitignored.
   * Convenience wrapper around `loadDirectory('.', '**\/*')` with sensible
   * defaults (skip node_modules, .git, dist).
   *
   * @param opts - Per-file load options.
   */
  async loadRepo(opts: LoadFileOptions = {}): Promise<Map<string, LoadedFile>> {
    return this.loadDirectory('.', '**/*', opts);
  }

  /**
   * Read a `.gitignore` file (from `dir` and all ancestors up to rootDir)
   * and return an `ignore` instance. Returns an empty-ignore instance if no
   * `.gitignore` is found.
   */
  private loadGitignore(dir: string): ignore.Ignore {
    const ig = ignore();
    let current = dir;
    const root = this.rootDir;
    // Walk up from `dir` to `root`, collecting .gitignore files in reverse
    // order so deeper files override shallower ones (matches git semantics).
    const files: Array<{ path: string; content: string }> = [];
    while (current.startsWith(root) || current === root) {
      const gi = join(current, '.gitignore');
      if (existsSync(gi)) {
        try {
          const content = readFileSync(gi, 'utf-8');
          files.unshift({ path: current, content });
        } catch {
          // skip
        }
      }
      if (current === root) break;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    for (const f of files) {
      ig.add(f.content);
    }
    // Always ignore common build artifacts even if .gitignore omits them.
    ig.add(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);
    return ig;
  }

  /**
   * Resolve a path (relative to rootDir if not absolute).
   */
  private resolve(path: string): string {
    if (isAbsolute(path)) return path;
    return join(this.rootDir, path);
  }
}

// ─── Internal: symbol-block extraction ──────────────────────────────────────

/**
 * Extract the source block defining `symbol` from `source`. Supports
 * function, class, const, let, var, and export-wrapped declarations.
 *
 * Strategy: find the line declaring the symbol via regex, then scan
 * forward tracking brace depth until the block closes.
 *
 * @example
 * ```ts
 * extractSymbolBlock('function foo() { return 1; }', 'foo');
 * // => 'function foo() { return 1; }'
 * ```
 */
export function extractSymbolBlock(source: string, symbol: string): string | null {
  // Escape the symbol for regex use.
  const esc = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match a declaration line. The `(export\s+)?` prefix allows `export
  // function foo`, `export const foo`, etc.
  const pattern = new RegExp(
    `^(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function|class|const|let|var)\\s+${esc}\\b`,
    'm',
  );
  const match = pattern.exec(source);
  if (!match) return null;

  const startIdx = match.index;
  // Find the end of the declaration block by brace-counting.
  let braceDepth = 0;
  let foundOpen = false;
  let endIdx = startIdx;
  for (let i = startIdx; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') {
      braceDepth++;
      foundOpen = true;
    } else if (ch === '}') {
      braceDepth--;
      if (foundOpen && braceDepth === 0) {
        endIdx = i + 1;
        break;
      }
    } else if (ch === ';' && !foundOpen) {
      // const x = 5; — no braces, ends at semicolon.
      endIdx = i + 1;
      break;
    } else if (ch === '\n' && !foundOpen) {
      // Single-line declaration without braces or semicolon (rare).
      endIdx = i;
      break;
    }
  }
  return source.slice(startIdx, endIdx).trim();
}
