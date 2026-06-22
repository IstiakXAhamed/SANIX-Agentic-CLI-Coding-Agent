/**
 * @file ReviewEngine.ts
 * @description The PR review engine: runs a configurable set of
 * {@link ReviewRule}s against a {@link PullRequest} and aggregates the
 * resulting {@link ReviewComment}s into a {@link ReviewResult} with a
 * final {@link ReviewState}.
 *
 * The engine ships with 52 built-in rules spanning 10 categories
 * (style, correctness, security, performance, maintainability,
 * documentation, testing, accessibility, compatibility, metadata).
 * Each rule is small, focused, and independently disable-able via the
 * {@link ReviewEngineOptions} or per-rule `enabled` flag.
 *
 * Aggregation logic:
 *
 *   - Any `blocker` comment → state = `blocked`
 *   - Any `error` comment with `blocksApproval` rule → state = `changes_requested`
 *   - Any `warning`/`error`/`suggestion`/`nit`/`info` comment → state = `commented`
 *   - No comments → state = `approved`
 *
 * The summary is a Markdown bullet list of the top findings grouped by
 * severity, plus an aggregate count and rule breakdown.
 *
 * @packageDocumentation
 */

import type {
  PullRequest,
  ReviewComment,
  ReviewEngineOptions,
  ReviewResult,
  ReviewRule,
  ReviewState,
  RuleCategory,
} from './types.js';
import { BUILTIN_RULES } from './rules.js';

/**
 * Runs {@link ReviewRule}s against a PR and aggregates the result.
 *
 * ```ts
 * const engine = new ReviewEngine();
 * const result = engine.review(pr);
 * if (result.state === 'blocked') failCI();
 * ```
 */
export class ReviewEngine {
  /** All registered rules (built-in + any added via {@link addRule}). */
  #rules: ReviewRule[] = [...BUILTIN_RULES];

  /**
   * Register an additional rule. Useful for project-specific checks.
   *
   * @param rule - The rule to register.
   */
  addRule(rule: ReviewRule): void {
    this.#rules.push(rule);
  }

  /**
   * Register multiple rules at once.
   *
   * @param rules - The rules to register.
   */
  addRules(rules: readonly ReviewRule[]): void {
    this.#rules.push(...rules);
  }

  /** All currently-registered rules (defensive copy). */
  get rules(): readonly ReviewRule[] {
    return [...this.#rules];
  }

  /**
   * Run all (enabled) rules against `pr` and return the aggregated
   * {@link ReviewResult}.
   *
   * @param pr      - The PR to review.
   * @param options - Engine options (see {@link ReviewEngineOptions}).
   * @returns The review result.
   */
  review(pr: PullRequest, options: ReviewEngineOptions = {}): ReviewResult {
    const start = Date.now();
    const disable = new Set(options.disableRules ?? []);
    const only = options.onlyRules ? new Set(options.onlyRules) : undefined;
    const comments: ReviewComment[] = [];
    const ruleCounts: Record<string, number> = {};
    for (const rule of this.#rules) {
      if (!rule.enabled) continue;
      if (disable.has(rule.id)) continue;
      if (only && !only.has(rule.id)) continue;
      let produced: ReviewComment[] = [];
      try {
        produced = rule.evaluate(pr) ?? [];
      } catch {
        // A misbehaving rule must never break the review — skip it.
        continue;
      }
      if (produced.length > 0) {
        ruleCounts[rule.id] = produced.length;
        comments.push(...produced);
      }
    }
    const state = this.#aggregateState(comments, options.dryRun ?? false);
    const summary = this.#buildSummary(pr, comments, ruleCounts, state);
    return {
      pullRequest: pr,
      comments,
      state,
      summary,
      ruleCounts,
      durationMs: Date.now() - start,
    };
  }

  /**
   * Determine the aggregate {@link ReviewState} from the comments. The
   * worst severity wins; `dryRun` always downgrades to `commented`.
   */
  #aggregateState(comments: readonly ReviewComment[], dryRun: boolean): ReviewState {
    if (dryRun) return 'commented';
    if (comments.length === 0) return 'approved';
    if (comments.some((c) => c.severity === 'blocker')) return 'blocked';
    // Look for `error`-severity comments produced by a rule that blocks approval.
    const blockerRuleIds = new Set(this.#rules.filter((r) => r.blocksApproval).map((r) => r.id));
    if (comments.some((c) => c.severity === 'error' && blockerRuleIds.has(c.ruleId))) {
      return 'changes_requested';
    }
    return 'commented';
  }

  /**
   * Build a Markdown summary of the review. Top section is the state,
   * middle section is counts by severity, bottom section is the top
   * finding per rule.
   */
  #buildSummary(
    pr: PullRequest,
    comments: readonly ReviewComment[],
    ruleCounts: Readonly<Record<string, number>>,
    state: ReviewState,
  ): string {
    const lines: string[] = [
      `## SANIX PR Review — ${state.toUpperCase()}`,
      '',
      `Reviewed **${pr.title}** (${pr.additions}+ / ${pr.deletions}- across ${pr.files.length} files).`,
      '',
    ];
    if (comments.length === 0) {
      lines.push('✅ No issues found. Looks good to merge!');
      return lines.join('\n');
    }
    const bySeverity = this.#groupBySeverity(comments);
    lines.push('### By severity');
    for (const sev of ['blocker', 'error', 'warning', 'suggestion', 'nit', 'info'] as const) {
      const n = bySeverity[sev];
      if (n > 0) lines.push(`- **${sev}**: ${n}`);
    }
    lines.push('', '### Top rules');
    const sorted = Object.entries(ruleCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
    for (const [ruleId, count] of sorted) {
      lines.push(`- \`${ruleId}\` — ${count} finding${count === 1 ? '' : 's'}`);
    }
    return lines.join('\n');
  }

  /** Group comments by severity and return counts. */
  #groupBySeverity(comments: readonly ReviewComment[]): Record<string, number> {
    const out: Record<string, number> = { blocker: 0, error: 0, warning: 0, suggestion: 0, nit: 0, info: 0 };
    for (const c of comments) out[c.severity] = (out[c.severity] ?? 0) + 1;
    return out;
  }

  /**
   * Return rules filtered by category. Useful for documentation
   * generation.
   *
   * @param category - The category to filter by.
   */
  rulesByCategory(category: RuleCategory): readonly ReviewRule[] {
    return this.#rules.filter((r) => r.category === category);
  }
}
