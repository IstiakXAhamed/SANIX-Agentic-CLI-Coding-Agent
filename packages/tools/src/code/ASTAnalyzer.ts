/**
 * @file ASTAnalyzer — regex-based symbol extraction for TypeScript,
 * JavaScript, and Python. Skips tree-sitter to avoid native build deps.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  type SanixTool,
  type ToolContext,
  type ToolResult,
  type ToolPermission,
  z,
  resolvePath,
  okResult,
  errResult,
} from '../types.js';

/** Input schema for `analyze_ast`. */
export const AnalyzeAstInputSchema = z.object({
  path: z.string().min(1),
  language: z.enum(['typescript', 'javascript', 'python']).optional(),
});

/** Output schema for `analyze_ast`. */
export const AnalyzeAstOutputSchema = z.object({
  symbols: z.array(
    z.object({
      name: z.string(),
      type: z.enum(['function', 'class', 'method', 'variable', 'import']),
      startLine: z.number().int(),
      endLine: z.number().int(),
    }),
  ),
});

export type AnalyzeAstInput = z.infer<typeof AnalyzeAstInputSchema>;
export type AnalyzeAstOutput = z.infer<typeof AnalyzeAstOutputSchema>;

export type Language = 'typescript' | 'javascript' | 'python';

interface Symbol {
  name: string;
  type: 'function' | 'class' | 'method' | 'variable' | 'import';
  startLine: number;
  endLine: number;
}

/** Map file extension → language. */
function detectLanguage(filePath: string): Language | null {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.ts' || ext === '.tsx') return 'typescript';
  if (ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') return 'javascript';
  if (ext === '.py') return 'python';
  return null;
}

/** Find the line number (1-indexed) of a byte offset. */
function lineOf(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

/** Approximate the end line by scanning for the next dedent / blank line. */
function approxEndLine(lines: string[], startIdx: number, indent: number): number {
  for (let i = startIdx + 1; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.trim() === '') continue;
    const curIndent = ln.length - ln.trimStart().length;
    if (curIndent < indent) return i; // exclusive end → convert to inclusive below
  }
  return lines.length;
}

/** Extract symbols from a TS/JS source string via regex. */
function analyzeJsLike(content: string): Symbol[] {
  const lines = content.split('\n');
  const symbols: Symbol[] = [];

  // Imports.
  const importRe =
    /^\s*(?:import\s+[^;]*?\s+from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]|const\s+\w+\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\))/gm;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(content)) !== null) {
    const name = m[1] ?? m[2] ?? m[3] ?? 'unknown';
    symbols.push({
      name,
      type: 'import',
      startLine: lineOf(content, m.index),
      endLine: lineOf(content, m.index + m[0].length),
    });
  }

  // Functions.
  const funcRe =
    /(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g;
  while ((m = funcRe.exec(content)) !== null) {
    const startLine = lineOf(content, m.index);
    const indent = (lines[startLine - 1] ?? '').length - (lines[startLine - 1] ?? '').trimStart().length;
    const endExclusive = approxEndLine(lines, startLine - 1, indent);
    symbols.push({
      name: m[1],
      type: 'function',
      startLine,
      endLine: Math.max(startLine, endExclusive - 1),
    });
  }

  // Arrow functions assigned to const/let/var.
  const arrowRe =
    /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=\s*(?:async\s*)?\([^)]*\)\s*=>/g;
  while ((m = arrowRe.exec(content)) !== null) {
    const startLine = lineOf(content, m.index);
    const indent = (lines[startLine - 1] ?? '').length - (lines[startLine - 1] ?? '').trimStart().length;
    const endExclusive = approxEndLine(lines, startLine - 1, indent);
    symbols.push({
      name: m[1],
      type: 'function',
      startLine,
      endLine: Math.max(startLine, endExclusive - 1),
    });
  }

  // Classes.
  const classRe =
    /(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g;
  while ((m = classRe.exec(content)) !== null) {
    const startLine = lineOf(content, m.index);
    const indent = (lines[startLine - 1] ?? '').length - (lines[startLine - 1] ?? '').trimStart().length;
    const endExclusive = approxEndLine(lines, startLine - 1, indent);
    symbols.push({
      name: m[1],
      type: 'class',
      startLine,
      endLine: Math.max(startLine, endExclusive - 1),
    });

    // Methods inside this class — scan until endLine.
    const classBody = lines.slice(startLine, endExclusive).join('\n');
    const methodRe =
      /(?:public|private|protected|static|async|readonly|\s)*\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{/g;
    let mm: RegExpExecArray | null;
    while ((mm = methodRe.exec(classBody)) !== null) {
      const methodLine = startLine + lineOf(classBody, mm.index) - 1;
      const methodIndent =
        (lines[methodLine - 1] ?? '').length - (lines[methodLine - 1] ?? '').trimStart().length;
      const methodEnd = approxEndLine(lines, methodLine - 1, methodIndent);
      // Skip constructor-shaped false positives.
      if (mm[1] === 'if' || mm[1] === 'for' || mm[1] === 'while' || mm[1] === 'switch') continue;
      symbols.push({
        name: `${m[1]}.${mm[1]}`,
        type: 'method',
        startLine: methodLine,
        endLine: Math.max(methodLine, methodEnd - 1),
      });
    }
  }

  // Top-level const/let/var declarations (variable type).
  const varRe =
    /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=/gm;
  while ((m = varRe.exec(content)) !== null) {
    const startLine = lineOf(content, m.index);
    // Skip if already captured as arrow function.
    if (symbols.some((s) => s.startLine === startLine && s.type === 'function')) continue;
    symbols.push({
      name: m[1],
      type: 'variable',
      startLine,
      endLine: startLine,
    });
  }

  return symbols.sort((a, b) => a.startLine - b.startLine);
}

/** Extract symbols from a Python source string via regex. */
function analyzePython(content: string): Symbol[] {
  const lines = content.split('\n');
  const symbols: Symbol[] = [];

  // Imports.
  const importRe = /^\s*(?:from\s+([\w.]+)\s+import\s+.*|import\s+([\w.]+))/gm;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(content)) !== null) {
    const name = m[1] ?? m[2] ?? 'unknown';
    const startLine = lineOf(content, m.index);
    symbols.push({
      name,
      type: 'import',
      startLine,
      endLine: startLine,
    });
  }

  // Functions.
  const funcRe = /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/gm;
  while ((m = funcRe.exec(content)) !== null) {
    const startLine = lineOf(content, m.index);
    const indent = (lines[startLine - 1] ?? '').length - (lines[startLine - 1] ?? '').trimStart().length;
    const endExclusive = approxEndLine(lines, startLine - 1, indent + 1);
    symbols.push({
      name: m[1],
      type: 'function',
      startLine,
      endLine: Math.max(startLine, endExclusive - 1),
    });
  }

  // Classes.
  const classRe = /^\s*class\s+([A-Za-z_][\w]*)/gm;
  while ((m = classRe.exec(content)) !== null) {
    const startLine = lineOf(content, m.index);
    const indent = (lines[startLine - 1] ?? '').length - (lines[startLine - 1] ?? '').trimStart().length;
    const endExclusive = approxEndLine(lines, startLine - 1, indent + 1);
    symbols.push({
      name: m[1],
      type: 'class',
      startLine,
      endLine: Math.max(startLine, endExclusive - 1),
    });

    // Methods inside.
    const classBody = lines.slice(startLine, endExclusive).join('\n');
    const methodRe = /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/gm;
    let mm: RegExpExecArray | null;
    while ((mm = methodRe.exec(classBody)) !== null) {
      const methodLine = startLine + lineOf(classBody, mm.index) - 1;
      const methodIndent =
        (lines[methodLine - 1] ?? '').length - (lines[methodLine - 1] ?? '').trimStart().length;
      const methodEnd = approxEndLine(lines, methodLine - 1, methodIndent + 1);
      symbols.push({
        name: `${m[1]}.${mm[1]}`,
        type: 'method',
        startLine: methodLine,
        endLine: Math.max(methodLine, methodEnd - 1),
      });
    }
  }

  // Module-level variable assignments.
  const varRe = /^([A-Za-z_][\w]*)\s*(?::\s*[^=]+)?=/gm;
  while ((m = varRe.exec(content)) !== null) {
    const startLine = lineOf(content, m.index);
    if (symbols.some((s) => s.startLine === startLine)) continue;
    // Skip if the line starts with whitespace (it's a local var).
    if ((lines[startLine - 1] ?? '').startsWith(' ')) continue;
    symbols.push({
      name: m[1],
      type: 'variable',
      startLine,
      endLine: startLine,
    });
  }

  return symbols.sort((a, b) => a.startLine - b.startLine);
}

/**
 * ASTAnalyzerTool — extract symbols from a source file.
 *
 * @example
 * ```ts
 * const res = await new ASTAnalyzerTool().execute(
 *   { path: 'src/index.ts' },
 *   ctx,
 * );
 * ```
 */
export class ASTAnalyzerTool
  implements SanixTool<AnalyzeAstInput, AnalyzeAstOutput>
{
  readonly name = 'analyze_ast';
  readonly description =
    'Extract symbols (functions, classes, methods, variables, imports) from a TypeScript/JavaScript/Python file. Uses regex (not tree-sitter) for portability.';
  readonly inputSchema = AnalyzeAstInputSchema;
  readonly outputSchema = AnalyzeAstOutputSchema;
  readonly permissions: ToolPermission[] = ['filesystem:read'];
  readonly maxTokensInput = 256;
  readonly maxTokensOutput = 8_000;

  async execute(
    input: AnalyzeAstInput,
    context: ToolContext,
  ): Promise<ToolResult<AnalyzeAstOutput>> {
    const start = Date.now();
    const absPath = resolvePath(input.path, context.cwd);
    try {
      const content = await fs.readFile(absPath, 'utf-8');
      const lang = input.language ?? detectLanguage(absPath);
      if (!lang) {
        return errResult<AnalyzeAstOutput>(
          `analyze_ast: cannot detect language for ${path.basename(absPath)}`,
          Date.now() - start,
        );
      }
      const symbols = lang === 'python' ? analyzePython(content) : analyzeJsLike(content);
      return okResult<AnalyzeAstOutput>({ symbols }, Date.now() - start);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errResult<AnalyzeAstOutput>(
        `analyze_ast failed for ${absPath}: ${msg}`,
        Date.now() - start,
      );
    }
  }

  formatForContext(result: AnalyzeAstOutput): string {
    if (result.symbols.length === 0) return '(no symbols found)';
    return result.symbols
      .map(
        (s) =>
          `${s.type.padEnd(8)} ${s.name}  [${s.startLine}-${s.endLine}]`,
      )
      .join('\n');
  }
}

/** Exported for CodeIndexer reuse. */
export function analyzeContent(
  content: string,
  language: Language,
): Symbol[] {
  return language === 'python' ? analyzePython(content) : analyzeJsLike(content);
}

/** Exported for CodeIndexer reuse. */
export { detectLanguage };
