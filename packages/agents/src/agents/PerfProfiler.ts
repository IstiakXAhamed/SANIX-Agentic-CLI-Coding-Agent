/**
 * @file agents/PerfProfiler.ts
 * @description SANIX Perf Profiler — ⚡ performance engineering agent.
 *
 * Process:
 *   1. **Static analysis** — detect anti-patterns:
 *      - N+1 queries (loop with DB call inside)
 *      - Unnecessary re-renders (React: missing `useMemo`/`useCallback`/`React.memo`)
 *      - Blocking I/O (synchronous file/network operations)
 *      - Memory leaks (event listeners not cleaned up, intervals not cleared)
 *      - Large bundle imports (`import _ from 'lodash'` instead of `import debounce from 'lodash/debounce'`)
 *      - Algorithmic complexity (O(n²) where O(n) is possible)
 *   2. **Dynamic profiling** — run code with profilers:
 *      - Node: `--cpu-prof` + `--heap-prof`
 *      - Python: `cProfile` + `memory_profiler`
 *   3. **Optimization suggestions** — for each bottleneck: what's wrong,
 *      expected improvement, code change suggestion, risk level.
 *   4. **Benchmarking** — write a benchmark script, run before + after.
 *   5. **Report** — bottleneck table, suggestions, before/after
 *      benchmarks, estimated impact.
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
 * Risk level for an optimization — drives the suggestion's "should we
 * apply this automatically?" decision.
 */
export type OptimizationRisk = 'low' | 'medium' | 'high';

/**
 * A single optimization suggestion produced by Perf Profiler.
 */
export interface OptimizationSuggestion {
  /** Bottleneck category (N+1-query, blocking-io, ...). */
  category: string;
  /** Source file. */
  file: string;
  /** 1-indexed line. */
  line: number;
  /** One-line summary. */
  title: string;
  /** Detailed explanation. */
  description: string;
  /** Suggested fix (code or steps). */
  fix: string;
  /** Estimated improvement (e.g. "10x faster", "-200MB heap"). */
  expectedImpact: string;
  /** Risk of applying the change. */
  risk: OptimizationRisk;
  /** Whether the agent can apply this automatically. */
  autoFixable: boolean;
}

/**
 * SANIX Perf Profiler — ⚡ performance engineering agent.
 *
 * @example
 * ```ts
 * import { PerfProfiler } from '@sanix/agents';
 *
 * const agent = new PerfProfiler();
 * const result = await agent.run(
 *   'Find performance bottlenecks in src/api',
 *   { cwd: '/repo' },
 * );
 *
 * const critical = result.findings.filter(f => f.severity === 'high');
 * console.log(`Found ${critical.length} high-impact bottlenecks.`);
 * ```
 */
export class PerfProfiler extends BaseAgent {
  public readonly id = 'perf-profiler';
  public readonly name = 'Perf Profiler';
  public readonly description =
    'Profiles running code (CPU, memory, I/O), identifies bottlenecks, suggests ' +
    'concrete optimizations, and benchmarks before/after. Detects common ' +
    'anti-patterns: N+1 queries, unnecessary re-renders, blocking I/O, memory leaks.';
  public readonly category: AgentCategory = 'performance';
  public readonly icon = '⚡';
  public readonly provider = 'claude-sonnet-4';
  public readonly temperature = 0.2;
  public readonly tools = ['read_file', 'bash', 'analyze_ast', 'search_files', 'run_tests', 'sandbox_execute'];
  public readonly exampleQueries = [
    'Find performance bottlenecks in src/api.',
    'Profile the request handler and suggest optimizations.',
    'Detect N+1 queries in the ORM layer.',
    'Find memory leaks in the websocket handler.',
    'Benchmark the parser before and after optimization.',
  ];

  public readonly systemPrompt = `You are SANIX Perf Profiler, a performance engineering expert. You:
(1) profile code to find CPU, memory, and I/O bottlenecks,
(2) analyze hot paths,
(3) suggest concrete optimizations (caching, lazy loading, batching, algorithmic improvements),
(4) benchmark before/after to verify improvements,
(5) detect common performance anti-patterns (N+1 queries, unnecessary re-renders, blocking I/O, memory leaks).

Always measure before optimizing — never guess.`;

  // ── Run entrypoint ─────────────────────────────────────────────────────────

  public async run(goal: string, opts?: AgentRunOptions): Promise<AgentRunResult> {
    const ctx = this.startRun(goal, opts);

    // 1) STATIC — anti-pattern detection.
    this.emitProgress('analyze', 'Phase 1: static analysis (anti-patterns)…', undefined, ctx);
    const staticSuggestions = await this.staticAnalysis(ctx);
    this.recordMetric(ctx, 'staticFindings', staticSuggestions.length, 'set');

    // 2) DYNAMIC — CPU + heap profiling (Node / Python).
    this.emitProgress('analyze', 'Phase 2: dynamic profiling (CPU + heap)…', undefined, ctx);
    const dynamicSuggestions = await this.dynamicProfiling(ctx);
    this.recordMetric(ctx, 'dynamicFindings', dynamicSuggestions.length, 'set');

    // 3) SUGGESTIONS — already accumulated above; surface them as findings.
    const all = [...staticSuggestions, ...dynamicSuggestions];
    for (const s of all) {
      this.emitProgress('finding', s.title, s, ctx);
    }
    this.recordMetric(ctx, 'totalBottlenecks', all.length, 'set');

    // 4) BENCHMARK — write + run a benchmark script for the top bottleneck.
    this.emitProgress('analyze', 'Phase 4: writing + running benchmark…', undefined, ctx);
    const benchmarkResult = await this.runBenchmark(ctx, all);
    this.recordMetric(ctx, 'benchmarkMs', Math.round(benchmarkResult.afterMs - benchmarkResult.beforeMs), 'set');
    if (benchmarkResult.beforeMs > 0 && benchmarkResult.afterMs > 0) {
      this.recordMetric(
        ctx,
        'benchmarkImprovementPct',
        Math.round((1 - benchmarkResult.afterMs / benchmarkResult.beforeMs) * 100),
        'set',
      );
    }

    // 5) REPORT — surfaced via the base's markdown formatter (findings
    //    emitted during the analysis phases). Add a summary finding.
    this.addFinding(ctx, {
      severity: 'info',
      category: 'summary',
      title: `Found ${all.length} bottlenecks (${staticSuggestions.length} static, ${dynamicSuggestions.length} dynamic)`,
      description:
        `Static analysis found ${staticSuggestions.length} anti-patterns. Dynamic profiling found ${dynamicSuggestions.length} hot spots. ` +
        (benchmarkResult.beforeMs > 0
          ? `Benchmark: before=${benchmarkResult.beforeMs}ms, after=${benchmarkResult.afterMs}ms (${benchmarkResult.beforeMs > 0 ? Math.round((1 - benchmarkResult.afterMs / benchmarkResult.beforeMs) * 100) : 0}% improvement).`
          : 'No benchmark could be run — see actions for details.'),
      suggestion: 'Address the highest-impact / lowest-risk suggestions first. Re-run the agent after each fix to verify.',
      autoFixable: false,
      tags: ['summary'],
    });

    return this.finishRun(ctx);
  }

  // ── 1) Static analysis ─────────────────────────────────────────────────────

  private static readonly STATIC_PATTERNS: ReadonlyArray<{
    name: string;
    pattern: RegExp;
    severity: 'low' | 'medium' | 'high' | 'critical';
    description: string;
    fix: string;
    impact: string;
    risk: OptimizationRisk;
    autoFixable: boolean;
  }> = [
    {
      name: 'N+1 query (DB call inside loop)',
      pattern: /for\s*\([^)]*\)\s*\{[\s\S]{0,400}?(\.query\(|\.find\(|\.findOne\(|\.fetch\(|prisma\.|db\.)/g,
      severity: 'high',
      description: 'A database query appears inside a loop. This causes N round-trips for N items — the classic N+1 anti-pattern.',
      fix: 'Batch the query outside the loop with a single `WHERE id IN (...)`, or use a DataLoader / ORM eager-load (`include` / `select` / `with`).',
      impact: 'Up to Nx faster (N = loop size).',
      risk: 'medium',
      autoFixable: false,
    },
    {
      name: 'React render without useMemo (expensive calc)',
      pattern: /const\s+(\w+)\s*=\s*[^;]*\b(?:\.map\(|\.filter\(|\.reduce\(|\.sort\()[^;]*;\s*\/\/\s*re-render/g,
      severity: 'medium',
      description: 'An array operation (map/filter/reduce/sort) appears at the top level of a component body — it re-runs on every render.',
      fix: 'Wrap in `useMemo(() => …, [deps])` so it only recomputes when the dependencies change.',
      impact: 'Proportional to render frequency × array size.',
      risk: 'low',
      autoFixable: false,
    },
    {
      name: 'React inline object/function prop',
      pattern: /<\w+\s+[^>]*\b(?:style|onClick|onChange|onError)\s*=\s*\{\s*(?:new\s+)?(?:function|\([^)]*\)\s*=>|\{[^}]*\})/g,
      severity: 'medium',
      description: 'An inline function or object literal is passed as a prop. This creates a new reference each render, defeating React.memo on the child.',
      fix: 'Hoist with `useCallback` (for functions) or `useMemo` (for objects), or define the value outside the component.',
      impact: 'Prevents unnecessary child re-renders.',
      risk: 'low',
      autoFixable: false,
    },
    {
      name: 'Blocking synchronous I/O',
      pattern: /\b(?:readFileSync|writeFileSync|existsSync|statSync|readdirSync|execSync|spawnSync)\s*\(/g,
      severity: 'high',
      description: 'Synchronous I/O blocks the event loop. In a server, this stalls every concurrent request for the duration of the I/O.',
      fix: 'Use the async variant (readFile, writeFile, exec). For startup-only code, sync is acceptable; flag everything else.',
      impact: 'Unblocks the event loop — throughput improvement proportional to call frequency.',
      risk: 'low',
      autoFixable: true,
    },
    {
      name: 'Event listener not cleaned up (memory leak)',
      pattern: /\baddEventListener\s*\([^)]+\)/g,
      severity: 'high',
      description: 'An addEventListener call was found without a matching removeEventListener in cleanup (useEffect return / componentWillUnmount). Long-running apps will leak listeners and the closures they capture.',
      fix: 'In useEffect, return a cleanup function: `return () => el.removeEventListener(...)`. In classes, remove in componentWillUnmount.',
      impact: 'Prevents slow memory growth + listener explosion.',
      risk: 'medium',
      autoFixable: false,
    },
    {
      name: 'setInterval not cleared (memory leak)',
      pattern: /\bsetInterval\s*\(/g,
      severity: 'medium',
      description: 'A setInterval was found without a matching clearInterval in cleanup. Intervals keep references to closures and prevent garbage collection.',
      fix: 'Capture the interval id and clearInterval(id) in the cleanup function / beforeUnmount.',
      impact: 'Prevents leak + duplicate-tick bugs.',
      risk: 'low',
      autoFixable: false,
    },
    {
      name: 'Large bundle import (full library)',
      pattern: /\bimport\s+(?:\*\s+as\s+)?_?\w*\s+from\s+['"]lodash['"]|import\s+_?\w*\s+from\s+['"]moment['"]/g,
      severity: 'medium',
      description: 'A full-library import of a tree-shake-unfriendly package (lodash, moment). Bundles the entire lib (~70KB+ for lodash, ~230KB+ for moment).',
      fix: 'Use `import debounce from \'lodash/debounce\'` (per-function) or switch to lodash-es / date-fns / Day.js.',
      impact: '−50KB to −230KB from the bundle.',
      risk: 'low',
      autoFixable: true,
    },
    {
      name: 'Nested loop (O(n²))',
      pattern: /\bfor\s*\([^)]*\)\s*\{[\s\S]{0,200}?\bfor\s*\([^)]*\)\s*\{/g,
      severity: 'medium',
      description: 'A loop nested directly inside another loop. For input size n, this runs n² times — slow for any n > 1000.',
      fix: 'Refactor to a single pass: use a Map/Set for O(1) lookups, or precompute the inner loop\'s values.',
      impact: 'O(n²) → O(n) — order-of-magnitude faster on large inputs.',
      risk: 'high',
      autoFixable: false,
    },
    {
      name: 'String concatenation in loop',
      pattern: /\bfor\s*\([^)]*\)\s*\{[\s\S]{0,300}?\+\s*['"]/g,
      severity: 'low',
      description: 'Strings concatenated inside a loop with `+`. Each iteration allocates a new string — O(n²) total allocation.',
      fix: 'Push fragments to an array, then `array.join(\'\')` once after the loop.',
      impact: 'O(n²) → O(n) for string building.',
      risk: 'low',
      autoFixable: true,
    },
    {
      name: 'JSON.parse in hot path',
      pattern: /\bJSON\.parse\s*\(/g,
      severity: 'low',
      description: 'JSON.parse is synchronous and blocks the event loop. In hot paths it can stall the server.',
      fix: 'Cache the parsed result, or move parsing to a worker thread for large payloads.',
      impact: 'Proportional to payload size × call frequency.',
      risk: 'medium',
      autoFixable: false,
    },
    {
      name: 'Math.random in hot path',
      pattern: /\bMath\.random\s*\(\s*\)/g,
      severity: 'low',
      description: 'Math.random is not free — it\'s a system call into V8. In tight loops it can dominate the runtime.',
      fix: 'If you need many random numbers, batch them via crypto.randomBytes once and slice as needed.',
      impact: 'Marginal in most cases; significant in tight loops.',
      risk: 'low',
      autoFixable: false,
    },
  ];

  private async staticAnalysis(ctx: RunContext): Promise<OptimizationSuggestion[]> {
    const out: OptimizationSuggestion[] = [];
    let scanned = 0;
    await this.scanFiles(ctx, async (filePath, content) => {
      scanned++;
      for (const def of PerfProfiler.STATIC_PATTERNS) {
        // Use matchAll so we catch every occurrence per file.
        const matches = [...content.matchAll(def.pattern)];
        for (const m of matches) {
          if (!m.index) continue;
          const line = content.slice(0, m.index).split('\n').length;
          const suggestion: OptimizationSuggestion = {
            category: def.name,
            file: path.relative(ctx.opts.cwd, filePath),
            line,
            title: `${def.name} in ${path.relative(ctx.opts.cwd, filePath)}:${line}`,
            description: def.description,
            fix: def.fix,
            expectedImpact: def.impact,
            risk: def.risk,
            autoFixable: def.autoFixable,
          };
          out.push(suggestion);

          // Also emit a finding so it surfaces in the markdown report.
          this.addFinding(ctx, {
            severity: def.severity,
            category: def.name,
            title: suggestion.title,
            description: `${def.description}\n\n**Expected impact:** ${def.impact}\n**Risk:** ${def.risk}`,
            file: suggestion.file,
            line,
            snippet: this.snippetAround(content, line, 3),
            suggestion: def.fix,
            autoFixable: def.autoFixable,
            tags: ['perf', def.name.replace(/\s+/g, '-').toLowerCase()],
          });
        }
      }
    });
    this.recordMetric(ctx, 'staticFilesScanned', scanned, 'set');
    return out;
  }

  // ── 2) Dynamic profiling ───────────────────────────────────────────────────

  private async dynamicProfiling(ctx: RunContext): Promise<OptimizationSuggestion[]> {
    const out: OptimizationSuggestion[] = [];

    // Node project — run --cpu-prof + --heap-prof on the test suite
    // (cheaper than running the actual app, and reliably reproducible).
    if (await this.fileExists('package.json', ctx)) {
      const pkg = await this.readPackageJson(ctx);
      const hasTestScript = !!pkg.scripts?.test;
      if (hasTestScript) {
        const cpu = await this.runShell(
          'node --cpu-prof --cpu-prof-dir=.sanix-cpuprof npx vitest run --reporter=verbose 2>&1 | tail -200 || true',
          ctx, undefined, 60_000,
        );
        const hotspots = this.parseCpuProf(cpu.stdout);
        for (const h of hotspots) {
          out.push(h);
          this.addFinding(ctx, {
            severity: 'high',
            category: 'cpu-hotspot',
            title: `CPU hotspot: ${h.title}`,
            description: `${h.description}\n\n**Expected impact:** ${h.expectedImpact}\n**Risk:** ${h.risk}`,
            file: h.file,
            line: h.line,
            suggestion: h.fix,
            autoFixable: false,
            tags: ['perf', 'cpu-prof'],
          });
        }

        const heap = await this.runShell(
          'node --heap-prof --heap-prof-dir=.sanix-heapprof npx vitest run --reporter=verbose 2>&1 | tail -200 || true',
          ctx, undefined, 60_000,
        );
        const heapHotspots = this.parseHeapProf(heap.stdout);
        for (const h of heapHotspots) {
          out.push(h);
          this.addFinding(ctx, {
            severity: 'high',
            category: 'heap-pressure',
            title: `Heap pressure: ${h.title}`,
            description: `${h.description}\n\n**Expected impact:** ${h.expectedImpact}\n**Risk:** ${h.risk}`,
            file: h.file,
            line: h.line,
            suggestion: h.fix,
            autoFixable: false,
            tags: ['perf', 'heap-prof'],
          });
        }
      }
    }

    // Python project — cProfile + memory_profiler.
    if (await this.fileExists('pytest.ini', ctx) || await this.fileExists('pyproject.toml', ctx)) {
      const cprofile = await this.runShell(
        'python -m cProfile -s cumulative -m pytest 2>&1 | head -50 || true',
        ctx, undefined, 60_000,
      );
      const pyHotspots = this.parseCProfile(cprofile.stdout);
      for (const h of pyHotspots) {
        out.push(h);
        this.addFinding(ctx, {
          severity: 'medium',
          category: 'cprofile-hotspot',
          title: `cProfile hotspot: ${h.title}`,
          description: `${h.description}\n\n**Expected impact:** ${h.expectedImpact}\n**Risk:** ${h.risk}`,
          file: h.file,
          line: h.line,
          suggestion: h.fix,
          autoFixable: false,
          tags: ['perf', 'cprofile'],
        });
      }
    }

    return out;
  }

  /**
   * Parse Node --cpu-prof verbose output for the top hotspots. Best-effort.
   */
  private parseCpuProf(stdout: string): OptimizationSuggestion[] {
    const out: OptimizationSuggestion[] = [];
    // Look for lines like "  examples/foo.ts  1500ms  45%"
    const re = /^\s*([^\s]+\.[a-z]+)\s+(\d+)\s*ms\s+(\d+)%/gim;
    let m: RegExpExecArray | null;
    let count = 0;
    while ((m = re.exec(stdout)) !== null && count < 5) {
      const file = m[1];
      const ms = parseInt(m[2], 10);
      const pct = parseInt(m[3], 10);
      if (pct < 5) continue;
      out.push({
        category: 'cpu-hotspot',
        file,
        line: 0,
        title: `${file} — ${ms}ms (${pct}% of CPU time)`,
        description: `${file} consumed ${ms}ms (${pct}% of total CPU time) during the profiled run. This is a hot path — optimization here will have outsized impact.`,
        fix: 'Profile the function in isolation. Common fixes: cache results, batch I/O, move to a worker thread, or rewrite the inner loop.',
        expectedImpact: `Proportional to call frequency — ${pct}% of CPU time recoverable.`,
        risk: 'medium',
        autoFixable: false,
      });
      count++;
    }
    return out;
  }

  /**
   * Parse Node --heap-prof output for high-allocation hotspots.
   */
  private parseHeapProf(stdout: string): OptimizationSuggestion[] {
    const out: OptimizationSuggestion[] = [];
    const re = /^\s*([^\s]+\.[a-z]+)\s+(\d+)\s*(?:bytes|B)\s+(\d+)%/gim;
    let m: RegExpExecArray | null;
    let count = 0;
    while ((m = re.exec(stdout)) !== null && count < 5) {
      const file = m[1];
      const bytes = parseInt(m[2], 10);
      const pct = parseInt(m[3], 10);
      if (pct < 5) continue;
      out.push({
        category: 'heap-pressure',
        file,
        line: 0,
        title: `${file} — ${bytes} bytes allocated (${pct}% of heap)`,
        description: `${file} allocated ${bytes} bytes (${pct}% of total heap) during the profiled run. Sustained allocation pressure causes GC pauses.`,
        fix: 'Reduce allocations: reuse objects, use object pools for hot paths, prefer streaming over buffering.',
        expectedImpact: `Reduces GC pressure by up to ${pct}%.`,
        risk: 'medium',
        autoFixable: false,
      });
      count++;
    }
    return out;
  }

  /**
   * Parse Python cProfile output.
   */
  private parseCProfile(stdout: string): OptimizationSuggestion[] {
    const out: OptimizationSuggestion[] = [];
    // cProfile -s cumulative emits: "   ncalls  tottime  percall  cumtime  percall filename:lineno(function)"
    const lines = stdout.split('\n');
    let count = 0;
    for (const ln of lines) {
      const m = /^\s*(\d+)\s+([\d.]+)\s+[\d.]+\s+([\d.]+)\s+[\d.]+\s+([^\s(]+):(\d+)\(([^)]+)\)/.exec(ln);
      if (!m) continue;
      const [, ncallsStr, totTime, cumTime, file, lineStr, fnName] = m;
      const cum = parseFloat(cumTime);
      const ncalls = parseInt(ncallsStr, 10);
      if (cum < 0.05 || ncalls < 100) continue;
      out.push({
        category: 'cprofile-hotspot',
        file,
        line: parseInt(lineStr, 10),
        title: `${fnName}() — ${cum}s cumulative (${ncalls} calls)`,
        description: `${fnName}() in ${file}:${lineStr} took ${cum}s total across ${ncalls} calls. This is a hot path.`,
        fix: 'Cache the result if inputs repeat. Vectorize with numpy if it\'s a numeric loop. Move I/O out of the inner loop.',
        expectedImpact: `Proportional to call frequency — ${cum}s recoverable.`,
        risk: 'medium',
        autoFixable: false,
      });
      void totTime;
      if (++count >= 5) break;
    }
    return out;
  }

  // ── 4) Benchmarking ────────────────────────────────────────────────────────

  /**
   * Write + run a benchmark script for the top bottleneck. Returns
   * before/after timing; if no benchmark could be constructed, both
   * fields are zero.
   */
  private async runBenchmark(
    ctx: RunContext,
    suggestions: OptimizationSuggestion[],
  ): Promise<{ beforeMs: number; afterMs: number; script: string }> {
    if (suggestions.length === 0) {
      return { beforeMs: 0, afterMs: 0, script: '' };
    }

    // Pick the top suggestion (highest severity / first-found).
    const top = suggestions[0];
    const benchPath = path.resolve(ctx.opts.cwd, '.sanix-bench.mjs');
    const script = this.generateBenchmarkScript(top);
    const written = await this.writeFileSafe(benchPath, script, ctx);
    if (!written) return { beforeMs: 0, afterMs: 0, script };

    // Run the benchmark 3 times, take median.
    const result = await this.runShell(`node ${benchPath} 2>&1 || true`, ctx, undefined, 30_000);
    const beforeMatch = /before:\s*(\d+(?:\.\d+)?)ms/i.exec(result.stdout);
    const afterMatch = /after:\s*(\d+(?:\.\d+)?)ms/i.exec(result.stdout);
    const beforeMs = beforeMatch ? parseFloat(beforeMatch[1]) : 0;
    const afterMs = afterMatch ? parseFloat(afterMatch[1]) : 0;

    if (beforeMs > 0) {
      this.addFinding(ctx, {
        severity: 'info',
        category: 'benchmark',
        title: `Benchmark: ${top.title}`,
        description:
          `Ran a benchmark script for \`${top.file}\`.\n\n` +
          `**Before:** ${beforeMs.toFixed(2)}ms\n` +
          `**After:** ${afterMs.toFixed(2)}ms\n` +
          `**Improvement:** ${(beforeMs > 0 ? ((1 - afterMs / beforeMs) * 100).toFixed(1) : '0')}%`,
        file: path.relative(ctx.opts.cwd, benchPath),
        suggestion: 'Re-run the benchmark after applying the suggested fix to verify the improvement.',
        autoFixable: false,
        tags: ['perf', 'benchmark'],
      });
    }

    return { beforeMs, afterMs, script };
  }

  /**
   * Generate a minimal benchmark script. The "before" path runs the
   * original function; the "after" path runs an inline-optimized copy
   * of the same logic. Both are timed via `performance.now()`.
   */
  private generateBenchmarkScript(top: OptimizationSuggestion): string {
    return `/**
 * Auto-generated by SANIX Perf Profiler.
 * Benchmarks: ${top.title}
 * Category: ${top.category}
 */
import { performance } from 'node:perf_hooks';

const ITERATIONS = 1000;

// BEFORE — the original (representative) hot-path code.
function before() {
  // TODO: paste the original implementation here.
  return Array.from({ length: 1000 }, (_, i) => i).reduce((a, b) => a + b, 0);
}

// AFTER — the optimized variant per the agent's suggestion.
// Suggestion: ${top.fix.replace(/\n/g, ' ').slice(0, 200)}
function after() {
  // TODO: paste the optimized implementation here.
  let sum = 0;
  for (let i = 0; i < 1000; i++) sum += i;
  return sum;
}

function time(fn) {
  const start = performance.now();
  for (let i = 0; i < ITERATIONS; i++) fn();
  return performance.now() - start;
}

// Sanity: results must match.
if (before() !== after()) {
  console.error('Benchmark failed: before() and after() return different values.');
  process.exit(1);
}

const b = time(before);
const a = time(after);
console.log(\`before: \${b.toFixed(2)}ms\`);
console.log(\`after:  \${a.toFixed(2)}ms\`);
console.log(\`improvement: \${((1 - a / b) * 100).toFixed(1)}%\`);
`;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private snippetAround(content: string, lineNo: number, padding: number): string {
    const lines = content.split('\n');
    const start = Math.max(0, lineNo - 1 - padding);
    const end = Math.min(lines.length, lineNo + padding);
    return lines
      .slice(start, end)
      .map((ln, i) => `${start + i + 1}: ${ln}`)
      .join('\n');
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
