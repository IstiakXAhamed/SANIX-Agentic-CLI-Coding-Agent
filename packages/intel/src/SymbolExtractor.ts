/**
 * @file SymbolExtractor.ts
 * @description Regex-based symbol extractor for six languages.
 *
 * The extractor walks each file line-by-line, runs language-specific
 * regex patterns to find declarations, and computes the end-line of
 * each symbol by brace / indentation / dedent tracking. It captures:
 *
 *   - functions, async functions, arrow-const functions
 *   - classes, methods, constructors
 *   - interfaces, types, enums
 *   - top-level constants (where the value looks like a function / class)
 *   - visibility modifiers, `static`, `async`, `export`
 *   - leading doc comments (JSDoc `/** … *\/`, Python `"""…"""`, etc.)
 *
 * It is intentionally a *recogniser*, not a parser: it never throws on
 * malformed input — it just emits the symbols it can confidently
 * identify. Every public method is pure (no I/O) so the extractor can
 * be unit-tested with string fixtures.
 */

import { extname } from 'node:path';
import { languageFromExtension } from './LSPClient.js';
import type { SupportedLanguage, SymbolInfo, SymbolKind } from './types.js';

interface RawDecl {
  name: string;
  kind: SymbolKind;
  line: number; // 1-based
  column: number; // 1-based
  signature: string | null;
  visibility: SymbolInfo['visibility'];
  isStatic: boolean;
  isAsync: boolean;
  isExported: boolean;
  container: string | null;
}

/**
 * Options for `SymbolExtractor.extract`.
 */
export interface ExtractOptions {
  /** Override the detected language. */
  language?: SupportedLanguage;
}

/**
 * Extracts symbols from source code without spawning an LSP server.
 *
 * @example
 * ```ts
 * const extractor = new SymbolExtractor();
 * const symbols = extractor.extract('/app/foo.ts', 'export async function bar(x: number): Promise<void> {}');
 * ```
 */
export class SymbolExtractor {
  /**
   * Extract symbols from a source file's text.
   * @param file Path (used only for the symbol id + `file` field).
   * @param text Full source text.
   * @param opts Optional overrides.
   * @returns Sorted-by-line symbol list.
   */
  public extract(file: string, text: string, opts: ExtractOptions = {}): SymbolInfo[] {
    const lang = opts.language ?? this.detectLanguage(file);
    if (!lang) return [];
    const lines = text.split(/\r?\n/);
    const decls = this.scan(lang, lines);
    return decls
      .map((d) => this.finalize(file, d, lines))
      .sort((a, b) => a.line - b.line || a.column - b.column);
  }

  /**
   * Detect language from a file's extension.
   * @returns Language or `null` if unsupported.
   */
  public detectLanguage(file: string): SupportedLanguage | null {
    return languageFromExtension(extname(file));
  }

  /**
   * Return the list of supported languages.
   */
  public supportedLanguages(): SupportedLanguage[] {
    return ['typescript', 'javascript', 'python', 'go', 'rust', 'java'];
  }

  // ─── Per-language scanners ───────────────────────────────────────────────

  private scan(lang: SupportedLanguage, lines: string[]): RawDecl[] {
    switch (lang) {
      case 'typescript':
      case 'javascript':
        return this.scanTS(lines);
      case 'python':
        return this.scanPython(lines);
      case 'go':
        return this.scanGo(lines);
      case 'rust':
        return this.scanRust(lines);
      case 'java':
        return this.scanJava(lines);
    }
  }

  /** TypeScript + JavaScript scanner. */
  private scanTS(lines: string[]): RawDecl[] {
    const decls: RawDecl[] = [];
    let classStack: string[] = [];
    let braceDepth = 0;
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const line = raw.trim();

      // Track class nesting via braces (rough but good enough for symbol bounds).
      const opens = (raw.match(/\{/g) ?? []).length;
      const closes = (raw.match(/\}/g) ?? []).length;
      const prevDepth = braceDepth;
      braceDepth += opens - closes;

      // export / visibility prefixes
      const exported = /^export\s/.test(line);
      const visibilityMatch = /^(public|private|protected|internal|package)\s+(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\(/.exec(line);
      const visibility: SymbolInfo['visibility'] = visibilityMatch
        ? (visibilityMatch[1] as SymbolInfo['visibility'])
        : null;
      const isStatic = /\bstatic\s/.test(line);
      const isAsync = /\basync\s/.test(line);

      // class
      const cls = /\b(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(line);
      if (cls) {
        decls.push({
          name: cls[1],
          kind: 'class',
          line: i + 1,
          column: line.indexOf(cls[1]) + 1,
          signature: line,
          visibility,
          isStatic: false,
          isAsync: false,
          isExported: exported,
          container: classStack[classStack.length - 1] ?? null,
        });
        // a class opens a new container only if it actually opened a brace on this line or next.
        if (opens > closes || this.opensLater(lines, i)) classStack.push(cls[1]);
        continue;
      }

      // interface
      const iface = /\binterface\s+([A-Za-z_$][\w$]*)/.exec(line);
      if (iface) {
        decls.push(this.simple(i + 1, line, iface[1], 'interface', exported, line));
        continue;
      }
      // type alias
      const typeAlias = /\btype\s+([A-Za-z_$][\w$]*)\s*=/.exec(line);
      if (typeAlias) {
        decls.push(this.simple(i + 1, line, typeAlias[1], 'type', exported, line));
        continue;
      }
      // enum
      const enumDecl = /\b(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/.exec(line);
      if (enumDecl) {
        decls.push(this.simple(i + 1, line, enumDecl[1], 'enum', exported, line));
        continue;
      }
      // function
      const fn = /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/.exec(line);
      if (fn) {
        decls.push({
          name: fn[1],
          kind: 'function',
          line: i + 1,
          column: line.indexOf(fn[1]) + 1,
          signature: this.extractSignature(line),
          visibility,
          isStatic,
          isAsync,
          isExported: exported,
          container: classStack[classStack.length - 1] ?? null,
        });
        continue;
      }
      // method (inside class) — `name(...) {` or `name(...): T {`
      if (classStack.length > 0) {
        const method = /^(?:public\s+|private\s+|protected\s+|internal\s+|package\s+)?(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\(/.exec(line);
        if (method && method[1] !== 'if' && method[1] !== 'for' && method[1] !== 'while' && method[1] !== 'switch' && method[1] !== 'catch' && method[1] !== 'return' && method[1] !== 'constructor') {
          const isCtor = method[1] === 'constructor';
          decls.push({
            name: isCtor ? 'constructor' : method[1],
            kind: 'method',
            line: i + 1,
            column: line.indexOf(method[1]) + 1,
            signature: this.extractSignature(line),
            visibility,
            isStatic,
            isAsync,
            isExported: false,
            container: classStack[classStack.length - 1] ?? null,
          });
          continue;
        }
      }
      // arrow const
      const arrow = /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=\s*(?:async\s*)?\(?[^=]*?=>/.exec(line);
      if (arrow) {
        const isConst = /\bconst\s/.test(line);
        decls.push({
          name: arrow[1],
          kind: isConst ? 'constant' : 'variable',
          line: i + 1,
          column: line.indexOf(arrow[1]) + 1,
          signature: this.extractSignature(line),
          visibility: null,
          isStatic: false,
          isAsync: isAsync,
          isExported: exported,
          container: null,
        });
        continue;
      }
      // exported const (non-arrow)
      const constExp = /\b(?:export\s+)?const\s+([A-Z_][A-Z0-9_]*)\s*=/.exec(line);
      if (constExp) {
        decls.push(this.simple(i + 1, line, constExp[1], 'constant', exported, line));
        continue;
      }

      // pop class container when braces close below the class opener depth
      if (closes > opens && braceDepth < prevDepth && classStack.length > 0) {
        // Heuristic: pop if we returned to the depth before the last push.
        classStack.pop();
      }
    }
    return decls;
  }

  /** Python scanner — `def`, `async def`, `class`. */
  private scanPython(lines: string[]): RawDecl[] {
    const decls: RawDecl[] = [];
    const indentStack: { indent: number; name: string }[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim() || line.trimStart().startsWith('#')) continue;
      const indent = line.length - line.trimStart().length;
      // pop containers that are no longer active
      while (indentStack.length && indent <= indentStack[indentStack.length - 1].indent) {
        indentStack.pop();
      }
      const cls = /^(\s*)class\s+([A-Za-z_][\w]*)/.exec(line);
      if (cls) {
        const name = cls[2];
        indentStack.push({ indent, name });
        decls.push({
          name,
          kind: 'class',
          line: i + 1,
          column: line.indexOf(name) + 1,
          signature: line.trim(),
          visibility: /^(\s*)_/.test(line) ? 'private' : 'public',
          isStatic: false,
          isAsync: false,
          isExported: false,
          container: indentStack[indentStack.length - 2]?.name ?? null,
        });
        continue;
      }
      const fn = /^(\s*)(async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/.exec(line);
      if (fn) {
        const name = fn[3];
        const isAsync = !!fn[2];
        const container = indentStack[indentStack.length - 1]?.name ?? null;
        decls.push({
          name,
          kind: container ? 'method' : 'function',
          line: i + 1,
          column: line.indexOf(name) + 1,
          signature: line.trim(),
          visibility: /^(\s*)_/.test(line) ? 'private' : 'public',
          isStatic: false,
          isAsync,
          isExported: false,
          container,
        });
        indentStack.push({ indent, name });
      }
    }
    return decls;
  }

  /** Go scanner — `func` (with optional receiver), `type`, `struct`, `interface`. */
  private scanGo(lines: string[]): RawDecl[] {
    const decls: RawDecl[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fn = /^func\s+(?:\(([^)]+)\)\s+)?([A-Za-z_][\w]*)\s*\(/.exec(line);
      if (fn) {
        const name = fn[2];
        const isMethod = !!fn[1];
        decls.push({
          name,
          kind: isMethod ? 'method' : 'function',
          line: i + 1,
          column: line.indexOf(name) + 1,
          signature: line.trim(),
          visibility: /^[a-z]/.test(name) ? 'public' : 'private',
          isStatic: false,
          isAsync: false,
          isExported: /^[A-Z]/.test(name),
          container: isMethod ? fn[1].trim().split(/\s+/)[0] : null,
        });
        continue;
      }
      const typeDecl = /^type\s+([A-Za-z_][\w]*)\s+(?:struct|interface)?/.exec(line);
      if (typeDecl) {
        const isIface = /\binterface\b/.test(line);
        const isStruct = /\bstruct\b/.test(line);
        decls.push({
          name: typeDecl[1],
          kind: isIface ? 'interface' : isStruct ? 'class' : 'type',
          line: i + 1,
          column: line.indexOf(typeDecl[1]) + 1,
          signature: line.trim(),
          visibility: 'public',
          isStatic: false,
          isAsync: false,
          isExported: /^[A-Z]/.test(typeDecl[1]),
          container: null,
        });
      }
    }
    return decls;
  }

  /** Rust scanner — `fn`, `struct`, `enum`, `trait`, `impl`, `type`. */
  private scanRust(lines: string[]): RawDecl[] {
    const decls: RawDecl[] = [];
    let implFor: string | null = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const impl = /^impl(?:<[^>]+>)?\s+(?:[\w<>]+?\s+for\s+)?([A-Za-z_][\w]*)/.exec(line);
      if (impl) {
        implFor = impl[1];
        decls.push({
          name: implFor,
          kind: 'namespace',
          line: i + 1,
          column: line.indexOf(impl[1]) + 1,
          signature: line.trim(),
          visibility: 'public',
          isStatic: false,
          isAsync: false,
          isExported: true,
          container: null,
        });
        continue;
      }
      const fn = /(?:pub\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_][\w]*)\s*\(/.exec(line);
      if (fn) {
        decls.push({
          name: fn[1],
          kind: implFor ? 'method' : 'function',
          line: i + 1,
          column: line.indexOf(fn[1]) + 1,
          signature: line.trim(),
          visibility: /^pub/.test(line.trim()) ? 'public' : 'private',
          isStatic: false,
          isAsync: /\basync\s/.test(line),
          isExported: /^pub/.test(line.trim()),
          container: implFor,
        });
        continue;
      }
      const struct = /(?:pub\s+)?struct\s+([A-Za-z_][\w]*)/.exec(line);
      if (struct) {
        decls.push(this.simple(i + 1, line, struct[1], 'class', /^pub/.test(line.trim()), line.trim()));
        continue;
      }
      const trait = /(?:pub\s+)?trait\s+([A-Za-z_][\w]*)/.exec(line);
      if (trait) {
        decls.push(this.simple(i + 1, line, trait[1], 'interface', /^pub/.test(line.trim()), line.trim()));
        continue;
      }
      const enumDecl = /(?:pub\s+)?enum\s+([A-Za-z_][\w]*)/.exec(line);
      if (enumDecl) {
        decls.push(this.simple(i + 1, line, enumDecl[1], 'enum', /^pub/.test(line.trim()), line.trim()));
        continue;
      }
      const typeAlias = /(?:pub\s+)?type\s+([A-Za-z_][\w]*)\s*=/.exec(line);
      if (typeAlias) {
        decls.push(this.simple(i + 1, line, typeAlias[1], 'type', /^pub/.test(line.trim()), line.trim()));
      }
    }
    return decls;
  }

  /** Java scanner — `class`, `interface`, `enum`, `method`. */
  private scanJava(lines: string[]): RawDecl[] {
    const decls: RawDecl[] = [];
    let pkg: string | null = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const pkgMatch = /^package\s+([\w.]+);/.exec(line);
      if (pkgMatch) {
        pkg = pkgMatch[1];
        continue;
      }
      const cls = /(?:public|private|protected)?\s*(?:abstract\s+|final\s+|static\s+)*class\s+([A-Za-z_][\w]*)/.exec(line);
      if (cls) {
        decls.push({
          name: cls[1],
          kind: 'class',
          line: i + 1,
          column: line.indexOf(cls[1]) + 1,
          signature: line.trim(),
          visibility: this.javaVisibility(line),
          isStatic: /\bstatic\s/.test(line),
          isAsync: false,
          isExported: /public/.test(line),
          container: pkg,
        });
        continue;
      }
      const iface = /(?:public|private|protected)?\s*interface\s+([A-Za-z_][\w]*)/.exec(line);
      if (iface) {
        decls.push(this.simple(i + 1, line, iface[1], 'interface', /public/.test(line), line.trim()));
        continue;
      }
      const enumDecl = /(?:public|private|protected)?\s*enum\s+([A-Za-z_][\w]*)/.exec(line);
      if (enumDecl) {
        decls.push(this.simple(i + 1, line, enumDecl[1], 'enum', /public/.test(line), line.trim()));
        continue;
      }
      // method — has parens and a return type, not a control keyword
      const method = /(?:public|private|protected|static|final|abstract|synchronized|\s)+([A-Za-z_][\w<>\[\],\s]*)\s+([A-Za-z_][\w]*)\s*\(/.exec(line);
      if (method && !/^(if|for|while|switch|catch|return|new|throw|super|this)$/.test(method[2])) {
        decls.push({
          name: method[2],
          kind: 'method',
          line: i + 1,
          column: line.indexOf(method[2]) + 1,
          signature: line.trim(),
          visibility: this.javaVisibility(line),
          isStatic: /\bstatic\s/.test(line),
          isAsync: false,
          isExported: /public/.test(line),
          container: null,
        });
      }
    }
    return decls;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private simple(line: number, rawLine: string, name: string, kind: SymbolKind, exported: boolean, signature: string): RawDecl {
    return {
      name,
      kind,
      line,
      column: rawLine.indexOf(name) + 1,
      signature,
      visibility: null,
      isStatic: false,
      isAsync: false,
      isExported: exported,
      container: null,
    };
  }

  private javaVisibility(line: string): SymbolInfo['visibility'] {
    if (/\bpublic\s/.test(line)) return 'public';
    if (/\bprivate\s/.test(line)) return 'private';
    if (/\bprotected\s/.test(line)) return 'protected';
    return 'package';
  }

  private extractSignature(line: string): string | null {
    // Capture from the keyword up to the matching `)` or `{`.
    const start = line.search(/\b(function|def|fn|async|static|public|private|protected|constructor|get|set)\b|\(/);
    if (start === -1) return line.trim().slice(0, 120);
    const slice = line.slice(start);
    const end = slice.search(/[({]/);
    return end === -1 ? slice.trim() : slice.slice(0, end).trim();
  }

  private opensLater(lines: string[], fromIdx: number): boolean {
    for (let j = fromIdx; j < Math.min(fromIdx + 3, lines.length); j++) {
      if (lines[j].includes('{')) return true;
    }
    return false;
  }

  private finalize(file: string, d: RawDecl, lines: string[]): SymbolInfo {
    const id = `${file}:${d.kind}:${d.name}:${d.line}`;
    const docstring = this.findDocstring(lines, d.line - 1, d.kind);
    const endLine = this.findEndLine(lines, d.line - 1, d.kind);
    return {
      id,
      file,
      name: d.name,
      containerName: d.container,
      kind: d.kind,
      line: d.line,
      column: d.column,
      endLine,
      signature: d.signature,
      docstring,
      visibility: d.visibility,
      isStatic: d.isStatic,
      isAsync: d.isAsync,
      isExported: d.isExported,
    };
  }

  /** Walk backwards from the declaration looking for a doc comment. */
  private findDocstring(lines: string[], declIdx: number, kind: SymbolKind): string | null {
    // JSDoc / block comment
    for (let i = declIdx - 1; i >= 0; i--) {
      const t = lines[i].trim();
      if (t === '') continue;
      if (t.endsWith('*/')) {
        // walk up to opening /**
        const parts: string[] = [t];
        for (let j = i - 1; j >= 0; j--) {
          parts.unshift(lines[j].trim());
          if (lines[j].includes('/**') || lines[j].includes('/*')) break;
        }
        return parts.join('\n').replace(/^\/\*+/, '').replace(/\*+\/$/, '').trim();
      }
      if (t.startsWith('//')) return t.replace(/^\/\//, '').trim() || null;
      if (t.startsWith('#') && kind !== 'class' && kind !== 'method' && kind !== 'function') return t.replace(/^#/, '').trim() || null;
      if (t.startsWith('"""') || t.startsWith("'''")) {
        // Python docstring is *below* the def — handle below.
        break;
      }
      break;
    }
    // Python triple-quoted docstring below the def
    if (declIdx + 1 < lines.length) {
      const next = lines[declIdx + 1].trim();
      if (next.startsWith('"""') || next.startsWith("'''")) {
        const quote = next.slice(0, 3);
        if (next.endsWith(quote) && next.length > 3) return next.slice(3, -3).trim();
        const parts = [next.slice(3)];
        for (let j = declIdx + 2; j < lines.length; j++) {
          if (lines[j].includes(quote)) {
            parts.push(lines[j].slice(0, lines[j].indexOf(quote)));
            break;
          }
          parts.push(lines[j]);
        }
        return parts.join('\n').trim();
      }
    }
    return null;
  }

  /** Estimate the end line of a symbol by brace matching or indentation. */
  private findEndLine(lines: string[], declIdx: number, kind: SymbolKind): number {
    // For brace languages, match braces.
    let depth = 0;
    let seenOpen = false;
    for (let i = declIdx; i < lines.length; i++) {
      const line = lines[i];
      for (const ch of line) {
        if (ch === '{') { depth++; seenOpen = true; }
        else if (ch === '}') { depth--; }
      }
      if (seenOpen && depth <= 0) return i + 1;
      // Python / Go: indentation-based end
      if ((kind === 'function' || kind === 'method' || kind === 'class') && i > declIdx) {
        const trimmed = lines[i];
        if (trimmed.trim() === '') continue;
        const indent = trimmed.length - trimmed.trimStart().length;
        const declIndent = lines[declIdx].length - lines[declIdx].trimStart().length;
        if (indent <= declIndent && !seenOpen) return i;
      }
    }
    return Math.min(declIdx + 1, lines.length);
  }
}
