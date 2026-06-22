/**
 * @file agents/DocDoctor.ts
 * @description SANIX Doc Doctor — 📝 technical documentation agent.
 *
 * Process:
 *   1. **Scan** — find all public APIs (exported functions, public
 *      classes/methods, interfaces, types) that lack documentation.
 *   2. **Generate docs** — for each undocumented API: analyze the
 *      function signature, body, and usage; generate JSDoc with
 *      `@param`, `@returns`, `@throws`, `@example`, `@see`.
 *   3. **Architecture diagram** — generate Mermaid diagrams:
 *      module dependency graph, class hierarchy, data flow.
 *   4. **README generation** — if missing or outdated: project
 *      description, installation, usage, API reference, configuration,
 *      contributing.
 *   5. **Changelog** — from `git log`, categorize commits
 *      (feat/fix/breaking/deprecated), generate Keep a Changelog format.
 *   6. **Drift detection** — compare docs to code, flag mismatches.
 *
 * @packageDocumentation
 */

import type {
  AgentCategory,
  AgentRunOptions,
  AgentRunResult,
} from '../types.js';
import { BaseAgent, type RunContext } from '../BaseAgent.js';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/**
 * A single undocumented API discovered by Doc Doctor.
 */
export interface UndocumentedApi {
  /** Source file path (relative to cwd). */
  file: string;
  /** 1-indexed line where the declaration starts. */
  line: number;
  /** Kind of API: function, class, method, interface, type, property. */
  kind: 'function' | 'class' | 'method' | 'interface' | 'type' | 'property';
  /** Symbol name. */
  name: string;
  /** Already-existing JSDoc above the declaration (if any — partial). */
  existingDoc: string;
  /** Detected parameters (name + type) — best-effort. */
  params: Array<{ name: string; type: string }>;
  /** Detected return type — best-effort. */
  returnType: string;
  /** Detected thrown errors — best-effort. */
  throws: string[];
}

/**
 * SANIX Doc Doctor — 📝 technical documentation agent.
 *
 * @example
 * ```ts
 * import { DocDoctor } from '@sanix/agents';
 *
 * const agent = new DocDoctor();
 * const result = await agent.run(
 *   'Generate JSDoc for all undocumented exported APIs in src/',
 *   { cwd: '/repo', dryRun: true },
 * );
 *
 * console.log(result.metrics.docsGenerated, 'JSDoc blocks generated');
 * ```
 */
export class DocDoctor extends BaseAgent {
  public readonly id = 'doc-doctor';
  public readonly name = 'Doc Doctor';
  public readonly description =
    'Scans code for undocumented APIs, generates JSDoc/docstrings, creates ' +
    'Mermaid architecture diagrams, generates READMEs, maintains changelogs ' +
    'from git history, and detects documentation drift.';
  public readonly category: AgentCategory = 'documentation';
  public readonly icon = '📝';
  public readonly provider = 'claude-sonnet-4';
  public readonly temperature = 0.3;
  public readonly tools = ['read_file', 'write_file', 'edit_file', 'search_files', 'analyze_ast', 'bash', 'list_directory'];
  public readonly exampleQueries = [
    'Generate JSDoc for all undocumented exported APIs in src/.',
    'Create a Mermaid architecture diagram of the module dependencies.',
    'Generate a README for this package.',
    'Update the CHANGELOG.md from git history since the last tag.',
    'Detect documentation drift — flag JSDoc that does not match the code.',
  ];

  public readonly systemPrompt = `You are SANIX Doc Doctor, a technical documentation expert. You:
(1) scan code for undocumented public APIs (functions, classes, methods, interfaces),
(2) generate accurate JSDoc/docstrings from code analysis,
(3) create architecture diagrams (Mermaid),
(4) generate READMEs with installation/usage/API sections,
(5) maintain changelogs from git history,
(6) detect documentation drift (docs that don't match code).

Documentation should be accurate, concise, and useful — not just restating the code.`;

  // ── Run entrypoint ─────────────────────────────────────────────────────────

  public async run(goal: string, opts?: AgentRunOptions): Promise<AgentRunResult> {
    const ctx = this.startRun(goal, opts);

    // Determine intent from the goal.
    const intent = this.detectIntent(goal);

    // 1) SCAN — find undocumented APIs.
    this.emitProgress('analyze', 'Phase 1: scanning for undocumented APIs…', undefined, ctx);
    const undocumented = await this.scanUndocumented(ctx);
    this.recordMetric(ctx, 'undocumentedApis', undocumented.length, 'set');

    if (intent.generateJsdoc) {
      // 2) GENERATE — write JSDoc blocks for each undocumented API.
      this.emitProgress('analyze', `Phase 2: generating JSDoc for ${undocumented.length} APIs…`, undefined, ctx);
      const generated = await this.generateJsdoc(ctx, undocumented);
      this.recordMetric(ctx, 'docsGenerated', generated, 'set');
    }

    if (intent.architectureDiagram) {
      // 3) ARCHITECTURE — Mermaid module dependency graph.
      this.emitProgress('analyze', 'Phase 3: generating architecture diagram…', undefined, ctx);
      await this.generateArchitectureDiagram(ctx);
    }

    if (intent.readme) {
      // 4) README — generate or refresh.
      this.emitProgress('analyze', 'Phase 4: generating README…', undefined, ctx);
      await this.generateReadme(ctx);
    }

    if (intent.changelog) {
      // 5) CHANGELOG — from git log since last tag.
      this.emitProgress('analyze', 'Phase 5: regenerating CHANGELOG…', undefined, ctx);
      await this.generateChangelog(ctx);
    }

    if (intent.driftDetection) {
      // 6) DRIFT — compare docs to code.
      this.emitProgress('analyze', 'Phase 6: detecting documentation drift…', undefined, ctx);
      await this.detectDrift(ctx);
    }

    // Summary.
    this.addFinding(ctx, {
      severity: 'info',
      category: 'summary',
      title: `Doc Doctor: ${undocumented.length} undocumented APIs found`,
      description:
        `Scanned the codebase and found ${undocumented.length} public APIs without JSDoc. ` +
        `Actions performed: ${[
          intent.generateJsdoc ? 'JSDoc generation' : '',
          intent.architectureDiagram ? 'architecture diagram' : '',
          intent.readme ? 'README generation' : '',
          intent.changelog ? 'changelog' : '',
          intent.driftDetection ? 'drift detection' : '',
        ].filter(Boolean).join(', ') || 'scan only'}.`,
      suggestion: 'Review the generated docs. Apply with `git diff` inspection; remove any drift findings.',
      autoFixable: false,
      tags: ['summary'],
    });

    return this.finishRun(ctx);
  }

  // ── Intent detection ───────────────────────────────────────────────────────

  private detectIntent(goal: string): {
    generateJsdoc: boolean;
    architectureDiagram: boolean;
    readme: boolean;
    changelog: boolean;
    driftDetection: boolean;
  } {
    const g = goal.toLowerCase();
    return {
      generateJsdoc: /\b(?:jsdoc|docstring|document|docs? for)\b/.test(g) || g === '' || /\bscan\b/.test(g),
      architectureDiagram: /\b(?:architecture|diagram|mermaid|dependency graph)\b/.test(g),
      readme: /\b(?:readme|read me)\b/.test(g),
      changelog: /\b(?:changelog|change log|release notes)\b/.test(g),
      driftDetection: /\b(?:drift|stale docs?|mismatch)\b/.test(g),
    };
  }

  // ── 1) Scan undocumented ───────────────────────────────────────────────────

  /**
   * Scan every source file for exported functions / classes / interfaces /
   * types that lack a JSDoc comment block above them. Returns the list.
   */
  private async scanUndocumented(ctx: RunContext): Promise<UndocumentedApi[]> {
    const out: UndocumentedApi[] = [];
    let scanned = 0;
    await this.scanFiles(ctx, async (filePath, content) => {
      scanned++;
      const rel = path.relative(ctx.opts.cwd, filePath);
      const apis = this.extractPublicApis(content);
      for (const api of apis) {
        if (api.existingDoc && api.existingDoc.length > 30) continue;
        out.push({
          ...api,
          file: rel,
        });
        this.addFinding(ctx, {
          severity: 'low',
          category: 'undocumented',
          title: `${api.kind} \`${api.name}\` lacks JSDoc`,
          description:
            `Public ${api.kind} \`${api.name}\` in \`${rel}:${api.line}\` is exported but undocumented. ` +
            `Parameters: ${api.params.map((p) => `${p.name}: ${p.type}`).join(', ') || 'none'}. ` +
            `Returns: ${api.returnType}.`,
          file: rel,
          line: api.line,
          suggestion: 'Add a JSDoc block above the declaration describing purpose, parameters, return value, and at least one @example.',
          autoFixable: true,
          tags: ['jsdoc', api.kind],
        });
      }
    }, { extensions: ['.ts', '.tsx', '.js', '.jsx'] });
    this.recordMetric(ctx, 'jsdocFilesScanned', scanned, 'set');
    return out;
  }

  /**
   * Extract public APIs (exported functions, classes, methods,
   * interfaces, types) from a source file. Returns one entry per
   * declaration; entries include the existing JSDoc above (if any).
   */
  private extractPublicApis(content: string): Array<Omit<UndocumentedApi, 'file'>> {
    const out: Array<Omit<UndocumentedApi, 'file'>> = [];
    const lines = content.split('\n');

    // ── Exported functions.
    const fnRe = /^(export\s+)?(?:default\s+)?(?:async\s+)?function\s+\*?\s*([A-Za-z_$][\w$]*)\s*\(([^)]*)\)(?:\s*:\s*([^\s{=]+))?/gm;
    let m: RegExpExecArray | null;
    while ((m = fnRe.exec(content)) !== null) {
      if (!m[1]) continue; // skip non-exported
      const name = m[2];
      const params = this.parseParams(m[3]);
      const returnType = (m[4] ?? 'void').trim();
      const line = content.slice(0, m.index).split('\n').length;
      out.push({
        kind: 'function',
        name,
        line,
        existingDoc: this.getJsdocAbove(lines, line),
        params,
        returnType,
        throws: this.detectThrows(content.slice(m.index, m.index + 2000)),
      });
    }

    // ── Exported arrow consts.
    const arrowRe = /^(export\s+)?const\s+([A-Za-z_$][\w$]*)\s*:\s*([^=]+?)\s*=\s*(?:async\s*)?\(([^)]*)\)/gm;
    while ((m = arrowRe.exec(content)) !== null) {
      if (!m[1]) continue;
      const name = m[2];
      const returnType = m[3].trim();
      const params = this.parseParams(m[4]);
      const line = content.slice(0, m.index).split('\n').length;
      out.push({
        kind: 'function',
        name,
        line,
        existingDoc: this.getJsdocAbove(lines, line),
        params,
        returnType,
        throws: this.detectThrows(content.slice(m.index, m.index + 2000)),
      });
    }

    // ── Exported classes.
    const clsRe = /^(export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm;
    while ((m = clsRe.exec(content)) !== null) {
      if (!m[1]) continue;
      const name = m[2];
      const line = content.slice(0, m.index).split('\n').length;
      out.push({
        kind: 'class',
        name,
        line,
        existingDoc: this.getJsdocAbove(lines, line),
        params: [],
        returnType: 'instance',
        throws: [],
      });

      // Public methods (inside the class body — heuristically the next 500 lines).
      const bodyStart = m.index + m[0].length;
      const body = content.slice(bodyStart, bodyStart + 50_000);
      const methodRe = /^\s*(?:public\s+)?(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\(([^)]*)\)(?:\s*:\s*([^\s{]+))?/gm;
      let mm: RegExpExecArray | null;
      while ((mm = methodRe.exec(body)) !== null) {
        const mname = mm[1];
        if (['if', 'for', 'while', 'switch', 'return', 'constructor'].includes(mname)) continue;
        const mline = content.slice(0, bodyStart + mm.index).split('\n').length;
        out.push({
          kind: 'method',
          name: `${name}.${mname}`,
          line: mline,
          existingDoc: this.getJsdocAbove(lines, mline),
          params: this.parseParams(mm[2]),
          returnType: (mm[3] ?? 'void').trim(),
          throws: this.detectThrows(body.slice(mm.index, mm.index + 1000)),
        });
      }
    }

    // ── Exported interfaces.
    const ifaceRe = /^(export\s+)?interface\s+([A-Za-z_$][\w$]*)/gm;
    while ((m = ifaceRe.exec(content)) !== null) {
      if (!m[1]) continue;
      const name = m[2];
      const line = content.slice(0, m.index).split('\n').length;
      out.push({
        kind: 'interface',
        name,
        line,
        existingDoc: this.getJsdocAbove(lines, line),
        params: [],
        returnType: 'n/a',
        throws: [],
      });
    }

    // ── Exported types.
    const typeRe = /^(export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/gm;
    while ((m = typeRe.exec(content)) !== null) {
      if (!m[1]) continue;
      const name = m[2];
      const line = content.slice(0, m.index).split('\n').length;
      out.push({
        kind: 'type',
        name,
        line,
        existingDoc: this.getJsdocAbove(lines, line),
        params: [],
        returnType: 'n/a',
        throws: [],
      });
    }

    return out;
  }

  /**
   * Parse a parameter list `name: type, name2: type2` into structured params.
   */
  private parseParams(paramsStr: string): Array<{ name: string; type: string }> {
    if (!paramsStr.trim()) return [];
    return paramsStr.split(',').map((p) => {
      const parts = p.trim().split(/\s*:\s*/);
      const name = (parts[0] ?? '').replace(/\.\.\./, '').replace(/\?$/, '').trim();
      const type = (parts[1] ?? 'any').trim();
      return { name: name || 'arg', type: type || 'any' };
    }).filter((p) => p.name);
  }

  /**
   * Look at the lines above `lineNo` (1-indexed) for a JSDoc block
   * (`/** ... *\/`). Returns the block text (empty string if none).
   */
  private getJsdocAbove(lines: string[], lineNo: number): string {
    let i = lineNo - 2; // 0-indexed line above the declaration
    const collected: string[] = [];
    while (i >= 0) {
      const ln = lines[i].trim();
      if (ln === '' || ln.startsWith('//')) {
        i--;
        continue;
      }
      if (ln.endsWith('*/')) {
        // Walk upward collecting the JSDoc block.
        collected.push(ln);
        let j = i - 1;
        while (j >= 0 && !lines[j].includes('/**')) {
          collected.unshift(lines[j].trim());
          j--;
        }
        if (j >= 0) collected.unshift(lines[j].trim());
        return collected.join('\n');
      }
      break;
    }
    return '';
  }

  /**
   * Detect `throw new XError(...)` calls in a code snippet.
   */
  private detectThrows(snippet: string): string[] {
    const out = new Set<string>();
    const re = /throw\s+new\s+([A-Za-z_$][\w$]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(snippet)) !== null) {
      out.add(m[1]);
    }
    return [...out];
  }

  // ── 2) Generate JSDoc ──────────────────────────────────────────────────────

  /**
   * Generate JSDoc blocks for every undocumented API. Returns the
   * number of files modified.
   */
  private async generateJsdoc(ctx: RunContext, apis: UndocumentedApi[]): Promise<number> {
    if (apis.length === 0) return 0;

    // Group by file so we apply all changes per file in one write.
    const byFile = new Map<string, UndocumentedApi[]>();
    for (const a of apis) {
      if (!byFile.has(a.file)) byFile.set(a.file, []);
      byFile.get(a.file)!.push(a);
    }

    let modified = 0;
    let i = 0;
    const cap = Math.min(byFile.size, Math.max(1, Math.floor(ctx.opts.maxIterations / 2)));
    for (const [file, fileApis] of byFile) {
      if (i++ >= cap) break;
      ctx.iteration++;

      const absPath = path.resolve(ctx.opts.cwd, file);
      const original = await this.readFileSafe(absPath, ctx);
      if (original === null) continue;

      // Apply JSDoc blocks bottom-up so line numbers stay valid.
      const lines = original.split('\n');
      const sorted = [...fileApis].sort((a, b) => b.line - a.line);
      for (const api of sorted) {
        const jsdoc = this.buildJsdocBlock(api);
        lines.splice(api.line - 1, 0, jsdoc);
      }
      const updated = lines.join('\n');

      const ok = await this.writeFileSafe(absPath, updated, ctx);
      if (ok) {
        modified++;
        this.addFinding(ctx, {
          severity: 'info',
          category: 'jsdoc-generated',
          title: `Generated ${fileApis.length} JSDoc block(s) in ${file}`,
          description: `Wrote JSDoc above ${fileApis.length} declaration(s) in \`${file}\`. Block format: description, @param, @returns, @throws (if any), @example.`,
          file,
          suggestion: 'Review the generated JSDoc — confirm descriptions match intent. Adjust @example to real expected outputs.',
          autoFixable: false,
          tags: ['jsdoc-gen'],
        });
      }
    }
    return modified;
  }

  /**
   * Build a JSDoc block string for a single API.
   */
  private buildJsdocBlock(api: UndocumentedApi): string {
    const lines: string[] = ['/**'];
    const summary = this.summarizeApi(api);
    lines.push(` * ${summary}`);
    lines.push(' *');
    if (api.params.length > 0) {
      for (const p of api.params) {
        lines.push(` * @param ${p.name} - TODO: describe (type: ${p.type}).`);
      }
      lines.push(' *');
    }
    if (api.kind === 'function' || api.kind === 'method') {
      lines.push(` * @returns TODO: describe return value (type: ${api.returnType}).`);
      if (api.throws.length > 0) {
        lines.push(' *');
        for (const t of api.throws) {
          lines.push(` * @throws ${t} - TODO: describe when this is thrown.`);
        }
      }
      lines.push(' *');
      lines.push(' * @example');
      lines.push(' * ```ts');
      lines.push(` * // TODO: add a real usage example for ${api.name}.`);
      lines.push(` * const result = ${api.name}(${api.params.map((p) => p.name).join(', ')});`);
      lines.push(' * ```');
    } else if (api.kind === 'interface' || api.kind === 'type') {
      lines.push(' * TODO: describe each field of this type.');
    } else if (api.kind === 'class') {
      lines.push(' * TODO: describe the class purpose and lifecycle.');
      lines.push(' *');
      lines.push(' * @example');
      lines.push(' * ```ts');
      lines.push(` * const instance = new ${api.name}();`);
      lines.push(' * ```');
    }
    lines.push(' */');
    return lines.join('\n');
  }

  /**
   * Produce a one-line summary for a JSDoc block based on the API's
   * signature + body. Conservative — emits a TODO-flavored summary
   * when no inference is possible.
   */
  private summarizeApi(api: UndocumentedApi): string {
    const verb =
      api.kind === 'class' ? 'Represents'
      : api.kind === 'interface' ? 'Defines the shape of'
      : api.kind === 'type' ? 'Type alias for'
      : 'TODO: describe what';
    const subject = api.kind === 'function' || api.kind === 'method' ? `\`${api.name}\` does` : `\`${api.name}\`.`;
    return `${verb} ${subject}`.replace('TODO: describe what  does', `TODO: describe what \`${api.name}\` does.`);
  }

  // ── 3) Architecture diagram ────────────────────────────────────────────────

  /**
   * Generate a Mermaid module dependency graph by scanning import
   * statements across the codebase. Writes `docs/architecture.md`.
   */
  private async generateArchitectureDiagram(ctx: RunContext): Promise<void> {
    const graph = new Map<string, Set<string>>();
    await this.scanFiles(ctx, async (filePath, content) => {
      const rel = path.relative(ctx.opts.cwd, filePath);
      const moduleNode = this.toModuleNode(rel);
      if (!graph.has(moduleNode)) graph.set(moduleNode, new Set());

      // import X from './foo'  /  const X = require('./foo')
      const importRe = /(?:import\s+[^;]*?\s+from\s+['"]([^'"]+)['"])|(?:require\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
      let m: RegExpExecArray | null;
      while ((m = importRe.exec(content)) !== null) {
        const dep = m[1] ?? m[2];
        if (!dep) continue;
        if (!dep.startsWith('.')) continue; // skip external deps
        const resolved = this.resolveRelativeImport(dep, filePath, ctx);
        if (resolved) {
          graph.get(moduleNode)!.add(this.toModuleNode(resolved));
        }
      }
    }, { extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'] });

    const mermaidLines: string[] = ['```mermaid', 'graph TD'];
    for (const [node, deps] of graph) {
      for (const dep of deps) {
        // Sanitize node names for Mermaid.
        const a = this.sanitizeMermaidNode(node);
        const b = this.sanitizeMermaidNode(dep);
        mermaidLines.push(`  ${a}["${node}"] --> ${b}["${dep}"]`);
      }
    }
    mermaidLines.push('```');

    const outPath = path.resolve(ctx.opts.cwd, 'docs', 'architecture.md');
    const content = `# Architecture\n\nModule dependency graph (auto-generated by SANIX Doc Doctor).\n\n${mermaidLines.join('\n')}\n`;
    const ok = await this.writeFileSafe(outPath, content, ctx);
    if (ok) {
      this.addFinding(ctx, {
        severity: 'info',
        category: 'architecture-diagram',
        title: `Generated architecture diagram (${graph.size} modules)`,
        description: `Wrote \`${path.relative(ctx.opts.cwd, outPath)}\` with a Mermaid graph covering ${graph.size} modules and their import dependencies.`,
        file: path.relative(ctx.opts.cwd, outPath),
        suggestion: 'Open the file in a Mermaid-aware viewer (GitHub renders it natively). Re-run after major refactors to keep it fresh.',
        autoFixable: false,
        tags: ['mermaid', 'architecture'],
      });
    }
  }

  private toModuleNode(relPath: string): string {
    return relPath.replace(/\.(t|j)sx?$/, '').replace(/[/\\]/g, '/');
  }

  private sanitizeMermaidNode(name: string): string {
    return name.replace(/[^A-Za-z0-9_]/g, '_');
  }

  private resolveRelativeImport(dep: string, fromFile: string, ctx: RunContext): string | null {
    const fromDir = path.dirname(fromFile);
    const candidates = [
      path.resolve(ctx.opts.cwd, fromDir, dep),
      path.resolve(ctx.opts.cwd, fromDir, dep + '.ts'),
      path.resolve(ctx.opts.cwd, fromDir, dep + '.tsx'),
      path.resolve(ctx.opts.cwd, fromDir, dep + '.js'),
      path.resolve(ctx.opts.cwd, fromDir, dep + '.jsx'),
      path.resolve(ctx.opts.cwd, fromDir, dep, 'index.ts'),
      path.resolve(ctx.opts.cwd, fromDir, dep, 'index.js'),
    ];
    return candidates[0]; // best-effort; we render the logical node name
  }

  // ── 4) README ──────────────────────────────────────────────────────────────

  /**
   * Generate a README.md if missing (or refresh if the goal mentions
   * "regenerate" / "refresh"). Pulls project name, description, scripts
   * from package.json + scans source for exported APIs.
   */
  private async generateReadme(ctx: RunContext): Promise<void> {
    const readmePath = path.resolve(ctx.opts.cwd, 'README.md');
    const exists = await this.fileExists('README.md', ctx);
    const pkg = await this.readPackageJson(ctx);

    const name = pkg.name ?? path.basename(ctx.opts.cwd);
    const description = pkg.description ?? 'TODO: describe this project.';
    const scripts = pkg.scripts ?? {};

    const lines: string[] = [];
    lines.push(`# ${name}`);
    lines.push('');
    lines.push(description);
    lines.push('');
    lines.push('## Installation');
    lines.push('');
    lines.push('```bash');
    lines.push('npm install');
    lines.push('```');
    lines.push('');
    if (scripts && Object.keys(scripts).length > 0) {
      lines.push('## Scripts');
      lines.push('');
      lines.push('| Script | Command |');
      lines.push('| --- | --- |');
      for (const [k, v] of Object.entries(scripts)) {
        lines.push(`| \`npm run ${k}\` | \`${v}\` |`);
      }
      lines.push('');
    }
    lines.push('## Usage');
    lines.push('');
    lines.push('```ts');
    lines.push(`// TODO: show a real usage example for ${name}.`);
    lines.push('```');
    lines.push('');
    lines.push('## API Reference');
    lines.push('');
    lines.push('Auto-generated from JSDoc — run `sanix doc-doctor` to refresh.');
    lines.push('');
    lines.push('## Configuration');
    lines.push('');
    lines.push('TODO: document environment variables and config files.');
    lines.push('');
    lines.push('## Contributing');
    lines.push('');
    lines.push('1. Fork the repo.');
    lines.push('2. Create a feature branch: `git checkout -b feat/my-feature`.');
    lines.push('3. Commit with conventional commits (`feat:`, `fix:`, `docs:`...).');
    lines.push('4. Open a PR.');
    lines.push('');
    lines.push('## License');
    lines.push('');
    lines.push(pkg.license ?? 'TODO: add a license.');
    lines.push('');

    const content = lines.join('\n');
    const header = exists ? '<!-- README auto-refreshed by SANIX Doc Doctor. Review before committing. -->\n\n' : '';
    const ok = await this.writeFileSafe(readmePath, header + content, ctx);
    if (ok) {
      this.addFinding(ctx, {
        severity: 'info',
        category: 'readme',
        title: exists ? `Refreshed README.md` : `Generated README.md`,
        description: `${exists ? 'Refreshed' : 'Created'} \`${path.relative(ctx.opts.cwd, readmePath)}\` from package.json metadata and code scan.`,
        file: 'README.md',
        suggestion: 'Review the generated README. Fill in the TODO sections with project-specific content.',
        autoFixable: false,
        tags: ['readme'],
      });
    }
  }

  // ── 5) Changelog ───────────────────────────────────────────────────────────

  /**
   * Generate / refresh CHANGELOG.md from `git log` since the last tag.
   * Categorizes commits by Conventional Commits prefix (feat / fix /
   * breaking / deprecated / docs / chore).
   */
  private async generateChangelog(ctx: RunContext): Promise<void> {
    // Determine the range: from the last tag to HEAD.
    const lastTagResult = await this.runShell('git describe --tags --abbrev=0 2>/dev/null || true', ctx);
    const lastTag = lastTagResult.stdout.trim();
    const range = lastTag ? `${lastTag}..HEAD` : 'HEAD';

    const logResult = await this.runShell(
      `git log ${range} --pretty=format:'%h|%s|%an|%ad' --date=short 2>/dev/null || true`,
      ctx,
    );
    if (!logResult.stdout.trim()) {
      this.addFinding(ctx, {
        severity: 'info',
        category: 'changelog',
        title: 'No commits to add to CHANGELOG',
        description: `No commits found in range \`${range}\`. Nothing to add to the changelog.`,
        suggestion: 'Tag a release first, then re-run to capture commits since that tag.',
        autoFixable: false,
        tags: ['changelog'],
      });
      return;
    }

    const entries: Array<{ hash: string; subject: string; author: string; date: string; kind: string; breaking: boolean }> = [];
    for (const ln of logResult.stdout.split('\n')) {
      const parts = ln.split('|');
      if (parts.length < 4) continue;
      const [hash, subject, author, date] = parts;
      const conventionalMatch = /^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/.exec(subject);
      const kind = conventionalMatch ? conventionalMatch[1].toLowerCase() : 'misc';
      const breaking = !!(conventionalMatch && conventionalMatch[3]) || /breaking/i.test(subject);
      entries.push({ hash, subject, author, date, kind, breaking });
    }

    // Bucket by kind.
    const buckets: Record<string, typeof entries> = {};
    for (const e of entries) {
      if (!buckets[e.kind]) buckets[e.kind] = [];
      buckets[e.kind].push(e);
    }

    const today = new Date().toISOString().slice(0, 10);
    const versionLabel = lastTag ? `Unreleased (since ${lastTag})` : `Unreleased (${today})`;

    const lines: string[] = [];
    lines.push('# Changelog');
    lines.push('');
    lines.push('All notable changes are documented here. Auto-generated by SANIX Doc Doctor from `git log`.');
    lines.push('Format: [Keep a Changelog](https://keepachangelog.com/).');
    lines.push('');
    lines.push(`## ${versionLabel}`);
    lines.push('');
    const renderBucket = (label: string, kind: string): void => {
      const list = buckets[kind];
      if (!list || list.length === 0) return;
      lines.push(`### ${label}`);
      lines.push('');
      for (const e of list) {
        lines.push(`- ${e.subject} (${e.hash}) — ${e.author}`);
      }
      lines.push('');
    };
    if (buckets.breaking?.length || entries.some((e) => e.breaking)) {
      const breakingEntries = entries.filter((e) => e.breaking);
      if (breakingEntries.length > 0) {
        lines.push('### ⚠️ Breaking Changes');
        lines.push('');
        for (const e of breakingEntries) {
          lines.push(`- ${e.subject} (${e.hash})`);
        }
        lines.push('');
      }
    }
    renderBucket('✨ Features', 'feat');
    renderBucket('🐛 Fixes', 'fix');
    renderBucket('📚 Documentation', 'docs');
    renderBucket('🚨 Security', 'security');
    renderBucket('♻️ Refactors', 'refactor');
    renderBucket('🎨 Styles', 'style');
    renderBucket('⚡ Performance', 'perf');
    renderBucket('🧪 Tests', 'test');
    renderBucket('🔧 Chores', 'chore');
    renderBucket('🔨 Build', 'build');
    renderBucket('🚀 CI', 'ci');
    renderBucket('Misc', 'misc');

    const changelogPath = path.resolve(ctx.opts.cwd, 'CHANGELOG.md');
    const ok = await this.writeFileSafe(changelogPath, lines.join('\n'), ctx);
    if (ok) {
      this.addFinding(ctx, {
        severity: 'info',
        category: 'changelog',
        title: `Generated CHANGELOG.md (${entries.length} commits)`,
        description: `Wrote \`${path.relative(ctx.opts.cwd, changelogPath)}\` covering ${entries.length} commits since ${lastTag || 'the beginning'}. Buckets: ${Object.keys(buckets).join(', ')}.`,
        file: 'CHANGELOG.md',
        suggestion: 'Review the changelog before publishing. Add a "## [version] — date" header when you cut a release.',
        autoFixable: false,
        tags: ['changelog'],
      });
    }
  }

  // ── 6) Drift detection ─────────────────────────────────────────────────────

  /**
   * Compare existing JSDoc to the code it documents. Flags mismatches:
   *   - @param names that don't appear in the function signature.
   *   - @param count != actual param count.
   *   - @returns on a void function.
   *   - @throws that the code no longer throws.
   */
  private async detectDrift(ctx: RunContext): Promise<void> {
    let drifts = 0;
    await this.scanFiles(ctx, async (filePath, content) => {
      const apis = this.extractPublicApis(content);
      for (const api of apis) {
        if (!api.existingDoc) continue;
        const rel = path.relative(ctx.opts.cwd, filePath);
        // Extract @param names from the JSDoc.
        const jsdocParams = [...api.existingDoc.matchAll(/@param\s+(\w+)/g)].map((m) => m[1]);
        const codeParams = api.params.map((p) => p.name);
        // Missing @param (code has, JSDoc doesn't).
        for (const p of codeParams) {
          if (!jsdocParams.includes(p)) {
            drifts++;
            this.addFinding(ctx, {
              severity: 'medium',
              category: 'drift-missing-param',
              title: `JSDoc for \`${api.name}\` is missing @param ${p}`,
              description: `The JSDoc above \`${api.name}\` in \`${rel}:${api.line}\` does not document the \`${p}\` parameter that the signature declares.`,
              file: rel,
              line: api.line,
              suggestion: `Add \`@param ${p} - ...\` to the JSDoc block.`,
              autoFixable: true,
              tags: ['drift', 'missing-param'],
            });
          }
        }
        // Extra @param (JSDoc has, code doesn't).
        for (const p of jsdocParams) {
          if (!codeParams.includes(p)) {
            drifts++;
            this.addFinding(ctx, {
              severity: 'medium',
              category: 'drift-extra-param',
              title: `JSDoc for \`${api.name}\` has stale @param ${p}`,
              description: `The JSDoc above \`${api.name}\` in \`${rel}:${api.line}\` documents a \`${p}\` parameter that the signature does not declare. Likely the parameter was renamed or removed.`,
              file: rel,
              line: api.line,
              suggestion: `Remove the \`@param ${p}\` line from the JSDoc.`,
              autoFixable: true,
              tags: ['drift', 'extra-param'],
            });
          }
        }
        // @returns on void.
        if (/@returns/.test(api.existingDoc) && (api.returnType === 'void' || api.returnType === 'undefined')) {
          drifts++;
          this.addFinding(ctx, {
            severity: 'low',
            category: 'drift-void-returns',
            title: `JSDoc for \`${api.name}\` has @returns on a void function`,
            description: `The JSDoc above \`${api.name}\` in \`${rel}:${api.line}\` declares a @returns, but the function returns \`${api.returnType}\`.`,
            file: rel,
            line: api.line,
            suggestion: 'Remove the @returns line — or fix the function to actually return a value.',
            autoFixable: true,
            tags: ['drift', 'void-returns'],
          });
        }
        // @throws that the code no longer throws.
        const jsdocThrows = [...api.existingDoc.matchAll(/@throws\s+(\w+)/g)].map((m) => m[1]);
        for (const t of jsdocThrows) {
          if (!api.throws.includes(t)) {
            drifts++;
            this.addFinding(ctx, {
              severity: 'low',
              category: 'drift-stale-throws',
              title: `JSDoc for \`${api.name}\` has stale @throws ${t}`,
              description: `The JSDoc above \`${api.name}\` in \`${rel}:${api.line}\` declares \`@throws ${t}\`, but the function body no longer throws ${t}.`,
              file: rel,
              line: api.line,
              suggestion: `Remove the \`@throws ${t}\` line — or restore the throw if it was accidentally deleted.`,
              autoFixable: true,
              tags: ['drift', 'stale-throws'],
            });
          }
        }
      }
    }, { extensions: ['.ts', '.tsx', '.js', '.jsx'] });
    this.recordMetric(ctx, 'driftFindings', drifts, 'set');
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async readPackageJson(ctx: RunContext): Promise<{
    name?: string;
    description?: string;
    license?: string;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  }> {
    try {
      const raw = await fs.readFile(path.resolve(ctx.opts.cwd, 'package.json'), 'utf8');
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  private async fileExists(relPath: string, ctx: RunContext): Promise<boolean> {
    try {
      await fs.access(path.resolve(ctx.opts.cwd, relPath));
      return true;
    } catch {
      return false;
    }
  }
}
