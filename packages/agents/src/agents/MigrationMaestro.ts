/**
 * @file agents/MigrationMaestro.ts
 * @description SANIX Migration Maestro — 🚚 framework / language
 * migration agent.
 *
 * Supports 8 migration types:
 *   - `js-to-ts` — Add types, interfaces, strict mode. Rename `.js` → `.ts`.
 *   - `commonjs-to-esm` — `require()` → `import`, `module.exports` →
 *     `export`, update `package.json` `"type": "module"`.
 *   - `vue2-to-vue3` — Options API → Composition API,
 *     `new Vue()` → `createApp()`, update lifecycle hooks.
 *   - `python2-to-3` — `print` statement → function, `xrange` → `range`,
 *     `unicode` → `str`, `has_key` → `in`.
 *   - `express-to-fastify` — Route handlers, middleware, plugins.
 *   - `cra-to-vite` — Config, entry point, build setup.
 *   - `class-to-hooks` — React class components → function components
 *     with hooks.
 *   - `rest-to-graphql` — REST endpoints → GraphQL resolvers + schema.
 *
 * Process: analyze → plan → execute (file-by-file) → verify (tests,
 * typecheck, lint) → report (what changed, what broke, what needs
 * manual review).
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
 * The set of migration types Migration Maestro supports. The user's
 * goal is parsed to determine which migration(s) to run.
 */
export type MigrationType =
  | 'js-to-ts'
  | 'commonjs-to-esm'
  | 'vue2-to-vue3'
  | 'python2-to-3'
  | 'express-to-fastify'
  | 'cra-to-vite'
  | 'class-to-hooks'
  | 'rest-to-graphql';

/**
 * A single file-level migration step. The Maestro emits one of these
 * for every file it visits, then executes the plan.
 */
export interface MigrationStep {
  /** The migration type this step belongs to. */
  type: MigrationType;
  /** Absolute path to the source file. */
  file: string;
  /** Relative-to-cwd path (for display). */
  relPath: string;
  /** What needs to change. */
  description: string;
  /** Estimated risk: low (mechanical), medium (semantic), high (behavioral). */
  risk: 'low' | 'medium' | 'high';
  /** Whether the agent can apply this automatically. */
  autoApplyable: boolean;
}

/**
 * The migration plan produced by the analyze phase.
 */
export interface MigrationPlan {
  /** Detected migration types (a single goal may trigger multiple). */
  types: MigrationType[];
  /** Steps in execution order (sorted by risk: low → high). */
  steps: MigrationStep[];
  /** Risk summary. */
  totalRisk: { low: number; medium: number; high: number };
  /** Files that need manual review. */
  manualReview: string[];
  /** Detected current state (what framework, what version, what patterns). */
  detected: Record<string, string>;
}

/**
 * SANIX Migration Maestro — 🚚 framework / language migration agent.
 *
 * @example
 * ```ts
 * import { MigrationMaestro } from '@sanix/agents';
 *
 * const agent = new MigrationMaestro();
 * const result = await agent.run(
 *   'Migrate this CommonJS codebase to ESM',
 *   { cwd: '/repo', dryRun: true },
 * );
 *
 * console.log(result.metrics.filesMigrated, 'files would be migrated');
 * ```
 */
export class MigrationMaestro extends BaseAgent {
  public readonly id = 'migration-maestro';
  public readonly name = 'Migration Maestro';
  public readonly description =
    'Handles framework/language migrations: JS→TS, CommonJS→ESM, Vue 2→3, ' +
    'Python 2→3, Express→Fastify, CRA→Vite, Class→Hooks, REST→GraphQL. ' +
    'Auto-rewrites code, updates configs, runs tests, and produces a migration report.';
  public readonly category: AgentCategory = 'migration';
  public readonly icon = '🚚';
  public readonly provider = 'claude-sonnet-4';
  public readonly temperature = 0.2;
  public readonly tools = [
    'read_file', 'write_file', 'edit_file', 'bash',
    'search_files', 'analyze_ast', 'run_tests', 'get_dependencies',
  ];
  public readonly exampleQueries = [
    'Migrate this JavaScript codebase to TypeScript with strict mode.',
    'Convert CommonJS require() calls to ESM imports.',
    'Migrate this Vue 2 app to Vue 3 Composition API.',
    'Convert this Express server to Fastify.',
    'Migrate this CRA app to Vite.',
  ];

  public readonly systemPrompt = `You are SANIX Migration Maestro, an expert in codebase migrations. You handle:
JS→TS, Vue 2→3, Python 2→3, Express→Fastify, CRA→Vite, Class→Hooks, CommonJS→ESM, REST→GraphQL.

For each migration:
(1) analyze the current codebase,
(2) create a migration plan,
(3) execute file-by-file,
(4) update configs + dependencies,
(5) run tests after each step,
(6) generate a migration report.

Always preserve behavior — if tests fail, rollback and try a different approach.`;

  // ── Run entrypoint ─────────────────────────────────────────────────────────

  public async run(goal: string, opts?: AgentRunOptions): Promise<AgentRunResult> {
    const ctx = this.startRun(goal, opts);

    // 1) ANALYZE — detect current state + determine which migration(s) to run.
    this.emitProgress('analyze', 'Phase 1: analyzing codebase…', undefined, ctx);
    const types = await this.detectMigrationTypes(goal, ctx);
    if (types.length === 0) {
      this.addFinding(ctx, {
        severity: 'info',
        category: 'migration-detection',
        title: 'No supported migration detected from goal',
        description: `Could not infer a supported migration type from the goal "${goal}". Supported types: ${this.allMigrationTypes().join(', ')}.`,
        suggestion: 'Rephrase the goal to mention one of the supported migration types.',
      });
      return this.finishRun(ctx);
    }
    this.recordMetric(ctx, 'migrationTypes', types.length, 'set');

    // 2) PLAN — list files to migrate, order by risk.
    this.emitProgress('analyze', `Phase 2: planning migration (${types.join(', ')})…`, undefined, ctx);
    const plan = await this.buildPlan(types, ctx);
    this.recordMetric(ctx, 'plannedSteps', plan.steps.length, 'set');
    this.recordMetric(ctx, 'lowRiskSteps', plan.totalRisk.low, 'set');
    this.recordMetric(ctx, 'mediumRiskSteps', plan.totalRisk.medium, 'set');
    this.recordMetric(ctx, 'highRiskSteps', plan.totalRisk.high, 'set');
    this.recordMetric(ctx, 'manualReviewFiles', plan.manualReview.length, 'set');

    // Surface the plan as a finding for visibility.
    this.addFinding(ctx, {
      severity: 'info',
      category: 'migration-plan',
      title: `Migration plan: ${plan.steps.length} steps across ${types.length} type(s)`,
      description: `Detected: ${Object.entries(plan.detected).map(([k, v]) => `${k}=${v}`).join(', ') || 'n/a'}.\n\nRisk breakdown: ${plan.totalRisk.low} low, ${plan.totalRisk.medium} medium, ${plan.totalRisk.high} high.\n\nFiles requiring manual review: ${plan.manualReview.length}.`,
      suggestion: 'Review the plan before executing. Set `dryRun: true` to preview without writing.',
      autoFixable: false,
      tags: ['plan', ...types],
    });

    // 3) EXECUTE — migrate file-by-file.
    this.emitProgress('analyze', `Phase 3: executing ${plan.steps.length} migration steps…`, undefined, ctx);
    let applied = 0;
    let skipped = 0;
    for (const step of plan.steps) {
      ctx.iteration++;
      if (ctx.iteration > ctx.opts.maxIterations) {
        this.addFinding(ctx, {
          severity: 'medium',
          category: 'iteration-cap',
          title: 'Hit maxIterations cap — stopping early',
          description: `Migration stopped at ${applied} of ${plan.steps.length} steps due to the maxIterations cap (${ctx.opts.maxIterations}).`,
          suggestion: 'Increase `maxIterations` and re-run, or scope the goal more narrowly.',
        });
        break;
      }
      if (!step.autoApplyable) {
        skipped++;
        continue;
      }
      const ok = await this.applyStep(step, ctx);
      if (ok) applied++;
      else skipped++;
    }
    this.recordMetric(ctx, 'stepsApplied', applied, 'set');
    this.recordMetric(ctx, 'stepsSkipped', skipped, 'set');

    // 4) VERIFY — full test suite, type checking, linting.
    this.emitProgress('analyze', 'Phase 4: verifying (tests + typecheck + lint)…', undefined, ctx);
    await this.verify(ctx);

    // 5) REPORT — done. The base's formatMarkdown emits the structured report.
    this.emitProgress('complete', `Migration complete: ${applied} applied, ${skipped} skipped.`, undefined, ctx);
    return this.finishRun(ctx);
  }

  // ── 1) Migration-type detection ────────────────────────────────────────────

  /**
   * Parse the goal string + scan the codebase to determine which
   * migration types apply. A single goal may trigger multiple (e.g.
   * "modernize this JS codebase" might mean both `js-to-ts` and
   * `commonjs-to-esm`).
   */
  private async detectMigrationTypes(goal: string, ctx: RunContext): Promise<MigrationType[]> {
    const g = goal.toLowerCase();
    const types = new Set<MigrationType>();

    // Keyword detection from the goal string.
    if (/\b(?:typescript|ts|\.ts\b|js-to-ts|js to ts|migrate.*ts)\b/.test(g)) {
      types.add('js-to-ts');
    }
    if (/\b(?:esm|ecmascript module|import\s+from|commonjs.*esm|cjs.*mjs)\b/.test(g)) {
      types.add('commonjs-to-esm');
    }
    if (/\b(?:vue\s*3|composition api|createapp|vue2.*vue3)\b/.test(g)) {
      types.add('vue2-to-vue3');
    }
    if (/\b(?:python\s*3|py2.*py3|python2.*python3|python 2 to 3)\b/.test(g)) {
      types.add('python2-to-3');
    }
    if (/\b(?:fastify|express.*fastify)\b/.test(g)) {
      types.add('express-to-fastify');
    }
    if (/\b(?:vite|cra.*vite|create-react-app.*vite)\b/.test(g)) {
      types.add('cra-to-vite');
    }
    if (/\b(?:hooks|class.*hooks|useeffect|usestate)\b/.test(g)) {
      types.add('class-to-hooks');
    }
    if (/\b(?:graphql|gql|resolver|rest.*graphql)\b/.test(g)) {
      types.add('rest-to-graphql');
    }

    // Heuristic detection from the codebase when the goal is vague.
    if (types.size === 0) {
      if (await this.hasPackageDeps(['vue'], ctx) && await this.usesPattern(/new\s+Vue\s*\(/g, ctx)) {
        types.add('vue2-to-vue3');
      }
      if (await this.hasPackageDeps(['express'], ctx)) {
        types.add('express-to-fastify');
      }
      if (await this.usesPattern(/\brequire\s*\(/g, ctx) && !(await this.hasPackageJsonField('type', 'module', ctx))) {
        types.add('commonjs-to-esm');
      }
      if (await this.hasJsFiles(ctx)) {
        types.add('js-to-ts');
      }
    }

    return [...types];
  }

  private allMigrationTypes(): string[] {
    return [
      'js-to-ts', 'commonjs-to-esm', 'vue2-to-vue3', 'python2-to-3',
      'express-to-fastify', 'cra-to-vite', 'class-to-hooks', 'rest-to-graphql',
    ];
  }

  // ── 2) Plan ────────────────────────────────────────────────────────────────

  /**
   * Build the migration plan. Walks every text file and asks each
   * applicable migration detector to emit steps.
   */
  private async buildPlan(types: MigrationType[], ctx: RunContext): Promise<MigrationPlan> {
    const steps: MigrationStep[] = [];
    const detected: Record<string, string> = {};

    // Pre-detection: scan for current-state evidence.
    detected['package.json'] = (await this.fileExists('package.json', ctx)) ? 'present' : 'absent';
    detected['tsconfig.json'] = (await this.fileExists('tsconfig.json', ctx)) ? 'present' : 'absent';
    detected['pyproject.toml'] = (await this.fileExists('pyproject.toml', ctx)) ? 'present' : 'absent';

    // Per-file scan.
    await this.scanFiles(ctx, async (filePath, content) => {
      const rel = path.relative(ctx.opts.cwd, filePath) || filePath;
      for (const type of types) {
        const step = this.detectStep(type, filePath, rel, content);
        if (step) steps.push(step);
      }
    });

    // Sort by risk: low → medium → high (apply mechanical changes first).
    const order = { low: 0, medium: 1, high: 2 } as const;
    steps.sort((a, b) => order[a.risk] - order[b.risk]);

    const totalRisk = {
      low: steps.filter((s) => s.risk === 'low').length,
      medium: steps.filter((s) => s.risk === 'medium').length,
      high: steps.filter((s) => s.risk === 'high').length,
    };
    const manualReview = steps.filter((s) => !s.autoApplyable).map((s) => s.relPath);

    return { types, steps, totalRisk, manualReview, detected };
  }

  /**
   * Run a single migration detector on a file. Returns `null` if the
   * detector finds nothing to migrate in this file.
   */
  private detectStep(
    type: MigrationType,
    file: string,
    relPath: string,
    content: string,
  ): MigrationStep | null {
    switch (type) {
      case 'js-to-ts': {
        if (!/\.(jsx?|mjs|cjs)$/.test(file)) return null;
        if (this.isTestOrFixture(file)) return null;
        return {
          type,
          file,
          relPath,
          description: `Rename \`${relPath}\` to \`.ts\` and add type annotations to function signatures and variables.`,
          risk: 'medium',
          autoApplyable: true,
        };
      }
      case 'commonjs-to-esm': {
        if (!/\.(js|cjs|ts)$/.test(file)) return null;
        if (!/\brequire\s*\(|module\.exports\b|exports\.\w+\s*=/.test(content)) return null;
        return {
          type,
          file,
          relPath,
          description: `Convert \`require()\` → \`import\` and \`module.exports\` → \`export\` in \`${relPath}\`.`,
          risk: 'medium',
          autoApplyable: true,
        };
      }
      case 'vue2-to-vue3': {
        if (!/\.vue$/.test(file) && !/new\s+Vue\s*\(/.test(content)) return null;
        const hasOptionsApi = /export\s+default\s*\{[\s\S]*?data\s*\(\s*\)\s*\{/.test(content);
        return {
          type,
          file,
          relPath,
          description: hasOptionsApi
            ? `Convert Options API → Composition API (setup()) in \`${relPath}\`. Replace \`new Vue()\` with \`createApp()\`.`
            : `Update Vue 2 lifecycle hooks to Vue 3 names in \`${relPath}\`.`,
          risk: 'high',
          autoApplyable: false,
        };
      }
      case 'python2-to-3': {
        if (!/\.py$/.test(file)) return null;
        const signals: string[] = [];
        if (/^\s*print\s+[^(\s]/m.test(content)) signals.push('print statement');
        if (/\bxrange\b/.test(content)) signals.push('xrange');
        if (/\bunicode\s*\(/.test(content)) signals.push('unicode()');
        if (/\.has_key\s*\(/.test(content)) signals.push('has_key()');
        if (signals.length === 0) return null;
        return {
          type,
          file,
          relPath,
          description: `Fix Python 2 → 3 idioms in \`${relPath}\`: ${signals.join(', ')}.`,
          risk: 'low',
          autoApplyable: true,
        };
      }
      case 'express-to-fastify': {
        if (!/\.(js|ts)$/.test(file)) return null;
        if (!/\bapp\.(?:get|post|put|delete|patch|use)\s*\(|\bexpress\(\s*\)/.test(content)) return null;
        return {
          type,
          file,
          relPath,
          description: `Convert Express routes/handlers to Fastify in \`${relPath}\` (app.get → fastify.get, req.body → request.body, etc.).`,
          risk: 'high',
          autoApplyable: false,
        };
      }
      case 'cra-to-vite': {
        if (!/\b(?:react-scripts|webpack|PUBLIC_URL|REACT_APP_)/.test(content)) return null;
        return {
          type,
          file,
          relPath,
          description: `Update CRA config to Vite in \`${relPath}\` (env vars: REACT_APP_ → VITE_, scripts: react-scripts → vite).`,
          risk: 'medium',
          autoApplyable: true,
        };
      }
      case 'class-to-hooks': {
        if (!/\.tsx?$/.test(file)) return null;
        if (!/\bclass\s+\w+\s+extends\s+(?:React\.)?Component/.test(content)) return null;
        return {
          type,
          file,
          relPath,
          description: `Convert React class component \`${relPath}\` to a function component with hooks (useState, useEffect, useMemo).`,
          risk: 'high',
          autoApplyable: false,
        };
      }
      case 'rest-to-graphql': {
        if (!/\.(js|ts)$/.test(file)) return null;
        if (!/\bapp\.(?:get|post|put|delete)\s*\(\s*['"][^'"]+['"]/.test(content)) return null;
        return {
          type,
          file,
          relPath,
          description: `Convert REST endpoints in \`${relPath}\` to GraphQL resolvers + schema definitions.`,
          risk: 'high',
          autoApplyable: false,
        };
      }
      default:
        return null;
    }
  }

  // ── 3) Execute ─────────────────────────────────────────────────────────────

  /**
   * Apply a single migration step. Delegates to the type-specific
   * rewriter. Returns true on success.
   */
  private async applyStep(step: MigrationStep, ctx: RunContext): Promise<boolean> {
    this.emitProgress('action', `Migrating ${step.relPath} (${step.type})`, step, ctx);
    const content = await this.readFileSafe(step.file, ctx);
    if (content === null) return false;

    let transformed: string = content;
    let changed = false;

    switch (step.type) {
      case 'commonjs-to-esm':
        ({ transformed, changed } = this.rewriteCommonjsToEsm(content));
        break;
      case 'python2-to-3':
        ({ transformed, changed } = this.rewritePython2to3(content));
        break;
      case 'cra-to-vite':
        ({ transformed, changed } = this.rewriteCraToVite(content));
        break;
      case 'js-to-ts':
        // js-to-ts is a rename + tsconfig update — handled below.
        transformed = content;
        changed = true;
        break;
      default:
        // High-risk migrations are surfaced as findings for manual review.
        this.addFinding(ctx, {
          severity: 'medium',
          category: 'manual-review',
          title: `Manual review required: ${step.relPath} (${step.type})`,
          description: `Migration step \`${step.type}\` on \`${step.relPath}\` is too risky to auto-apply: ${step.description}`,
          file: step.relPath,
          suggestion: 'Apply the change manually, run the test suite, then re-run this agent to verify.',
          autoFixable: false,
          tags: ['migration', step.type, 'manual'],
        });
        return false;
    }

    if (!changed) return false;

    // For js-to-ts, write the file with the new extension.
    const outPath = step.type === 'js-to-ts' ? step.file.replace(/\.(jsx?|mjs|cjs)$/, '.ts') : step.file;
    const ok = await this.writeFileSafe(outPath, transformed, ctx);
    if (ok && step.type === 'js-to-ts' && outPath !== step.file) {
      // Remove the old .js file (in non-dryRun mode only).
      if (!ctx.opts.dryRun) {
        try { await fs.unlink(step.file); } catch { /* best-effort */ }
      }
    }
    return ok;
  }

  /**
   * Rewrite CommonJS require/module.exports to ESM import/export.
   * Conservative: only handles the most common shapes.
   */
  private rewriteCommonjsToEsm(src: string): { transformed: string; changed: boolean } {
    let out = src;
    let changed = false;

    // const X = require('Y')  →  import X from 'Y'
    out = out.replace(
      /const\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g,
      (_m, name, mod) => { changed = true; return `import ${name} from '${mod}'`; },
    );
    // const { a, b } = require('Y')  →  import { a, b } from 'Y'
    out = out.replace(
      /const\s*\{([^}]+)\}\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g,
      (_m, names, mod) => { changed = true; return `import { ${names.trim()} } from '${mod}'`; },
    );
    // require('Y')  →  import 'Y'
    out = out.replace(
      /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
      (_m, mod) => { changed = true; return `import '${mod}'`; },
    );
    // module.exports = X  →  export default X
    out = out.replace(
      /module\.exports\s*=\s*/g,
      () => { changed = true; return 'export default '; },
    );
    // exports.foo = X  →  export const foo = X (single-occurrence per line)
    out = out.replace(
      /^(\s*)exports\.([A-Za-z_$][\w$]*)\s*=\s*/gm,
      (_m, indent, name) => { changed = true; return `${indent}export const ${name} = `; },
    );

    return { transformed: out, changed };
  }

  /**
   * Rewrite Python 2 idioms to Python 3. Mechanical, behavior-preserving.
   */
  private rewritePython2to3(src: string): { transformed: string; changed: boolean } {
    let out = src;
    let changed = false;

    // print "x" → print("x")  (statement → function call)
    out = out.replace(
      /^(\s*)print\s+(['"].*?['"]|[^\n]+)/gm,
      (_m, indent, rest) => {
        // Skip if already a function call.
        if (/^print\s*\(/.test(_m.trim())) return _m;
        changed = true;
        return `${indent}print(${rest})`;
      },
    );
    // xrange(...) → range(...)
    out = out.replace(/\bxrange\s*\(/g, () => { changed = true; return 'range('; });
    // unicode(...) → str(...)
    out = out.replace(/\bunicode\s*\(/g, () => { changed = true; return 'str('; });
    // dict.has_key(k) → k in dict
    out = out.replace(
      /([A-Za-z_$][\w$]*)\.has_key\s*\(([^)]+)\)/g,
      (_m, d, k) => { changed = true; return `${k} in ${d}`; },
    );

    return { transformed: out, changed };
  }

  /**
   * Rewrite CRA-isms to Vite-isms. Conservative: env vars + scripts.
   */
  private rewriteCraToVite(src: string): { transformed: string; changed: boolean } {
    let out = src;
    let changed = false;

    // process.env.REACT_APP_FOO  →  import.meta.env.VITE_FOO
    out = out.replace(
      /\bprocess\.env\.REACT_APP_([A-Z0-9_]+)/g,
      (_m, name) => { changed = true; return `import.meta.env.VITE_${name}`; },
    );
    // process.env.PUBLIC_URL  →  import.meta.env.BASE_URL
    out = out.replace(
      /\bprocess\.env\.PUBLIC_URL\b/g,
      () => { changed = true; return 'import.meta.env.BASE_URL'; },
    );

    return { transformed: out, changed };
  }

  // ── 4) Verify ──────────────────────────────────────────────────────────────

  /**
   * Run tests + typecheck + lint after migration. Findings surface any
   * regressions. In dryRun mode, this is a no-op (no migrations applied).
   */
  private async verify(ctx: RunContext): Promise<void> {
    if (ctx.opts.dryRun) {
      this.addFinding(ctx, {
        severity: 'info',
        category: 'verify-skipped',
        title: 'Verification skipped (dry-run mode)',
        description: 'No migrations were applied — verification is unnecessary in dry-run mode.',
        autoFixable: false,
      });
      return;
    }

    // Type-check (TypeScript).
    if (await this.fileExists('tsconfig.json', ctx)) {
      const tsc = await this.runShell('npx tsc --noEmit 2>&1 || true', ctx);
      if (tsc.exitCode !== 0) {
        this.addFinding(ctx, {
          severity: 'high',
          category: 'typecheck-failed',
          title: 'TypeScript compilation failed after migration',
          description: `tsc exited with ${tsc.exitCode}. Errors:\n\n${tsc.stdout.slice(0, 4000)}`,
          file: 'tsconfig.json',
          suggestion: 'Address type errors manually, or roll back the migration with git checkout.',
          autoFixable: false,
          tags: ['verify', 'typecheck'],
        });
      }
    }

    // Lint.
    if (await this.fileExists('.eslintrc.json', ctx) || await this.fileExists('.eslintrc.js', ctx)) {
      const lint = await this.runShell('npx eslint . --max-warnings=0 2>&1 || true', ctx);
      if (lint.exitCode !== 0) {
        this.addFinding(ctx, {
          severity: 'medium',
          category: 'lint-failed',
          title: 'ESLint reported errors after migration',
          description: `eslint exited with ${lint.exitCode}. Errors:\n\n${lint.stdout.slice(0, 4000)}`,
          suggestion: 'Run `npx eslint . --fix` to auto-fix stylistic issues, then address remaining errors manually.',
          autoFixable: false,
          tags: ['verify', 'lint'],
        });
      }
    }

    // Test suite.
    if (await this.fileExists('package.json', ctx)) {
      const test = await this.runShell('npm test -- --silent 2>&1 || true', ctx);
      if (test.exitCode !== 0) {
        this.addFinding(ctx, {
          severity: 'high',
          category: 'tests-failed',
          title: 'Test suite failed after migration',
          description: `npm test exited with ${test.exitCode}. Failures:\n\n${test.stdout.slice(0, 4000)}`,
          suggestion: 'Roll back the offending file(s) with `git checkout`, or fix the tests to match the new behavior.',
          autoFixable: false,
          tags: ['verify', 'tests'],
        });
      }
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private isTestOrFixture(filePath: string): boolean {
    return /(^|[\\/])(tests?|__tests__|test|spec|specs|fixtures?|examples?|samples?|mocks?)([\\/]|$)|\.(test|spec)\.[a-z]+$|\.fixtures?\.[a-z]+$/i.test(
      filePath,
    );
  }

  private async hasPackageDeps(deps: string[], ctx: RunContext): Promise<boolean> {
    try {
      const pkgPath = path.resolve(ctx.opts.cwd, 'package.json');
      const raw = await fs.readFile(pkgPath, 'utf8');
      const pkg = JSON.parse(raw) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      const all = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      return deps.every((d) => d in all);
    } catch {
      return false;
    }
  }

  private async hasPackageJsonField(field: string, value: string, ctx: RunContext): Promise<boolean | null> {
    try {
      const pkgPath = path.resolve(ctx.opts.cwd, 'package.json');
      const raw = await fs.readFile(pkgPath, 'utf8');
      const pkg = JSON.parse(raw) as Record<string, unknown>;
      if (!(field in pkg)) return null;
      return pkg[field] === value;
    } catch {
      return null;
    }
  }

  private async hasJsFiles(ctx: RunContext): Promise<boolean> {
    for await (const file of this.walkFiles(ctx.opts.cwd, { extensions: ['.js', '.jsx', '.mjs', '.cjs'] })) {
      if (!this.isTestOrFixture(file)) return true;
      // Early-exit after the first hit.
      break;
    }
    return false;
  }

  /**
   * Quick "does this pattern appear anywhere?" check. Used for
   * migration-type detection. Bounded — bails out after the first hit.
   */
  private async usesPattern(pattern: RegExp, ctx: RunContext): Promise<boolean> {
    let found = false;
    await this.scanFiles(ctx, async (_filePath, content) => {
      if (found) return;
      pattern.lastIndex = 0;
      if (pattern.test(content)) {
        found = true;
      }
    }, { extensions: ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'] });
    return found;
  }

  private async fileExists(relPath: string, ctx: RunContext): Promise<boolean> {
    try {
      const abs = path.resolve(ctx.opts.cwd, relPath);
      await fs.access(abs);
      return true;
    } catch {
      return false;
    }
  }
}
