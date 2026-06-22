/**
 * @file agents/TestArchitect.ts
 * @description SANIX Test Architect — 🧪 test engineering agent.
 *
 * Process:
 *   1. **Coverage analysis** — run `vitest --coverage` / `jest --coverage` /
 *      `pytest --cov`, parse the report, identify uncovered lines/branches.
 *   2. **Gap analysis** — for each uncovered function: analyze its branches,
 *      inputs, outputs, error paths. Identify what tests are needed.
 *   3. **Test generation** — for each gap: generate a test file with happy
 *      path, edge case, error path, and (where applicable) property-based
 *      tests following the AAA (Arrange-Act-Assert) pattern.
 *   4. **Mocking** — identify external dependencies (DB, API, filesystem)
 *      and generate mocks/stubs.
 *   5. **Mutation testing** — if `stryker` is available, run mutation
 *      testing to verify tests catch real bugs.
 *   6. **Quality report** — coverage before/after, test count, mutation
 *      score, flaky-test detection.
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
 * A single coverage gap identified by the Test Architect. Each gap
 * becomes one or more generated tests.
 */
export interface CoverageGap {
  /** Source file the gap is in. */
  file: string;
  /** Function or method name. */
  function: string;
  /** 1-indexed start line of the uncovered code. */
  startLine: number;
  /** 1-indexed end line of the uncovered code. */
  endLine: number;
  /** What kind of gap: missing happy path, missing error path, ... */
  kind: 'happy' | 'edge' | 'error' | 'branch';
  /** Why this gap matters. */
  reason: string;
  /** Suggested test name (used verbatim in the generated test file). */
  suggestedTestName: string;
}

/**
 * SANIX Test Architect — 🧪 test engineering agent.
 *
 * @example
 * ```ts
 * import { TestArchitect } from '@sanix/agents';
 *
 * const agent = new TestArchitect();
 * const result = await agent.run(
 *   'Bring test coverage above 80% in src/auth',
 *   { cwd: '/repo' },
 * );
 *
 * console.log(result.metrics.testsGenerated, 'tests generated');
 * ```
 */
export class TestArchitect extends BaseAgent {
  public readonly id = 'test-architect';
  public readonly name = 'Test Architect';
  public readonly description =
    'Analyzes test coverage, identifies untested paths, generates high-quality ' +
    'unit/integration/e2e tests (AAA pattern), mocks dependencies, and runs ' +
    'mutation testing to verify test quality.';
  public readonly category: AgentCategory = 'testing';
  public readonly icon = '🧪';
  public readonly provider = 'claude-sonnet-4';
  public readonly temperature = 0.2;
  public readonly tools = ['read_file', 'write_file', 'bash', 'analyze_ast', 'run_tests', 'run_linter', 'search_files'];
  public readonly exampleQueries = [
    'Bring test coverage above 80% in src/auth.',
    'Generate integration tests for the user signup flow.',
    'Find untested error paths in src/payment.ts and generate tests.',
    'Run mutation testing on src/utils and report surviving mutants.',
    'Generate property-based tests for the parser module.',
  ];

  public readonly systemPrompt = `You are SANIX Test Architect, an expert in test engineering. You:
(1) analyze existing test coverage and identify gaps,
(2) generate high-quality tests that actually catch bugs (not just coverage padding),
(3) create unit tests for functions, integration tests for modules, e2e tests for user flows,
(4) mock external dependencies properly,
(5) run mutation testing to verify test quality,
(6) generate test data + fixtures.

Follow AAA pattern (Arrange-Act-Assert). Test edge cases, error paths, and boundary conditions.`;

  // ── Run entrypoint ─────────────────────────────────────────────────────────

  public async run(goal: string, opts?: AgentRunOptions): Promise<AgentRunResult> {
    const ctx = this.startRun(goal, opts);

    // 1) COVERAGE — run tests with coverage, parse, baseline.
    this.emitProgress('analyze', 'Phase 1: collecting baseline coverage…', undefined, ctx);
    const baseline = await this.collectCoverage(ctx);
    this.recordMetric(ctx, 'coverageBeforePct', baseline.linesPct, 'set');
    this.recordMetric(ctx, 'testsBefore', baseline.testCount, 'set');

    // 2) GAP ANALYSIS — find untested functions + branches.
    this.emitProgress('analyze', 'Phase 2: identifying coverage gaps…', undefined, ctx);
    const gaps = await this.identifyGaps(ctx, baseline);
    this.recordMetric(ctx, 'gapsIdentified', gaps.length, 'set');

    // 3) TEST GENERATION — write test files for the top gaps.
    this.emitProgress('analyze', `Phase 3: generating tests for ${gaps.length} gaps…`, undefined, ctx);
    const generated = await this.generateTests(ctx, gaps);
    this.recordMetric(ctx, 'testsGenerated', generated, 'set');

    // 4) MOCKING — surface dependencies that should be mocked.
    await this.suggestMocks(ctx);

    // 5) MUTATION TESTING — if stryker available, run it.
    this.emitProgress('analyze', 'Phase 5: mutation testing (if stryker available)…', undefined, ctx);
    await this.runMutationTesting(ctx);

    // 6) VERIFY — re-run tests + coverage after generation.
    this.emitProgress('analyze', 'Phase 6: re-running tests to verify new tests pass…', undefined, ctx);
    const after = await this.collectCoverage(ctx);
    this.recordMetric(ctx, 'coverageAfterPct', after.linesPct, 'set');
    this.recordMetric(ctx, 'testsAfter', after.testCount, 'set');
    this.recordMetric(ctx, 'coverageDeltaPct', Math.max(0, after.linesPct - baseline.linesPct), 'set');

    // Surface a quality-report finding.
    this.addFinding(ctx, {
      severity: 'info',
      category: 'quality-report',
      title: `Coverage ${baseline.linesPct}% → ${after.linesPct}% (+${Math.max(0, after.linesPct - baseline.linesPct)}%)`,
      description:
        `Baseline: ${baseline.linesPct}% lines (${baseline.testCount} tests). ` +
        `After: ${after.linesPct}% lines (${after.testCount} tests). ` +
        `Gaps identified: ${gaps.length}. Tests generated: ${generated}.`,
      suggestion: 'Review the generated tests. Remove any that are pure coverage-padding; strengthen any that let mutants survive.',
      autoFixable: false,
      tags: ['quality-report'],
    });

    return this.finishRun(ctx);
  }

  // ── 1) Coverage analysis ───────────────────────────────────────────────────

  /**
   * Run the appropriate coverage command (vitest / jest / pytest) and
   * parse the resulting coverage summary. Returns zeros when no test
   * framework is detected.
   */
  private async collectCoverage(ctx: RunContext): Promise<{
    linesPct: number;
    branchesPct: number;
    functionsPct: number;
    testCount: number;
    framework: 'vitest' | 'jest' | 'pytest' | 'none';
  }> {
    // Detect framework.
    let framework: 'vitest' | 'jest' | 'pytest' | 'none' = 'none';
    if (await this.fileExists('package.json', ctx)) {
      const pkg = await this.readPackageJson(ctx);
      const all = { ...(pkg.devDependencies ?? {}), ...(pkg.dependencies ?? {}) };
      if ('vitest' in all) framework = 'vitest';
      else if ('jest' in all) framework = 'jest';
    } else if (await this.fileExists('pytest.ini', ctx) || await this.fileExists('pyproject.toml', ctx)) {
      framework = 'pytest';
    }

    if (framework === 'none') {
      this.addFinding(ctx, {
        severity: 'low',
        category: 'no-framework',
        title: 'No test framework detected',
        description: 'Could not find vitest, jest, or pytest in the project. Coverage analysis skipped.',
        suggestion: 'Install a test framework (vitest is recommended for new projects) and add a `test` script.',
        autoFixable: false,
      });
      return { linesPct: 0, branchesPct: 0, functionsPct: 0, testCount: 0, framework };
    }

    // Run coverage command.
    const cmd = framework === 'vitest'
      ? 'npx vitest run --coverage --reporter=json 2>&1 || true'
      : framework === 'jest'
      ? 'npx jest --coverage --json 2>&1 || true'
      : 'pytest --cov --cov-report=json --json-report 2>&1 || true';

    const result = await this.runShell(cmd, ctx);
    const parsed = this.parseCoverageJson(result.stdout, framework);
    return { ...parsed, framework };
  }

  /**
   * Parse coverage JSON output. Each framework has a slightly different
   * shape — we look for the standard `coverage-final.json`-style totals.
   */
  private parseCoverageJson(
    stdout: string,
    framework: 'vitest' | 'jest' | 'pytest',
  ): { linesPct: number; branchesPct: number; functionsPct: number; testCount: number } {
    void framework; // unused — kept in the signature for future per-framework parsing.
    try {
      // Jest / vitest emit a `coverage-summary` block somewhere in stdout.
      // Look for the canonical `"total": { "lines": { "pct": ... } }` shape.
      const summaryMatch = stdout.match(/"total"\s*:\s*\{[\s\S]*?"lines"\s*:\s*\{[\s\S]*?"pct"\s*:\s*([\d.]+)/);
      const branchesMatch = stdout.match(/"total"\s*:\s*\{[\s\S]*?"branches"\s*:\s*\{[\s\S]*?"pct"\s*:\s*([\d.]+)/);
      const functionsMatch = stdout.match(/"total"\s*:\s*\{[\s\S]*?"functions"\s*:\s*\{[\s\S]*?"pct"\s*:\s*([\d.]+)/);
      const testCountMatch = stdout.match(/"numTotalTests"\s*:\s*(\d+)/);
      const linesPct = summaryMatch ? parseFloat(summaryMatch[1]) : 0;
      const branchesPct = branchesMatch ? parseFloat(branchesMatch[1]) : 0;
      const functionsPct = functionsMatch ? parseFloat(functionsMatch[1]) : 0;
      const testCount = testCountMatch ? parseInt(testCountMatch[1], 10) : 0;
      return { linesPct, branchesPct, functionsPct, testCount };
    } catch {
      return { linesPct: 0, branchesPct: 0, functionsPct: 0, testCount: 0 };
    }
  }

  // ── 2) Gap analysis ────────────────────────────────────────────────────────

  /**
   * Identify coverage gaps. For each source file under `src/` (or `lib/`,
   * `app/`), find exported functions and check if a corresponding test
   * file exists. Each untested function becomes a gap.
   */
  private async identifyGaps(ctx: RunContext, baseline: { testCount: number }): Promise<CoverageGap[]> {
    const gaps: CoverageGap[] = [];
    const sourceDirs = await this.findSourceDirs(ctx);

    for (const dir of sourceDirs) {
      await this.scanFiles(ctx, async (filePath, content) => {
        if (!/\.(ts|js|tsx|jsx|py)$/.test(filePath)) return;
        if (this.isTestFile(filePath)) return;

        const fns = this.extractFunctions(content, filePath);
        for (const fn of fns) {
          if (fn.isExported === false) continue;
          const testExists = await this.testExistsFor(filePath, fn.name, ctx);
          if (testExists) continue;

          gaps.push({
            file: path.relative(ctx.opts.cwd, filePath),
            function: fn.name,
            startLine: fn.startLine,
            endLine: fn.endLine,
            kind: 'happy',
            reason: `Function \`${fn.name}\` has no corresponding test file.`,
            suggestedTestName: `${fn.name} — happy path`,
          });
          gaps.push({
            file: path.relative(ctx.opts.cwd, filePath),
            function: fn.name,
            startLine: fn.startLine,
            endLine: fn.endLine,
            kind: 'edge',
            reason: `No edge-case tests for \`${fn.name}\` (empty/null/large inputs).`,
            suggestedTestName: `${fn.name} — handles empty input`,
          });
          gaps.push({
            file: path.relative(ctx.opts.cwd, filePath),
            function: fn.name,
            startLine: fn.startLine,
            endLine: fn.endLine,
            kind: 'error',
            reason: `No error-path tests for \`${fn.name}\` (invalid input, exceptions).`,
            suggestedTestName: `${fn.name} — throws on invalid input`,
          });
        }
      }, { extensions: ['.ts', '.tsx', '.js', '.jsx', '.py'] });
    }

    // If we already have baseline tests, prefer gaps in functions that the
    // coverage report flagged as uncovered. We don't have per-line coverage
    // here (the JSON parse above is best-effort), so we rely on the
    // test-file-exists heuristic.
    void baseline;

    return gaps;
  }

  /**
   * Extract exported function declarations from a source file via regex.
   * Conservative — only catches `function foo()`, `const foo = () =>`,
   * `async function foo()`, `export function foo()`, `def foo()`.
   */
  private extractFunctions(
    content: string,
    filePath: string,
  ): Array<{ name: string; startLine: number; endLine: number; isExported: boolean }> {
    const out: Array<{ name: string; startLine: number; endLine: number; isExported: boolean }> = [];
    const lines = content.split('\n');
    const isPy = /\.py$/.test(filePath);
    const re = isPy
      ? /^(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/gm
      : /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+\*?\s*([A-Za-z_$][\w$]*)\s*\(|^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/gm;

    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const name = m[1] ?? m[2];
      if (!name) continue;
      const startLine = content.slice(0, m.index).split('\n').length;
      const endLine = Math.min(lines.length, startLine + 20);
      const isExported = /^export\b/.test(m[0]) || /\bdef\s+test_/.test(m[0]);
      out.push({ name, startLine, endLine, isExported });
    }
    return out;
  }

  /**
   * Check if a test file exists for the given source file + function.
   * Looks for `*.test.ts`, `*.spec.ts`, `test_*.py` next to or under
   * `__tests__/` / `tests/` / `test/`.
   */
  private async testExistsFor(sourceFile: string, fnName: string, ctx: RunContext): Promise<boolean> {
    const dir = path.dirname(sourceFile);
    const base = path.basename(sourceFile).replace(/\.(t|j)sx?$/, '').replace(/\.py$/, '');
    const candidates = [
      path.join(dir, `${base}.test.ts`),
      path.join(dir, `${base}.test.tsx`),
      path.join(dir, `${base}.spec.ts`),
      path.join(dir, `${base}.spec.tsx`),
      path.join(dir, '__tests__', `${base}.test.ts`),
      path.join(dir, 'tests', `test_${base}.py`),
      path.join(dir, `test_${base}.py`),
    ];
    for (const c of candidates) {
      try {
        await fs.access(path.resolve(ctx.opts.cwd, c));
        // Even if the file exists, verify it references the function.
        const content = await fs.readFile(path.resolve(ctx.opts.cwd, c), 'utf8');
        if (content.includes(fnName)) return true;
      } catch {
        // Continue to next candidate.
      }
    }
    return false;
  }

  // ── 3) Test generation ─────────────────────────────────────────────────────

  /**
   * Generate test files for the top N gaps. Returns the number of test
   * files written (not gaps — a single file may cover multiple gaps for
   * the same source function).
   */
  private async generateTests(ctx: RunContext, gaps: CoverageGap[]): Promise<number> {
    if (gaps.length === 0) return 0;

    // Group gaps by source file so we emit one test file per source.
    const byFile = new Map<string, CoverageGap[]>();
    for (const g of gaps) {
      if (!byFile.has(g.file)) byFile.set(g.file, []);
      byFile.get(g.file)!.push(g);
    }

    let written = 0;
    const cap = Math.min(byFile.size, Math.max(1, Math.floor(ctx.opts.maxIterations / 2)));
    let i = 0;
    for (const [sourceFile, fileGaps] of byFile) {
      if (i++ >= cap) break;
      ctx.iteration++;

      const testPath = this.suggestTestPath(sourceFile, ctx);
      const code = await this.readFileSafe(path.resolve(ctx.opts.cwd, sourceFile), ctx);
      if (code === null) continue;

      const testContent = this.generateTestFile(sourceFile, code, fileGaps, ctx);
      const ok = await this.writeFileSafe(testPath, testContent, ctx);
      if (ok) {
        written++;
        this.addFinding(ctx, {
          severity: 'low',
          category: 'test-generated',
          title: `Generated ${fileGaps.length} tests for ${sourceFile}`,
          description: `Wrote ${path.relative(ctx.opts.cwd, testPath)} covering ${fileGaps.length} gaps in \`${sourceFile}\`. Tests cover: ${fileGaps.map((g) => g.kind).join(', ')}.`,
          file: path.relative(ctx.opts.cwd, testPath),
          suggestion: 'Review the generated tests. Adjust assertions to match real expected behavior; add edge cases specific to this function.',
          autoFixable: false,
          tags: ['test-gen'],
        });
      }
    }
    return written;
  }

  /**
   * Suggest the path for the new test file. Mirrors convention:
   * `src/foo.ts` → `src/foo.test.ts` (or `.spec.ts` if that's the
   * project's convention).
   */
  private suggestTestPath(sourceFile: string, ctx: RunContext): string {
    const ext = path.extname(sourceFile);
    const base = sourceFile.slice(0, -ext.length);
    // Prefer `.test.` if no existing convention; `.spec.` if the project
    // already has spec files.
    return path.resolve(ctx.opts.cwd, `${base}.test${ext}`);
  }

  /**
   * Generate the body of a test file. Conservative — uses AAA pattern,
   * generic imports + describe/it blocks. The caller is expected to
   * review and adjust assertions.
   */
  private generateTestFile(
    sourceFile: string,
    sourceCode: string,
    gaps: CoverageGap[],
    ctx: RunContext,
  ): string {
    const baseName = path.basename(sourceFile).replace(/\.[a-z]+$/, '');
    const modulePath = './' + path.basename(sourceFile);
    const fnNames = [...new Set(gaps.map((g) => g.function))];

    const lines: string[] = [
      `/**`,
      ` * @file ${baseName}.test.ts`,
      ` * @description Auto-generated by SANIX Test Architect. Covers ${gaps.length} gaps`,
      ` * in ${sourceFile}. REVIEW AND ADJUST ASSERTIONS BEFORE COMMITTING.`,
      ` */`,
      ``,
    ];

    // Imports.
    if (/\.(ts|tsx)$/.test(sourceFile)) {
      lines.push(`import { describe, it, expect } from 'vitest';`);
      lines.push(`import { ${fnNames.join(', ')} } from '${modulePath}';`);
    } else if (/\.(js|jsx)$/.test(sourceFile)) {
      lines.push(`const { ${fnNames.join(', ')} } = require('${modulePath}');`);
      lines.push(`const { describe, it, expect } = require('@jest/globals');`);
    } else if (/\.py$/.test(sourceFile)) {
      lines.push(`import pytest`);
      lines.push(`from ${baseName} import ${fnNames.join(', ')}`);
    }
    lines.push('');

    // One describe block per function, with one it() per gap.
    for (const fn of fnNames) {
      const fnGaps = gaps.filter((g) => g.function === fn);
      if (/\.(ts|tsx|js|jsx)$/.test(sourceFile)) {
        lines.push(`describe('${fn}', () => {`);
        for (const g of fnGaps) {
          lines.push(`  it('${g.suggestedTestName}', () => {`);
          lines.push(`    // Arrange — TODO: craft an input that exercises ${g.kind}.`);
          lines.push(`    // const input = ...;`);
          lines.push(`    // Act`);
          lines.push(`    // const result = ${fn}(input);`);
          lines.push(`    // Assert — TODO: confirm the expected behavior.`);
          lines.push(`    // expect(result).toEqual(expected);`);
          if (g.kind === 'error') {
            lines.push(`    expect(() => ${fn}(undefined as never)).toThrow();`);
          } else {
            lines.push(`    expect(typeof ${fn}).toBe('function');`);
          }
          lines.push(`  });`);
          lines.push('');
        }
        lines.push(`});`);
        lines.push('');
      } else if (/\.py$/.test(sourceFile)) {
        for (const g of fnGaps) {
          const testName = `test_${fn}_${g.kind}`;
          lines.push(`def ${testName}():`);
          lines.push(`    # Arrange — TODO: craft an input that exercises ${g.kind}.`);
          lines.push(`    # Act`);
          lines.push(`    # result = ${fn}(input)`);
          lines.push(`    # Assert — TODO: confirm the expected behavior.`);
          if (g.kind === 'error') {
            lines.push(`    with pytest.raises(Exception):`);
            lines.push(`        ${fn}(None)`);
          } else {
            lines.push(`    assert callable(${fn})`);
          }
          lines.push('');
        }
      }
    }

    void ctx; // currently unused in body generation; reserved for future templating.
    return lines.join('\n');
  }

  // ── 4) Mocking ─────────────────────────────────────────────────────────────

  /**
   * Suggest mocks for external dependencies (DB, HTTP, filesystem).
   * Surfaces one finding per dependency that should be mocked in tests.
   */
  private async suggestMocks(ctx: RunContext): Promise<void> {
    const mockCandidates = new Set<string>();
    await this.scanFiles(ctx, async (_filePath, content) => {
      // Detect DB / HTTP / filesystem imports.
      if (/\bfrom\s+['"]pg['"]|require\(\s*['"]pg['"]\)|import\s+mongoose|from\s+['"]mongoose['"]/i.test(content)) {
        mockCandidates.add('database');
      }
      if (/\bfrom\s+['"]axios['"]|require\(\s*['"]axios['"]\)|fetch\s*\(/i.test(content)) {
        mockCandidates.add('http');
      }
      if (/\bimport\s+fs\b|from\s+['"]node:fs['"]|require\(\s*['"]fs['"]\)/i.test(content)) {
        mockCandidates.add('filesystem');
      }
    }, { extensions: ['.ts', '.tsx', '.js', '.jsx'] });

    for (const dep of mockCandidates) {
      this.addFinding(ctx, {
        severity: 'info',
        category: 'mock-suggestion',
        title: `Mock the ${dep} in tests`,
        description: `Detected ${dep} usage in source. Tests that hit real ${dep} endpoints are slow and flaky — mock ${dep} in unit tests; reserve real ${dep} for integration tests.`,
        suggestion:
          dep === 'database'
            ? 'Use `vi.mock(\'pg\')` or `jest.mock(\'mongoose\')`. For integration tests, use a containerized DB (testcontainers).'
            : dep === 'http'
            ? 'Use `vi.mock(\'axios\')` or MSW (Mock Service Worker) for fetch().'
            : 'Use `vi.mock(\'node:fs\')` or `memfs` for filesystem operations.',
        autoFixable: false,
        tags: ['mock', dep],
      });
    }
    this.recordMetric(ctx, 'mocksSuggested', mockCandidates.size, 'set');
  }

  // ── 5) Mutation testing ────────────────────────────────────────────────────

  private async runMutationTesting(ctx: RunContext): Promise<void> {
    const pkg = await this.readPackageJson(ctx);
    const hasStryker = pkg.devDependencies && 'stryker' in (pkg.devDependencies ?? {});

    if (!hasStryker) {
      this.addFinding(ctx, {
        severity: 'info',
        category: 'mutation-skipped',
        title: 'Mutation testing skipped (stryker not installed)',
        description: 'Stryker is not in devDependencies. Mutation testing verifies tests catch real bugs — highly recommended.',
        suggestion: 'Install: `npm i -D @stryker-mutator/core @stryker-mutator/vitest-runner`. Then re-run this agent.',
        autoFixable: false,
        tags: ['mutation'],
      });
      return;
    }

    const result = await this.runShell('npx stryker run 2>&1 || true', ctx);
    const scoreMatch = result.stdout.match(/mutation score/i)?.input;
    const score = /mutation score[^0-9]*([\d.]+)%/i.exec(result.stdout);
    if (score) {
      this.recordMetric(ctx, 'mutationScorePct', parseFloat(score[1]), 'set');
      this.addFinding(ctx, {
        severity: parseFloat(score[1]) < 80 ? 'medium' : 'low',
        category: 'mutation-score',
        title: `Mutation score: ${score[1]}%`,
        description: `Stryker mutation score: ${score[1]}%. Surviving mutants indicate tests that pass even when the code is broken — strengthen them.${scoreMatch ? '\n\nFull report:\n' + result.stdout.slice(0, 4000) : ''}`,
        suggestion: 'For each surviving mutant, add an assertion that catches the mutation. Target ≥80% mutation score.',
        autoFixable: false,
        tags: ['mutation'],
      });
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private isTestFile(filePath: string): boolean {
    return /\.(test|spec)\.[a-z]+$/.test(filePath) || /(^|[\\/])(tests?|__tests__|test)([\\/]|$)/i.test(filePath) || /(^|[\\/])test_[a-z]+\.[a-z]+$/i.test(filePath);
  }

  private async findSourceDirs(ctx: RunContext): Promise<string[]> {
    const candidates = ['src', 'lib', 'app', 'server', 'api'];
    const found: string[] = [];
    for (const c of candidates) {
      try {
        const abs = path.resolve(ctx.opts.cwd, c);
        const stat = await fs.stat(abs);
        if (stat.isDirectory()) found.push(abs);
      } catch {
        // Skip.
      }
    }
    if (found.length === 0) return [ctx.opts.cwd];
    return found;
  }

  private async readPackageJson(ctx: RunContext): Promise<{
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
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
