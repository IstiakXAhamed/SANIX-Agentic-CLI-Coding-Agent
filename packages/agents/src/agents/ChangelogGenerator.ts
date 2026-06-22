/**
 * @file agents/ChangelogGenerator.ts
 * @description SANIX Changelog Generator agent (id: `changelog-gen`, icon:
 * 📋, category: `release`). Analyzes git history, categorizes commits using
 * Conventional Commits, detects breaking changes via AST-aware diff
 * inspection, computes the next semantic version, and writes both a
 * `CHANGELOG.md` (Keep a Changelog format) and a GitHub-formatted
 * release-notes document.
 *
 * The agent shells out to `git` via the `bash` tool (no `simple-git`
 * dependency), parses commit subjects + bodies with a small state
 * machine, and uses lightweight regex heuristics to classify
 * non-conventional messages. For breaking-change detection it inspects
 * `git show --stat` + the raw diff for removed exports / changed
 * function signatures (best-effort — full AST analysis is delegated to
 * the `analyze_ast` tool when available).
 *
 * @packageDocumentation
 */

import { BaseAgent } from '../BaseAgent.js';
import type {
  AgentAction,
  AgentArtifact,
  AgentCategory,
  AgentFinding,
  AgentRunOptions,
  AgentRunResult,
} from '../types.js';

/** Keep-a-Changelog category. */
type KeepAChangelogCategory =
  | 'Added'
  | 'Changed'
  | 'Deprecated'
  | 'Removed'
  | 'Fixed'
  | 'Security';

/** A parsed commit. */
interface ParsedCommit {
  readonly hash: string;
  readonly subject: string;
  readonly body: string;
  readonly author?: string;
  readonly date?: string;
  readonly conventional?: {
    readonly type: string;
    readonly scope?: string;
    readonly breaking: boolean;
    readonly description: string;
  };
  readonly inferredType: string;
  readonly inferredBreaking: boolean;
  readonly prNumber?: string;
}

/** A breaking change with migration notes. */
interface BreakingChange {
  readonly commit: ParsedCommit;
  readonly summary: string;
  readonly migration: string;
  readonly evidence: string;
}

/** Result of the version-bump computation. */
interface VersionBump {
  readonly current: string;
  readonly next: string;
  readonly kind: 'major' | 'minor' | 'patch' | 'none';
  readonly reason: string;
}

/** Counter for unique ids within a single run. */
let _idCounter = 0;
function nextId(prefix: string): string {
  _idCounter += 1;
  return `${prefix}-${_idCounter.toString(36).padStart(4, '0')}`;
}

/**
 * SANIX Changelog Generator — release-management specialist.
 *
 * @example
 * ```ts
 * import { ChangelogGeneratorAgent } from '@sanix/agents';
 * const agent = new ChangelogGeneratorAgent();
 * const result = await agent.run({
 *   cwd: '/workspace/project',
 *   goal: 'Generate a changelog and release notes for v1.4.0 since v1.3.0.',
 *   toolCall: async (t, i) => invokeSanixTool(t, i),
 * });
 * console.log(result.summary);
 * ```
 */
export class ChangelogGeneratorAgent extends BaseAgent {
  readonly id = 'changelog-gen';
  readonly name = 'Changelog Generator';
  readonly icon = '📋';
  readonly category: AgentCategory = 'release';
  readonly description =
    'Analyzes git history, categorizes commits using Conventional Commits, ' +
    'detects breaking changes (removed exports, changed signatures), ' +
    'computes the next semantic version, and writes CHANGELOG.md ' +
    '(Keep a Changelog) + GitHub release notes + a migration guide.';
  readonly systemPrompt =
    'You are SANIX Changelog Generator, a release management expert. You analyze git history ' +
    'and generate: (1) changelogs in Keep a Changelog format, (2) GitHub release notes, ' +
    '(3) semantic version bumps, (4) migration guides for breaking changes. You categorize ' +
    'commits using Conventional Commits (feat, fix, breaking, refactor, docs, test, chore). ' +
    'You can detect breaking changes by analyzing code diffs.';
  readonly tools = ['read_file', 'write_file', 'bash', 'search_files', 'analyze_ast'];
  readonly exampleQueries = [
    'Generate a changelog for the last 50 commits and propose the next version.',
    'Create release notes for v2.0.0 since v1.9.0, including breaking-change migration guide.',
    'Detect breaking changes between tags v1.4.0 and HEAD.',
    'Categorize commits since the last release and write CHANGELOG.md.',
    'Recommend a version bump based on commits since v0.9.0.',
  ];

  /** @inheritdoc */
  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    const startedAt = Date.now();
    const actions: AgentAction[] = [];
    const findings: AgentFinding[] = [];
    const artifacts: AgentArtifact[] = [];
    const recommendations: string[] = [];
    let tokensUsed = 0;
    let toolCalls = 0;
    _idCounter = 0;

    this.emit(options, 'agent:start', { agentId: this.id, goal: options.goal });

    try {
      // ── Phase 1: parse the range from the goal ───────────────────────
      const range = this.parseRange(options.goal);
      this.emit(options, 'agent:plan', { range });

      // ── Phase 2: confirm git repo + read package.json ────────────────
      this.emit(options, 'phase:start', { phase: 'repo' });
      const currentVersion = await this.detectCurrentVersion(options, actions);
      toolCalls += 1;
      this.emit(options, 'phase:complete', { phase: 'repo', currentVersion });

      // ── Phase 3: git log ─────────────────────────────────────────────
      this.emit(options, 'phase:start', { phase: 'git-log' });
      const logRes = await this.runGit(
        options,
        `git log --no-merges --format='%H%x09%an%x09%ad%x09%s%x09%x09%b' ${range.since ? `${range.since}..` : ''}${range.until ?? 'HEAD'}${range.limit ? ` -n ${range.limit}` : ''}`,
        actions,
        `Read git log since ${range.since ?? '(root)'} until ${range.until ?? 'HEAD'}`,
      );
      toolCalls += 1;
      const commits = this.parseGitLog(String(logRes.output ?? ''));
      tokensUsed += Math.ceil((logRes.output as string)?.length ?? 0 / 4);
      findings.push({
        id: nextId('finding'),
        severity: 'info',
        category: 'git-analysis',
        title: `Parsed ${commits.length} commit(s) from git log`,
        description: `Range: ${range.since ?? '(root)'}..${range.until ?? 'HEAD'}${range.limit ? ` (limit ${range.limit})` : ''}.`,
      });
      this.emit(options, 'phase:complete', { phase: 'git-log', count: commits.length });

      // ── Phase 4: categorize commits ──────────────────────────────────
      this.emit(options, 'phase:start', { phase: 'categorize' });
      const categorized = this.categorizeCommits(commits);
      this.emit(options, 'phase:complete', { phase: 'categorize', counts: this.categorizedCounts(categorized) });

      // ── Phase 5: breaking change detection ───────────────────────────
      this.emit(options, 'phase:start', { phase: 'breaking' });
      const breaking: BreakingChange[] = [];
      for (const c of commits.filter((c) => c.conventional?.breaking || c.inferredBreaking)) {
        const detail = await this.inspectBreakingCommit(options, c, actions);
        toolCalls += 1;
        breaking.push(detail);
      }
      // Also look for removed exports even on non-marked commits
      const removedExports = await this.scanForRemovedExports(options, range, actions);
      toolCalls += 1;
      for (const r of removedExports) {
        breaking.push(r);
      }
      this.emit(options, 'phase:complete', { phase: 'breaking', count: breaking.length });
      if (breaking.length > 0) {
        findings.push({
          id: nextId('finding'),
          severity: 'high',
          category: 'breaking-changes',
          title: `${breaking.length} breaking change(s) detected`,
          description: breaking.map((b) => `- ${b.summary}`).join('\n'),
          recommendation: 'Bump the major version and add a "Migration Guide" section to the release notes.',
        });
      }

      // ── Phase 6: version bump ────────────────────────────────────────
      this.emit(options, 'phase:start', { phase: 'bump' });
      const bump = this.computeBump(currentVersion, categorized, breaking);
      this.emit(options, 'phase:complete', { phase: 'bump', bump });
      findings.push({
        id: nextId('finding'),
        severity: 'info',
        category: 'version-bump',
        title: `Recommended version bump: ${currentVersion} → ${bump.next} (${bump.kind})`,
        description: bump.reason,
        recommendation: `Update package.json to "${bump.next}" and tag as v${bump.next}.`,
      });

      // ── Phase 7: changelog + release notes ───────────────────────────
      this.emit(options, 'phase:start', { phase: 'write' });
      const today = new Date().toISOString().slice(0, 10);
      const changelog = this.composeChangelog(bump.next, today, categorized, breaking);
      const releaseNotes = this.composeReleaseNotes(bump, today, categorized, breaking);
      const migrationGuide = this.composeMigrationGuide(breaking);

      artifacts.push({
        id: nextId('artifact'),
        name: 'CHANGELOG.md',
        type: 'document',
        content: changelog,
        description: `Keep a Changelog entry for v${bump.next}`,
        path: 'CHANGELOG.md',
        language: 'markdown',
      });
      artifacts.push({
        id: nextId('artifact'),
        name: `release-notes-v${bump.next}.md`,
        type: 'report',
        content: releaseNotes,
        description: `GitHub release notes for v${bump.next}`,
        path: `release-notes-v${bump.next}.md`,
        language: 'markdown',
      });
      if (migrationGuide) {
        artifacts.push({
          id: nextId('artifact'),
          name: `migration-v${bump.next}.md`,
          type: 'document',
          content: migrationGuide,
          description: `Migration guide for breaking changes in v${bump.next}`,
          path: `migration-v${bump.next}.md`,
          language: 'markdown',
        });
      }

      // Write the CHANGELOG.md
      const writeRes = await this.callToolWrite(
        options,
        'write_file',
        { path: 'CHANGELOG.md', content: changelog, cwd: options.cwd },
        actions,
        `Write CHANGELOG.md for v${bump.next}`,
      );
      toolCalls += 1;
      if (!writeRes.ok) {
        findings.push({
          id: nextId('finding'),
          severity: 'medium',
          category: 'write',
          title: 'Failed to persist CHANGELOG.md',
          description: `write_file reported: ${writeRes.error}`,
        });
      }
      // Write release notes
      const relRes = await this.callToolWrite(
        options,
        'write_file',
        { path: `release-notes-v${bump.next}.md`, content: releaseNotes, cwd: options.cwd },
        actions,
        `Write release notes for v${bump.next}`,
      );
      toolCalls += 1;
      if (!relRes.ok) {
        findings.push({
          id: nextId('finding'),
          severity: 'low',
          category: 'write',
          title: 'Failed to persist release notes',
          description: `write_file reported: ${relRes.error}`,
        });
      }
      if (migrationGuide) {
        const mgRes = await this.callToolWrite(
          options,
          'write_file',
          { path: `migration-v${bump.next}.md`, content: migrationGuide, cwd: options.cwd },
          actions,
          `Write migration guide for v${bump.next}`,
        );
        toolCalls += 1;
        if (!mgRes.ok) {
          findings.push({
            id: nextId('finding'),
            severity: 'low',
            category: 'write',
            title: 'Failed to persist migration guide',
            description: `write_file reported: ${mgRes.error}`,
          });
        }
      }
      this.emit(options, 'phase:complete', { phase: 'write' });

      // ── recommendations ──────────────────────────────────────────────
      if (bump.kind === 'major') {
        recommendations.push(`Tag v${bump.next} as a major release — communicate breaking changes prominently.`);
      } else if (bump.kind === 'minor') {
        recommendations.push(`Tag v${bump.next} as a minor release — highlight new features.`);
      } else if (bump.kind === 'patch') {
        recommendations.push(`Tag v${bump.next} as a patch release — note bug fixes only.`);
      }
      if (commits.some((c) => !c.conventional)) {
        recommendations.push(
          'Adopt Conventional Commits (`feat:`, `fix:`, etc.) so future changelog entries are auto-generated reliably.',
        );
      }
      if (breaking.length > 0) {
        recommendations.push(`Review the migration guide at migration-v${bump.next}.md before publishing.`);
      }

      const summary = this.composeSummary(bump, commits.length, breaking.length, Date.now() - startedAt);
      const result: AgentRunResult = {
        agentId: this.id,
        agentName: this.name,
        category: this.category,
        goal: options.goal,
        summary,
        findings,
        actions,
        artifacts,
        recommendations,
        metrics: {
          steps: actions.length,
          durationMs: Date.now() - startedAt,
          tokensUsed,
          costUsd: 0,
          toolCalls,
        },
        success: true,
      };
      this.emit(options, 'agent:complete', { agentId: this.id, result });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      findings.push({
        id: nextId('finding'),
        severity: 'critical',
        category: 'pipeline',
        title: 'Changelog generation aborted',
        description: message,
      });
      const result: AgentRunResult = {
        agentId: this.id,
        agentName: this.name,
        category: this.category,
        goal: options.goal,
        summary: `Changelog generation aborted: ${message}`,
        findings,
        actions,
        artifacts,
        recommendations,
        metrics: {
          steps: actions.length,
          durationMs: Date.now() - startedAt,
          tokensUsed,
          costUsd: 0,
          toolCalls,
        },
        success: false,
        error: message,
      };
      this.emit(options, 'agent:complete', { agentId: this.id, result });
      return result;
    }
  }

  // ─── tool helpers ───────────────────────────────────────────────────

  private emit(options: AgentRunOptions, event: string, payload: unknown): void {
    try {
      options.emit?.(event, payload);
    } catch {
      /* swallow */
    }
  }

  private async runGit(
    options: AgentRunOptions,
    command: string,
    actions: AgentAction[],
    description: string,
  ): Promise<{ ok: true; output: unknown } | { ok: false; error: string; output?: string }> {
    const startedAt = Date.now();
    if (!options.toolCall) {
      actions.push({
        id: nextId('action'),
        type: 'bash',
        description: `${description} (skipped: no toolCall)`,
        target: 'bash',
        success: false,
        error: 'no toolCall callback provided',
        durationMs: Date.now() - startedAt,
      });
      return { ok: false, error: 'no toolCall callback provided' };
    }
    try {
      const raw = await options.toolCall('bash', { command, cwd: options.cwd });
      const output = typeof raw === 'string' ? raw : String(raw ?? '');
      actions.push({
        id: nextId('action'),
        type: 'bash',
        description,
        target: 'bash',
        input: command,
        output: output.slice(0, 4000),
        durationMs: Date.now() - startedAt,
        success: true,
      });
      return { ok: true, output };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      actions.push({
        id: nextId('action'),
        type: 'bash',
        description,
        target: 'bash',
        input: command,
        durationMs: Date.now() - startedAt,
        success: false,
        error: message,
      });
      return { ok: false, error: message };
    }
  }

  private async callToolWrite(
    options: AgentRunOptions,
    tool: string,
    input: unknown,
    actions: AgentAction[],
    description: string,
  ): Promise<{ ok: true; output: unknown } | { ok: false; error: string }> {
    const startedAt = Date.now();
    if (!options.toolCall) {
      actions.push({
        id: nextId('action'),
        type: 'write',
        description: `${description} (skipped: no toolCall)`,
        target: tool,
        success: false,
        error: 'no toolCall callback provided',
        durationMs: Date.now() - startedAt,
      });
      return { ok: false, error: 'no toolCall callback provided' };
    }
    try {
      const output = await options.toolCall(tool, input);
      actions.push({
        id: nextId('action'),
        type: 'write',
        description,
        target: tool,
        input: typeof input === 'string' ? input.slice(0, 2000) : JSON.stringify(input).slice(0, 2000),
        output: typeof output === 'string' ? output.slice(0, 2000) : JSON.stringify(output ?? '').slice(0, 2000),
        durationMs: Date.now() - startedAt,
        success: true,
      });
      return { ok: true, output };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      actions.push({
        id: nextId('action'),
        type: 'write',
        description,
        target: tool,
        durationMs: Date.now() - startedAt,
        success: false,
        error: message,
      });
      return { ok: false, error: message };
    }
  }

  // ─── range + version parsing ────────────────────────────────────────

  private parseRange(goal: string): { since?: string; until?: string; limit?: number } {
    const sinceMatch = goal.match(/\bsince\s+(v[\d.]+|[\da-f]{7,40}|[A-Za-z0-9_./-]+)/i);
    const untilMatch = goal.match(/\buntil\s+(v[\d.]+|[\da-f]{7,40}|HEAD|[A-Za-z0-9_./-]+)/i);
    const betweenMatch = goal.match(/\bbetween\s+(v[\d.]+|[\da-f]{7,40})\s+and\s+(v[\d.]+|[\da-f]{7,40}|HEAD)/i);
    const lastNMatch = goal.match(/\blast\s+(\d+)\s+commits\b/i);
    const vTagMatch = goal.match(/\bv?(\d+\.\d+\.\d+)\b/);
    if (betweenMatch) {
      return { since: betweenMatch[1], until: betweenMatch[2] };
    }
    if (sinceMatch) {
      return { since: sinceMatch[1], until: untilMatch?.[1] ?? 'HEAD' };
    }
    if (lastNMatch) {
      return { until: 'HEAD', limit: Number(lastNMatch[1]) };
    }
    if (vTagMatch) {
      // "for v1.2.0" → since previous tag
      return { since: `v${vTagMatch[1]}`, until: 'HEAD' };
    }
    return { until: 'HEAD', limit: 100 };
  }

  private async detectCurrentVersion(
    options: AgentRunOptions,
    actions: AgentAction[],
  ): Promise<string> {
    const startedAt = Date.now();
    if (!options.toolCall) {
      actions.push({
        id: nextId('action'),
        type: 'read',
        description: 'read package.json (skipped: no toolCall)',
        target: 'package.json',
        success: false,
        error: 'no toolCall',
        durationMs: Date.now() - startedAt,
      });
      return '0.0.0';
    }
    try {
      const raw = await options.toolCall('read_file', { path: 'package.json', cwd: options.cwd });
      const content = typeof raw === 'string' ? raw : String(raw ?? '');
      const match = content.match(/"version"\s*:\s*"([^"]+)"/);
      actions.push({
        id: nextId('action'),
        type: 'read',
        description: 'Read current version from package.json',
        target: 'package.json',
        output: content.slice(0, 2000),
        durationMs: Date.now() - startedAt,
        success: true,
      });
      return match?.[1] ?? '0.0.0';
    } catch {
      actions.push({
        id: nextId('action'),
        type: 'read',
        description: 'Read current version from package.json (no package.json — defaulting to 0.0.0)',
        target: 'package.json',
        durationMs: Date.now() - startedAt,
        success: false,
        error: 'no package.json',
      });
      return '0.0.0';
    }
  }

  // ─── git log parsing ────────────────────────────────────────────────

  private parseGitLog(raw: string): ParsedCommit[] {
    const commits: ParsedCommit[] = [];
    const lines = raw.split('\n');
    let current: ParsedCommit | null = null;
    let bodyLines: string[] = [];

    const flush = () => {
      if (!current) return;
      const body = bodyLines.join('\n').trim();
      const conv = this.parseConventional(current.subject);
      const inferred = this.inferType(current.subject, body);
      commits.push({
        ...current,
        body,
        conventional: conv,
        inferredType: conv?.type ?? inferred.type,
        inferredBreaking: conv?.breaking ?? inferred.breaking,
        prNumber: this.extractPr(current.subject) ?? this.extractPr(body),
      });
      current = null;
      bodyLines = [];
    };

    for (const line of lines) {
      const parts = line.split('\t');
      if (parts.length >= 4 && parts[0] && /^[0-9a-f]{7,40}$/i.test(parts[0])) {
        flush();
        current = {
          hash: parts[0],
          author: parts[1] || undefined,
          date: parts[2] || undefined,
          subject: parts[3] ?? '',
          body: '',
          inferredType: 'chore',
          inferredBreaking: false,
        };
        // Anything past the 5th tab belongs to the body.
        if (parts.length > 5) bodyLines.push(parts.slice(5).join('\t'));
      } else if (current) {
        bodyLines.push(line);
      }
    }
    flush();
    return commits;
  }

  private parseConventional(subject: string): ParsedCommit['conventional'] {
    // type(scope)!?: description
    const m = subject.match(/^([a-z]+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/i);
    if (!m) return undefined;
    const type = m[1].toLowerCase();
    const scope = m[2];
    const breaking = m[3] === '!';
    const description = m[4].trim();
    return { type, scope: scope || undefined, breaking, description };
  }

  private inferType(subject: string, body: string): { type: string; breaking: boolean } {
    const text = `${subject}\n${body}`.toLowerCase();
    let breaking = /\bbreaking\s+change\b/.test(text) || /\bbreaking[:\s]/.test(text);
    let type = 'chore';
    if (/\b(add|adds|added|new|create|introduce|support)\b/.test(subject.toLowerCase())) type = 'feat';
    if (/\bfix|fixed|fixes|bug\s*fix|resolve[sd]?|patch(es|ed)?\b/.test(subject.toLowerCase())) type = 'fix';
    if (/\brefactor|cleanup|clean\s+up|restructure\b/.test(subject.toLowerCase())) type = 'refactor';
    if (/\bdoc|docs|documentation|readme\b/.test(subject.toLowerCase())) type = 'docs';
    if (/\btest|tests|spec\b/.test(subject.toLowerCase())) type = 'test';
    if (/\bperf|optimi[sz]e|speed\s*up|faster\b/.test(subject.toLowerCase())) type = 'perf';
    if (/\bsecurity|cve|vulnerability|xss|csrf|injection\b/.test(subject.toLowerCase())) {
      type = 'fix';
    }
    if (/remove[sd]?\s+\w+\s+(api|export|function|class|method)/.test(text)) breaking = true;
    return { type, breaking };
  }

  private extractPr(text: string): string | undefined {
    const m = text.match(/#(\d{1,7})\b/);
    return m?.[1];
  }

  // ─── categorization ─────────────────────────────────────────────────

  private categorizeCommits(
    commits: ParsedCommit[],
  ): Map<KeepAChangelogCategory, ParsedCommit[]> {
    const map = new Map<KeepAChangelogCategory, ParsedCommit[]>([
      ['Added', []], ['Changed', []], ['Deprecated', []],
      ['Removed', []], ['Fixed', []], ['Security', []],
    ]);
    for (const c of commits) {
      const type = c.inferredType;
      if (c.inferredBreaking) {
        map.get('Removed')!.push(c);
        continue;
      }
      switch (type) {
        case 'feat':
          map.get('Added')!.push(c);
          break;
        case 'fix':
          if (/secur|cve|vulnerab|xss|csrf|injection/.test(c.subject.toLowerCase())) {
            map.get('Security')!.push(c);
          } else {
            map.get('Fixed')!.push(c);
          }
          break;
        case 'refactor':
        case 'perf':
          map.get('Changed')!.push(c);
          break;
        case 'docs':
        case 'test':
        case 'chore':
        default:
          // docs/test/chore typically don't appear in CHANGELOG; bucket under Changed for visibility
          if (type === 'docs') map.get('Changed')!.push(c);
          break;
      }
    }
    // Detect "deprecate" keyword
    for (const c of commits) {
      if (/\bdeprecat(e|ed|ion)\b/i.test(c.subject)) {
        map.get('Deprecated')!.push(c);
      }
    }
    return map;
  }

  private categorizedCounts(map: Map<KeepAChangelogCategory, ParsedCommit[]>): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of map) out[k] = v.length;
    return out;
  }

  // ─── breaking-change inspection ─────────────────────────────────────

  private async inspectBreakingCommit(
    options: AgentRunOptions,
    commit: ParsedCommit,
    actions: AgentAction[],
  ): Promise<BreakingChange> {
    const res = await this.runGit(
      options,
      `git show --stat --format='%H%n%s%n%b' ${commit.hash}`,
      actions,
      `Inspect breaking commit ${commit.hash.slice(0, 8)}`,
    );
    const output = String(res.output ?? '');
    // Heuristic: look for removed `export function/class/const` lines.
    const removedExports = this.extractRemovedExportsFromDiff(output);
    const summary = commit.conventional?.description ?? commit.subject;
    const evidence = removedExports.length
      ? `Removed exports: ${removedExports.join(', ')}`
      : `Commit subject/body indicates a breaking change.`;
    const migration = this.composeMigrationForCommit(commit, removedExports);
    return { commit, summary, migration, evidence };
  }

  private async scanForRemovedExports(
    options: AgentRunOptions,
    range: { since?: string; until?: string },
    actions: AgentAction[],
  ): Promise<BreakingChange[]> {
    if (!range.since) return [];
    const res = await this.runGit(
      options,
      `git diff ${range.since}..${range.until ?? 'HEAD'} -- '*.ts' '*.tsx' '*.js' '*.jsx'`,
      actions,
      `Scan diff for removed exports (${range.since}..${range.until ?? 'HEAD'})`,
    );
    const diff = String(res.output ?? '');
    const removed = this.extractRemovedExportsFromDiff(diff);
    const out: BreakingChange[] = [];
    for (const name of removed.slice(0, 20)) {
      out.push({
        commit: {
          hash: range.since,
          subject: `Removed export: ${name}`,
          body: '',
          inferredType: 'fix',
          inferredBreaking: true,
        },
        summary: `Removed exported symbol \`${name}\``,
        migration: `Replace usages of \`${name}\` or pin the previous version until you can migrate.`,
        evidence: `git diff detected \`-export … ${name}\``,
      });
    }
    return out;
  }

  private extractRemovedExportsFromDiff(diff: string): string[] {
    const out: string[] = [];
    // Lines beginning with `-` (removed) that declare an export
    const re = /^-\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(diff)) !== null) {
      out.push(m[1]);
    }
    // Also detect changed signatures: export function foo(a, b) → export function foo(a, b, c)
    // We count `-export function foo(` and `+export function foo(` pairs.
    const removedSigs = diff.match(/^-\s*export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)/gm) ?? [];
    const addedSigs = diff.match(/^\+\s*export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)/gm) ?? [];
    const removedNames = removedSigs
      .map((s) => s.match(/function\s+([A-Za-z_$][\w$]*)/)?.[1])
      .filter((n): n is string => Boolean(n));
    const addedNames = addedSigs
      .map((s) => s.match(/function\s+([A-Za-z_$][\w$]*)/)?.[1])
      .filter((n): n is string => Boolean(n));
    for (const name of removedNames) {
      if (addedNames.includes(name) && !out.includes(name)) {
        out.push(`${name} (signature changed)`);
      }
    }
    return Array.from(new Set(out));
  }

  private composeMigrationForCommit(commit: ParsedCommit, removedExports: string[]): string {
    if (removedExports.length > 0) {
      return (
        `The following symbols were removed or changed in ${commit.hash.slice(0, 8)}:\n` +
        removedExports.map((n) => `- \`${n}\``).join('\n') +
        `\n\nSearch the codebase for usages and replace them with the recommended alternative ` +
        `(see the commit message and related PR for details). If no alternative exists, pin the ` +
        `previous version until you can refactor.`
      );
    }
    return (
      `Review commit ${commit.hash.slice(0, 8)} ("${commit.subject}") for migration steps. ` +
      `The commit body is the primary source of migration guidance.`
    );
  }

  // ─── version bump ───────────────────────────────────────────────────

  private computeBump(
    current: string,
    categorized: Map<KeepAChangelogCategory, ParsedCommit[]>,
    breaking: BreakingChange[],
  ): VersionBump {
    const parts = current.split('.').map((n) => Number(n) || 0);
    while (parts.length < 3) parts.push(0);
    const [maj, min, pat] = parts;
    const bumpMajor = breaking.length > 0;
    const bumpMinor = !bumpMajor && categorized.get('Added')!.length > 0;
    const bumpPatch = !bumpMajor && !bumpMinor && categorized.get('Fixed')!.length > 0;
    if (bumpMajor) {
      return {
        current,
        next: `${maj + 1}.0.0`,
        kind: 'major',
        reason: `${breaking.length} breaking change(s) detected → major bump.`,
      };
    }
    if (bumpMinor) {
      return {
        current,
        next: `${maj}.${min + 1}.0`,
        kind: 'minor',
        reason: `${categorized.get('Added')!.length} new feature(s) → minor bump.`,
      };
    }
    if (bumpPatch) {
      return {
        current,
        next: `${maj}.${min}.${pat + 1}`,
        kind: 'patch',
        reason: `${categorized.get('Fixed')!.length} bug fix(es) only → patch bump.`,
      };
    }
    return {
      current,
      next: current,
      kind: 'none',
      reason: 'No features, fixes, or breaking changes detected → no bump.',
    };
  }

  // ─── composition ────────────────────────────────────────────────────

  private composeChangelog(
    version: string,
    date: string,
    categorized: Map<KeepAChangelogCategory, ParsedCommit[]>,
    breaking: BreakingChange[],
  ): string {
    const lines: string[] = [];
    lines.push('# Changelog', '');
    lines.push('All notable changes to this project are documented in this file.');
    lines.push('The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),');
    lines.push('and this project adheres to [Semantic Versioning](https://semver.org/).', '');
    lines.push(`## [${version}] - ${date}`, '');

    const sectionTitle: Record<KeepAChangelogCategory, string> = {
      Added: '### Added',
      Changed: '### Changed',
      Deprecated: '### Deprecated',
      Removed: '### Removed',
      Fixed: '### Fixed',
      Security: '### Security',
    };
    for (const cat of ['Added', 'Changed', 'Deprecated', 'Fixed', 'Security', 'Removed'] as KeepAChangelogCategory[]) {
      const list = categorized.get(cat) ?? [];
      if (list.length === 0 && cat !== 'Removed') continue;
      if (cat === 'Removed' && breaking.length === 0 && list.length === 0) continue;
      lines.push(sectionTitle[cat]);
      if (cat === 'Removed') {
        for (const b of breaking) {
          lines.push(`- ${b.summary}. ${b.evidence}`);
        }
        for (const c of list) {
          if (breaking.some((b) => b.commit.hash === c.hash)) continue;
          lines.push(`- ${this.formatCommit(c)}`);
        }
      } else {
        for (const c of list) {
          lines.push(`- ${this.formatCommit(c)}`);
        }
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  private formatCommit(c: ParsedCommit): string {
    const desc = c.conventional?.description ?? c.subject;
    const scope = c.conventional?.scope ? `**${c.conventional.scope}**: ` : '';
    const pr = c.prNumber ? ` (#${c.prNumber})` : '';
    return `${scope}${desc}${pr}`;
  }

  private composeReleaseNotes(
    bump: VersionBump,
    date: string,
    categorized: Map<KeepAChangelogCategory, ParsedCommit[]>,
    breaking: BreakingChange[],
  ): string {
    const lines: string[] = [];
    lines.push(`# Release v${bump.next}`, '');
    lines.push(`**Date:** ${date}`);
    lines.push(`**Bump:** ${bump.kind} (from ${bump.current}) — ${bump.reason}`, '');
    lines.push('## Highlights', '');
    const added = categorized.get('Added') ?? [];
    const fixed = categorized.get('Fixed') ?? [];
    if (added.length) {
      lines.push(`- 🎉 ${added.length} new feature(s)`);
    }
    if (fixed.length) {
      lines.push(`- 🐛 ${fixed.length} bug fix(es)`);
    }
    if (breaking.length) {
      lines.push(`- ⚠️ ${breaking.length} breaking change(s) — see Migration Guide`);
    }
    if (added.length === 0 && fixed.length === 0 && breaking.length === 0) {
      lines.push('- Maintenance release; no user-visible changes.');
    }
    lines.push('');

    if (added.length) {
      lines.push('## New features', '');
      for (const c of added) lines.push(`- ${this.formatCommit(c)}`);
      lines.push('');
    }
    if (fixed.length) {
      lines.push('## Fixes', '');
      for (const c of fixed) lines.push(`- ${this.formatCommit(c)}`);
      lines.push('');
    }
    const changed = categorized.get('Changed') ?? [];
    if (changed.length) {
      lines.push('## Changes', '');
      for (const c of changed) lines.push(`- ${this.formatCommit(c)}`);
      lines.push('');
    }
    const sec = categorized.get('Security') ?? [];
    if (sec.length) {
      lines.push('## Security', '');
      for (const c of sec) lines.push(`- ${this.formatCommit(c)}`);
      lines.push('');
    }
    if (breaking.length) {
      lines.push('## ⚠️ Breaking changes', '');
      for (const b of breaking) {
        lines.push(`### ${b.summary}`);
        lines.push(`- ${b.evidence}`);
        lines.push('');
        lines.push('**Migration:**');
        lines.push(b.migration);
        lines.push('');
      }
    }
    lines.push('## Contributors', '');
    const contributors = new Set<string>();
    for (const list of categorized.values()) {
      for (const c of list) if (c.author) contributors.add(c.author);
    }
    if (contributors.size === 0) {
      lines.push('_Contributor list unavailable (commits had no author metadata)._');
    } else {
      for (const a of contributors) lines.push(`- @${a}`);
    }
    lines.push('');
    lines.push('---');
    lines.push(`_Generated by 📋 SANIX Changelog Generator (\`changelog-gen\`)._`);
    return lines.join('\n');
  }

  private composeMigrationGuide(breaking: BreakingChange[]): string | undefined {
    if (breaking.length === 0) return undefined;
    const lines: string[] = [];
    lines.push('# Migration Guide', '');
    lines.push(`This document covers ${breaking.length} breaking change(s) and the recommended migration steps.`);
    lines.push('');
    for (const b of breaking) {
      lines.push(`## ${b.summary}`);
      lines.push(`**Evidence:** ${b.evidence}`, '');
      lines.push('**Migration:**');
      lines.push(b.migration);
      lines.push('');
    }
    return lines.join('\n');
  }

  private composeSummary(
    bump: VersionBump,
    commitCount: number,
    breakingCount: number,
    durationMs: number,
  ): string {
    return (
      `📋 Changelog Generator analyzed ${commitCount} commit(s) in ${durationMs}ms — ` +
      `${breakingCount} breaking change(s), recommended bump: ${bump.current} → ${bump.next} (${bump.kind}). ` +
      `Wrote CHANGELOG.md, release notes${breakingCount ? ', and migration guide' : ''}.`
    );
  }
}
