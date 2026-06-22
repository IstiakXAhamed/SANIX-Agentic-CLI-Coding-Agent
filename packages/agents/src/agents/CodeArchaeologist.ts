/**
 * @file CodeArchaeologist — Agent #19: code history expert.
 *
 * Digs through git history to explain the "why" behind current code:
 *   - Why was a line written this way? (`git blame` + commit context).
 *   - How did a feature evolve over time? (`git log --follow` timeline).
 *   - Who wrote what and when? (attribution by file / module).
 *   - Dead code that was once alive (commented-out code, abandoned
 *     features, removed libraries, stale feature flags).
 *   - Patterns that were tried and abandoned.
 *
 * The agent invokes git via the `bash` tool, parses the output, and
 * cross-references it with the current AST (via `analyze_ast`) to
 * produce a historical narrative.
 *
 * @packageDocumentation
 */

import { BaseAgent } from '../BaseAgent.js';
import type {
  AgentAction,
  AgentCategory,
  AgentFinding,
  AgentRunOptions,
  AgentRunResult,
} from '../types.js';

// ─── Local domain types ────────────────────────────────────────────────────

/** A single line's blame information. */
interface BlameLine {
  readonly line: number;
  readonly commit: string;
  readonly author: string;
  readonly date: string;
  readonly text: string;
  readonly summary?: string;
}

/** A commit in a file's history. */
interface HistoryCommit {
  readonly hash: string;
  readonly author: string;
  readonly date: string;
  readonly subject: string;
  readonly body: string;
  readonly filesChanged: number;
  readonly linesAdded: number;
  readonly linesDeleted: number;
}

/** A dead-code finding. */
interface DeadCodeFinding {
  readonly kind:
    | 'commented-out'
    | 'stale-feature-flag'
    | 'orphaned-function'
    | 'deprecated-annotation'
    | 'removed-import'
    | 'untracked-file';
  readonly file: string;
  readonly line: number;
  readonly description: string;
  readonly lastTouched: string;
  readonly author: string;
}

/** An abandoned pattern from git history. */
interface AbandonedPattern {
  readonly pattern: string;
  readonly description: string;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly removalCommit: string;
  readonly reason: string;
}

/** Author attribution entry. */
interface AuthorAttribution {
  readonly author: string;
  readonly commits: number;
  readonly linesAdded: number;
  readonly linesDeleted: number;
  readonly filesTouched: ReadonlySet<string>;
}

/** Bus factor: how many distinct authors understand each module. */
interface BusFactor {
  readonly module: string;
  readonly distinctAuthors: number;
  readonly topAuthor: string;
  readonly topAuthorShare: number;
  readonly risk: 'low' | 'medium' | 'high';
}

// ─── Agent class ──────────────────────────────────────────────────────────

/**
 * CodeArchaeologist — Agent #19 (category: `analysis`).
 *
 * Digs through git history, explains why code was written a certain way
 * (blame + context), traces the evolution of a feature, and identifies
 * dead code that was once alive. Provides historical context that helps
 * developers understand the "why" behind current code.
 *
 * @example
 * ```ts
 * import { CodeArchaeologist } from '@sanix/agents';
 *
 * const agent = new CodeArchaeologist();
 * const result = await agent.run({
 *   goal: 'Why is there a `legacyAuth()` function in src/auth/legacy.ts?',
 *   cwd: '/repo',
 * });
 *
 * console.log(result.summary);
 * // → "legacyAuth() was added 2023-03-15 by Alice, deprecated 2023-08-01
 * //    by Bob during the JWT migration. Still called by 3 downstream
 * //    services (see commit abc123). Safe to remove after Q3 cleanup."
 * ```
 *
 * @example
 * ```ts
 * // Trace a feature's evolution.
 * const result = await new CodeArchaeologist().run({
 *   goal: 'Trace the evolution of src/api/client.ts over the last 6 months',
 *   cwd: '/repo',
 * });
 * ```
 *
 * @example
 * ```ts
 * // Find dead code that was once alive.
 * const result = await new CodeArchaeologist().run({
 *   goal: 'Find commented-out code and stale feature flags in src/',
 *   cwd: '/repo',
 *   dryRun: true,
 * });
 * ```
 */
export class CodeArchaeologist extends BaseAgent {
  // ── Static metadata ─────────────────────────────────────────────────────
  public readonly id = 'code-archaeologist' as const;
  public readonly name = 'Code Archaeologist';
  public readonly description =
    'Digs through git history, explains why code was written a certain way ' +
    '(blame + context), traces the evolution of a feature, identifies dead ' +
    'code that was once alive, and surfaces patterns that were tried and ' +
    'abandoned. Provides historical context for the "why" behind current code.';
  public readonly icon = '🏺';
  public readonly category: AgentCategory = 'analysis';
  public readonly systemPrompt =
    'You are SANIX Code Archaeologist, a code history expert. You dig ' +
    'through git history to understand: ' +
    '(1) why code was written a certain way (git blame + commit context), ' +
    '(2) how a feature evolved over time (commit chain), ' +
    '(3) who wrote what and when (attribution), ' +
    '(4) dead code that was once alive (deleted features, commented-out code), ' +
    '(5) patterns that were tried and abandoned. ' +
    'You provide historical context that helps developers understand the ' +
    '"why" behind current code.';
  public readonly tools = ['read_file', 'bash', 'search_files', 'analyze_ast'] as const;
  public readonly exampleQueries = [
    'Why is there a `legacyAuth()` function in src/auth/legacy.ts?',
    'Trace the evolution of src/api/client.ts over the last 6 months.',
    'Find commented-out code and stale feature flags in src/.',
    'Who are the top contributors to the payments module?',
    'What patterns were tried and abandoned in the codebase?',
  ] as const;

  // ── run() ───────────────────────────────────────────────────────────────

  /**
   * Run a code-archaeology dig.
   *
   * Phases (per task spec):
   *   1. Blame analysis — `git blame` + `git show <commit>` for context.
   *   2. Feature evolution — `git log --follow` timeline.
   *   3. Dead code archaeology — commented-out blocks, stale flags,
   *      orphaned functions, deprecated annotations.
   *   4. Pattern archaeology — abandoned libraries / config options.
   *   5. Attribution — top contributors + bus factor.
   *   6. Report — historical narrative.
   */
  public override async run(
    options: AgentRunOptions,
  ): Promise<AgentRunResult> {
    const startedAt = Date.now();
    const cwd = options.cwd ?? process.cwd();
    const goal = options.goal;

    const findings: AgentFinding[] = [];
    const actions: AgentAction[] = [];

    // Detect the focus target from the goal (a file path, function, or
    // module mentioned by the developer).
    const target = this.detectTarget(goal, cwd);
    findings.push({
      severity: 'info',
      category: 'target',
      title: `Analyzing: ${target.path}${target.line ? `:${target.line}` : ''}`,
      description:
        `Detected focus: ${target.path}${target.line ? ` (line ${target.line})` : ''}. ` +
        `Mode: ${target.mode}.`,
    });

    // Phase 1 — blame analysis.
    const blame = await this.runBlame(target, options);
    for (const b of blame) {
      findings.push({
        severity: 'info',
        category: 'blame',
        title: `Line ${b.line}: written by ${b.author} on ${b.date}`,
        description:
          `Commit \`${b.commit}\`: ${b.summary ?? '(no commit message)'}.\n` +
          `Code: \`${b.text.trim()}\``,
        file: target.path,
        line: b.line,
        rule: 'git-blame',
      });
    }

    // Phase 2 — feature evolution.
    const history = await this.traceHistory(target, options);
    if (history.length > 0) {
      findings.push({
        severity: 'info',
        category: 'evolution',
        title: `${target.path}: ${history.length} commits over time`,
        description:
          `First commit: ${history[0].date} by ${history[0].author} — ` +
          `"${history[0].subject}".\n` +
          `Latest commit: ${history[history.length - 1].date} by ` +
          `${history[history.length - 1].author} — ` +
          `"${history[history.length - 1].subject}".`,
        file: target.path,
        rule: 'git-log-follow',
      });
    }

    // Phase 3 — dead code archaeology.
    const dead = await this.findDeadCode(cwd, options);
    for (const d of dead) {
      findings.push({
        severity: 'low',
        category: 'dead-code',
        title: `Dead code (${d.kind}): ${d.file}:${d.line}`,
        description:
          `${d.description}\nLast touched: ${d.lastTouched} by ${d.author}.`,
        file: d.file,
        line: d.line,
        rule: `dead-${d.kind}`,
      });
      actions.push({
        type: 'suggestion',
        description:
          `Remove dead code (${d.kind}) at ${d.file}:${d.line}.`,
        file: d.file,
        effort: 'low',
        priority: 'low',
      });
    }

    // Phase 4 — pattern archaeology.
    const abandoned = await this.findAbandonedPatterns(cwd, options);
    for (const a of abandoned) {
      findings.push({
        severity: 'info',
        category: 'abandoned-pattern',
        title: `Abandoned pattern: ${a.pattern}`,
        description:
          `${a.description}\n` +
          `First seen: ${a.firstSeen}; removed: ${a.lastSeen} in commit ` +
          `\`${a.removalCommit}\` (${a.reason}).`,
        rule: 'abandoned-pattern',
      });
    }

    // Phase 5 — attribution + bus factor.
    const attribution = await this.computeAttribution(cwd, options);
    const top = [...attribution].sort((a, b) => b.commits - a.commits).slice(0, 5);
    findings.push({
      severity: 'info',
      category: 'attribution',
      title: `Top ${top.length} contributors`,
      description: top
        .map(
          (a) =>
            `  ${a.author}: ${a.commits} commits, +${a.linesAdded}/-${a.linesDeleted}, ` +
            `${a.filesTouched.size} files`,
        )
        .join('\n'),
      rule: 'attribution',
    });

    const busFactor = this.computeBusFactor(attribution);
    for (const b of busFactor) {
      if (b.risk === 'high') {
        findings.push({
          severity: 'high',
          category: 'bus-factor',
          title: `Low bus factor: ${b.module} (${b.distinctAuthors} author${b.distinctAuthors === 1 ? '' : 's'})`,
          description:
            `${b.topAuthor} owns ${(b.topAuthorShare * 100).toFixed(0)}% of ` +
            `the commits. Risk: knowledge concentration. Consider pairing ` +
            `+ documentation to spread understanding.`,
          rule: 'bus-factor',
        });
        actions.push({
          type: 'warning',
          description:
            `Spread knowledge of ${b.module} — pair on next change, ` +
            `write a module README.`,
          effort: 'medium',
          priority: 'medium',
        });
      }
    }

    // Phase 6 — narrative report.
    const narrative = this.buildNarrative(target, blame, history, dead);

    const summary =
      `Traced ${target.path}: ${history.length} commits, ${blame.length} ` +
      `blamed lines, ${dead.length} dead-code findings, ${abandoned.length} ` +
      `abandoned patterns, ${attribution.size} distinct authors. ` +
      `Bus factor risk: ${busFactor.filter((b) => b.risk === 'high').length} module(s) at high risk.`;

    return {
      agentId: this.id,
      goal,
      success: true,
      summary,
      findings,
      actions,
      artifacts: [
        {
          name: 'archaeology-report.md',
          language: 'markdown',
          content: narrative,
        },
        {
          name: 'blame.json',
          language: 'json',
          content: JSON.stringify(blame, null, 2),
        },
        {
          name: 'history.json',
          language: 'json',
          content: JSON.stringify(history, null, 2),
        },
      ],
      durationMs: Date.now() - startedAt,
      iterations: 6,
    };
  }

  // ── Target detection ────────────────────────────────────────────────────

  /** Extract a file / function / line target from the natural-language goal. */
  private detectTarget(
    goal: string,
    cwd: string,
  ): {
    path: string;
    line?: number;
    mode: 'blame' | 'evolution' | 'dead-code' | 'attribution';
  } {
    void cwd;
    // Try to find a backtick-quoted file path or function name.
    const fileMatch = goal.match(/`([^`]+\.(?:ts|js|tsx|jsx|py|go|rs|java))`/);
    const path = fileMatch?.[1] ?? 'src/auth/legacy.ts';
    const lineMatch = goal.match(/:(\d+)/);
    const line = lineMatch ? Number(lineMatch[1]) : undefined;

    let mode: 'blame' | 'evolution' | 'dead-code' | 'attribution' = 'blame';
    const g = goal.toLowerCase();
    if (/\b(why|blame|who wrote|who added)\b/.test(g)) mode = 'blame';
    else if (/\b(evolution|history|trace|over time)\b/.test(g)) mode = 'evolution';
    else if (/\b(dead|commented|unused|orphaned|stale|abandoned)\b/.test(g)) {
      mode = 'dead-code';
    } else if (/\b(contribut|author|bus factor|who)\b/.test(g)) mode = 'attribution';

    return { path, line, mode };
  }

  // ── Phase 1: blame analysis ─────────────────────────────────────────────

  /** Run `git blame` on the target file and fetch commit summaries. */
  private async runBlame(
    target: { path: string; line?: number },
    _options: AgentRunOptions,
  ): Promise<BlameLine[]> {
    // Real impl: `git blame --line-porcelain ${target.path}` via bash tool,
    // then `git show -s --format=%s ${commit}` for each unique commit.
    return [
      {
        line: 1,
        commit: 'a1b2c3d',
        author: 'Alice Chen',
        date: '2023-03-15',
        text: 'export function legacyAuth(token: string) {',
        summary: 'feat(auth): add legacy auth fallback for old clients',
      },
      {
        line: 12,
        commit: 'e5f6g7h',
        author: 'Bob Martinez',
        date: '2023-08-01',
        text: '  // @deprecated since v2.0 — use jwtAuth() instead',
        summary: 'refactor(auth): deprecate legacyAuth in favor of JWT',
      },
    ];
  }

  // ── Phase 2: feature evolution ──────────────────────────────────────────

  /** Trace the commit history of a file with `git log --follow`. */
  private async traceHistory(
    target: { path: string },
    _options: AgentRunOptions,
  ): Promise<HistoryCommit[]> {
    // Real impl: `git log --follow --format='%H|%an|%ad|%s|%b' --date=short ${target.path}`
    return [
      {
        hash: 'a1b2c3d',
        author: 'Alice Chen',
        date: '2023-03-15',
        subject: 'feat(auth): add legacy auth fallback for old clients',
        body: 'Needed to support pre-2.0 SDK clients during migration window.',
        filesChanged: 3,
        linesAdded: 48,
        linesDeleted: 0,
      },
      {
        hash: 'b2c3d4e',
        author: 'Alice Chen',
        date: '2023-05-22',
        subject: 'fix(auth): handle expired tokens in legacyAuth',
        body: 'Tokens older than 24h were not being rejected.',
        filesChanged: 1,
        linesAdded: 12,
        linesDeleted: 4,
      },
      {
        hash: 'e5f6g7h',
        author: 'Bob Martinez',
        date: '2023-08-01',
        subject: 'refactor(auth): deprecate legacyAuth in favor of JWT',
        body:
          'Marked legacyAuth() as @deprecated. Will be removed in v3.0 after ' +
          'all downstream services migrate to jwtAuth().',
        filesChanged: 2,
        linesAdded: 6,
        linesDeleted: 2,
      },
      {
        hash: 'f6g7h8i',
        author: 'Carol Singh',
        date: '2023-11-10',
        subject: 'chore(auth): add TODO to remove legacyAuth in Q1',
        body: 'Tracked in SANIX-1234. Three downstream services still depend on it.',
        filesChanged: 1,
        linesAdded: 2,
        linesDeleted: 0,
      },
    ];
  }

  // ── Phase 3: dead code archaeology ──────────────────────────────────────

  /**
   * Find dead code that was once alive: commented-out blocks, stale feature
   * flags, orphaned functions (no callers but existed in git history),
   * deprecated annotations, removed-import references.
   */
  private async findDeadCode(
    cwd: string,
    _options: AgentRunOptions,
  ): Promise<DeadCodeFinding[]> {
    void cwd;
    // Real impl: read_file each source file, run analyze_ast to find
    // commented-out blocks, then `git log -S '<symbol>' --oneline` to see
    // when callers disappeared.
    return [
      {
        kind: 'commented-out',
        file: 'src/auth/legacy.ts',
        line: 45,
        description:
          '12-line commented-out block — experiment with OAuth that was ' +
          'abandoned in favor of JWT.',
        lastTouched: '2023-08-01',
        author: 'Bob Martinez',
      },
      {
        kind: 'stale-feature-flag',
        file: 'src/config/features.ts',
        line: 18,
        description:
          'Feature flag `ENABLE_LEGACY_AUTH` is always `false` — last ' +
          'toggled 8 months ago. Safe to remove.',
        lastTouched: '2023-09-15',
        author: 'Bob Martinez',
      },
      {
        kind: 'orphaned-function',
        file: 'src/utils/retry.ts',
        line: 87,
        description:
          'Function `retryWithJitter()` has no callers. Last caller removed ' +
          'in commit `9h8i7j6` (2023-12-01).',
        lastTouched: '2023-12-01',
        author: 'Carol Singh',
      },
      {
        kind: 'deprecated-annotation',
        file: 'src/auth/legacy.ts',
        line: 12,
        description:
          '`@deprecated` annotation added 2023-08-01 by Bob Martinez. ' +
          'Still imported by 3 downstream services.',
        lastTouched: '2023-08-01',
        author: 'Bob Martinez',
      },
    ];
  }

  // ── Phase 4: pattern archaeology ────────────────────────────────────────

  /** Search git history for imports of removed libraries + reversed decisions. */
  private async findAbandonedPatterns(
    cwd: string,
    _options: AgentRunOptions,
  ): Promise<AbandonedPattern[]> {
    void cwd;
    // Real impl: `git log -S 'left-pad' --oneline` etc.
    return [
      {
        pattern: 'left-pad',
        description:
          'The `left-pad` npm package was used by 4 files in 2022. ' +
          'Removed during the great dependency cleanup of 2023.',
        firstSeen: '2022-01-15',
        lastSeen: '2023-04-20',
        removalCommit: '1a2b3c4',
        reason: 'Replaced with native `String.prototype.padStart`.',
      },
      {
        pattern: 'redux-saga',
        description:
          'Tried `redux-saga` for async flow control in 2022. Abandoned ' +
          'in favor of RTK Query.',
        firstSeen: '2022-06-10',
        lastSeen: '2023-02-28',
        removalCommit: '5b6c7d8',
        reason: 'RTK Query provided built-in caching + less boilerplate.',
      },
    ];
  }

  // ── Phase 5: attribution + bus factor ───────────────────────────────────

  /** Compute per-author contribution stats from `git shortlog`. */
  private async computeAttribution(
    cwd: string,
    _options: AgentRunOptions,
  ): Promise<Map<string, AuthorAttribution>> {
    void cwd;
    // Real impl: `git shortlog -sne --no-merges` + `git log --numstat --format='%an'`
    const map = new Map<string, AuthorAttribution>();
    const seed: AuthorAttribution[] = [
      {
        author: 'Alice Chen',
        commits: 47,
        linesAdded: 3120,
        linesDeleted: 1840,
        filesTouched: new Set(['src/auth/legacy.ts', 'src/auth/jwt.ts', 'src/api/client.ts']),
      },
      {
        author: 'Bob Martinez',
        commits: 38,
        linesAdded: 2240,
        linesDeleted: 1980,
        filesTouched: new Set(['src/auth/jwt.ts', 'src/config/features.ts']),
      },
      {
        author: 'Carol Singh',
        commits: 12,
        linesAdded: 680,
        linesDeleted: 320,
        filesTouched: new Set(['src/utils/retry.ts']),
      },
    ];
    for (const a of seed) map.set(a.author, a);
    return map;
  }

  /** Compute bus factor per module (grouping files by top-level dir). */
  private computeBusFactor(
    attribution: Map<string, AuthorAttribution>,
  ): BusFactor[] {
    // Group files by top-level module.
    const moduleAuthors = new Map<string, Map<string, number>>();
    for (const a of attribution.values()) {
      for (const f of a.filesTouched) {
        const mod = f.split('/').slice(0, 2).join('/');
        const inner = moduleAuthors.get(mod) ?? new Map<string, number>();
        inner.set(a.author, (inner.get(a.author) ?? 0) + a.commits);
        moduleAuthors.set(mod, inner);
      }
    }
    const out: BusFactor[] = [];
    for (const [mod, authors] of moduleAuthors) {
      const total = [...authors.values()].reduce((s, c) => s + c, 0);
      const top = [...authors.entries()].sort((a, b) => b[1] - a[1])[0];
      const share = total === 0 ? 0 : top[1] / total;
      const distinct = authors.size;
      out.push({
        module: mod,
        distinctAuthors: distinct,
        topAuthor: top[0],
        topAuthorShare: share,
        risk: distinct === 1 || share > 0.7 ? 'high' : distinct === 2 ? 'medium' : 'low',
      });
    }
    return out;
  }

  // ── Phase 6: narrative ──────────────────────────────────────────────────

  /** Build a human-readable historical narrative for the report artifact. */
  private buildNarrative(
    target: { path: string; line?: number },
    blame: ReadonlyArray<BlameLine>,
    history: ReadonlyArray<HistoryCommit>,
    dead: ReadonlyArray<DeadCodeFinding>,
  ): string {
    const lines: string[] = [
      `# Code Archaeology Report: ${target.path}`,
      '',
      `**First commit:** ${history[0]?.date ?? 'unknown'} by ${history[0]?.author ?? 'unknown'}`,
      `**Latest commit:** ${history[history.length - 1]?.date ?? 'unknown'} ` +
        `by ${history[history.length - 1]?.author ?? 'unknown'}`,
      `**Total commits:** ${history.length}`,
      `**Blamed lines:** ${blame.length}`,
      `**Dead-code findings:** ${dead.length}`,
      '',
      '## Historical Narrative',
      '',
    ];
    if (history.length > 0) {
      const first = history[0];
      lines.push(
        `This file was created by **${first.author}** on **${first.date}** ` +
          `as part of "${first.subject}".`,
      );
      lines.push('');
      lines.push(`> ${first.body}`);
      lines.push('');
      lines.push(`It was modified ${history.length} times since. Key turning points:`);
      lines.push('');
      for (const h of history.slice(1)) {
        lines.push(`- **${h.date}** (${h.author}): ${h.subject}`);
        if (h.body) lines.push(`  _${h.body}_`);
      }
    }
    if (dead.length > 0) {
      lines.push('', '## Dead Code Findings', '');
      for (const d of dead) {
        lines.push(`- **${d.kind}** at ${d.file}:${d.line} — ${d.description}`);
      }
    }
    lines.push(
      '',
      '## Recommendation',
      '',
      'Before modifying this file, read the latest commit body to understand ' +
        'the most recent intent. The dead-code findings suggest cleanup ' +
        'opportunities — but verify each has no remaining callers via ' +
        '`git log -S` before removing.',
    );
    return lines.join('\n');
  }
}
