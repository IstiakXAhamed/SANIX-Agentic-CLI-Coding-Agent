/**
 * @file commands/explain.ts
 * @description `sanix explain` — code explainer.
 *
 *   sanix explain <file-path>                  Explain a file
 *   sanix explain <file-path>:<line>           Explain a specific line
 *   sanix explain <directory>                  Explain a directory structure
 *     --depth <n>                              How deep to go (default 2)
 *     --format <text|markdown|json>            Output format
 *     --diagram                                Include a Mermaid diagram
 *
 * For a file:
 *   - Parse the code (regex-based; @sanix/intel is used if available)
 *   - Explain: what the file does, key functions/classes, data flow
 *   - If `--diagram`: generate a Mermaid flowchart
 *
 * For a directory:
 *   - Show the tree structure
 *   - Explain each file's purpose (one line)
 *   - Show dependencies between files
 *
 * For a specific line:
 *   - Show the line + 5 lines of context before/after
 *   - Explain what it does and why
 *
 * @packageDocumentation
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import type { SanixContext } from '../bootstrap.js';

/** Parsed options for `sanix explain`. */
export interface ExplainCommandOptions {
  depth?: number;
  format?: 'text' | 'markdown' | 'json';
  diagram?: boolean;
}

/** Result of explaining a file. */
export interface FileExplanation {
  /** Absolute path of the file. */
  path: string;
  /** One-line summary of what the file does. */
  summary: string;
  /** Detected language (e.g. `typescript`, `python`). */
  language: string;
  /** Top-level functions defined in the file. */
  functions: Array<{ name: string; line: number; signature: string }>;
  /** Top-level classes defined in the file. */
  classes: Array<{ name: string; line: number }>;
  /** Imports / requires the file declares. */
  imports: Array<{ from: string; names: string[] }>;
  /** Approximate line count. */
  lineCount: number;
  /** Mermaid diagram (only if `--diagram` was set). */
  mermaid?: string;
  /** Full multi-paragraph explanation. */
  explanation: string;
}

/** Result of explaining a directory. */
export interface DirectoryExplanation {
  /** Absolute path of the directory. */
  path: string;
  /** Tree of entries (files + subdirs). */
  tree: TreeNode;
  /** One-line explanation per file. */
  files: Array<{ path: string; summary: string }>;
  /** Dependencies between files (best-effort). */
  dependencies: Array<{ from: string; to: string }>;
  /** Mermaid diagram (only if `--diagram` was set). */
  mermaid?: string;
}

/** A node in a directory tree. */
export interface TreeNode {
  name: string;
  type: 'file' | 'dir';
  children?: TreeNode[];
}

/** Result of explaining a specific line. */
export interface LineExplanation {
  /** Absolute path of the file. */
  path: string;
  /** The line number (1-based). */
  line: number;
  /** Surrounding context (5 lines before/after, with line numbers). */
  context: Array<{ line: number; content: string }>;
  /** Explanation of the line. */
  explanation: string;
}

/** Aggregate result. */
export type ExplainResult =
  | { kind: 'file'; data: FileExplanation }
  | { kind: 'directory'; data: DirectoryExplanation }
  | { kind: 'line'; data: LineExplanation };

/** Lazy handle to the @sanix/intel module (optional). */
interface IntelModule {
  // We only use a few methods if available; the rest is structural.
  extractSymbols?: (code: string, lang: string) => unknown;
}

let intelPromise: Promise<IntelModule | null> | null = null;

/** Lazy dynamic-import of @sanix/intel. Returns null if unavailable. */
async function loadIntel(): Promise<IntelModule | null> {
  if (intelPromise) return intelPromise;
  intelPromise = (async () => {
    try {
      const spec = '@sanix/intel';
      const mod = (await import(spec)) as unknown;
      return mod as IntelModule;
    } catch {
      return null;
    }
  })();
  return intelPromise;
}

/** Directories to skip when walking a project tree. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'coverage',
  '.cache', '.turbo', '.venv', '__pycache__', '.pytest_cache',
  'target', 'bin', 'obj',
]);

/** File extensions to skip when walking a project tree. */
const SKIP_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf',
  '.zip', '.tar', '.gz', '.lock', '.woff', '.woff2', '.ttf',
]);

/**
 * Register the `sanix explain` command.
 *
 * @param program     - The Commander root program.
 * @param ctxProvider - Lazy context provider (called on first action).
 */
export function registerExplainCommand(
  program: Command,
  ctxProvider: () => Promise<SanixContext>,
): void {
  program
    .command('explain <target>')
    .description('Explain a file, a specific line, or a directory structure.')
    .option('--depth <n>', 'How deep to walk a directory (default 2)', (v: string) => parseInt(v, 10), 2)
    .option('--format <fmt>', 'Output format (text|markdown|json)', 'text')
    .option('--diagram', 'Include a Mermaid diagram (file/dir only)')
    .action(async (target: string, opts: ExplainCommandOptions) => {
      try {
        const ctx = await ctxProvider();
        const result = await explainCommand(ctx, target, opts);
        printResult(result, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(chalk.red(`\n✗ sanix explain failed: ${msg}\n`));
        process.exitCode = 1;
      }
    });
}

/**
 * Run the `sanix explain` command. Exposed for programmatic use.
 *
 * @param ctx    - The wired SANIX context.
 * @param target - File path, `file:line`, or directory path.
 * @param opts   - Parsed CLI options.
 */
export async function explainCommand(
  ctx: SanixContext,
  target: string,
  opts: ExplainCommandOptions,
): Promise<ExplainResult> {
  const cwd = process.cwd();
  // Detect `file:line` form.
  const lineMatch = target.match(/^(.+):(\d+)$/);
  if (lineMatch && lineMatch[1] && lineMatch[2]) {
    const filePath = resolve(cwd, lineMatch[1]);
    const line = parseInt(lineMatch[2], 10);
    if (existsSync(filePath) && statSync(filePath).isFile()) {
      return { kind: 'line', data: await explainLine(ctx, filePath, line) };
    }
  }
  const abs = resolve(cwd, target);
  if (!existsSync(abs)) {
    throw new Error(`No such file or directory: ${target}`);
  }
  if (statSync(abs).isDirectory()) {
    return {
      kind: 'directory',
      data: await explainDirectory(ctx, abs, opts.depth ?? 2, opts.diagram === true),
    };
  }
  return { kind: 'file', data: await explainFile(ctx, abs, opts.diagram === true) };
}

/** Explain a single file. */
async function explainFile(
  ctx: SanixContext,
  filePath: string,
  diagram: boolean,
): Promise<FileExplanation> {
  const content = readFileSync(filePath, 'utf-8');
  const language = detectLanguage(filePath);
  const functions = extractFunctions(content, language);
  const classes = extractClasses(content, language);
  const imports = extractImports(content, language);
  const lineCount = content.split('\n').length;
  const summary = oneLineSummary(filePath, content, language);
  const explanation = await buildFileExplanation(ctx, filePath, content, language, functions, classes, imports);
  const mermaid = diagram ? buildFileMermaid(filePath, functions, classes, imports) : undefined;
  return {
    path: filePath,
    summary,
    language,
    functions,
    classes,
    imports,
    lineCount,
    mermaid,
    explanation,
  };
}

/** Explain a directory tree. */
async function explainDirectory(
  ctx: SanixContext,
  dirPath: string,
  depth: number,
  diagram: boolean,
): Promise<DirectoryExplanation> {
  const tree = buildTree(dirPath, depth);
  const files: Array<{ path: string; summary: string }> = [];
  const dependencies: Array<{ from: string; to: string }> = [];
  // Walk the tree, collecting file summaries + import edges.
  walkTree(tree, dirPath, (node, abs) => {
    if (node.type !== 'file') return;
    const ext = extname(node.name).toLowerCase();
    if (SKIP_EXTS.has(ext)) return;
    let summary = '(binary or unsupported file)';
    let imports: Array<{ from: string; names: string[] }> = [];
    try {
      const content = readFileSync(abs, 'utf-8');
      const lang = detectLanguage(abs);
      summary = oneLineSummary(abs, content, lang);
      imports = extractImports(content, lang);
    } catch {
      // Keep the default summary.
    }
    const rel = relative(dirPath, abs).split(sep).join('/');
    files.push({ path: rel, summary });
    // Resolve imports to local files (best-effort).
    for (const imp of imports) {
      const resolved = resolveImport(dirPath, abs, imp.from);
      if (resolved) {
        const relTo = relative(dirPath, resolved).split(sep).join('/');
        dependencies.push({ from: rel, to: relTo });
      }
    }
  });
  const mermaid = diagram ? buildDirMermaid(dirPath, files, dependencies) : undefined;
  return { path: dirPath, tree, files, dependencies, mermaid };
}

/** Explain a single line in a file. */
async function explainLine(
  ctx: SanixContext,
  filePath: string,
  line: number,
): Promise<LineExplanation> {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  if (line < 1 || line > lines.length) {
    throw new Error(`Line ${line} out of range (1..${lines.length})`);
  }
  const start = Math.max(0, line - 6);
  const end = Math.min(lines.length, line + 5);
  const context: Array<{ line: number; content: string }> = [];
  for (let i = start; i < end; i++) {
    context.push({ line: i + 1, content: lines[i] ?? '' });
  }
  const targetLine = lines[line - 1] ?? '';
  const explanation = await buildLineExplanation(ctx, filePath, targetLine, line, content);
  return { path: filePath, line, context, explanation };
}

/** Detect a file's language from its extension. */
function detectLanguage(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
    '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
    '.py': 'python',
    '.go': 'go',
    '.rs': 'rust',
    '.java': 'java',
    '.kt': 'kotlin',
    '.rb': 'ruby',
    '.php': 'php',
    '.c': 'c', '.h': 'c',
    '.cpp': 'cpp', '.cc': 'cpp', '.hpp': 'cpp',
    '.cs': 'csharp',
    '.swift': 'swift',
    '.scala': 'scala',
    '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell',
    '.yml': 'yaml', '.yaml': 'yaml',
    '.json': 'json',
    '.md': 'markdown',
    '.sql': 'sql',
  };
  return map[ext] ?? 'text';
}

/** Extract top-level function definitions via regex (multi-language). */
function extractFunctions(
  content: string,
  language: string,
): Array<{ name: string; line: number; signature: string }> {
  const out: Array<{ name: string; line: number; signature: string }> = [];
  const lines = content.split('\n');
  // Patterns per language family.
  const patterns: Array<{ lang: string[]; re: RegExp }> = [
    // JS/TS: `function foo(`, `const foo = (`, `const foo = function`, `export function foo`
    {
      lang: ['typescript', 'javascript'],
      re: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/,
    },
    {
      lang: ['typescript', 'javascript'],
      re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/,
    },
    // Python: `def foo(`
    {
      lang: ['python'],
      re: /^\s*def\s+([A-Za-z_][\w]*)\s*\(([^)]*)\)/,
    },
    // Go: `func foo(`
    {
      lang: ['go'],
      re: /^\s*func\s+(?:\([^)]+\)\s+)?([A-Za-z_][\w]*)\s*\(([^)]*)\)/,
    },
    // Rust: `fn foo(`
    {
      lang: ['rust'],
      re: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)\s*\(([^)]*)\)/,
    },
  ];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const p of patterns) {
      if (!p.lang.includes(language)) continue;
      const m = line.match(p.re);
      if (m && m[1]) {
        out.push({
          name: m[1],
          line: i + 1,
          signature: line.trim(),
        });
        break;
      }
    }
  }
  return out;
}

/** Extract top-level class definitions via regex. */
function extractClasses(content: string, language: string): Array<{ name: string; line: number }> {
  const out: Array<{ name: string; line: number }> = [];
  const lines = content.split('\n');
  const patterns: Array<{ lang: string[]; re: RegExp }> = [
    {
      lang: ['typescript', 'javascript'],
      re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
    },
    {
      lang: ['python'],
      re: /^\s*class\s+([A-Za-z_][\w]*)/,
    },
    {
      lang: ['java', 'kotlin', 'scala', 'csharp'],
      re: /^\s*(?:public|private|protected|abstract|final|open|sealed)?\s*class\s+([A-Za-z_][\w]*)/,
    },
  ];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const p of patterns) {
      if (!p.lang.includes(language)) continue;
      const m = line.match(p.re);
      if (m && m[1]) {
        out.push({ name: m[1], line: i + 1 });
        break;
      }
    }
  }
  return out;
}

/** Extract import/require statements. */
function extractImports(
  content: string,
  language: string,
): Array<{ from: string; names: string[] }> {
  const out: Array<{ from: string; names: string[] }> = [];
  const lines = content.split('\n');
  for (const line of lines) {
    // ES module: `import { a, b } from './x'` or `import x from './x'` or `import './x'`
    if (language === 'typescript' || language === 'javascript') {
      const m = line.match(/^\s*import\s+(?:(\*\s+as\s+[A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*)|(\{[^}]*\}))\s+from\s+['"]([^'"]+)['"]/);
      if (m) {
        const from = m[4]!;
        const names: string[] = [];
        if (m[1]) names.push(m[1].trim());
        if (m[2]) names.push(m[2]);
        if (m[3]) {
          names.push(...m[3].slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean));
        }
        out.push({ from, names });
        continue;
      }
      const bare = line.match(/^\s*import\s+['"]([^'"]+)['"]/);
      if (bare && bare[1]) {
        out.push({ from: bare[1], names: [] });
        continue;
      }
      const req = line.match(/^\s*(?:const|let|var)\s+\{?[^}]+\}?\s*=\s*require\(['"]([^'"]+)['"]\)/);
      if (req && req[1]) {
        out.push({ from: req[1], names: [] });
        continue;
      }
    }
    if (language === 'python') {
      const m1 = line.match(/^\s*from\s+(\S+)\s+import\s+(.+)/);
      if (m1 && m1[1] && m1[2]) {
        out.push({
          from: m1[1],
          names: m1[2].split(',').map((s) => s.trim()).filter(Boolean),
        });
        continue;
      }
      const m2 = line.match(/^\s*import\s+(\S+)/);
      if (m2 && m2[1]) {
        out.push({ from: m2[1], names: [m2[1]] });
        continue;
      }
    }
    if (language === 'go') {
      const m = line.match(/^\s*import\s+"([^"]+)"/);
      if (m && m[1]) {
        out.push({ from: m[1], names: [] });
        continue;
      }
    }
  }
  return out;
}

/** Build a one-line summary of a file from its content. */
function oneLineSummary(filePath: string, content: string, language: string): string {
  const funcs = extractFunctions(content, language);
  const classes = extractClasses(content, language);
  const basename = filePath.split(sep).pop() ?? filePath;
  const parts: string[] = [];
  if (classes.length > 0) {
    parts.push(`defines ${classes.length} class(es): ${classes.slice(0, 3).map((c) => c.name).join(', ')}${classes.length > 3 ? ', …' : ''}`);
  }
  if (funcs.length > 0) {
    parts.push(`${funcs.length} function(s): ${funcs.slice(0, 3).map((f) => f.name).join(', ')}${funcs.length > 3 ? ', …' : ''}`);
  }
  if (parts.length === 0) {
    return `${basename} (${language}, ${content.split('\n').length} lines)`;
  }
  return `${basename} — ${parts.join('; ')}`;
}

/** Use the LLM (if available) to build a multi-paragraph explanation. */
async function buildFileExplanation(
  ctx: SanixContext,
  filePath: string,
  content: string,
  language: string,
  functions: Array<{ name: string; line: number; signature: string }>,
  classes: Array<{ name: string; line: number }>,
  imports: Array<{ from: string; names: string[] }>,
): Promise<string> {
  let providers: unknown[] = [];
  try {
    providers = ctx.router.list();
  } catch {
    providers = [];
  }
  // Static fallback when no LLM.
  const fallback = [
    `**File:** ${filePath}`,
    `**Language:** ${language}`,
    `**Lines:** ${content.split('\n').length}`,
    '',
    `**Functions (${functions.length}):**`,
    functions.length > 0
      ? functions.map((f) => `- \`${f.name}\` (line ${f.line}): \`${f.signature}\``).join('\n')
      : '_(none detected)_',
    '',
    `**Classes (${classes.length}):**`,
    classes.length > 0
      ? classes.map((c) => `- \`${c.name}\` (line ${c.line})`).join('\n')
      : '_(none detected)_',
    '',
    `**Imports (${imports.length}):**`,
    imports.length > 0
      ? imports.map((i) => `- from \`${i.from}\`: ${i.names.length > 0 ? i.names.join(', ') : '(side-effect import)'}`).join('\n')
      : '_(none detected)_',
  ].join('\n');
  if (providers.length === 0) return fallback;
  try {
    const intel = await loadIntel();
    void intel; // we may consult intel here in future
    const res = await ctx.router.route({
      messages: [
        {
          role: 'system',
          content: 'You are a senior software engineer explaining code. Be concise but thorough. Use Markdown headings.',
        },
        {
          role: 'user',
          content: `Explain this ${language} file (${filePath}).

Detected functions: ${functions.map((f) => f.name).join(', ') || '(none)'}
Detected classes: ${classes.map((c) => c.name).join(', ') || '(none)'}
Imports: ${imports.map((i) => i.from).join(', ') || '(none)'}

File content:
\`\`\`${language}
${content.slice(0, 12000)}
\`\`\`

Produce:
1. A one-paragraph summary of what the file does.
2. A bulleted list of the key functions/classes with a one-line description each.
3. A short "Data flow" section describing how inputs become outputs.
4. Any notable side effects, gotchas, or assumptions.`,
        },
      ],
      taskType: 'code',
      maxTokens: 4000,
    });
    return res.content?.trim() || fallback;
  } catch {
    return fallback;
  }
}

/** Build a per-file Mermaid flowchart. */
function buildFileMermaid(
  filePath: string,
  functions: Array<{ name: string; line: number; signature: string }>,
  classes: Array<{ name: string; line: number }>,
  imports: Array<{ from: string; names: string[] }>,
): string {
  const lines: string[] = ['flowchart TD'];
  const fileNode = 'F';
  lines.push(`  ${fileNode}["${filePath.split(sep).pop() ?? filePath}"]`);
  for (const c of classes) {
    const id = `C_${c.name}`;
    lines.push(`  ${id}["class ${c.name}"]`);
    lines.push(`  ${fileNode} --> ${id}`);
  }
  for (const f of functions) {
    const id = `F_${f.name}`;
    lines.push(`  ${id}["fn ${f.name}()"]`);
    lines.push(`  ${fileNode} --> ${id}`);
  }
  for (const imp of imports.slice(0, 10)) {
    const id = `I_${imp.from.replace(/[^A-Za-z0-9]/g, '_')}`;
    lines.push(`  ${id}("${imp.from}")`);
    lines.push(`  ${id} -.-> ${fileNode}`);
  }
  return lines.join('\n');
}

/** Build a per-directory Mermaid dependency diagram. */
function buildDirMermaid(
  dirPath: string,
  files: Array<{ path: string; summary: string }>,
  dependencies: Array<{ from: string; to: string }>,
): string {
  const lines: string[] = ['flowchart LR'];
  const baseName = dirPath.split(sep).pop() ?? dirPath;
  lines.push(`  Root["${baseName}/"]`);
  for (const f of files.slice(0, 50)) {
    const id = 'N_' + f.path.replace(/[^A-Za-z0-9]/g, '_');
    lines.push(`  ${id}["${f.path}"]`);
    lines.push(`  Root --> ${id}`);
  }
  for (const d of dependencies.slice(0, 50)) {
    const fromId = 'N_' + d.from.replace(/[^A-Za-z0-9]/g, '_');
    const toId = 'N_' + d.to.replace(/[^A-Za-z0-9]/g, '_');
    lines.push(`  ${fromId} -.-> ${toId}`);
  }
  return lines.join('\n');
}

/** Build a directory tree (depth-limited). */
function buildTree(dirPath: string, maxDepth: number): TreeNode {
  const name = dirPath.split(sep).pop() ?? dirPath;
  const node: TreeNode = { name, type: 'dir' };
  if (maxDepth <= 0) {
    return node;
  }
  let entries: string[];
  try {
    entries = readdirSync(dirPath).sort();
  } catch {
    return node;
  }
  const children: TreeNode[] = [];
  for (const entry of entries) {
    if (entry.startsWith('.') && entry !== '.github') continue;
    const childPath = join(dirPath, entry);
    let stat;
    try {
      stat = statSync(childPath);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      children.push(buildTree(childPath, maxDepth - 1));
    } else {
      const ext = extname(entry).toLowerCase();
      if (SKIP_EXTS.has(ext)) continue;
      children.push({ name: entry, type: 'file' });
    }
  }
  node.children = children;
  return node;
}

/** Walk a tree, calling `cb` for every node (with its absolute path). */
function walkTree(
  node: TreeNode,
  absPath: string,
  cb: (node: TreeNode, abs: string) => void,
): void {
  cb(node, absPath);
  if (node.type !== 'dir' || !node.children) return;
  for (const child of node.children) {
    walkTree(child, join(absPath, child.name), cb);
  }
}

/** Try to resolve an import path to a local file (best-effort). */
function resolveImport(rootDir: string, fromFile: string, spec: string): string | null {
  // Only relative or alias imports can be resolved locally.
  if (!spec.startsWith('.') && !spec.startsWith('/') && !spec.startsWith('@/')) {
    return null;
  }
  const fromDir = fromFile.split(sep).slice(0, -1).join(sep);
  const candidates: string[] = [];
  if (spec.startsWith('@/')) {
    candidates.push(join(rootDir, spec.slice(2)));
  } else if (spec.startsWith('/')) {
    candidates.push(spec);
  } else {
    candidates.push(resolve(fromDir, spec));
  }
  // Try several extensions.
  const exts = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '/index.ts', '/index.js'];
  for (const c of candidates) {
    for (const ext of exts) {
      const tryPath = c.endsWith(ext) ? c : c + ext;
      if (existsSync(tryPath)) return tryPath;
    }
    if (existsSync(c)) return c;
  }
  return null;
}

/** Use the LLM to explain a single line. */
async function buildLineExplanation(
  ctx: SanixContext,
  filePath: string,
  line: string,
  lineNo: number,
  content: string,
): Promise<string> {
  let providers: unknown[] = [];
  try {
    providers = ctx.router.list();
  } catch {
    providers = [];
  }
  const fallback = `Line ${lineNo} of ${filePath}: \`${line.trim()}\``;
  if (providers.length === 0) return fallback;
  try {
    const res = await ctx.router.route({
      messages: [
        {
          role: 'system',
          content: 'You are a senior software engineer explaining a single line of code. Be concise (2-4 sentences).',
        },
        {
          role: 'user',
          content: `File: ${filePath}
Line ${lineNo}: \`${line}\`

Surrounding context (the file's first 100 lines for context):
\`\`\`
${content.split('\n').slice(0, 100).join('\n')}
\`\`\`

Explain what this specific line does and why. 2-4 sentences max.`,
        },
      ],
      taskType: 'code',
      maxTokens: 500,
    });
    return res.content?.trim() || fallback;
  } catch {
    return fallback;
  }
}

/** Print the explanation result. */
function printResult(result: ExplainResult, opts: ExplainCommandOptions): void {
  if (opts.format === 'json') {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const md = opts.format === 'markdown';
  const h1 = (s: string) => md ? `# ${s}\n` : chalk.hex('#00D4FF')(s + '\n');
  const h2 = (s: string) => md ? `## ${s}\n` : chalk.hex('#FFB347')(s + '\n');
  const code = (s: string) => md ? `\`${s}\`` : chalk.cyan(s);
  if (result.kind === 'file') {
    const f = result.data;
    // eslint-disable-next-line no-console
    console.log(h1(`File: ${f.path}`));
    // eslint-disable-next-line no-console
    console.log(`Language: ${code(f.language)}  •  Lines: ${f.lineCount}\n`);
    // eslint-disable-next-line no-console
    console.log(`Summary: ${f.summary}\n`);
    // eslint-disable-next-line no-console
    console.log(h2('Symbols'));
    if (f.classes.length > 0) {
      // eslint-disable-next-line no-console
      console.log('Classes:');
      for (const c of f.classes) {
        // eslint-disable-next-line no-console
        console.log(`  - ${code(c.name)} (line ${c.line})`);
      }
    }
    if (f.functions.length > 0) {
      // eslint-disable-next-line no-console
      console.log('Functions:');
      for (const fn of f.functions) {
        // eslint-disable-next-line no-console
        console.log(`  - ${code(fn.name)} (line ${fn.line}): ${chalk.dim(fn.signature)}`);
      }
    }
    if (f.imports.length > 0) {
      // eslint-disable-next-line no-console
      console.log(h2('Imports'));
      for (const imp of f.imports) {
        // eslint-disable-next-line no-console
        console.log(`  - ${code(imp.from)}: ${imp.names.length > 0 ? imp.names.join(', ') : '(side-effect)'}`);
      }
    }
    // eslint-disable-next-line no-console
    console.log(h2('Explanation'));
    // eslint-disable-next-line no-console
    console.log(f.explanation + '\n');
    if (f.mermaid) {
      // eslint-disable-next-line no-console
      console.log(h2('Diagram'));
      // eslint-disable-next-line no-console
      console.log('```mermaid');
      // eslint-disable-next-line no-console
      console.log(f.mermaid);
      // eslint-disable-next-line no-console
      console.log('```\n');
    }
    return;
  }
  if (result.kind === 'directory') {
    const d = result.data;
    // eslint-disable-next-line no-console
    console.log(h1(`Directory: ${d.path}`));
    // eslint-disable-next-line no-console
    console.log(h2('Tree'));
    // eslint-disable-next-line no-console
    console.log(renderTree(d.tree, ''));
    // eslint-disable-next-line no-console
    console.log(h2('Files'));
    for (const f of d.files) {
      // eslint-disable-next-line no-console
      console.log(`  ${code(f.path)} — ${f.summary}`);
    }
    if (d.dependencies.length > 0) {
      // eslint-disable-next-line no-console
      console.log(h2('Dependencies'));
      for (const dep of d.dependencies.slice(0, 100)) {
        // eslint-disable-next-line no-console
        console.log(`  ${code(dep.from)} → ${code(dep.to)}`);
      }
      if (d.dependencies.length > 100) {
        // eslint-disable-next-line no-console
        console.log(chalk.dim(`  … (${d.dependencies.length - 100} more)`));
      }
    }
    if (d.mermaid) {
      // eslint-disable-next-line no-console
      console.log(h2('Diagram'));
      // eslint-disable-next-line no-console
      console.log('```mermaid');
      // eslint-disable-next-line no-console
      console.log(d.mermaid);
      // eslint-disable-next-line no-console
      console.log('```\n');
    }
    return;
  }
  // line
  const l = result.data;
  // eslint-disable-next-line no-console
  console.log(h1(`Line ${l.line} of ${l.path}`));
  // eslint-disable-next-line no-console
  console.log(h2('Context'));
  for (const c of l.context) {
    const marker = c.line === l.line ? chalk.hex('#FFB347')('→') : ' ';
    const num = String(c.line).padStart(4, ' ');
    // eslint-disable-next-line no-console
    console.log(`  ${marker} ${chalk.dim(num)}  ${c.content}`);
  }
  // eslint-disable-next-line no-console
  console.log(h2('Explanation'));
  // eslint-disable-next-line no-console
  console.log(l.explanation + '\n');
}

/** Render a tree node as a text tree. */
function renderTree(node: TreeNode, prefix: string): string {
  const lines: string[] = [];
  const name = node.type === 'dir' ? chalk.hex('#00D4FF')(node.name + '/') : node.name;
  lines.push(`${prefix}${name}`);
  if (node.children) {
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i]!;
      const isLast = i === node.children.length - 1;
      const branch = isLast ? '└── ' : '├── ';
      const childPrefix = prefix + (isLast ? '    ' : '│   ');
      const childName = child.type === 'dir' ? chalk.hex('#00D4FF')(child.name + '/') : child.name;
      lines.push(`${prefix}${branch}${childName}`);
      if (child.children && child.children.length > 0) {
        // Recurse, indented under this child.
        const sub = renderTree(child, childPrefix);
        // Strip the child's own name line (already pushed above).
        const subLines = sub.split('\n').slice(1);
        lines.push(...subLines);
      }
    }
  }
  return lines.join('\n');
}
