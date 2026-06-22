/**
 * @file workspace/WorkspaceLoader.ts
 * @description Detect + summarize the user's project so the agent has
 * high-signal context (language, framework, package manager, entry points,
 * test/lint commands, relevant files) on every `sanix run` / `sanix code`
 * invocation.
 *
 * Detection logic (Task A4 / Part 6):
 *
 *   - `package.json`  → TypeScript/JavaScript; package manager inferred
 *     from lockfile (`package-lock.json` → npm, `yarn.lock` → yarn,
 *     `pnpm-lock.yaml` → pnpm); framework inferred from deps
 *     (`next` → next, `react` → react, `express` → express, ...).
 *   - `requirements.txt` / `pyproject.toml` → Python; package manager
 *     inferred from `pyproject.toml` `[tool.poetry]` section.
 *   - `Cargo.toml`     → Rust; package manager `cargo`.
 *   - `go.mod`         → Go; package manager `go`.
 *
 * Relevant-file selection (Task A4 / Part 6):
 *   1. Tokenize the goal into keywords (split on non-word chars, lower-case,
 *      drop stop-words + 3-char words).
 *   2. Walk the project tree (respecting `.gitignore` via the `ignore`
 *      package + a hard-coded blocklist for `node_modules`, `.git`, `dist`,
 *      `build`, etc.).
 *   3. Score each file by:
 *        +2 per keyword that appears in the file name
 *        +1 per keyword that appears in the file content (light grep — read
 *          the first 4 KB only, case-insensitive match).
 *   4. Return the top N files (default 20).
 *
 * Context string (Task A4 / Part 6): a compact, LLM-friendly summary of
 * the workspace, suitable for prepending to the agent's system prompt:
 *
 *   ```
 *   Project: next typescript project using npm.
 *   Entry points: src/app/page.tsx, src/server.ts
 *   Test command: npm test
 *   Lint command: npm run lint
 *   Relevant files:
 *     src/app/page.tsx (124 lines)
 *     src/lib/auth.ts (89 lines)
 *   ```
 *
 * @packageDocumentation
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import ignore from 'ignore';

/** Supported project languages. */
export type ProjectLanguage =
  | 'typescript'
  | 'python'
  | 'rust'
  | 'go'
  | 'mixed'
  | 'unknown';

/** Supported package managers. */
export type PackageManager =
  | 'npm'
  | 'yarn'
  | 'pnpm'
  | 'pip'
  | 'poetry'
  | 'cargo'
  | 'go';

/**
 * A snapshot of the user's project — what it is, how it's built, and which
 * files matter for the current goal.
 */
export interface WorkspaceContext {
  /** Absolute path to the project root. */
  readonly rootPath: string;
  /** Primary language of the project. */
  readonly language: ProjectLanguage;
  /** Package manager in use (inferred from lockfile / project files). */
  readonly packageManager?: PackageManager;
  /** High-level framework id (e.g. 'next', 'react', 'express', 'django'). */
  readonly framework?: string;
  /** Entry-point files (relative to `rootPath`). */
  readonly entryPoints: readonly string[];
  /** Detected test command (e.g. `npm test`, `pytest`, `cargo test`). */
  readonly testCommand?: string;
  /** Detected lint command (e.g. `npm run lint`, `ruff check`). */
  readonly lintCommand?: string;
  /** Files relevant to the current goal (relative to `rootPath`). */
  readonly relevantFiles: readonly string[];
  /** Paths excluded from consideration (gitignore + standard blocklist). */
  readonly ignoredPaths: readonly string[];
}

/** Options accepted by {@link WorkspaceLoader.selectRelevantFiles}. */
export interface SelectRelevantFilesOptions {
  /** Max files to return. Default 20. */
  readonly maxFiles?: number;
  /** Max files to walk (safety guard against huge repos). Default 5000. */
  readonly maxWalk?: number;
  /** Max bytes to read per file for content scoring. Default 4096. */
  readonly contentSampleBytes?: number;
}

/** Options accepted by {@link WorkspaceLoader.buildContextString}. */
export interface BuildContextStringOptions {
  /** Soft cap on the returned string's length (in characters). */
  readonly maxTokens?: number;
}

/** Hard-coded list of directories that are never considered relevant. */
const BLOCKED_DIRS: readonly string[] = [
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  'target',
  '.idea',
  '.vscode',
  'out',
  'bin',
  'obj',
];

/** File extensions considered for relevant-file scoring. */
const RELEVANT_EXTENSIONS: readonly string[] = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.rs',
  '.go',
  '.java',
  '.kt',
  '.swift',
  '.rb',
  '.php',
  '.vue',
  '.svelte',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.md',
  '.css',
  '.scss',
  '.html',
];

/** Common English stop-words filtered out of the goal tokenizer. */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'for',
  'from',
  'has',
  'have',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'so',
  'that',
  'the',
  'this',
  'to',
  'up',
  'with',
  'use',
  'using',
  'into',
  'your',
  'you',
  'i',
  'we',
  'they',
  'them',
  'us',
  'our',
  'their',
  'its',
  'was',
  'were',
  'will',
  'would',
  'should',
  'could',
  'can',
  'do',
  'does',
  'did',
  'how',
  'what',
  'when',
  'where',
  'why',
  'who',
  'which',
  'whom',
  'whose',
  'about',
  'add',
  'make',
  'get',
  'set',
  'run',
  'create',
  'build',
  'fix',
  'update',
  'show',
  'list',
  'all',
  'any',
  'some',
  'no',
  'not',
]);

/**
 * Workspace detection + relevant-file selection.
 *
 * @example
 * ```ts
 * const loader = new WorkspaceLoader();
 * const ws = await loader.detect(process.cwd());
 * const files = await loader.selectRelevantFiles('refactor auth', ws, { maxFiles: 10 });
 * const ctx = await loader.buildContextString({ ...ws, relevantFiles: files }, 2000);
 * ```
 */
export class WorkspaceLoader {
  /**
   * Detect the project structure for `cwd`. Walks the standard set of
   * project files (`package.json`, `pyproject.toml`, etc.) and returns a
   * populated {@link WorkspaceContext}. Always returns a context — on
   * failure (no recognizable files), `language` is `'unknown'` and
   * `entryPoints` / `relevantFiles` are empty arrays.
   *
   * @param cwd - Absolute path to the project root.
   * @returns A populated {@link WorkspaceContext}.
   */
  async detect(cwd: string): Promise<WorkspaceContext> {
    const ignoredPaths = this.collectIgnoredPaths(cwd);

    // Node.js / TypeScript / JavaScript.
    const pkgJsonPath = join(cwd, 'package.json');
    if (existsSync(pkgJsonPath)) {
      return this.detectNode(cwd, ignoredPaths);
    }

    // Python.
    const pyprojectPath = join(cwd, 'pyproject.toml');
    const requirementsPath = join(cwd, 'requirements.txt');
    if (existsSync(pyprojectPath) || existsSync(requirementsPath)) {
      return this.detectPython(cwd, ignoredPaths, existsSync(pyprojectPath));
    }

    // Rust.
    const cargoPath = join(cwd, 'Cargo.toml');
    if (existsSync(cargoPath)) {
      return this.detectRust(cwd, ignoredPaths);
    }

    // Go.
    const goModPath = join(cwd, 'go.mod');
    if (existsSync(goModPath)) {
      return this.detectGo(cwd, ignoredPaths);
    }

    // Unknown project — return a minimal context.
    return {
      rootPath: cwd,
      language: 'unknown',
      entryPoints: [],
      relevantFiles: [],
      ignoredPaths,
    };
  }

  /**
   * Select the files most relevant to `goal` from `ws`. See the file-level
   * docstring for the scoring heuristic.
   *
   * @param goal     - The user's high-level goal.
   * @param ws       - The detected workspace context.
   * @param maxFiles - Maximum files to return (default 20).
   * @returns An array of project-relative paths, sorted by relevance.
   */
  async selectRelevantFiles(
    goal: string,
    ws: WorkspaceContext,
    maxFiles: number,
  ): Promise<string[]>;
  /** @internal Variant accepting an options object. */
  async selectRelevantFiles(
    goal: string,
    ws: WorkspaceContext,
    opts: SelectRelevantFilesOptions,
  ): Promise<string[]>;
  async selectRelevantFiles(
    goal: string,
    ws: WorkspaceContext,
    maxFilesOrOpts: number | SelectRelevantFilesOptions = 20,
  ): Promise<string[]> {
    const opts: SelectRelevantFilesOptions =
      typeof maxFilesOrOpts === 'number'
        ? { maxFiles: maxFilesOrOpts }
        : maxFilesOrOpts;
    const maxFiles = opts.maxFiles ?? 20;
    const maxWalk = opts.maxWalk ?? 5000;
    const sampleBytes = opts.contentSampleBytes ?? 4096;

    const keywords = this.tokenize(goal);
    if (keywords.length === 0) return [];

    const ig = this.loadGitignore(ws.rootPath);
    const scored: Array<{ path: string; score: number }> = [];
    let walked = 0;

    this.walk(
      ws.rootPath,
      (absPath) => {
        if (walked >= maxWalk) return false;
        walked++;
        const rel = relative(ws.rootPath, absPath).split(sep).join('/');
        if (this.isBlocked(rel)) return;
        if (ig.ignores(rel)) return;
        const ext = rel.slice(rel.lastIndexOf('.'));
        if (!RELEVANT_EXTENSIONS.includes(ext)) return;

        let score = 0;
        const base = basename(rel).toLowerCase();
        for (const kw of keywords) {
          if (base.includes(kw)) score += 2;
        }

        // Light content grep — read first 4 KB only.
        try {
          const buf = readFileSync(absPath);
          const text = buf.subarray(0, sampleBytes).toString('utf-8').toLowerCase();
          for (const kw of keywords) {
            if (text.includes(kw)) score += 1;
          }
        } catch {
          // Binary / unreadable — skip content scoring.
        }

        if (score > 0) {
          scored.push({ path: rel, score });
        }
        return true;
      },
    );

    scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    return scored.slice(0, maxFiles).map((s) => s.path);
  }

  /**
   * Build a compact, LLM-friendly string describing the workspace. Suitable
   * for prepending to the agent's system prompt or first user message.
   *
   * @param ws        - The detected workspace (with `relevantFiles` populated).
   * @param maxTokens - Soft cap on the returned string's length (chars).
   * @returns A multi-line summary string.
   */
  async buildContextString(
    ws: WorkspaceContext,
    maxTokens: number = 2000,
  ): Promise<string> {
    const lines: string[] = [];
    const parts: string[] = [];
    if (ws.framework) parts.push(ws.framework);
    if (ws.language !== 'unknown') parts.push(ws.language);
    parts.push('project');
    if (ws.packageManager) parts.push(`using ${ws.packageManager}`);
    lines.push(`Project: ${parts.join(' ')}.`);

    if (ws.entryPoints.length > 0) {
      lines.push(`Entry points: ${ws.entryPoints.join(', ')}`);
    }
    if (ws.testCommand) {
      lines.push(`Test command: ${ws.testCommand}`);
    }
    if (ws.lintCommand) {
      lines.push(`Lint command: ${ws.lintCommand}`);
    }

    if (ws.relevantFiles.length > 0) {
      lines.push('Relevant files:');
      let budget = maxTokens - lines.join('\n').length - 100;
      for (const rel of ws.relevantFiles) {
        const abs = join(ws.rootPath, rel);
        let lineCount = 0;
        try {
          const text = readFileSync(abs, 'utf-8');
          lineCount = text.split('\n').length;
        } catch {
          // Unreadable — skip line count.
        }
        const entry = `  ${rel} (${lineCount} lines)`;
        if (budget < entry.length + 1) break;
        lines.push(entry);
        budget -= entry.length + 1;
      }
    }

    return lines.join('\n');
  }

  // ─── Per-language detectors ────────────────────────────────────────────

  /** Node.js / TypeScript / JavaScript project detection. */
  private detectNode(
    cwd: string,
    ignoredPaths: readonly string[],
  ): WorkspaceContext {
    const pkgJsonPath = join(cwd, 'package.json');
    let pkg: Record<string, unknown> = {};
    try {
      pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      // Malformed package.json — fall through with empty record.
    }

    const allDeps: Record<string, string> = {
      ...((pkg.dependencies as Record<string, string>) ?? {}),
      ...((pkg.devDependencies as Record<string, string>) ?? {}),
    };

    const framework = this.detectFramework(allDeps);
    const packageManager = this.detectNodePackageManager(cwd);
    const language: ProjectLanguage = this.detectNodeLanguage(cwd, allDeps);

    const entryPoints = this.detectNodeEntryPoints(cwd, pkg);
    const testCommand = this.detectNodeScript(pkg, ['test', 'test:unit']);
    const lintCommand = this.detectNodeScript(pkg, ['lint', 'eslint']);

    return {
      rootPath: cwd,
      language,
      packageManager,
      framework,
      entryPoints,
      testCommand: testCommand ? `${packageManager ?? 'npm'} ${testCommand}` : undefined,
      lintCommand: lintCommand ? `${packageManager ?? 'npm'} run ${lintCommand}` : undefined,
      relevantFiles: [],
      ignoredPaths,
    };
  }

  /** Python project detection. */
  private detectPython(
    cwd: string,
    ignoredPaths: readonly string[],
    hasPyproject: boolean,
  ): WorkspaceContext {
    let isPoetry = false;
    let framework: string | undefined;

    if (hasPyproject) {
      try {
        const text = readFileSync(join(cwd, 'pyproject.toml'), 'utf-8');
        if (/\[tool\.poetry\]/.test(text)) isPoetry = true;
        if (/django/i.test(text)) framework = 'django';
        else if (/fastapi/i.test(text)) framework = 'fastapi';
        else if (/flask/i.test(text)) framework = 'flask';
      } catch {
        // Unreadable — skip.
      }
    }

    const packageManager: PackageManager = isPoetry ? 'poetry' : 'pip';
    const entryPoints = this.detectPythonEntryPoints(cwd);

    return {
      rootPath: cwd,
      language: 'python',
      packageManager,
      framework,
      entryPoints,
      testCommand: isPoetry ? 'poetry run pytest' : 'pytest',
      lintCommand: isPoetry ? 'poetry run ruff check' : 'ruff check',
      relevantFiles: [],
      ignoredPaths,
    };
  }

  /** Rust project detection. */
  private detectRust(
    cwd: string,
    ignoredPaths: readonly string[],
  ): WorkspaceContext {
    let framework: string | undefined;
    try {
      const text = readFileSync(join(cwd, 'Cargo.toml'), 'utf-8');
      if (/axum/i.test(text)) framework = 'axum';
      else if (/actix/i.test(text)) framework = 'actix';
      else if (/tokio/i.test(text)) framework = 'tokio';
      else if (/rocket/i.test(text)) framework = 'rocket';
    } catch {
      // Unreadable — skip.
    }
    return {
      rootPath: cwd,
      language: 'rust',
      packageManager: 'cargo',
      framework,
      entryPoints: this.existsOrDefault(
        [join(cwd, 'src/main.rs'), join(cwd, 'src/lib.rs')],
      ).map((p) => relative(cwd, p).split(sep).join('/')),
      testCommand: 'cargo test',
      lintCommand: 'cargo clippy',
      relevantFiles: [],
      ignoredPaths,
    };
  }

  /** Go project detection. */
  private detectGo(
    cwd: string,
    ignoredPaths: readonly string[],
  ): WorkspaceContext {
    return {
      rootPath: cwd,
      language: 'go',
      packageManager: 'go',
      entryPoints: this.existsOrDefault([join(cwd, 'main.go')]).map((p) =>
        relative(cwd, p).split(sep).join('/'),
      ),
      testCommand: 'go test ./...',
      relevantFiles: [],
      ignoredPaths,
    };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  /**
   * Tokenize a free-text goal into keyword tokens. Splits on non-word
   * chars, lower-cases, drops stop-words and tokens shorter than 3 chars,
   * and de-duplicates (preserving first-seen order).
   */
  private tokenize(goal: string): string[] {
    const raw = goal
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
    const seen = new Set<string>();
    const out: string[] = [];
    for (const t of raw) {
      if (!seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
    }
    return out;
  }

  /** Walk a directory tree breadth-first, invoking `cb` on each file. */
  private walk(
    root: string,
    cb: (absPath: string) => boolean | void,
  ): void {
    // Use spawnSync('find') for portability + speed — avoids a hand-rolled
    // recursive walker that would be O(N) on Node's slow `fs.readdirSync`.
    // Falls back to a no-op if `find` is unavailable.
    const result = spawnSync('find', [
      root,
      '-type', 'f',
      '-not', '-path', '*/.git/*',
      '-not', '-path', '*/node_modules/*',
    ], {
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf-8',
    });
    if (result.error || result.status !== 0) return;
    const files = (result.stdout ?? '').split('\n').filter(Boolean);
    for (const absPath of files) {
      if (cb(absPath) === false) break;
    }
  }

  /** Load `.gitignore` (if present) into an `ignore` instance. */
  private loadGitignore(root: string): ReturnType<typeof ignore> {
    const ig = ignore();
    const gitignorePath = join(root, '.gitignore');
    if (existsSync(gitignorePath)) {
      try {
        ig.add(readFileSync(gitignorePath, 'utf-8'));
      } catch {
        // Unreadable — skip.
      }
    }
    return ig;
  }

  /** True when a relative path falls into a blocked directory. */
  private isBlocked(rel: string): boolean {
    const parts = rel.split('/');
    return parts.some((p) => BLOCKED_DIRS.includes(p));
  }

  /** Collect all ignored paths (gitignore + standard blocklist). */
  private collectIgnoredPaths(root: string): string[] {
    const out: string[] = [...BLOCKED_DIRS];
    const gitignorePath = join(root, '.gitignore');
    if (existsSync(gitignorePath)) {
      try {
        const text = readFileSync(gitignorePath, 'utf-8');
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith('#')) out.push(trimmed);
        }
      } catch {
        // Unreadable — skip.
      }
    }
    return out;
  }

  /** Detect the framework from a `package.json` dependencies map. */
  private detectFramework(deps: Record<string, string>): string | undefined {
    if (deps['next']) return 'next';
    if (deps['nuxt']) return 'nuxt';
    if (deps['@remix-run/node'] || deps['@remix-run/react']) return 'remix';
    if (deps['sveltekit'] || deps['@sveltejs/kit']) return 'sveltekit';
    if (deps['react']) return 'react';
    if (deps['vue']) return 'vue';
    if (deps['express']) return 'express';
    if (deps['fastify']) return 'fastify';
    if (deps['koa']) return 'koa';
    if (deps['nest'] || deps['@nestjs/core']) return 'nestjs';
    if (deps['hapi'] || deps['@hapi/hapi']) return 'hapi';
    return undefined;
  }

  /** Detect the Node package manager from the lockfile present. */
  private detectNodePackageManager(cwd: string): PackageManager {
    if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
    if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn';
    return 'npm';
  }

  /**
   * Detect the language: TypeScript if any `.ts`/`.tsx` file exists OR
   * `typescript` is a devDependency; else JavaScript.
   */
  private detectNodeLanguage(
    cwd: string,
    deps: Record<string, string>,
  ): ProjectLanguage {
    if (deps['typescript']) return 'typescript';
    // Heuristic: presence of a `tsconfig.json` → typescript.
    if (existsSync(join(cwd, 'tsconfig.json'))) return 'typescript';
    // Walk the top-level `src` for any `.ts`/`.tsx` file.
    try {
      const srcDir = join(cwd, 'src');
      if (existsSync(srcDir)) {
        const stat = statSync(srcDir);
        if (stat.isDirectory()) {
          // Use `find` for one-shot detection (cheap).
          const result = spawnSync('find', [
            srcDir,
            '-maxdepth', '3',
            '-name', '*.ts',
            '-o',
            '-name', '*.tsx',
          ], { encoding: 'utf-8' });
          if (result.stdout && result.stdout.trim().length > 0) {
            return 'typescript';
          }
        }
      }
    } catch {
      // Skip.
    }
    return 'typescript'; // default for any package.json project
  }

  /** Detect entry-point files for a Node project (relative paths). */
  private detectNodeEntryPoints(
    cwd: string,
    pkg: Record<string, unknown>,
  ): string[] {
    const candidates: string[] = [];
    const main = typeof pkg.main === 'string' ? pkg.main : undefined;
    if (main) candidates.push(main);
    const module = typeof pkg.module === 'string' ? pkg.module : undefined;
    if (module) candidates.push(module);
    // Common Next.js / Remix entry points.
    for (const guess of [
      'src/app/page.tsx',
      'src/app/layout.tsx',
      'app/page.tsx',
      'app/layout.tsx',
      'pages/index.tsx',
      'pages/_app.tsx',
      'src/index.ts',
      'src/main.ts',
      'src/server.ts',
      'src/index.tsx',
      'src/main.tsx',
      'index.ts',
      'main.ts',
      'server.ts',
    ]) {
      const abs = join(cwd, guess);
      if (existsSync(abs) && !candidates.includes(guess)) {
        candidates.push(guess);
      }
    }
    // De-duplicate + filter to existing files.
    const seen = new Set<string>();
    const out: string[] = [];
    for (const c of candidates) {
      if (seen.has(c)) continue;
      seen.add(c);
      if (existsSync(join(cwd, c))) out.push(c);
    }
    return out.slice(0, 8);
  }

  /** Return the first `scripts` key from a list of candidates. */
  private detectNodeScript(
    pkg: Record<string, unknown>,
    candidates: readonly string[],
  ): string | undefined {
    const scripts = (pkg.scripts as Record<string, string> | undefined) ?? {};
    for (const c of candidates) {
      if (scripts[c]) return c;
    }
    return undefined;
  }

  /** Detect entry-point files for a Python project (relative paths). */
  private detectPythonEntryPoints(cwd: string): string[] {
    const guesses = [
      'main.py',
      'app.py',
      'manage.py',
      'src/main.py',
      'src/app.py',
      'app/main.py',
      'app/__main__.py',
    ];
    const out: string[] = [];
    for (const g of guesses) {
      if (existsSync(join(cwd, g))) out.push(g);
    }
    return out.slice(0, 4);
  }

  /** Return only the paths that exist on disk. */
  private existsOrDefault(paths: readonly string[]): string[] {
    return paths.filter((p) => existsSync(p));
  }
}
