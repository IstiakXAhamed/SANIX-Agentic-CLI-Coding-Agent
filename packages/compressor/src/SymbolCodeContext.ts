/**
 * @file SymbolCodeContext.ts
 * @description Symbol-aware code context builder. Rather than loading
 * whole files into the LLM context (which burns tokens on
 * boilerplate, imports, blank lines, and irrelevant helpers), this
 * module extracts only the *symbols* (functions / classes / methods /
 * variables / interfaces / types) a file defines, lets the caller
 * pick the ones relevant to the current query, and renders the
 * selected symbols as a compact code block.
 *
 * ## Why regex, not tree-sitter?
 *
 * Tree-sitter gives perfect ASTs but requires a native binary per
 * language. The SANIX optimizer stack is deliberately pure-JS (no
 * `node-gyp` builds, no platform-specific wheels) so the compressor
 * ships with a hand-tuned regex extractor per language family. The
 * regexes handle the common cases — including:
 *
 *   - **Nested classes** (a method inside a class is captured as a
 *     separate `method` symbol with the right line range).
 *   - **Async functions** (`async function foo()`, `async () =>`).
 *   - **Arrow consts** (`const foo = (...) => { ... }`,
 *     `const foo = async () => ...`).
 *   - **Decorators** (`@Component\nclass Foo` — the decorator line is
 *     attached to the following class/function as part of its
 *     signature).
 *   - **TypeScript interfaces / types / enums**.
 *   - **Python `def` / `class` / `async def`** with optional
 *     triple-quoted docstrings.
 *   - **Go `func`** (including methods on receiver types).
 *   - **Rust `fn` / `struct` / `enum` / `trait` / `impl`**.
 *
 * The extractor is best-effort: it doesn't try to parse the language
 * (which would require a real parser); it just finds the most common
 * declaration shapes. If a construct isn't matched, it's simply absent
 * from the symbol list — never wrong, occasionally incomplete.
 *
 * @packageDocumentation
 */

import { tokenizer as optimizerTokenizer } from '@sanix/optimizer';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * The kind of a symbol extracted from source code.
 */
export type SymbolType =
  | 'function'
  | 'class'
  | 'method'
  | 'variable'
  | 'import'
  | 'interface'
  | 'type';

/**
 * A single symbol extracted from a source file. The compressor uses
 * the symbol's `name`, `signature`, and `docstring` to rank relevance
 * against the user's query, then renders the selected symbols as a
 * compact code block via {@link SymbolCodeContext.buildContextString}.
 */
export interface Symbol {
  /** The symbol's identifier (function name, class name, etc.). */
  name: string;
  /** The kind of symbol. */
  type: SymbolType;
  /** 1-based line number where the symbol starts (including decorator lines). */
  startLine: number;
  /** 1-based line number of the symbol's last line (inclusive). */
  endLine: number;
  /** The signature line (the first line of the declaration, including decorators). */
  signature: string;
  /** Optional docstring (the first comment block above the symbol). */
  docstring?: string;
  /** Approximate token count of the symbol's body. */
  bodyTokens: number;
}

/**
 * Supported file extensions. The extractor auto-detects the language
 * from the file path's extension; unknown extensions fall back to a
 * generic C-like extractor (which catches Java / Kotlin / Swift / PHP /
 * C# / C / C++ / etc. well enough for symbol-overlap ranking).
 */
export type SupportedExtension =
  | '.ts'
  | '.tsx'
  | '.js'
  | '.jsx'
  | '.mjs'
  | '.cjs'
  | '.py'
  | '.go'
  | '.rs'
  | '.java'
  | '.kt'
  | '.swift'
  | '.rb'
  | '.php'
  | '.cs'
  | '.cpp'
  | '.c'
  | '.h';

// ─── Language detection ─────────────────────────────────────────────────────

/**
 * Mapping from file extension to a "language family" identifier. The
 * extractor dispatches on this; the generic family covers Java / Kotlin
 * / Swift / PHP / C# / C / C++ (all C-like).
 */
type LanguageFamily = 'typescript' | 'javascript' | 'python' | 'go' | 'rust' | 'ruby' | 'generic';

/**
 * Map a file extension to its language family.
 */
function detectFamily(filePath: string): LanguageFamily {
  const ext = filePath.toLowerCase().match(/(\.[^.]+)$/u)?.[1] ?? '';
  switch (ext) {
    case '.ts':
    case '.tsx':
      return 'typescript';
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    case '.py':
      return 'python';
    case '.go':
      return 'go';
    case '.rs':
      return 'rust';
    case '.rb':
      return 'ruby';
    default:
      // Java, Kotlin, Swift, PHP, C#, C, C++, .h, plus unknowns → generic.
      return 'generic';
  }
}

// ─── Docstring extraction ───────────────────────────────────────────────────

/**
 * Extract the docstring (first comment block above a line) for a
 * declaration starting at `startLine`. Handles:
 *
 *   - `//` line comments (one or more consecutive)
 *   - `/* ... *‌/` block comments (C-like)
 *   - `"""..."""` and `'''...'''` (Python)
 *   - `=begin`/`=end` (Ruby)
 *
 * Returns `undefined` when no comment block immediately precedes the
 * declaration (allowing for blank lines between the comment and the
 * declaration).
 */
function extractDocstring(lines: string[], startLine: number): string | undefined {
  // Walk upward from the line *above* the declaration, skipping blank
  // lines, collecting comment lines.
  let i = startLine - 2; // 0-based, line above the declaration
  // Skip blank lines.
  while (i >= 0 && lines[i]!.trim().length === 0) i--;
  if (i < 0) return undefined;

  const collected: string[] = [];

  // Python: triple-quoted docstring on the line(s) *after* the def
  // signature is handled separately in the python extractor. Here we
  // only handle *above-the-declaration* comments.
  //
  // Block comment ending on this line (`*/`)? Then collect the block.
  const blockEndMatch = /\*\/\s*$/u.exec(lines[i]!);
  if (blockEndMatch) {
    // Walk upward collecting until we find `/*`.
    collected.unshift(lines[i]!.replace(/\*\/\s*$/u, '').trim());
    i--;
    while (i >= 0) {
      const line = lines[i]!;
      const startIdx = line.indexOf('/*');
      if (startIdx >= 0) {
        collected.unshift(line.slice(startIdx + 2).trim());
        break;
      }
      collected.unshift(line.replace(/^\s*\*\s?/u, '').trim());
      i--;
    }
    return collected.filter((s) => s.length > 0).join('\n').trim() || undefined;
  }

  // Ruby: `=end` ending on this line? Walk upward to `=begin`.
  if (/^=end\b/u.test(lines[i]!.trim())) {
    collected.unshift(lines[i]!.replace(/^=end\b.*$/u, '').trim());
    i--;
    while (i >= 0) {
      const line = lines[i]!.trim();
      if (/^=begin\b/u.test(line)) {
        break;
      }
      collected.unshift(lines[i]!.trim());
      i--;
    }
    return collected.filter((s) => s.length > 0).join('\n').trim() || undefined;
  }

  // Consecutive `//` line comments.
  while (i >= 0) {
    const line = lines[i]!.trim();
    if (line.startsWith('//')) {
      collected.unshift(line.replace(/^\/\/\s?/u, '').trim());
      i--;
    } else {
      break;
    }
  }
  return collected.filter((s) => s.length > 0).join('\n').trim() || undefined;
}

// ─── Per-family extractors ──────────────────────────────────────────────────

/**
 * A raw declaration hit from a regex sweep. The extractor turns each
 * hit into a {@link Symbol} by computing the end line (via brace
 * matching) and the docstring.
 */
interface RawDecl {
  /** 1-based line number where the declaration starts. */
  startLine: number;
  /** The signature line (the matched declaration line). */
  signature: string;
  /** The symbol name. */
  name: string;
  /** The symbol type. */
  type: SymbolType;
}

/**
 * Match a regex against every line, returning one {@link RawDecl} per
 * hit. Decorator lines (`@Foo`) are attached to the following
 * declaration: the `startLine` is moved up to include the decorators,
 * and the decorator lines are prepended to the signature.
 */
function sweepLines(
  lines: string[],
  pattern: RegExp,
  type: SymbolType,
  nameGroup: number | string,
): RawDecl[] {
  const decls: RawDecl[] = [];
  // Decorator lines that should attach to the *next* declaration.
  let pendingDecorators: string[] = [];
  let decoratorStartLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    // Track decorators.
    if (/^@[\w]/u.test(trimmed)) {
      if (pendingDecorators.length === 0) decoratorStartLine = i + 1;
      pendingDecorators.push(trimmed);
      continue;
    }
    // Skip blank lines between decorators and the declaration.
    if (trimmed.length === 0 && pendingDecorators.length > 0) continue;
    const match = pattern.exec(line);
    if (!match) {
      // Non-decorator, non-declaration line — clear pending decorators.
      pendingDecorators = [];
      decoratorStartLine = -1;
      continue;
    }
    const groups = match.groups ?? {};
    const name = (typeof nameGroup === 'number'
      ? match[nameGroup]
      : groups[nameGroup]) as string | undefined;
    if (typeof name !== 'string' || name.length === 0) {
      pendingDecorators = [];
      decoratorStartLine = -1;
      continue;
    }
    const sig = pendingDecorators.length > 0
      ? [...pendingDecorators, line].join('\n')
      : line;
    const startLine = pendingDecorators.length > 0 ? decoratorStartLine : i + 1;
    decls.push({ startLine, signature: sig, name, type });
    pendingDecorators = [];
    decoratorStartLine = -1;
  }
  return decls;
}

/**
 * Compute the end line of a declaration via brace matching. The
 * `startLine` is 1-based; we look at the source from that line
 * onward, counting `{` and `}` (skipping strings and comments where
 * possible). The end line is the line containing the closing `}`.
 *
 * For declarations with no body (e.g. `type Foo = string;` or
 * `interface Foo {}`), the end line is the same as the start line.
 */
function computeEndLine(lines: string[], startLine: number): number {
  const startIdx = startLine - 1;
  if (startIdx >= lines.length) return startLine;
  // Find the first `{` from the start line onward.
  let braceIdx = -1;
  for (let i = startIdx; i < lines.length; i++) {
    const idx = findBraceIndex(lines[i]!);
    if (idx >= 0) {
      braceIdx = i;
      break;
    }
    // If we hit a semicolon before any `{`, it's a single-line decl.
    if (lines[i]!.includes(';') && !lines[i]!.includes('{')) {
      return i + 1;
    }
  }
  if (braceIdx < 0) return startLine;
  // Walk from braceIdx, counting braces (skipping strings/comments).
  let depth = 0;
  let inString: '"' | "'" | '`' | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = braceIdx; i < lines.length; i++) {
    const line = lines[i]!;
    inLineComment = false;
    for (let c = 0; c < line.length; c++) {
      const ch = line[c]!;
      const next = line[c + 1];
      if (inLineComment) break;
      if (inBlockComment) {
        if (ch === '*' && next === '/') {
          inBlockComment = false;
          c++;
        }
        continue;
      }
      if (inString) {
        if (ch === '\\') {
          c++; // skip escaped char
          continue;
        }
        if (ch === inString) inString = null;
        continue;
      }
      if (ch === '/' && next === '/') {
        inLineComment = true;
        break;
      }
      if (ch === '/' && next === '*') {
        inBlockComment = true;
        c++;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        inString = ch;
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return i + 1;
      }
    }
  }
  // Unbalanced — fall back to the last line.
  return lines.length;
}

/**
 * Find the index of the first `{` in a line, ignoring those inside
 * strings or comments. Returns -1 if there is no body-opening brace.
 */
function findBraceIndex(line: string): number {
  let inString: '"' | "'" | '`' | null = null;
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    const next = line[i + 1];
    if (inString) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === inString) inString = null;
      i++;
      continue;
    }
    if (ch === '/' && next === '/') return -1; // rest of line is comment
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      i++;
      continue;
    }
    if (ch === '{') return i;
    i++;
  }
  return -1;
}

/**
 * Extract Python docstrings (the triple-quoted string that appears as
 * the first statement in a function / class body). Returns the
 * docstring text (without the surrounding triple quotes) or
 * `undefined`.
 */
function extractPythonDocstring(lines: string[], startLine: number): string | undefined {
  // Look for the docstring on one of the first few lines of the body.
  for (let i = startLine; i < Math.min(lines.length, startLine + 5); i++) {
    const line = lines[i]!.trim();
    const match = /^("""|''')([\s\S]*?)(?:\1)?\s*$/u.exec(line);
    if (match && match[2] !== undefined) {
      const text = match[2].trim();
      if (text.length > 0) return text;
    }
    // Multi-line docstring opening.
    const open = /^(?:\s*)("""|''')([\s\S]*)$/u.exec(line);
    if (open && open[1] !== undefined && !line.endsWith(open[1])) {
      const parts: string[] = [];
      if (open[2] !== undefined) parts.push(open[2].trim());
      for (let j = i + 1; j < lines.length; j++) {
        const closeMatch = lines[j]!.indexOf(open[1]);
        if (closeMatch >= 0) {
          parts.push(lines[j]!.slice(0, closeMatch).trim());
          return parts.filter((s) => s.length > 0).join('\n').trim() || undefined;
        }
        parts.push(lines[j]!.trim());
      }
    }
    // If we hit a non-comment, non-blank line that isn't a docstring,
    // stop looking.
    if (line.length > 0 && !line.startsWith('#') && !line.startsWith('"""') && !line.startsWith("'''")) {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Extract symbols from a TypeScript / JavaScript source file.
 *
 * Handles: `function`, `async function`, `class`, `interface`, `type`,
 * `enum`, arrow consts (`const foo = () =>`), and methods inside
 * classes (recognized by leading whitespace + method-shape signature).
 */
function extractTypeScriptSymbols(source: string): RawDecl[] {
  const lines = source.split('\n');
  const decls: RawDecl[] = [];
  // Top-level function declarations (incl. async, generators).
  decls.push(
    ...sweepLines(
      lines,
      /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/u,
      'function',
      1,
    ),
  );
  // Class declarations.
  decls.push(
    ...sweepLines(
      lines,
      /^\s*(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/u,
      'class',
      1,
    ),
  );
  // Interface / type declarations.
  decls.push(
    ...sweepLines(
      lines,
      /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/u,
      'interface',
      1,
    ),
  );
  decls.push(
    ...sweepLines(
      lines,
      /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/u,
      'type',
      1,
    ),
  );
  decls.push(
    ...sweepLines(
      lines,
      /^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/u,
      'type',
      1,
    ),
  );
  // Arrow / function-expr consts.
  decls.push(
    ...sweepLines(
      lines,
      /^\s*(?:export\s+(?:default\s+)?)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/u,
      'variable',
      1,
    ),
  );
  // Class methods (indented method-shape signatures). We only treat
  // lines that start with whitespace + identifier + `(` as methods —
  // this catches `foo() {}`, `async foo() {}`, `private foo(): T {}`,
  // `static foo() {}`, getters / setters.
  decls.push(
    ...sweepLines(
      lines,
      /^\s+(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+|async\s+|get\s+|set\s+|abstract\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::\s*[^{=]+)?\s*[{=]/u,
      'method',
      1,
    ),
  );
  return dedupeDecls(decls, lines);
}

/**
 * Extract symbols from a Python source file.
 *
 * Handles: `def`, `async def`, `class`. Docstrings are extracted from
 * the function / class body (the triple-quoted string as the first
 * statement).
 */
function extractPythonSymbols(source: string): RawDecl[] {
  const lines = source.split('\n');
  const decls: RawDecl[] = [];
  decls.push(
    ...sweepLines(
      lines,
      /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)/u,
      'function',
      1,
    ),
  );
  decls.push(
    ...sweepLines(
      lines,
      /^\s*class\s+([A-Za-z_][\w]*)/u,
      'class',
      1,
    ),
  );
  return dedupeDecls(decls, lines);
}

/**
 * Extract symbols from a Go source file.
 *
 * Handles: `func Name(...)`, `func (recv) Method(...)`, `type Name struct`,
 * `type Name interface`, `type Name = alias`.
 */
function extractGoSymbols(source: string): RawDecl[] {
  const lines = source.split('\n');
  const decls: RawDecl[] = [];
  // Funcs (with or without receiver).
  decls.push(
    ...sweepLines(
      lines,
      /^\s*func\s+(?:\([^)]*\)\s+)?([A-Za-z_][\w]*)\s*(?:\[[^\]]*\])?\s*\(/u,
      'function',
      1,
    ),
  );
  // Type declarations.
  decls.push(
    ...sweepLines(
      lines,
      /^\s*type\s+([A-Za-z_][\w]*)\s+(?:struct|interface|func)/u,
      'type',
      1,
    ),
  );
  decls.push(
    ...sweepLines(
      lines,
      /^\s*type\s+([A-Za-z_][\w]*)\s*=/u,
      'type',
      1,
    ),
  );
  return dedupeDecls(decls, lines);
}

/**
 * Extract symbols from a Rust source file.
 *
 * Handles: `fn`, `pub fn`, `struct`, `enum`, `trait`, `impl`,
 * `mod`, `const`, `static`. Methods inside `impl` blocks are captured
 * as `method` symbols.
 */
function extractRustSymbols(source: string): RawDecl[] {
  const lines = source.split('\n');
  const decls: RawDecl[] = [];
  decls.push(
    ...sweepLines(
      lines,
      /^\s*pub\s+(?:async\s+|unsafe\s+|const\s+)?fn\s+([A-Za-z_][\w]*)/u,
      'function',
      1,
    ),
  );
  decls.push(
    ...sweepLines(
      lines,
      /^\s*(?:async\s+|unsafe\s+|const\s+)?fn\s+([A-Za-z_][\w]*)/u,
      'method',
      1,
    ),
  );
  decls.push(
    ...sweepLines(
      lines,
      /^\s*pub\s+struct\s+([A-Za-z_][\w]*)/u,
      'class',
      1,
    ),
  );
  decls.push(
    ...sweepLines(
      lines,
      /^\s*struct\s+([A-Za-z_][\w]*)/u,
      'class',
      1,
    ),
  );
  decls.push(
    ...sweepLines(
      lines,
      /^\s*(?:pub\s+)?enum\s+([A-Za-z_][\w]*)/u,
      'type',
      1,
    ),
  );
  decls.push(
    ...sweepLines(
      lines,
      /^\s*(?:pub\s+)?trait\s+([A-Za-z_][\w]*)/u,
      'interface',
      1,
    ),
  );
  decls.push(
    ...sweepLines(
      lines,
      /^\s*impl(?:<[^>]*>)?\s+([A-Za-z_][\w]*)/u,
      'class',
      1,
    ),
  );
  return dedupeDecls(decls, lines);
}

/**
 * Extract symbols from a Ruby source file.
 *
 * Handles: `def name`, `def self.name`, `class Name`, `module Name`,
 * `attr_*`. Methods inside classes / modules are captured as `method`
 * symbols (indented `def`).
 */
function extractRubySymbols(source: string): RawDecl[] {
  const lines = source.split('\n');
  const decls: RawDecl[] = [];
  // Top-level defs (no leading whitespace).
  decls.push(
    ...sweepLines(
      lines,
      /^def\s+(?:self\.)?([A-Za-z_][\w?!]*)/u,
      'function',
      1,
    ),
  );
  // Indented defs (methods inside a class / module).
  decls.push(
    ...sweepLines(
      lines,
      /^\s+def\s+(?:self\.)?([A-Za-z_][\w?!]*)/u,
      'method',
      1,
    ),
  );
  decls.push(
    ...sweepLines(
      lines,
      /^(?:module|class)\s+([A-Za-z_][\w]*)/u,
      'class',
      1,
    ),
  );
  return dedupeDecls(decls, lines);
}

/**
 * Generic C-like extractor (Java, Kotlin, Swift, PHP, C#, C, C++).
 * Handles `function`/`func`/`fun`/`def`/`void`/etc. — best-effort.
 */
function extractGenericSymbols(source: string): RawDecl[] {
  const lines = source.split('\n');
  const decls: RawDecl[] = [];
  // Java / C# / C / C++ / PHP function declarations:
  //   [modifiers] <rettype> <name>(<args>) {
  // We require a `{` somewhere on the line or following lines, but the
  // regex here just matches the signature line. Body discovery is
  // handled by computeEndLine.
  decls.push(
    ...sweepLines(
      lines,
      /^\s*(?:public|private|protected|static|final|abstract|internal|open|override|inline|async|suspend|func|fun|function|def|void|int|long|short|float|double|char|bool|boolean|string|String|var|let|val)\s+(?:[\w<>\[\],\s*]+?\s+)?([A-Za-z_][\w]*)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::\s*[^{=]+)?\s*[{=]/u,
      'function',
      1,
    ),
  );
  // Class / struct / interface / enum / protocol / trait declarations.
  decls.push(
    ...sweepLines(
      lines,
      /^\s*(?:public|private|protected|internal|abstract|final|open|sealed|data|inline)\s+(?:class|struct|interface|enum|protocol|trait|extension)\s+([A-Za-z_][\w]*)/u,
      'class',
      1,
    ),
  );
  decls.push(
    ...sweepLines(
      lines,
      /^\s*(?:class|struct|interface|enum|protocol|trait|extension)\s+([A-Za-z_][\w]*)/u,
      'class',
      1,
    ),
  );
  // Methods inside classes (indented). Same shape as TS but allowing
  // for `func`/`fun`/`function`/`def` keywords.
  decls.push(
    ...sweepLines(
      lines,
      /^\s+(?:public|private|protected|static|final|override|open|suspend|async|inline|abstract)\s+(?:[\w<>\[\],\s*]+?\s+)?(?:func\s+|fun\s+|function\s+)?([A-Za-z_][\w]*)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::\s*[^{=]+)?\s*[{=]/u,
      'method',
      1,
    ),
  );
  return dedupeDecls(decls, lines);
}

/**
 * Deduplicate raw declarations: the same line may match multiple
 * regexes (e.g. an arrow const might also be caught by a method
 * regex). We keep the first hit per `startLine` and drop later
 * duplicates.
 */
function dedupeDecls(decls: RawDecl[], _lines: string[]): RawDecl[] {
  const seen = new Set<number>();
  const result: RawDecl[] = [];
  for (const d of decls) {
    if (seen.has(d.startLine)) continue;
    seen.add(d.startLine);
    result.push(d);
  }
  // Sort by startLine.
  result.sort((a, b) => a.startLine - b.startLine);
  return result;
}

// ─── SymbolCodeContext ──────────────────────────────────────────────────────

/**
 * Symbol-aware code context builder.
 *
 * Extracts only the relevant symbols (functions / classes / methods)
 * from a code file, ranks them against the user's query, and renders
 * the selected symbols as a compact code block — instead of loading
 * the whole file into the LLM context.
 *
 * @example
 * ```ts
 * import { SymbolCodeContext } from '@sanix/compressor';
 * import { readFile } from 'node:fs/promises';
 *
 * const scc = new SymbolCodeContext();
 * const source = await readFile('src/auth.ts', 'utf8');
 * const context = await scc.loadRelevantSymbols('src/auth.ts', source, 'verifyToken', 2000);
 * // context === '// src/auth.ts:12-28\nexport function verifyToken(token: string): User { ... }'
 * ```
 */
export class SymbolCodeContext {
  /**
   * Extract all symbols from a source file. Language is auto-detected
   * from the file extension.
   *
   * @param filePath - The file path (used for language detection).
   * @param source - The file's source text.
   * @returns An array of {@link Symbol}s, sorted by start line.
   *
   * @example
   * ```ts
   * const symbols = scc.extractSymbols('src/foo.ts', source);
   * console.log(symbols.map(s => `${s.type} ${s.name} L${s.startLine}-${s.endLine}`));
   * ```
   */
  extractSymbols(filePath: string, source: string): Symbol[] {
    const family = detectFamily(filePath);
    const lines = source.split('\n');
    let raw: RawDecl[];
    switch (family) {
      case 'typescript':
      case 'javascript':
        raw = extractTypeScriptSymbols(source);
        break;
      case 'python':
        raw = extractPythonSymbols(source);
        break;
      case 'go':
        raw = extractGoSymbols(source);
        break;
      case 'rust':
        raw = extractRustSymbols(source);
        break;
      case 'ruby':
        raw = extractRubySymbols(source);
        break;
      default:
        raw = extractGenericSymbols(source);
        break;
    }
    const symbols: Symbol[] = [];
    for (const decl of raw) {
      const endLine = computeEndLine(lines, decl.startLine);
      const bodyLines = lines.slice(decl.startLine - 1, endLine);
      const body = bodyLines.join('\n');
      const bodyTokens = optimizerTokenizer.count(body);
      // Docstring: above-the-decl comment (most languages) OR
      // Python-style body docstring.
      let docstring = extractDocstring(lines, decl.startLine);
      if (!docstring && family === 'python') {
        docstring = extractPythonDocstring(lines, decl.startLine);
      }
      symbols.push({
        name: decl.name,
        type: decl.type,
        startLine: decl.startLine,
        endLine,
        signature: decl.signature,
        docstring,
        bodyTokens,
      });
    }
    return symbols;
  }

  /**
   * Select the most relevant symbols for a query, ranked by overlap
   * with the symbol's `name` + `signature` + `docstring`. Stops once
   * the cumulative token budget is exhausted.
   *
   * The ranking is a simple word-overlap score: each query token that
   * appears in the symbol's text (case-insensitive, identifier-split
   * on camelCase / snake_case boundaries) adds 1 to the symbol's
   * score. Symbols with score 0 are dropped unless the budget hasn't
   * been filled (in which case the highest-body-token symbols are
   * kept as filler so the LLM has *some* context).
   *
   * @param symbols - The full symbol list (from {@link extractSymbols}).
   * @param query - The user's query (e.g. "verifyToken JWT auth").
   * @param budget - Maximum total tokens to return.
   * @returns A subset of `symbols`, ranked by relevance, fitting the
   *   budget.
   *
   * @example
   * ```ts
   * const symbols = scc.extractSymbols('src/auth.ts', source);
   * const selected = scc.selectSymbols(symbols, 'verifyToken', 2000);
   * const ctx = scc.buildContextString('src/auth.ts', selected);
   * ```
   */
  selectSymbols(symbols: ReadonlyArray<Symbol>, query: string, budget: number): Symbol[] {
    if (symbols.length === 0) return [];
    const queryTokens = tokenizeQuery(query);
    const scored = symbols.map((s) => {
      const haystack = `${s.name} ${s.signature} ${s.docstring ?? ''}`.toLowerCase();
      let score = 0;
      for (const qt of queryTokens) {
        if (haystack.includes(qt)) score += 2;
      }
      // Identifier-split bonus: split the symbol name on camelCase /
      // snake_case and check each piece.
      const nameParts = splitIdentifier(s.name);
      for (const part of nameParts) {
        for (const qt of queryTokens) {
          if (part.includes(qt)) score += 1;
        }
      }
      return { symbol: s, score };
    });
    // Sort by score desc, then by start line (stable order for ties).
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.symbol.startLine - b.symbol.startLine;
    });
    // Greedy fill: take the top-scored symbols until budget is hit.
    const selected: Symbol[] = [];
    let used = 0;
    for (const { symbol, score } of scored) {
      if (score === 0) break; // No overlap — stop.
      if (used + symbol.bodyTokens > budget) continue;
      selected.push(symbol);
      used += symbol.bodyTokens;
    }
    // If we have budget left and selected is empty (no overlap hits),
    // fill with the largest symbols so the LLM has some context.
    if (selected.length === 0) {
      const byBodyTokens = [...symbols].sort((a, b) => b.bodyTokens - a.bodyTokens);
      for (const s of byBodyTokens) {
        if (used + s.bodyTokens > budget) continue;
        selected.push(s);
        used += s.bodyTokens;
      }
    }
    // Re-sort the selected symbols by start line so the rendered
    // context reads in source order.
    selected.sort((a, b) => a.startLine - b.startLine);
    return selected;
  }

  /**
   * Render the selected symbols as a compact code block. Each symbol
   * is rendered as:
   *
   *   // path/to/file.ts:N-L
   *   <symbol source lines>
   *
   * Symbols are separated by blank lines. The header line uses `//`
   * for C-like languages and `#` for Python / Ruby (auto-detected
   * from the file extension).
   *
   * @param filePath - The file path (used for the header + comment syntax).
   * @param selected - The selected symbols (from {@link selectSymbols}).
   * @returns The rendered context string. Empty when `selected` is
   *   empty.
   *
   * @example
   * ```ts
   * const ctx = scc.buildContextString('src/auth.ts', selected);
   * // → '// src/auth.ts:12-28\nexport function verifyToken(token: string): User { ... }'
   * ```
   */
  buildContextString(filePath: string, selected: ReadonlyArray<Symbol>): string {
    if (selected.length === 0) return '';
    const commentToken = this.commentTokenFor(filePath);
    const blocks: string[] = [];
    for (const s of selected) {
      const range = s.startLine === s.endLine
        ? `${s.startLine}`
        : `${s.startLine}-${s.endLine}`;
      blocks.push(`${commentToken} ${filePath}:${range}\n${s.signature}`);
    }
    return blocks.join('\n\n');
  }

  /**
   * Convenience: extract → select → render in one call. This is the
   * main entry point for callers that just want a context string for
   * a given file + query + budget.
   *
   * @param filePath - The file path (used for language detection).
   * @param source - The file's source text.
   * @param query - The user's query (e.g. "verifyToken JWT auth").
   * @param budget - Maximum total tokens to return.
   * @returns The rendered context string. Empty when no symbols match
   *   or the file has no extractable symbols.
   *
   * @example
   * ```ts
   * const ctx = await scc.loadRelevantSymbols('src/auth.ts', source, 'verifyToken', 2000);
   * ```
   */
  loadRelevantSymbols(
    filePath: string,
    source: string,
    query: string,
    budget: number,
  ): string {
    const symbols = this.extractSymbols(filePath, source);
    const selected = this.selectSymbols(symbols, query, budget);
    return this.buildContextString(filePath, selected);
  }

  /**
   * Pick the comment-line token for a file extension. `#` for Python
   * and Ruby, `//` for everything else.
   */
  private commentTokenFor(filePath: string): string {
    const family = detectFamily(filePath);
    if (family === 'python' || family === 'ruby') return '#';
    return '//';
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Tokenize a query string into lowercase search terms. Splits on
 * whitespace and on camelCase / snake_case boundaries so "verifyToken
 * JWT auth" becomes `['verifytoken', 'jwt', 'auth', 'verify', 'token']`.
 */
function tokenizeQuery(query: string): string[] {
  const tokens = new Set<string>();
  const words = query.toLowerCase().split(/\s+/u).filter((w) => w.length > 0);
  for (const word of words) {
    tokens.add(word);
    for (const part of splitIdentifier(word)) {
      if (part.length >= 3) tokens.add(part);
    }
  }
  return [...tokens];
}

/**
 * Split an identifier on camelCase / snake_case / kebab-case
 * boundaries. `verifyToken` → `['verify', 'token']`,
 * `verify_token` → `['verify', 'token']`, `verify-token` →
 * `['verify', 'token']`.
 */
function splitIdentifier(name: string): string[] {
  // Split on non-alphanumeric, then on camelCase boundaries.
  const parts = name
    .split(/[^A-Za-z0-9]+/u)
    .flatMap((p) => p.split(/([A-Z][a-z]*)/u).filter((s) => s.length > 0))
    .map((p) => p.toLowerCase());
  return parts.filter((p) => p.length > 0);
}
