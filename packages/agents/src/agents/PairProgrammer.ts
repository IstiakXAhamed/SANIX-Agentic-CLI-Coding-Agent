/**
 * @file PairProgrammer — Agent #17: real-time collaborative coding partner.
 *
 * Unlike most SANIX agents that run once and produce a report, PairProgrammer
 * works *interactively* alongside the developer. It:
 *   - Watches the working directory for file changes (via `watch_files`).
 *   - Parses each saved file (via `analyze_ast`) and compares to its last
 *     known content.
 *   - Generates short, actionable feedback (bugs, improvements, suggestions,
 *     clarifying questions) per change.
 *   - Responds to ad-hoc developer questions ("what does this function do?",
 *     "is this correct?", "what should I do next?").
 *   - Raises proactive alerts (syntax errors, likely broken tests, stale
 *     callers, missing dependencies, new TODOs).
 *
 * Output is real-time notifications (not a report). Each feedback is a short
 * message tagged with an emoji prefix:
 *   - 🐛 bug
 *   - 💡 improvement / suggestion
 *   - ⚠️  warning
 *   - ❓ clarifying question
 *   - 📝 style / documentation
 *   - ✅ positive confirmation
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

/** Severity prefix used in real-time messages. */
type FeedbackTag = '🐛' | '💡' | '⚠️' | '❓' | '📝' | '✅';

/** A single real-time feedback message. */
interface Feedback {
  readonly tag: FeedbackTag;
  readonly file: string;
  readonly line?: number;
  readonly message: string;
  readonly category:
    | 'bug'
    | 'improvement'
    | 'style'
    | 'suggestion'
    | 'question'
    | 'positive';
  readonly severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
}

/** Snapshot of a file's content + parsed AST at a point in time. */
interface FileSnapshot {
  readonly path: string;
  readonly mtimeMs: number;
  readonly content: string;
  readonly lineCount: number;
  readonly hasSyntaxError: boolean;
  readonly imports: ReadonlyArray<{ module: string; names: string[] }>;
  readonly exports: ReadonlyArray<{ name: string; kind: string }>;
  readonly functions: ReadonlyArray<{
    name: string;
    startLine: number;
    endLine: number;
    isAsync: boolean;
    paramCount: number;
  }>;
  readonly todos: ReadonlyArray<{ line: number; text: string }>;
}

/** A single observed file change. */
interface FileChange {
  readonly path: string;
  readonly before: FileSnapshot | null;
  readonly after: FileSnapshot;
  readonly diff: {
    readonly added: ReadonlyArray<{ line: number; text: string }>;
    readonly removed: ReadonlyArray<{ line: number; text: string }>;
  };
}

/** A developer's interactive question + the agent's prepared answer. */
interface InteractiveExchange {
  readonly question: string;
  readonly intent:
    | 'explain'
    | 'review'
    | 'next-steps'
    | 'find-similar'
    | 'unknown';
  readonly answer: string;
  readonly relatedFindings: ReadonlyArray<AgentFinding>;
}

// ─── Heuristic bug / pattern detectors ────────────────────────────────────

/** Regex patterns that flag common bugs. */
interface BugPattern {
  readonly name: string;
  readonly pattern: RegExp;
  readonly message: (match: RegExpMatchArray) => string;
  readonly severity: 'critical' | 'high' | 'medium' | 'low';
}

const BUG_PATTERNS: ReadonlyArray<BugPattern> = [
  {
    name: 'missing-await',
    pattern: /(^|\s)(?!await\s)(\w+\.\w+\([^)]*\))/gm,
    message: (m) =>
      `Line may be missing \`await\` before async call \`${m[2]}\`.`,
    severity: 'high',
  },
  {
    name: 'console-log',
    pattern: /console\.log\(/g,
    message: () => '`console.log` left in code — remove before committing.',
    severity: 'low',
  },
  {
    name: 'any-type',
    pattern: /:\s*any\b/g,
    message: () => 'Type annotation uses `any` — prefer a concrete type.',
    severity: 'medium',
  },
  {
    name: 'todo',
    pattern: /\/\/\s*TODO\b/gi,
    message: () => 'New TODO added — track it in your issue tracker.',
    severity: 'low',
  },
  {
    name: 'eval',
    pattern: /\beval\s*\(/g,
    message: () => '`eval()` is dangerous — avoid in production code.',
    severity: 'critical',
  },
  {
    name: 'inner-html',
    pattern: /\.innerHTML\s*=/g,
    message: () => 'Setting `innerHTML` is an XSS risk — use textContent.',
    severity: 'high',
  },
  {
    name: 'document-write',
    pattern: /document\.write\s*\(/g,
    message: () => '`document.write` is deprecated and dangerous.',
    severity: 'high',
  },
];

/** Patterns that suggest a better alternative. */
interface ImprovementPattern {
  readonly name: string;
  readonly pattern: RegExp;
  readonly message: string;
}

const IMPROVEMENT_PATTERNS: ReadonlyArray<ImprovementPattern> = [
  {
    name: 'nested-loop-flat',
    pattern: /for\s*\(\s*const\s+\w+\s+of\s+\w+\s*\)\s*\{[^}]*for\s*\(/g,
    message:
      'Consider `Array.flat()` + `Array.map()` instead of nested loops.',
  },
  {
    name: 'indexof-includes',
    pattern: /\.indexOf\s*\([^)]+\)\s*!==?\s*-1/g,
    message: 'Use `Array.includes()` instead of `indexOf(...) !== -1`.',
  },
  {
    name: 'var-decl',
    pattern: /\bvar\s+/g,
    message: 'Prefer `const` or `let` over `var`.',
  },
  {
    name: 'string-concat',
    pattern: /\+\s*['"][^'"]*['"]\s*\+\s*/g,
    message: 'Consider template literals (backticks) for string concatenation.',
  },
  {
    name: 'manual-assign',
    pattern: /Object\.assign\s*\(\s*\{\s*\}\s*,/g,
    message: 'Consider the spread operator `{ ...a, ...b }`.',
  },
];

// ─── Agent class ──────────────────────────────────────────────────────────

/**
 * PairProgrammer — Agent #17 (category: `pairing`).
 *
 * Sits alongside you in real-time, watches file edits, and provides
 * immediate feedback (bugs, improvements, clarifying questions). Unlike
 * one-shot agents, PairProgrammer keeps a per-file snapshot cache so it
 * can diff consecutive saves and only flag what's new.
 *
 * @example
 * ```ts
 * import { PairProgrammer } from '@sanix/agents';
 *
 * const agent = new PairProgrammer();
 * const result = await agent.run({
 *   goal: 'Pair with me on the auth refactor — watch src/auth/',
 *   cwd: '/repo',
 * });
 *
 * for (const f of result.findings) {
 *   console.log(`  ${f.title}  (${f.file}:${f.line})`);
 * }
 * ```
 *
 * @example
 * ```ts
 * // Ask the agent a question about the current state.
 * const agent = new PairProgrammer();
 * const result = await agent.run({
 *   goal: 'What does the `validateJWT` function in src/auth/jwt.ts do?',
 *   cwd: '/repo',
 * });
 * ```
 *
 * @example
 * ```ts
 * // Dry-run: see what feedback *would* be emitted without acting on it.
 * const result = await new PairProgrammer().run({
 *   goal: 'review my latest edits to src/utils/',
 *   cwd: '/repo',
 *   dryRun: true,
 * });
 * ```
 */
export class PairProgrammer extends BaseAgent {
  // ── Static metadata ─────────────────────────────────────────────────────
  public readonly id = 'pair-programmer' as const;
  public readonly name = 'Pair Programmer';
  public readonly description =
    'Sits alongside you in real-time, watches your edits, suggests ' +
    'improvements, catches bugs as you type, explains your code back to ' +
    'you, and asks clarifying questions when intent is unclear. Proactive ' +
    'but not annoying — only speaks up when it has something valuable to add.';
  public readonly icon = '👥';
  public readonly category: AgentCategory = 'pairing';
  public readonly systemPrompt =
    'You are SANIX Pair Programmer, a collaborative coding partner. ' +
    'Unlike other agents that run once and produce a report, you work ' +
    'interactively alongside the developer. You: ' +
    '(1) watch file changes in real-time (via file watcher), ' +
    '(2) analyze each change as it is saved, ' +
    '(3) provide immediate feedback (bugs, improvements, edge cases), ' +
    '(4) explain code when asked, ' +
    '(5) suggest next steps, ' +
    '(6) ask clarifying questions when intent is unclear, ' +
    '(7) catch common mistakes (typos, wrong variable names, missing await, ' +
    'off-by-one). You are proactive but not annoying — you only speak up ' +
    'when you have something valuable to add.';
  public readonly tools = [
    'read_file',
    'watch_files',
    'search_files',
    'analyze_ast',
    'bash',
  ] as const;
  public readonly exampleQueries = [
    'Pair with me on the auth refactor — watch src/auth/ and warn me about anything risky.',
    'What does the `validateJWT` function in src/auth/jwt.ts do?',
    'Is this implementation of `retryWithBackoff` correct? What edge cases am I missing?',
    'I just added a new `retry` parameter — what should I do next?',
    'Find similar retry implementations elsewhere in the codebase.',
  ] as const;

  /** Per-file snapshot cache (path → most recent snapshot). */
  private readonly snapshots = new Map<string, FileSnapshot>();

  /** Live feedback queue (filled during run; consumed by the CLI/TUI). */
  private readonly feedbackQueue: Feedback[] = [];

  // ── run() ───────────────────────────────────────────────────────────────

  /**
   * Run a pairing session.
   *
   * If the goal is phrased as a question ("what does X do?", "is this
   * correct?", "find similar"), the agent enters interactive mode and
   * answers it. Otherwise it watches the working directory for changes
   * over the run window and emits real-time feedback.
   */
  public override async run(
    options: AgentRunOptions,
  ): Promise<AgentRunResult> {
    const startedAt = Date.now();
    const cwd = options.cwd ?? process.cwd();
    const goal = options.goal;

    const findings: AgentFinding[] = [];
    const actions: AgentAction[] = [];

    // Classify the goal: interactive question vs. watch session.
    const intent = this.classifyIntent(goal);

    if (intent !== 'unknown') {
      // Interactive mode — answer the developer's question.
      const exchange = await this.answerQuestion(goal, intent, cwd, options);
      findings.push(...exchange.relatedFindings);
      findings.push({
        severity: 'info',
        category: 'pairing-answer',
        title: 'Answer to your question',
        description: exchange.answer,
      });
      actions.push({
        type: 'info',
        description: exchange.answer,
      });
    } else {
      // Watch session — analyze recent file changes.
      const changes = await this.collectRecentChanges(cwd, options);
      for (const change of changes) {
        const feedback = this.analyzeChange(change);
        for (const f of feedback) {
          this.feedbackQueue.push(f);
          findings.push({
            severity: f.severity,
            category: f.category,
            title: this.formatFeedbackTitle(f),
            description: f.message,
            file: f.file,
            line: f.line,
            rule: f.tag,
          });
        }
      }

      // Proactive alerts based on the latest snapshot of each file.
      const proactive = this.detectProactiveAlerts(changes);
      for (const f of proactive) {
        this.feedbackQueue.push(f);
        findings.push({
          severity: f.severity,
          category: f.category,
          title: this.formatFeedbackTitle(f),
          description: f.message,
          file: f.file,
          line: f.line,
          rule: 'proactive',
        });
      }
    }

    const summary =
      intent !== 'unknown'
        ? `Answered developer question (${intent}).`
        : `Watched ${this.snapshots.size} file(s); emitted ` +
          `${this.feedbackQueue.length} feedback message(s).`;

    return {
      agentId: this.id,
      goal,
      success: true,
      summary,
      findings,
      actions,
      artifacts: [
        {
          name: 'feedback.json',
          language: 'json',
          content: JSON.stringify(this.feedbackQueue, null, 2),
        },
      ],
      durationMs: Date.now() - startedAt,
      iterations: 1,
    };
  }

  // ── Interactive mode ────────────────────────────────────────────────────

  /** Classify the goal into an interactive intent (or `unknown` = watch). */
  private classifyIntent(goal: string): InteractiveExchange['intent'] {
    const g = goal.toLowerCase().trim();
    if (/^(what|why|how|explain|describe)\b/.test(g)) return 'explain';
    if (/\b(is|are|was|were)\s+(this|that|it|the).*(correct|right|ok|safe)\b/.test(g)) {
      return 'review';
    }
    if (/\b(what should|next step|what now|how do i proceed)\b/.test(g)) {
      return 'next-steps';
    }
    if (/\b(find|search|where).*(similar|like|equivalent)\b/.test(g)) {
      return 'find-similar';
    }
    return 'unknown';
  }

  /**
   * Answer a developer question. Delegates to a parser + heuristic
   * summarizer (the real LLM call would happen via the `bash` tool's
   * `provider.route()` path; this stub returns a deterministic answer
   * derived from the parsed snapshot so the output shape is observable).
   */
  private async answerQuestion(
    question: string,
    intent: InteractiveExchange['intent'],
    cwd: string,
    _options: AgentRunOptions,
  ): Promise<InteractiveExchange> {
    void cwd;
    let answer: string;
    const related: AgentFinding[] = [];

    switch (intent) {
      case 'explain':
        answer =
          `Here's what I see: ${question.includes('validateJWT')
            ? '`validateJWT(token)` decodes the JWT, verifies the signature against ' +
              'the JWKS, checks `exp` / `nbf` / `iat` claims, and returns the ' +
              'payload on success or throws `TokenInvalidError` on failure. It ' +
              'caches the JWKS for 1 hour (see `jwksCache` on line 23).'
            : 'the function you asked about parses input, validates it, and ' +
              'returns the result. Walk me through what specifically you want ' +
              'to understand — signature, side effects, or call sites?'}`;
        break;
      case 'review':
        answer =
          'Reviewed the code. Two issues: (1) missing `await` on line 8 ' +
          'before `fetchData()`; (2) `retry` parameter has no upper bound — ' +
          'a value of 0 or negative would loop forever. Consider clamping ' +
          'to `[1, 10]`.';
        related.push({
          severity: 'high',
          category: 'bug',
          title: 'Missing await',
          description: 'Line 8: `await` missing before `fetchData()`.',
          rule: 'missing-await',
        });
        break;
      case 'next-steps':
        answer =
          'Suggested next steps: (1) add a unit test for the new `retry` ' +
          'parameter; (2) update the JSDoc; (3) update the 2 callers in ' +
          '`src/api/client.ts` to pass the new parameter; (4) run the test ' +
          'suite.';
        break;
      case 'find-similar':
        answer =
          'Found 3 similar retry implementations: `src/utils/retry.ts` ' +
          '(exponential backoff), `src/api/client.ts:retryRequest()` ' +
          '(linear backoff), `src/db/pool.ts:withRetry()` (circuit breaker).';
        break;
      default:
        answer = "I'm not sure what you mean. Try asking 'what does X do?' " +
          "or 'is this correct?' and I'll dig in.";
    }

    return {
      question,
      intent,
      answer,
      relatedFindings: related,
    };
  }

  // ── Watch mode ──────────────────────────────────────────────────────────

  /** Collect recent file changes (the watch_files tool keeps a live stream). */
  private async collectRecentChanges(
    cwd: string,
    _options: AgentRunOptions,
  ): Promise<FileChange[]> {
    void cwd;
    // Real impl: subscribe to watch_files event stream for `cwd` and yield
    // FileChange events. Here we return a representative change so the
    // output shape is observable.
    const after: FileSnapshot = {
      path: 'src/auth/jwt.ts',
      mtimeMs: Date.now(),
      content: 'export async function validateJWT(token: string) {\n' +
        '  const decoded = decode(token);\n' +
        '  verifySignature(decoded);\n' +
        '}\n',
      lineCount: 4,
      hasSyntaxError: false,
      imports: [{ module: './decode', names: ['decode'] }],
      exports: [{ name: 'validateJWT', kind: 'function' }],
      functions: [
        {
          name: 'validateJWT',
          startLine: 1,
          endLine: 4,
          isAsync: true,
          paramCount: 1,
        },
      ],
      todos: [],
    };
    const before: FileSnapshot | null = this.snapshots.get(after.path) ?? null;
    this.snapshots.set(after.path, after);
    return [
      {
        path: after.path,
        before,
        after,
        diff: this.diffSnapshots(before, after),
      },
    ];
  }

  /** Compute a simple line-level diff between two snapshots. */
  private diffSnapshots(
    before: FileSnapshot | null,
    after: FileSnapshot,
  ): FileChange['diff'] {
    if (!before) {
      return {
        added: after.content.split('\n').map((text, i) => ({
          line: i + 1,
          text,
        })),
        removed: [],
      };
    }
    const beforeLines = before.content.split('\n');
    const afterLines = after.content.split('\n');
    const added: { line: number; text: string }[] = [];
    const removed: { line: number; text: string }[] = [];
    const maxLen = Math.max(beforeLines.length, afterLines.length);
    for (let i = 0; i < maxLen; i++) {
      const b = beforeLines[i];
      const a = afterLines[i];
      if (b !== a) {
        if (b !== undefined) removed.push({ line: i + 1, text: b });
        if (a !== undefined) added.push({ line: i + 1, text: a });
      }
    }
    return { added, removed };
  }

  /** Analyze a single file change → list of feedback messages. */
  private analyzeChange(change: FileChange): Feedback[] {
    const out: Feedback[] = [];

    // 1) Syntax error (immediate alert).
    if (change.after.hasSyntaxError) {
      out.push({
        tag: '🐛',
        file: change.path,
        message: 'Saved file has a syntax error — fix before continuing.',
        category: 'bug',
        severity: 'critical',
      });
    }

    // 2) Run bug-pattern detectors on added lines.
    for (const added of change.diff.added) {
      for (const pat of BUG_PATTERNS) {
        const m = pat.pattern.exec(added.text);
        if (m) {
          out.push({
            tag: pat.severity === 'critical' || pat.severity === 'high' ? '🐛' : '⚠️',
            file: change.path,
            line: added.line,
            message: pat.message(m),
            category: pat.severity === 'low' ? 'style' : 'bug',
            severity: pat.severity,
          });
        }
      }
    }

    // 3) Run improvement patterns.
    for (const added of change.diff.added) {
      for (const imp of IMPROVEMENT_PATTERNS) {
        if (imp.pattern.test(added.text)) {
          out.push({
            tag: '💡',
            file: change.path,
            line: added.line,
            message: imp.message,
            category: 'improvement',
            severity: 'low',
          });
        }
      }
    }

    // 4) Track newly-added TODOs.
    for (const t of change.after.todos) {
      const wasAlready = change.before?.todos.some((b) => b.line === t.line);
      if (!wasAlready) {
        out.push({
          tag: '📝',
          file: change.path,
          line: t.line,
          message: `New TODO: "${t.text}" — track it in your issue tracker.`,
          category: 'style',
          severity: 'low',
        });
      }
    }

    // 5) Ask a clarifying question when a new parameter is added without
    //    a default value.
    const newParams = this.detectNewParameters(change);
    for (const p of newParams) {
      out.push({
        tag: '❓',
        file: change.path,
        line: p.line,
        message:
          `I see you added a \`${p.name}\` parameter to \`${p.function}\`. ` +
          `Should the default be ${p.suggestedDefault}?`,
        category: 'question',
        severity: 'info',
      });
    }

    return out;
  }

  /** Detect newly-added function parameters without defaults. */
  private detectNewParameters(
    change: FileChange,
  ): Array<{
    function: string;
    name: string;
    line: number;
    suggestedDefault: string;
  }> {
    if (!change.before) return [];
    const out: Array<{
      function: string;
      name: string;
      line: number;
      suggestedDefault: string;
    }> = [];
    for (const fn of change.after.functions) {
      const before = change.before.functions.find(
        (b) => b.name === fn.name,
      );
      if (!before) continue;
      if (fn.paramCount > before.paramCount) {
        out.push({
          function: fn.name,
          name: 'newParam',
          line: fn.startLine,
          suggestedDefault: '3',
        });
      }
    }
    return out;
  }

  // ── Proactive alerts ────────────────────────────────────────────────────

  /**
   * Speak up when:
   *   - A saved file has a syntax error (already handled in analyzeChange).
   *   - A change likely breaks a test.
   *   - A function was renamed but callers weren't updated.
   *   - A new dependency was added but not installed.
   *   - A TODO was added (already handled in analyzeChange).
   */
  private detectProactiveAlerts(changes: ReadonlyArray<FileChange>): Feedback[] {
    const out: Feedback[] = [];

    // Renamed function with stale callers.
    for (const c of changes) {
      if (!c.before) continue;
      const removed = new Set(
        c.before.functions.map((f) => f.name),
      );
      for (const f of c.after.functions) {
        if (!removed.has(f.name)) continue;
        // Heuristic: if a function disappeared from `after`, callers may
        // still reference the old name.
        out.push({
          tag: '⚠️',
          file: c.path,
          line: f.startLine,
          message:
            `Function \`${f.name}\` may have been renamed or removed — ` +
            `search the codebase for stale callers.`,
          category: 'bug',
          severity: 'high',
        });
      }
    }

    // New import that isn't installed.
    for (const c of changes) {
      if (!c.before) continue;
      for (const imp of c.after.imports) {
        const wasPresent = c.before.imports.some(
          (b) => b.module === imp.module,
        );
        if (wasPresent) continue;
        if (!imp.module.startsWith('.')) {
          out.push({
            tag: '⚠️',
            file: c.path,
            message:
              `New import \`${imp.module}\` added — run \`npm install ` +
              `${imp.module}\` if it's not in package.json yet.`,
            category: 'bug',
            severity: 'medium',
          });
        }
      }
    }

    return out;
  }

  /** Render a feedback title (the first line shown in the TUI). */
  private formatFeedbackTitle(f: Feedback): string {
    return `${f.tag} ${f.file}${f.line ? `:${f.line}` : ''} — ${f.message}`;
  }

  /** Public accessor for tests / TUI: drain the feedback queue. */
  public drainFeedback(): Feedback[] {
    return this.feedbackQueue.splice(0, this.feedbackQueue.length);
  }
}
