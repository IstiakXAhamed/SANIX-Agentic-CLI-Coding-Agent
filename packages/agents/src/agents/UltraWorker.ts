/**
 * @file agents/UltraWorker.ts
 * @description SANIX UltraWorker orchestrator agent — 👑 (id:
 * `ultra-worker`, category: `orchestration`).
 *
 * UltraWorker is the master orchestrator of the SANIX agent catalog.
 * Given a high-level goal, it:
 *   1. **Decomposes** the goal into typed sub-tasks.
 *   2. **Selects** the best specialized agent(s) for each sub-task
 *      via a keyword-driven decision engine.
 *   3. **Plans** execution phases with explicit dependencies and
 *      priorities (rendered as an ASCII plan).
 *   4. **Executes** sub-tasks in parallel (up to `maxConcurrency`
 *      at once, default 4) with per-subtask timeouts (default 5 min)
 *      and bounded retries.
 *   5. **Synthesizes** results — deduplicates overlapping findings,
 *      sorts by severity, and cross-references related findings
 *      across agents.
 *   6. **Decides** — when agents disagree or fail, applies one of
 *      `consensus`, `authority`, `escalation`, or `union` resolution
 *      strategies; retries failed sub-tasks with the same or an
 *      alternative agent before giving up.
 *   7. **Delivers** a unified final report that combines every
 *      sub-task's findings, actions, metrics, and the orchestration
 *      log itself.
 *
 * UltraWorker is the only agent that needs access to the
 * {@link AgentRegistry}; it accepts one via
 * `AgentRunOptions.registry`, falling back to the package-level
 * singleton (`getGlobalRegistry()`).
 *
 * @packageDocumentation
 */

import * as path from 'node:path';
import { BaseAgent, type RunContext } from '../BaseAgent.js';
import type {
  AgentCategory,
  AgentFinding,
  AgentRunOptions,
  AgentRunResult,
  SpecializedAgent,
} from '../types.js';
import { AgentRegistry } from '../AgentRegistry.js';
import { getGlobalRegistry } from '../registerAllAgents.js';

// ─── Public types ────────────────────────────────────────────────────────────

/** Priority bucket for a sub-task — drives execution order. */
export type SubTaskPriority = 'critical' | 'high' | 'medium' | 'low' | 'info';

/** Conflict-resolution strategy. */
export type ConflictStrategy = 'consensus' | 'authority' | 'escalation' | 'union';

/** A decomposed sub-task. */
export interface SubTask {
  /** Stable unique id (used by `dependsOn`). */
  id: string;
  /** The concrete goal handed to the sub-agent. */
  goal: string;
  /** One or more agent ids deemed capable of handling this sub-task. */
  agentIds: string[];
  /** Priority bucket. */
  priority: SubTaskPriority;
  /** Domain label (`security`, `testing`, ...) — surfaced in the plan. */
  domain: string;
  /** Ids of sub-tasks that must complete before this one starts. */
  dependsOn: string[];
  /** Per-subtask timeout in ms (default 5 min). */
  timeoutMs?: number;
  /** Max retries before giving up (default 2). */
  maxRetries?: number;
  /** Optional rationale for the agent selection (shown in the plan). */
  rationale?: string;
}

/** Result of a single sub-task execution attempt. */
export interface SubTaskResult {
  /** The sub-task this result corresponds to. */
  subTaskId: string;
  /** The agent that produced this result. */
  agentId: string;
  /** The agent's run result (null if the run never succeeded). */
  result: AgentRunResult | null;
  /** Number of attempts made (including the successful one). */
  attempts: number;
  /** True if the sub-task ultimately succeeded. */
  success: boolean;
  /** Error message (set when `success === false`). */
  error?: string;
  /** Wall-clock duration of all attempts combined. */
  durationMs: number;
}

/** A discovered conflict between two agents' findings. */
export interface FindingConflict {
  /** The shared topic / file the conflict is about. */
  topic: string;
  /** Ids of the agents that disagreed. */
  agentIds: string[];
  /** The competing findings. */
  findings: AgentFinding[];
  /** The strategy used to resolve the conflict. */
  resolvedBy: ConflictStrategy;
  /** Human-readable resolution note. */
  resolution: string;
}

/** UltraWorker-specific run options (extends {@link AgentRunOptions}). */
export interface UltraWorkerOptions extends AgentRunOptions {
  /** Max number of sub-tasks to run in parallel (default 4). */
  maxConcurrency?: number;
  /** Default per-subtask timeout in ms (default 300_000 = 5 min). */
  defaultTimeoutMs?: number;
  /** Default max retries per subtask (default 2). */
  defaultMaxRetries?: number;
  /** Conflict-resolution strategy (default `'union'`). */
  conflictStrategy?: ConflictStrategy;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Default max parallel sub-tasks. */
const DEFAULT_MAX_CONCURRENCY = 4;

/** Default per-subtask timeout: 5 minutes. */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/** Default retry count per subtask. */
const DEFAULT_MAX_RETRIES = 2;

/**
 * The keyword → agent-id decision map. Each entry maps a domain
 * label to: the keywords that trigger it, the primary agent id, and
 * (optionally) one or more backup agent ids for redundancy /
 * reconciliation.
 *
 * UltraWorker itself is intentionally absent — it never spawns
 * itself as a sub-agent (would cause unbounded recursion).
 */
interface AgentMapping {
  domain: string;
  keywords: ReadonlyArray<string>;
  primary: string;
  alternates: ReadonlyArray<string>;
  priority: SubTaskPriority;
  rationale: string;
}

const AGENT_MAPPINGS: ReadonlyArray<AgentMapping> = [
  { domain: 'security', keywords: ['security', 'vulnerability', 'owasp', 'secret', 'cve', 'crypto', 'xss', 'injection', 'auth'], primary: 'security-sentinel', alternates: ['bug-bounty-hunter'], priority: 'critical', rationale: 'Security Sentinel is the canonical CWE-tagged scanner; Bug Bounty Hunter provides a second pass for exploit chains.' },
  { domain: 'migration', keywords: ['migrate', 'migration', 'upgrade', 'typescript', 'esm', 'cjs', 'framework migration'], primary: 'migration-maestro', alternates: [], priority: 'high', rationale: 'Migration Maestro owns framework / language migrations end-to-end.' },
  { domain: 'testing', keywords: ['test', 'tests', 'coverage', 'jest', 'vitest', 'pytest', 'unit test', 'integration test'], primary: 'test-architect', alternates: [], priority: 'high', rationale: 'Test Architect designs the test pyramid and writes missing tests.' },
  { domain: 'performance', keywords: ['performance', 'perf', 'optimize', 'bottleneck', 'slow', 'latency', 'throughput', 'memory leak'], primary: 'perf-profiler', alternates: [], priority: 'medium', rationale: 'Perf Profiler runs CPU / heap profilers and detects anti-patterns (N+1, re-renders).' },
  { domain: 'documentation', keywords: ['doc', 'docs', 'readme', 'documentation', 'jsdoc', 'changelog', 'architecture diagram'], primary: 'doc-doctor', alternates: ['changelog-generator'], priority: 'medium', rationale: 'Doc Doctor generates JSDoc / README / diagrams; Changelog Generator owns release notes.' },
  { domain: 'refactoring', keywords: ['refactor', 'code smell', 'clean code', 'duplication', 'dead code', 'complexity'], primary: 'refactor-ranger', alternates: [], priority: 'medium', rationale: 'Refactor Ranger detects code smells and proposes safe refactors.' },
  { domain: 'dependencies', keywords: ['dependency', 'dependencies', 'package', 'npm', 'outdated', 'yarn', 'pnpm', 'pip', 'cargo'], primary: 'dependency-detective', alternates: [], priority: 'high', rationale: 'Dependency Detective audits versions, licenses, and CVEs in the dependency graph.' },
  { domain: 'api', keywords: ['api', 'rest', 'graphql', 'openapi', 'endpoint', 'swagger'], primary: 'api-designer', alternates: [], priority: 'medium', rationale: 'API Designer designs endpoints, generates OpenAPI specs and SDK clients.' },
  { domain: 'database', keywords: ['database', 'db', 'sql', 'schema', 'index', 'migration', 'query'], primary: 'dba-agent', alternates: [], priority: 'medium', rationale: 'DBA Agent owns schema design, indexing, and query optimization.' },
  { domain: 'devops', keywords: ['devops', 'ci', 'cd', 'docker', 'kubernetes', 'deploy', 'pipeline', 'terraform'], primary: 'devops-engineer', alternates: [], priority: 'medium', rationale: 'DevOps Engineer owns CI/CD pipelines, containers, and IaC.' },
  { domain: 'data', keywords: ['data', 'analysis', 'ml', 'model', 'statistics', 'dataset', 'notebook'], primary: 'data-scientist-agent', alternates: [], priority: 'low', rationale: 'Data Scientist runs analyses and builds models.' },
  { domain: 'accessibility', keywords: ['accessibility', 'a11y', 'wcag', 'aria', 'contrast', 'screen reader'], primary: 'a11y-auditor', alternates: [], priority: 'high', rationale: 'Accessibility Auditor maps violations to WCAG 2.2 criteria and auto-fixes safe ones.' },
  { domain: 'release', keywords: ['release', 'version', 'changelog', 'semantic version', 'tag'], primary: 'changelog-generator', alternates: [], priority: 'low', rationale: 'Changelog Generator produces release notes from git history.' },
  { domain: 'onboarding', keywords: ['onboarding', 'setup', 'install', 'getting started', 'new developer'], primary: 'onboarding-buddy', alternates: [], priority: 'low', rationale: 'Onboarding Buddy generates setup guides and quickstarts.' },
  { domain: 'cost', keywords: ['cost', 'spend', 'billing', 'budget', 'cloud cost'], primary: 'cost-optimizer', alternates: [], priority: 'medium', rationale: 'Cost Optimizer analyzes cloud spend and recommends savings.' },
  { domain: 'pairing', keywords: ['pair', 'pair program', 'mob', 'live coding'], primary: 'pair-programmer', alternates: [], priority: 'low', rationale: 'Pair Programmer is a live-coding companion.' },
  { domain: 'learning', keywords: ['retro', 'retrospective', 'learn', 'improve', 'post-mortem'], primary: 'retro-agent', alternates: [], priority: 'low', rationale: 'Retro Agent learns from past runs to improve future ones.' },
  { domain: 'analysis', keywords: ['archaeology', 'history', 'git blame', 'evolution', 'code history'], primary: 'code-archaeologist', alternates: [], priority: 'low', rationale: 'Code Archaeologist reconstructs a codebase evolution from VCS history.' },
  { domain: 'monitoring', keywords: ['log', 'logs', 'monitoring', 'observability', 'tracing', 'metrics', 'alert'], primary: 'log-detective', alternates: [], priority: 'medium', rationale: 'Log Detective parses logs and traces to find root causes.' },
  { domain: 'design', keywords: ['ui', 'ux', 'design', 'wireframe', 'component', 'design system', 'theme', 'responsive'], primary: 'ui-designer', alternates: [], priority: 'medium', rationale: 'UI/UX Designer designs interfaces and generates component code.' },
];

// ─── Agent ───────────────────────────────────────────────────────────────────

/**
 * SANIX UltraWorker — 👑 the master orchestrator agent.
 *
 * UltraWorker is the most powerful agent in the catalog: it spawns
 * and manages every other agent. It decomposes a high-level goal
 * into typed sub-tasks, selects agents, plans execution phases,
 * runs them in parallel with timeouts and retries, synthesizes the
 * results, and delivers a unified report.
 *
 * @example
 * ```ts
 * import { UltraWorker } from '@sanix/agents';
 *
 * const result = await new UltraWorker().run(
 *   'Audit this codebase for security, performance, and quality',
 *   { cwd: '/repo', maxConcurrency: 4 },
 * );
 *
 * console.log(result.success, result.findings.length, 'unified findings');
 * console.log(result.metrics.subTasksSucceeded, '/', result.metrics.subTasksTotal);
 * ```
 *
 * @example With an explicit registry
 * ```ts
 * import { UltraWorker, AgentRegistry, SecuritySentinel } from '@sanix/agents';
 *
 * const registry = new AgentRegistry().register(new SecuritySentinel());
 * const result = await new UltraWorker().run('Security audit', { registry });
 * ```
 */
export class UltraWorker extends BaseAgent {
  public readonly id = 'ultra-worker';
  public readonly name = 'UltraWorker';
  public readonly description =
    'Master orchestrator. Decomposes any complex goal into sub-tasks, selects the best ' +
    'specialized agent(s) for each, runs them in parallel with timeouts and retries, ' +
    'synthesizes results (dedupe, prioritize, cross-reference), resolves conflicts, ' +
    'and delivers a unified report. Can spawn every other agent in the catalog.';
  public readonly category: AgentCategory = 'orchestration';
  public readonly icon = '👑';
  public readonly provider = 'claude-sonnet-4';
  public readonly temperature = 0.2;
  public readonly tools = [
    'read_file', 'write_file', 'edit_file', 'search_files', 'analyze_ast',
    'bash', 'sandbox_execute', 'list_directory',
  ];
  public readonly exampleQueries = [
    'Audit this entire codebase for security, performance, and quality',
    'Set up a new project: design the UI, create the API, write tests, set up CI/CD',
    'Fix all issues found in the last code review: security bugs, missing tests, bad docs',
    'Migrate this project to TypeScript and ensure everything still works',
    'Prepare this project for production: security hardening, performance optimization, monitoring setup, documentation',
  ];

  public readonly systemPrompt = `You are SANIX UltraWorker, the master orchestrator agent. You are the most powerful agent in the SANIX ecosystem. You can: (1) decompose any complex goal into sub-tasks, (2) decide which specialized agents to deploy for each sub-task, (3) spawn multiple agents in parallel, (4) monitor their progress, (5) collect and synthesize their results, (6) make decisions when agents disagree, (7) re-plan when agents fail, (8) deliver a unified final output. You think strategically: you don't just run agents — you reason about WHICH agents to use, in WHAT ORDER, with WHAT INPUTS, and HOW to combine their outputs. You are efficient: you parallelize independent tasks, avoid redundant work, and cache intermediate results. You are adaptive: if an agent fails, you try a different agent or approach. You are transparent: you explain your orchestration decisions.`;

  // ── Run entrypoint ─────────────────────────────────────────────────────────

  public async run(goal: string, opts?: UltraWorkerOptions): Promise<AgentRunResult> {
    const ctx = this.startRun(goal, opts);
    const uwOpts = this.resolveOptions(opts);

    // 1) Resolve the registry (explicit > global singleton).
    const registry = opts?.registry ?? (await this.resolveGlobalRegistry());
    if (registry.size === 0) {
      this.emitProgress('error', 'No agents available in the registry — cannot orchestrate.', undefined, ctx);
      this.addFinding(ctx, {
        severity: 'critical',
        category: 'orchestration:no-agents',
        title: 'Empty registry — no sub-agents available',
        description: 'UltraWorker requires at least one registered specialized agent to spawn. The supplied registry (and the global singleton) contain zero agents. Register agents via `registry.register(new SecuritySentinel())` or call `getGlobalRegistry()` to auto-register all built-ins.',
        suggestion: 'Call `getGlobalRegistry()` before invoking UltraWorker, or pass a populated registry via `AgentRunOptions.registry`.',
        autoFixable: false,
        tags: ['orchestration', 'registry-empty'],
      });
      this.markFailed(ctx, 'No agents available to orchestrate.');
      return this.finishRun(ctx);
    }
    this.emitProgress('analyze', `Registry: ${registry.size} agent(s) available.`, { size: registry.size }, ctx);

    // 2) Decompose the goal into sub-tasks.
    this.emitProgress('analyze', 'Decomposing goal into sub-tasks…', undefined, ctx);
    const subTasks = this.decompose(goal, registry);
    this.recordMetric(ctx, 'subTasksTotal', subTasks.length, 'set');
    if (subTasks.length === 0) {
      this.addFinding(ctx, {
        severity: 'medium',
        category: 'orchestration:no-subtasks',
        title: 'No sub-tasks could be derived from the goal',
        description: `UltraWorker could not map the goal to any specialized agent's domain. The goal may be too vague, or it may concern a domain not covered by the current catalog. Try rephrasing with specific keywords (security, performance, testing, refactoring, ui, ...).`,
        suggestion: 'Rephrase the goal to mention a concrete concern (security, performance, ui, tests, docs, migration, ...).',
        autoFixable: false,
        tags: ['orchestration'],
      });
      ctx.output = 'Goal could not be decomposed — no matching agent domains detected.';
      return this.finishRun(ctx);
    }

    // 3) Generate the execution plan.
    const phases = this.planPhases(subTasks);
    const planText = this.formatExecutionPlan(goal, subTasks, phases);
    this.emitProgress('analyze', `Execution plan: ${phases.length} phase(s), ${subTasks.length} sub-task(s).`, { phases: phases.length, subTasks: subTasks.length }, ctx);
    await this.writeFileSafe(path.join(ctx.opts.cwd, 'ultra-worker-plan.md'), planText, ctx);

    // 4) Execute the plan phase by phase.
    const allResults: SubTaskResult[] = [];
    for (let p = 0; p < phases.length; p++) {
      const phase = phases[p];
      this.emitProgress('analyze', `Phase ${p + 1}/${phases.length}: running ${phase.length} sub-task(s)…`, { phase: p + 1, count: phase.length }, ctx);
      const phaseResults = await this.runPhase(ctx, phase, registry, uwOpts, allResults);
      allResults.push(...phaseResults);
    }

    // 5) Synthesize results.
    this.emitProgress('analyze', 'Synthesizing results…', undefined, ctx);
    const synthesis = this.synthesize(ctx, allResults);

    // 6) Detect and resolve conflicts.
    const conflicts = this.detectConflicts(allResults, uwOpts.conflictStrategy);
    this.recordMetric(ctx, 'conflictsDetected', conflicts.length, 'set');

    // 7) Roll up sub-agent findings into the unified result.
    this.recordMetric(ctx, 'subTasksSucceeded', allResults.filter((r) => r.success).length, 'set');
    this.recordMetric(ctx, 'subTasksFailed', allResults.filter((r) => !r.success).length, 'set');
    this.recordMetric(ctx, 'totalFindings', synthesis.findings.length, 'set');
    this.recordMetric(ctx, 'dedupedFindings', synthesis.dedupedCount, 'set');
    this.recordMetric(ctx, 'totalActions', synthesis.totalActions, 'set');
    this.recordMetric(ctx, 'totalCostUsd', Number(synthesis.totalCostUsd.toFixed(4)), 'set');
    this.recordMetric(ctx, 'totalTokens', synthesis.totalTokens, 'set');

    // 8) Write the unified report.
    const report = this.formatUnifiedReport(ctx, goal, subTasks, phases, allResults, synthesis, conflicts, registry);
    await this.writeFileSafe(path.join(ctx.opts.cwd, 'ultra-worker-report.md'), report, ctx);
    ctx.output = `Orchestrated ${subTasks.length} sub-task(s) across ${phases.length} phase(s). ${allResults.filter((r) => r.success).length}/${subTasks.length} succeeded. ${synthesis.findings.length} unified finding(s) (${synthesis.dedupedCount} deduped). Report: ultra-worker-report.md`;

    return this.finishRun(ctx);
  }

  // ── Options resolution ─────────────────────────────────────────────────────

  /** Normalize UltraWorker options with defaults. */
  protected resolveOptions(opts?: UltraWorkerOptions): Required<
    Pick<UltraWorkerOptions, 'maxConcurrency' | 'defaultTimeoutMs' | 'defaultMaxRetries' | 'conflictStrategy'>
  > {
    return {
      maxConcurrency: opts?.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
      defaultTimeoutMs: opts?.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      defaultMaxRetries: opts?.defaultMaxRetries ?? DEFAULT_MAX_RETRIES,
      conflictStrategy: opts?.conflictStrategy ?? 'union',
    };
  }

  /**
   * Lazily resolve the global registry. Wrapped in try/catch so a
   * failure to import the singleton (e.g. circular-import edge case
   * during boot) degrades gracefully to an empty registry.
   */
  protected async resolveGlobalRegistry(): Promise<AgentRegistry> {
    try {
      return getGlobalRegistry();
    } catch {
      return new AgentRegistry();
    }
  }

  // ── Goal decomposition + agent selection ───────────────────────────────────

  /**
   * Decompose the goal into typed sub-tasks. Each sub-task is matched
   * to one or more agents via the {@link AGENT_MAPPINGS} keyword
   * engine. Agents not present in the registry are skipped.
   */
  protected decompose(goal: string, registry: AgentRegistry): SubTask[] {
    const g = goal.toLowerCase();
    const subTasks: SubTask[] = [];
    let idx = 1;

    for (const mapping of AGENT_MAPPINGS) {
      const matched = mapping.keywords.filter((k) => g.includes(k));
      if (matched.length === 0) continue;

      // Skip if the primary agent isn't registered (and no alternates either).
      const available = [mapping.primary, ...mapping.alternates].filter((id) => registry.has(id));
      if (available.length === 0) continue;

      const id = `st-${String(idx).padStart(2, '0')}`;
      idx++;
      subTasks.push({
        id,
        goal: this.refineSubGoal(goal, mapping.domain, matched),
        agentIds: available,
        priority: mapping.priority,
        domain: mapping.domain,
        dependsOn: [],
        timeoutMs: undefined,
        maxRetries: undefined,
        rationale: mapping.rationale,
      });
    }

    // Add cross-cutting dependencies: documentation and testing often
    // depend on the analysis sub-tasks finishing first. We model this
    // by making any doc/test sub-task depend on every earlier sub-task
    // from a different domain.
    for (const st of subTasks) {
      if (st.domain === 'documentation' || st.domain === 'testing' || st.domain === 'release') {
        st.dependsOn = subTasks.filter((x) => x.id !== st.id && x.domain !== st.domain).map((x) => x.id);
      }
    }

    return subTasks;
  }

  /**
   * Refine the high-level goal into a domain-specific sub-goal. This
   * gives the sub-agent a focused prompt instead of the full
   * umbrella goal.
   */
  protected refineSubGoal(originalGoal: string, domain: string, matchedKeywords: string[]): string {
    const kw = matchedKeywords.slice(0, 3).join(', ');
    switch (domain) {
      case 'security':
        return `Security audit (focus: ${kw}). Original goal: "${originalGoal}". Scan for OWASP Top 10, hardcoded secrets, dependency CVEs, and crypto weaknesses.`;
      case 'performance':
        return `Performance profiling (focus: ${kw}). Original goal: "${originalGoal}". Detect bottlenecks (N+1 queries, re-renders, blocking I/O, memory leaks) and suggest optimizations.`;
      case 'testing':
        return `Test coverage analysis (focus: ${kw}). Original goal: "${originalGoal}". Find uncovered code paths and generate missing tests.`;
      case 'documentation':
        return `Documentation audit (focus: ${kw}). Original goal: "${originalGoal}". Find undocumented public APIs and generate JSDoc / README sections.`;
      case 'refactoring':
        return `Refactoring review (focus: ${kw}). Original goal: "${originalGoal}". Detect code smells, duplication, and high complexity.`;
      case 'dependencies':
        return `Dependency audit (focus: ${kw}). Original goal: "${originalGoal}". Check for outdated packages, license issues, and known CVEs.`;
      case 'accessibility':
        return `Accessibility audit (focus: ${kw}). Original goal: "${originalGoal}". Scan UI components for WCAG 2.2 AA violations.`;
      case 'design':
        return `UI/UX design (focus: ${kw}). Original goal: "${originalGoal}". Audit existing UI or generate new components / design tokens.`;
      case 'api':
        return `API design review (focus: ${kw}). Original goal: "${originalGoal}". Validate REST/GraphQL endpoints against best practices.`;
      case 'database':
        return `Database review (focus: ${kw}). Original goal: "${originalGoal}". Check schema, indexes, and query patterns.`;
      case 'devops':
        return `DevOps review (focus: ${kw}). Original goal: "${originalGoal}". Audit CI/CD pipelines, Dockerfiles, and IaC.`;
      case 'monitoring':
        return `Log/observability review (focus: ${kw}). Original goal: "${originalGoal}". Find root causes in logs and improve tracing.`;
      default:
        return `${domain} analysis (focus: ${kw}). Original goal: "${originalGoal}".`;
    }
  }

  // ── Phase planning (topological sort) ──────────────────────────────────────

  /**
   * Group sub-tasks into execution phases via topological sort over
   * `dependsOn`. Sub-tasks within the same phase have no inter-phase
   * dependencies and may run in parallel.
   */
  protected planPhases(subTasks: SubTask[]): SubTask[][] {
    const phases: SubTask[][] = [];
    const completed = new Set<string>();
    const remaining = new Set(subTasks.map((s) => s.id));
    const byId = new Map(subTasks.map((s) => [s.id, s] as const));

    let guard = 0;
    while (remaining.size > 0 && guard < subTasks.length + 5) {
      guard++;
      const ready = [...remaining]
        .map((id) => byId.get(id)!)
        .filter((st) => st.dependsOn.every((dep) => completed.has(dep)));

      if (ready.length === 0) {
        // Cycle / unsatisfiable dependency — emit the rest as a final phase.
        for (const id of remaining) {
          const st = byId.get(id)!;
          if (phases.length === 0) phases.push([]);
          phases[phases.length - 1].push(st);
        }
        break;
      }

      // Sort ready sub-tasks by priority within the phase.
      const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4 } as const;
      ready.sort((a, b) => order[a.priority] - order[b.priority]);
      phases.push(ready);
      for (const st of ready) {
        completed.add(st.id);
        remaining.delete(st.id);
      }
    }

    return phases;
  }

  // ── Phase execution ────────────────────────────────────────────────────────

  /**
   * Run one phase: all sub-tasks in parallel, bounded by
   * `maxConcurrency`. Returns one {@link SubTaskResult} per sub-task.
   */
  protected async runPhase(
    ctx: RunContext,
    phase: SubTask[],
    registry: AgentRegistry,
    uwOpts: Required<Pick<UltraWorkerOptions, 'maxConcurrency' | 'defaultTimeoutMs' | 'defaultMaxRetries' | 'conflictStrategy'>>,
    _priorResults: SubTaskResult[],
  ): Promise<SubTaskResult[]> {
    const limiter = new ConcurrencyLimiter(uwOpts.maxConcurrency);
    const results = await Promise.all(
      phase.map((st) =>
        limiter.run(() => this.runSubTaskWithRetries(ctx, st, registry, uwOpts)),
      ),
    );
    return results;
  }

  /**
   * Run a single sub-task with retry + alternate-agent fallback.
   *
   * Strategy:
   *   1. Try the primary agent up to `maxRetries + 1` times.
   *   2. If still failing, try each alternate agent once.
   *   3. If all agents fail, return a failed SubTaskResult with the
   *      last error message.
   */
  protected async runSubTaskWithRetries(
    ctx: RunContext,
    st: SubTask,
    registry: AgentRegistry,
    uwOpts: Required<Pick<UltraWorkerOptions, 'maxConcurrency' | 'defaultTimeoutMs' | 'defaultMaxRetries' | 'conflictStrategy'>>,
  ): Promise<SubTaskResult> {
    const startedAt = Date.now();
    const maxRetries = st.maxRetries ?? uwOpts.defaultMaxRetries;
    const timeoutMs = st.timeoutMs ?? uwOpts.defaultTimeoutMs;
    let attempts = 0;
    let lastError: string | undefined;

    for (const agentId of st.agentIds) {
      const agent = registry.get(agentId);
      if (!agent) continue;
      const maxAttempts = (agentId === st.agentIds[0] ? maxRetries + 1 : 1);
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        attempts++;
        this.emitProgress(
          'analyze',
          `Sub-task ${st.id} (${st.domain}) → ${agentId} attempt ${attempt}/${maxAttempts}…`,
          { subTaskId: st.id, agentId, attempt, maxAttempts },
          ctx,
        );
        const result = await this.runAgentWithTimeout(agent, st.goal, ctx, timeoutMs);
        if (result.success && result.result !== null && result.result.success) {
          this.emitProgress('finding', `✓ ${st.id} (${agentId}) succeeded in ${result.durationMs}ms`, { subTaskId: st.id, agentId }, ctx);
          return {
            subTaskId: st.id,
            agentId,
            result: result.result,
            attempts,
            success: true,
            durationMs: Date.now() - startedAt,
          };
        }
        lastError = result.error ?? (result.result ? `agent returned success=false` : 'unknown error');
        this.emitProgress('action', `✗ ${st.id} (${agentId}) attempt ${attempt} failed: ${lastError}`, { subTaskId: st.id, agentId, error: lastError }, ctx);
      }
    }

    // All agents failed — record a finding so the user knows.
    this.addFinding(ctx, {
      severity: 'high',
      category: 'orchestration:subtask-failed',
      title: `Sub-task ${st.id} (${st.domain}) could not be completed`,
      description: `UltraWorker exhausted all retries and alternate agents for sub-task "${st.goal}". Last error: ${lastError ?? 'unknown'}. The sub-task requires manual review.`,
      suggestion: `Run the agent manually: \`registry.run('${st.agentIds[0]}', ${JSON.stringify(st.goal)})\` and inspect the agent's output for the failure cause.`,
      autoFixable: false,
      tags: ['orchestration', 'failure', st.domain],
    });

    return {
      subTaskId: st.id,
      agentId: st.agentIds[st.agentIds.length - 1],
      result: null,
      attempts,
      success: false,
      error: lastError,
      durationMs: Date.now() - startedAt,
    };
  }

  /**
   * Invoke a single agent with a hard timeout. Returns the agent's
   * {@link AgentRunResult} (success or not) plus metadata. Never
   * throws — exceptions are captured into `error`.
   */
  protected async runAgentWithTimeout(
    agent: SpecializedAgent,
    goal: string,
    ctx: RunContext,
    timeoutMs: number,
  ): Promise<{ result: AgentRunResult | null; success: boolean; error?: string; durationMs: number }> {
    const start = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutGuard = new Promise<{
      result: null;
      success: false;
      error: string;
      durationMs: number;
    }>((resolve) => {
      timer = setTimeout(() => {
        resolve({
          result: null,
          success: false,
          error: `agent timed out after ${timeoutMs}ms`,
          durationMs: Date.now() - start,
        });
      }, timeoutMs);
    });

    const runPromise = agent
      .run(goal, {
        cwd: ctx.opts.cwd,
        dryRun: ctx.opts.dryRun,
        outputFormat: 'markdown',
        provider: ctx.opts.provider === 'static' ? undefined : ctx.opts.provider,
        maxIterations: ctx.opts.maxIterations,
        onProgress: (ev) => this.emitProgress('action', `[${agent.id}] ${ev.message}`, { subAgent: agent.id, event: ev }, ctx),
      })
      .then((result) => ({
        result,
        success: true as const,
        durationMs: Date.now() - start,
      }))
      .catch((err: unknown) => ({
        result: null,
        success: false as const,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      }));

    try {
      return await Promise.race([runPromise, timeoutGuard]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ── Synthesis ──────────────────────────────────────────────────────────────

  /**
   * Synthesize findings from all sub-task results: deduplicate,
   * cross-reference, and roll up cost / token / action totals.
   */
  protected synthesize(ctx: RunContext, results: SubTaskResult[]): {
    findings: AgentFinding[];
    dedupedCount: number;
    totalActions: number;
    totalCostUsd: number;
    totalTokens: number;
  } {
    const allFindings: Array<AgentFinding & { _agentId: string }> = [];
    let totalActions = 0;
    let totalCostUsd = 0;
    let totalTokens = 0;

    for (const r of results) {
      if (!r.result) continue;
      for (const f of r.result.findings) {
        allFindings.push(Object.assign({}, f, { _agentId: r.agentId }));
      }
      totalActions += r.result.actions.length;
      totalCostUsd += r.result.costUsd;
      totalTokens += r.result.tokensUsed;
    }

    // Deduplicate by normalized (category, file, title) key. When two
    // findings collide, keep the higher-severity one and merge tags.
    const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4 } as const;
    const buckets = new Map<string, Array<AgentFinding & { _agentId: string }>>();
    for (const f of allFindings) {
      const key = this.dedupeKey(f);
      const arr = buckets.get(key) ?? [];
      arr.push(f);
      buckets.set(key, arr);
    }

    const deduped: AgentFinding[] = [];
    let dedupedCount = 0;
    for (const arr of buckets.values()) {
      if (arr.length === 1) {
        // Strip the internal _agentId marker before promoting.
        const f = arr[0];
        const cleaned: AgentFinding = {
          id: f.id,
          severity: f.severity,
          category: f.category,
          title: f.title,
          description: f.description,
          file: f.file,
          line: f.line,
          endLine: f.endLine,
          snippet: f.snippet,
          suggestion: f.suggestion,
          autoFixable: f.autoFixable,
          tags: f.tags,
        };
        deduped.push(cleaned);
      } else {
        // Merge: keep the highest-severity finding, append agent tags.
        arr.sort((a, b) => order[a.severity] - order[b.severity]);
        const primary = arr[0];
        const agentTags = arr.map((f) => `agent:${f._agentId}`);
        const merged: AgentFinding = {
          id: primary.id,
          severity: primary.severity,
          category: primary.category,
          title: primary.title,
          description: `${primary.description}\n\n**Cross-referenced by ${arr.length} agents:** ${arr.map((f) => f._agentId).join(', ')}.`,
          file: primary.file,
          line: primary.line,
          endLine: primary.endLine,
          snippet: primary.snippet,
          suggestion: primary.suggestion,
          autoFixable: primary.autoFixable,
          tags: [...new Set([...(primary.tags ?? []), ...agentTags, 'cross-referenced'])],
        };
        deduped.push(merged);
        dedupedCount += arr.length - 1;
      }
    }

    // Sort: critical → info.
    deduped.sort((a, b) => order[a.severity] - order[b.severity]);

    // Promote synthesized findings to the run context.
    for (const f of deduped) {
      this.addFinding(ctx, f);
    }

    return {
      findings: deduped,
      dedupedCount,
      totalActions,
      totalCostUsd,
      totalTokens,
    };
  }

  /** Build a dedupe key from a finding's category + file + normalized title. */
  protected dedupeKey(f: AgentFinding): string {
    const titleNorm = f.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 60);
    const fileNorm = (f.file ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '/').slice(-80);
    const cat = f.category.toLowerCase();
    return `${cat}|${fileNorm}|${titleNorm}`;
  }

  // ── Conflict detection ─────────────────────────────────────────────────────

  /**
   * Detect conflicts between agents' findings. A conflict is when
   * two agents emit findings with overlapping dedupe-keys but
   * *different* suggestions (i.e. they disagree on the fix).
   */
  protected detectConflicts(results: SubTaskResult[], strategy: ConflictStrategy): FindingConflict[] {
    const byAgent: Array<{ agentId: string; finding: AgentFinding }> = [];
    for (const r of results) {
      if (!r.result) continue;
      for (const f of r.result.findings) byAgent.push({ agentId: r.agentId, finding: f });
    }

    const conflicts: FindingConflict[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < byAgent.length; i++) {
      for (let j = i + 1; j < byAgent.length; j++) {
        const a = byAgent[i];
        const b = byAgent[j];
        if (a.agentId === b.agentId) continue;
        const ka = this.dedupeKey(a.finding);
        const kb = this.dedupeKey(b.finding);
        if (ka !== kb) continue;
        const key = [a.agentId, b.agentId, ka].sort().join('||');
        if (seen.has(key)) continue;
        seen.add(key);
        const sa = (a.finding.suggestion ?? '').trim();
        const sb = (b.finding.suggestion ?? '').trim();
        if (sa.length > 0 && sb.length > 0 && sa !== sb) {
          conflicts.push({
            topic: a.finding.title,
            agentIds: [a.agentId, b.agentId],
            findings: [a.finding, b.finding],
            resolvedBy: strategy,
            resolution: this.resolveConflict(strategy, a, b),
          });
        }
      }
    }
    return conflicts;
  }

  /**
   * Apply a conflict-resolution strategy. Returns a human-readable
   * resolution note.
   */
  protected resolveConflict(
    strategy: ConflictStrategy,
    a: { agentId: string; finding: AgentFinding },
    b: { agentId: string; finding: AgentFinding },
  ): string {
    const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4 } as const;
    switch (strategy) {
      case 'consensus': {
        // Majority wins — but with only 2 agents, fall back to severity.
        const winner = order[a.finding.severity] <= order[b.finding.severity] ? a : b;
        return `Consensus (severity tiebreak): adopting ${winner.agentId}'s recommendation.`;
      }
      case 'authority': {
        // The agent with the higher-severity finding is the authority.
        const winner = order[a.finding.severity] <= order[b.finding.severity] ? a : b;
        return `Authority: ${winner.agentId} (higher-severity finding) wins.`;
      }
      case 'escalation': {
        return `Escalation: conflict flagged for human review. Both recommendations retained. Agents: ${a.agentId}, ${b.agentId}.`;
      }
      case 'union':
      default: {
        return `Union: both recommendations retained and flagged. Agents: ${a.agentId}, ${b.agentId}.`;
      }
    }
  }

  // ── Output formatting ──────────────────────────────────────────────────────

  /** Render the ASCII execution plan. */
  protected formatExecutionPlan(goal: string, subTasks: SubTask[], phases: SubTask[][]): string {
    const lines: string[] = [];
    lines.push(`ULTRAWORKER EXECUTION PLAN`);
    lines.push(`══════════════════════════`);
    lines.push(`Goal: "${goal}"`);
    lines.push('');
    phases.forEach((phase, i) => {
      const isLast = i === phases.length - 1;
      const label = isLast && phase.length === 1 && phase[0].id === 'synthesis' ? 'synthesis' : `parallel, max ${DEFAULT_MAX_CONCURRENCY} agents`;
      lines.push(`Phase ${i + 1} (${label}):`);
      phase.forEach((st, j) => {
        const branch = j === phase.length - 1 ? '└─' : '├─';
        const agents = st.agentIds.join(' | ');
        const deps = st.dependsOn.length > 0 ? ` [depends on: ${st.dependsOn.join(', ')}]` : '';
        lines.push(`  ${branch} ${agents.padEnd(22)} → "${st.goal.slice(0, 60)}${st.goal.length > 60 ? '…' : ''}" [priority: ${st.priority}]${deps}`);
      });
      lines.push('');
    });
    if (phases.length === 0) {
      lines.push('(no sub-tasks could be derived from the goal)');
      lines.push('');
    }
    lines.push(`Phase ${phases.length + 1} (synthesis):`);
    lines.push(`  └─ UltraWorker          → "Combine all findings into unified report"`);
    lines.push('');
    return lines.join('\n');
  }

  /** Render the unified final report. */
  protected formatUnifiedReport(
    ctx: RunContext,
    goal: string,
    subTasks: SubTask[],
    phases: SubTask[][],
    results: SubTaskResult[],
    synthesis: { findings: AgentFinding[]; dedupedCount: number; totalActions: number; totalCostUsd: number; totalTokens: number },
    conflicts: FindingConflict[],
    registry: AgentRegistry,
  ): string {
    const lines: string[] = [];
    lines.push(`# 👑 UltraWorker — Unified Orchestration Report`);
    lines.push('');
    lines.push(`**Goal:** ${goal}`);
    lines.push(`**Status:** ${ctx.success ? '✅ Completed' : '⚠️ Completed with issues'}`);
    lines.push(`**Registry:** ${registry.size} agent(s) available`);
    lines.push(`**Sub-tasks:** ${results.filter((r) => r.success).length}/${subTasks.length} succeeded`);
    lines.push(`**Phases:** ${phases.length}`);
    lines.push(`**Unified findings:** ${synthesis.findings.length} (${synthesis.dedupedCount} deduped)`);
    lines.push(`**Conflicts:** ${conflicts.length}`);
    lines.push(`**Total cost:** $${synthesis.totalCostUsd.toFixed(4)} (${synthesis.totalTokens} tokens, ${synthesis.totalActions} actions)`);
    lines.push('');

    // Execution plan.
    lines.push('## Execution plan');
    lines.push('');
    lines.push('```');
    lines.push(this.formatExecutionPlan(goal, subTasks, phases).trim());
    lines.push('```');
    lines.push('');

    // Sub-task results table.
    lines.push('## Sub-task results');
    lines.push('');
    lines.push('| # | Sub-task | Domain | Agent | Attempts | Status | Duration | Findings |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    results.forEach((r, i) => {
      const st = subTasks.find((s) => s.id === r.subTaskId);
      const status = r.success ? '✅' : '❌';
      const findings = r.result?.findings.length ?? 0;
      lines.push(`| ${i + 1} | ${r.subTaskId} | ${st?.domain ?? '-'} | ${r.agentId} | ${r.attempts} | ${status} | ${r.durationMs}ms | ${findings} |`);
    });
    lines.push('');

    // Conflicts.
    if (conflicts.length > 0) {
      lines.push('## Conflicts resolved');
      lines.push('');
      for (const c of conflicts) {
        lines.push(`### ⚖️ ${c.topic}`);
        lines.push('');
        lines.push(`- **Agents:** ${c.agentIds.join(', ')}`);
        lines.push(`- **Resolution:** ${c.resolvedBy} — ${c.resolution}`);
        lines.push('');
      }
    }

    // Unified findings (sorted by severity).
    if (synthesis.findings.length > 0) {
      lines.push('## Unified findings');
      lines.push('');
      const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4 } as const;
      const sorted = [...synthesis.findings].sort((a, b) => order[a.severity] - order[b.severity]);
      for (const f of sorted) {
        const agentTag = f.tags?.find((t) => t.startsWith('agent:'));
        const agents = agentTag ? ` · ${agentTag}` : '';
        const loc = f.file ? ` \`${f.file}${f.line ? `:${f.line}` : ''}\`` : '';
        lines.push(`### [${f.severity.toUpperCase()}] ${f.title}${loc}${agents}`);
        lines.push('');
        lines.push(`- **Category:** ${f.category}`);
        if (f.tags && f.tags.length > 0) lines.push(`- **Tags:** ${f.tags.map((t) => `\`${t}\``).join(', ')}`);
        lines.push('');
        lines.push(f.description);
        if (f.suggestion) {
          lines.push('');
          lines.push('**Suggested fix:**');
          lines.push('');
          lines.push(f.suggestion);
        }
        lines.push('');
      }
    }

    // Per-agent metric roll-up.
    lines.push('## Per-agent metrics');
    lines.push('');
    lines.push('| Agent | Findings | Actions | Cost (USD) | Tokens | Duration |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    const byAgent = new Map<string, { findings: number; actions: number; cost: number; tokens: number; duration: number }>();
    for (const r of results) {
      if (!r.result) continue;
      const cur = byAgent.get(r.agentId) ?? { findings: 0, actions: 0, cost: 0, tokens: 0, duration: 0 };
      cur.findings += r.result.findings.length;
      cur.actions += r.result.actions.length;
      cur.cost += r.result.costUsd;
      cur.tokens += r.result.tokensUsed;
      cur.duration += r.result.durationMs;
      byAgent.set(r.agentId, cur);
    }
    for (const [agentId, m] of byAgent) {
      lines.push(`| ${agentId} | ${m.findings} | ${m.actions} | $${m.cost.toFixed(4)} | ${m.tokens} | ${m.duration}ms |`);
    }
    lines.push('');
    return lines.join('\n');
  }
}

// ─── Concurrency limiter (inline; replaces the `p-limit` dep) ────────────────

/**
 * Minimal promise concurrency limiter — equivalent to `p-limit`.
 * Keeps at most `maxConcurrent` promises running at once.
 */
class ConcurrencyLimiter {
  private readonly maxConcurrent: number;
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(maxConcurrent: number) {
    this.maxConcurrent = Math.max(1, maxConcurrent);
  }

  /** Run `fn`, respecting the concurrency cap. Resolves with fn's result. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}
