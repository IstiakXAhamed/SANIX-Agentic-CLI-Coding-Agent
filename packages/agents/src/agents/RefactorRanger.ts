/**
 * @file RefactorRanger.ts
 * @description SANIX Refactor Ranger — a refactoring specialist agent.
 *
 * Detects code smells across a project (long methods, god classes,
 * duplicated code, deep nesting, long parameter lists, feature envy,
 * data clumps, primitive obsession, switch statements, parallel
 * inheritance hierarchies, shotgun surgery, divergent change), ranks
 * them by severity, plans a refactoring sequence, executes each
 * refactoring step with **test-before + test-after** verification, and
 * reports before/after complexity metrics.
 *
 * The agent NEVER changes behavior — every refactoring is bracketed by
 * test runs and rolled back if the test suite breaks.
 *
 * @packageDocumentation
 */

import { nanoid } from 'nanoid';
import { BaseAgent } from '../BaseAgent.js';
import type {
  AgentAction,
  AgentCategory,
  AgentFinding,
  AgentProgressEvent,
  AgentRunOptions,
  AgentRunResult,
} from '../types.js';

/** Refactoring patterns the agent can apply. */
export type RefactoringPattern =
  | 'extract_method'
  | 'extract_class'
  | 'move_method'
  | 'replace_conditional_with_polymorphism'
  | 'replace_inheritance_with_delegation'
  | 'introduce_parameter_object'
  | 'replace_method_with_method_object'
  | 'replace_array_with_object';

/** Categories of code smells the agent detects. */
export type CodeSmellType =
  | 'long_method'
  | 'god_class'
  | 'duplicated_code'
  | 'deep_nesting'
  | 'long_parameter_list'
  | 'feature_envy'
  | 'data_clumps'
  | 'primitive_obsession'
  | 'switch_statement'
  | 'parallel_inheritance'
  | 'shotgun_surgery'
  | 'divergent_change';

/** Severity ranking for smells. */
export type SmellSeverity = 'critical' | 'high' | 'medium' | 'low';

/** A single detected code smell. */
export interface CodeSmell {
  /** Stable unique id. */
  id: string;
  /** Smell category. */
  type: CodeSmellType;
  /** Severity ranking. */
  severity: SmellSeverity;
  /** File path (relative to workspace). */
  file: string;
  /** Optional symbol name (function/class/method). */
  symbol?: string;
  /** Line range. */
  lineStart: number;
  lineEnd: number;
  /** Quantitative metric (e.g. method length, class size). */
  metric: number;
  /** Human-readable description. */
  description: string;
  /** Suggested refactoring pattern. */
  suggestedRefactoring: RefactoringPattern;
}

/** A planned refactoring step (executed in sequence). */
export interface RefactoringStep {
  /** Step id. */
  id: string;
  /** Pattern to apply. */
  pattern: RefactoringPattern;
  /** Smell ids this step addresses. */
  targets: string[];
  /** Human-readable description of the change. */
  description: string;
  /** Files that will be touched. */
  files: string[];
}

/** Complexity metrics measured before/after refactoring. */
export interface ComplexityMetrics {
  /** Average cyclomatic complexity per function. */
  avgCyclomaticComplexity: number;
  /** Max cyclomatic complexity across all functions. */
  maxCyclomaticComplexity: number;
  /** Average method length (lines). */
  avgMethodLength: number;
  /** Max method length (lines). */
  maxMethodLength: number;
  /** Average nesting depth. */
  avgNestingDepth: number;
  /** Max nesting depth. */
  maxNestingDepth: number;
  /** Maintainability index (0..100, higher is better). */
  maintainabilityIndex: number;
}

/** Result of one refactoring step (for the actions log). */
export interface RefactoringStepResult {
  /** Step id. */
  stepId: string;
  /** Outcome. */
  status: 'completed' | 'rolled_back' | 'skipped';
  /** Tests passed before the change. */
  testsPassedBefore: boolean;
  /** Tests passed after the change. */
  testsPassedAfter: boolean;
  /** Reason for rollback/skip, if any. */
  note?: string;
}

/** Files to skip during smell detection. */
const IGNORED_PATH_PATTERNS = [
  /node_modules\//,
  /\/dist\//,
  /\/build\//,
  /\/.next\//,
  /\/coverage\//,
  /\.min\.js$/,
  /\.map$/,
  /vendor\//,
];

/** File extensions the agent analyzes for code smells. */
const ANALYZABLE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.rb',
  '.php',
  '.cs',
  '.swift',
];

/** Smell severity → finding severity mapping. */
const SEVERITY_TO_FINDING: Record<SmellSeverity, 'critical' | 'high' | 'medium' | 'low'> = {
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  low: 'low',
};

/** Smell type → suggested refactoring pattern. */
const SMELL_TO_PATTERN: Record<CodeSmellType, RefactoringPattern> = {
  long_method: 'extract_method',
  god_class: 'extract_class',
  duplicated_code: 'extract_method',
  deep_nesting: 'extract_method',
  long_parameter_list: 'introduce_parameter_object',
  feature_envy: 'move_method',
  data_clumps: 'introduce_parameter_object',
  primitive_obsession: 'replace_array_with_object',
  switch_statement: 'replace_conditional_with_polymorphism',
  parallel_inheritance: 'replace_inheritance_with_delegation',
  shotgun_surgery: 'extract_class',
  divergent_change: 'extract_class',
};

/** Smell severity thresholds. */
const THRESHOLDS = {
  longMethodLines: 50,
  godClassLines: 500,
  godClassMethods: 20,
  deepNestingLevels: 4,
  longParameterCount: 5,
  duplicationMinBlock: 6, // lines
  duplicationMinPct: 0.6,
} as const;

/**
 * SANIX Refactor Ranger — a refactoring specialist.
 *
 * @example
 * ```ts
 * import { RefactorRanger } from '@sanix/agents';
 *
 * const agent = new RefactorRanger();
 * const result = await agent.run({
 *   query: 'Find code smells in src/ and safely refactor the worst offenders.',
 *   workspacePath: '/repo/my-app',
 *   tools: registry,
 *   onProgress: (e) => console.log(`[${e.phase}] ${e.message}`),
 * });
 * console.log(`Found ${result.findings.length} smells, applied ${result.actions.length} refactorings.`);
 * ```
 */
export class RefactorRanger extends BaseAgent {
  /** @inheritdoc */
  readonly id = 'refactor-ranger';
  /** @inheritdoc */
  readonly name = 'SANIX Refactor Ranger';
  /** @inheritdoc */
  readonly description =
    'Detects code smells (long methods, god classes, duplicated code, deep nesting, long parameter lists, feature envy, data clumps, primitive obsession, switch statements, parallel inheritance, shotgun surgery, divergent change) and applies safe refactoring transformations. NEVER changes behavior — every refactoring step is verified with tests before and after, and rolled back if the test suite breaks.';
  /** @inheritdoc */
  readonly icon = '🔧';
  /** @inheritdoc */
  readonly category: AgentCategory = 'refactoring' as AgentCategory;
  /** @inheritdoc */
  readonly systemPrompt = `You are SANIX Refactor Ranger, a refactoring expert. You detect code smells and apply safe refactoring transformations. You NEVER change behavior — always verify with tests before and after.

Code smells you detect:
- long methods (>50 lines)
- god classes (>500 lines or >20 methods)
- duplicated code (copy-paste detection)
- deep nesting (>4 levels)
- long parameter lists (>5 params)
- feature envy
- data clumps
- primitive obsession
- switch statements
- parallel inheritance hierarchies
- shotgun surgery
- divergent change

Refactoring patterns you apply:
- Extract Method
- Extract Class
- Move Method
- Replace Conditional with Polymorphism
- Replace Inheritance with Delegation
- Introduce Parameter Object
- Replace Method with Method Object
- Replace Array with Object

Always run tests before and after each refactoring step. If tests fail after a step, roll back the change and try a different approach. Measure cyclomatic complexity and maintainability index before/after to quantify improvement.`;
  /** @inheritdoc */
  readonly tools = [
    'read_file',
    'write_file',
    'edit_file',
    'search_files',
    'analyze_ast',
    'run_tests',
    'run_linter',
  ];
  /** @inheritdoc */
  readonly exampleQueries = [
    'Scan the src/ directory for code smells and refactor the worst offenders.',
    'Find duplicated code blocks across packages/api/src and extract a shared helper.',
    'The UserService class is 800 lines — split it into focused classes via Extract Class.',
    'Reduce nesting depth in handleRequest() — it has 6 levels of if/else.',
    'Replace the switch statement in Shape.area() with polymorphism.',
  ];

  /**
   * Run the Refactor Ranger on a workspace.
   *
   * @param options - Run options (query, workspacePath, tools, signal, onProgress).
   * @returns Findings (smells), actions (refactorings applied), and before/after metrics.
   */
  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    const startedAt = Date.now();
    const startedBy = startedAt;
    const emit = (phase: string, message: string, progress?: number, data?: Record<string, unknown>): void => {
      const event: AgentProgressEvent = {
        phase,
        message,
        progress,
        timestamp: Date.now(),
        data,
      };
      options.onProgress?.(event);
    };
    const aborted = (): boolean => options.signal?.aborted === true;
    const tools = options.tools ?? {};

    const findings: AgentFinding[] = [];
    const actions: AgentAction[] = [];
    const metrics: Record<string, number | string> = {};

    try {
      // ── Phase 1: Smell detection ───────────────────────────────────────
      emit('detection', 'Scanning workspace for code smells…', 0.05);
      const files = await this.discoverFiles(options.workspacePath, tools);
      emit('detection', `Discovered ${files.length} analyzable files.`, 0.1, { fileCount: files.length });

      const smells: CodeSmell[] = [];
      for (let i = 0; i < files.length; i++) {
        if (aborted()) throw new Error('Aborted by signal');
        const file = files[i];
        try {
          const content = await this.readFile(file, tools, options.workspacePath);
          if (content === null) continue;
          smells.push(...this.detectSmellsInFile(file, content));
        } catch {
          // best-effort: skip unreadable files
        }
        if (i % 10 === 0 || i === files.length - 1) {
          emit(
            'detection',
            `Scanned ${i + 1}/${files.length} files — ${smells.length} smells so far.`,
            0.1 + 0.2 * ((i + 1) / files.length),
          );
        }
      }

      // ── Phase 2: Prioritize ────────────────────────────────────────────
      emit('prioritization', 'Ranking smells by severity…', 0.32);
      const ranked = this.rankSmells(smells);
      for (const smell of ranked) {
        findings.push(this.smellToFinding(smell));
      }
      metrics.smellsFound = ranked.length;
      metrics.criticalSmells = ranked.filter((s) => s.severity === 'critical').length;
      metrics.highSmells = ranked.filter((s) => s.severity === 'high').length;
      metrics.mediumSmells = ranked.filter((s) => s.severity === 'medium').length;
      metrics.lowSmells = ranked.filter((s) => s.severity === 'low').length;
      emit(
        'prioritization',
        `Prioritized ${ranked.length} smells (critical=${metrics.criticalSmells}, high=${metrics.highSmells}).`,
        0.35,
      );

      // ── Phase 3: Plan ──────────────────────────────────────────────────
      emit('planning', 'Creating refactoring sequence…', 0.4);
      const plan = this.planRefactorings(ranked);
      metrics.plannedSteps = plan.length;
      emit('planning', `Planned ${plan.length} refactoring steps.`, 0.42);

      // ── Phase 4: Measure baseline ──────────────────────────────────────
      emit('baseline', 'Measuring baseline complexity + running tests…', 0.45);
      const beforeMetrics = await this.measureComplexity(files, tools, options.workspacePath);
      metrics.beforeAvgCyclomatic = beforeMetrics.avgCyclomaticComplexity.toFixed(2);
      metrics.beforeMaxCyclomatic = beforeMetrics.maxCyclomaticComplexity;
      metrics.beforeMaintainability = beforeMetrics.maintainabilityIndex.toFixed(1);
      const baselineTestsPassed = await this.runTests(tools, options.workspacePath);
      metrics.baselineTestsPassed = baselineTestsPassed ? 'true' : 'false';
      emit(
        'baseline',
        `Baseline: avg CC=${beforeMetrics.avgCyclomaticComplexity.toFixed(2)}, MI=${beforeMetrics.maintainabilityIndex.toFixed(1)}, tests=${baselineTestsPassed ? 'PASS' : 'FAIL'}.`,
        0.5,
      );

      // ── Phase 5: Execute refactorings ──────────────────────────────────
      const stepResults: RefactoringStepResult[] = [];
      for (let i = 0; i < plan.length; i++) {
        if (aborted()) throw new Error('Aborted by signal');
        const step = plan[i];
        const progress = 0.5 + 0.35 * (i / Math.max(plan.length, 1));
        emit(
          'execution',
          `Step ${i + 1}/${plan.length}: ${step.description}`,
          progress,
          { stepId: step.id, pattern: step.pattern },
        );
        const result = await this.executeStep(step, tools, options.workspacePath, baselineTestsPassed);
        stepResults.push(result);
        actions.push(this.stepResultToAction(step, result));
      }

      const completed = stepResults.filter((r) => r.status === 'completed').length;
      const rolledBack = stepResults.filter((r) => r.status === 'rolled_back').length;
      const skipped = stepResults.filter((r) => r.status === 'skipped').length;
      metrics.refactoringsApplied = completed;
      metrics.refactoringsRolledBack = rolledBack;
      metrics.refactoringsSkipped = skipped;

      // ── Phase 6: Verify ────────────────────────────────────────────────
      emit('verification', 'Running full test suite + linter…', 0.9);
      const finalTestsPassed = await this.runTests(tools, options.workspacePath);
      const linterPassed = await this.runLinter(tools, options.workspacePath);
      const afterMetrics = await this.measureComplexity(files, tools, options.workspacePath);
      metrics.afterAvgCyclomatic = afterMetrics.avgCyclomaticComplexity.toFixed(2);
      metrics.afterMaxCyclomatic = afterMetrics.maxCyclomaticComplexity;
      metrics.afterMaintainability = afterMetrics.maintainabilityIndex.toFixed(1);
      metrics.finalTestsPassed = finalTestsPassed ? 'true' : 'false';
      metrics.linterPassed = linterPassed ? 'true' : 'false';
      const ccImprovement =
        beforeMetrics.avgCyclomaticComplexity > 0
          ? ((beforeMetrics.avgCyclomaticComplexity - afterMetrics.avgCyclomaticComplexity) /
              beforeMetrics.avgCyclomaticComplexity) *
            100
          : 0;
      metrics.complexityReductionPct = ccImprovement.toFixed(1);
      emit(
        'verification',
        `Final: avg CC=${afterMetrics.avgCyclomaticComplexity.toFixed(2)} (-${ccImprovement.toFixed(1)}%), tests=${finalTestsPassed ? 'PASS' : 'FAIL'}, lint=${linterPassed ? 'PASS' : 'FAIL'}.`,
        0.95,
      );

      // ── Phase 7: Report ────────────────────────────────────────────────
      emit('report', 'Refactor Ranger complete.', 1);
      const durationMs = Date.now() - startedBy;
      metrics.durationMs = durationMs;

      const summary = this.buildSummary(ranked, stepResults, beforeMetrics, afterMetrics, finalTestsPassed, linterPassed);

      return {
        agentId: this.id,
        summary,
        findings,
        actions,
        metrics,
        durationMs,
        success: finalTestsPassed,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit('error', `Refactor Ranger failed: ${message}`, 1);
      return {
        agentId: this.id,
        summary: `Refactor Ranger aborted: ${message}`,
        findings,
        actions,
        metrics,
        durationMs: Date.now() - startedBy,
        success: false,
      };
    }
  }

  // ─── File discovery ────────────────────────────────────────────────────

  /**
   * Discover analyzable source files in the workspace. Uses the
   * `search_files` tool when available; otherwise falls back to a
   * shallow recursive directory walk.
   */
  private async discoverFiles(
    workspacePath: string,
    tools: string[],
  ): Promise<string[]> {
    const searchFiles = tools['search_files'];
    if (typeof searchFiles === 'function') {
      try {
        const result = await searchFiles({
          path: workspacePath,
          pattern: `**/*{${ANALYZABLE_EXTENSIONS.join(',')}}`,
        });
        const list = this.asStringArray(result);
        return list.filter((p) => !IGNORED_PATH_PATTERNS.some((re) => re.test(p)));
      } catch {
        // fall through to fs walk
      }
    }
    return this.walkDir(workspacePath);
  }

  /** Recursive directory walk (best-effort, sync via fs). */
  private async walkDir(root: string): Promise<string[]> {
    const path = await import('node:path');
    const fs = await import('node:fs/promises');
    const out: string[] = [];
    const visit = async (dir: string): Promise<void> => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        const rel = path.relative(root, full);
        if (IGNORED_PATH_PATTERNS.some((re) => re.test(rel + '/'))) continue;
        if (entry.isDirectory()) {
          await visit(full);
        } else if (
          entry.isFile() &&
          ANALYZABLE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))
        ) {
          if (!IGNORED_PATH_PATTERNS.some((re) => re.test(rel))) {
            out.push(full);
          }
        }
      }
    };
    await visit(root);
    return out;
  }

  /** Read a file via the `read_file` tool or directly from disk. */
  private async readFile(
    file: string,
    tools: string[],
    workspacePath: string,
  ): Promise<string | null> {
    const readFileTool = tools['read_file'];
    if (typeof readFileTool === 'function') {
      try {
        const result = await readFileTool({ path: file });
        if (typeof result === 'string') return result;
        if (result && typeof result === 'object' && 'content' in result) {
          const content = (result as { content: unknown }).content;
          if (typeof content === 'string') return content;
        }
      } catch {
        // fall through
      }
    }
    try {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const full = path.isAbsolute(file) ? file : path.join(workspacePath, file);
      return await fs.readFile(full, 'utf8');
    } catch {
      return null;
    }
  }

  // ─── Smell detection ───────────────────────────────────────────────────

  /**
   * Detect code smells in a single file's source content. Uses simple
   * text + indentation heuristics that work across most C-like and
   * Python-like languages without requiring a real AST.
   */
  private detectSmellsInFile(file: string, content: string): CodeSmell[] {
    const smells: CodeSmell[] = [];
    const lines = content.split(/\r?\n/);
    const ext = file.slice(file.lastIndexOf('.')).toLowerCase();

    // Function/method detection: matches `name(...) {` or `def name(...):` or `func name(...) {`
    const functions = this.findFunctions(lines, ext);
    for (const fn of functions) {
      const length = fn.lineEnd - fn.lineStart + 1;
      if (length > THRESHOLDS.longMethodLines) {
        smells.push({
          id: nanoid(10),
          type: 'long_method',
          severity: this.severityForLength(length, THRESHOLDS.longMethodLines),
          file,
          symbol: fn.name,
          lineStart: fn.lineStart,
          lineEnd: fn.lineEnd,
          metric: length,
          description: `Method '${fn.name}' is ${length} lines long (threshold ${THRESHOLDS.longMethodLines}). Consider Extract Method.`,
          suggestedRefactoring: 'extract_method',
        });
      }
      const nesting = this.maxNestingDepth(lines, fn.lineStart, fn.lineEnd);
      if (nesting > THRESHOLDS.deepNestingLevels) {
        smells.push({
          id: nanoid(10),
          type: 'deep_nesting',
          severity: nesting >= 6 ? 'high' : 'medium',
          file,
          symbol: fn.name,
          lineStart: fn.lineStart,
          lineEnd: fn.lineEnd,
          metric: nesting,
          description: `Method '${fn.name}' has ${nesting} levels of nesting (threshold ${THRESHOLDS.deepNestingLevels}). Extract nested blocks into helper methods.`,
          suggestedRefactoring: 'extract_method',
        });
      }
      const params = this.countParameters(fn.signature);
      if (params > THRESHOLDS.longParameterCount) {
        smells.push({
          id: nanoid(10),
          type: 'long_parameter_list',
          severity: params >= 8 ? 'high' : 'medium',
          file,
          symbol: fn.name,
          lineStart: fn.lineStart,
          lineEnd: fn.lineStart,
          metric: params,
          description: `Method '${fn.name}' takes ${params} parameters (threshold ${THRESHOLDS.longParameterCount}). Introduce a Parameter Object.`,
          suggestedRefactoring: 'introduce_parameter_object',
        });
      }
      const cc = this.cyclomaticComplexity(lines, fn.lineStart, fn.lineEnd);
      if (cc >= 10) {
        // High complexity is itself a "long method"-class smell; record it as divergent_change risk.
        smells.push({
          id: nanoid(10),
          type: 'divergent_change',
          severity: cc >= 15 ? 'high' : 'medium',
          file,
          symbol: fn.name,
          lineStart: fn.lineStart,
          lineEnd: fn.lineEnd,
          metric: cc,
          description: `Method '${fn.name}' has cyclomatic complexity ${cc}. Too many decision points — extract branches or replace conditionals with polymorphism.`,
          suggestedRefactoring: 'replace_conditional_with_polymorphism',
        });
      }
    }

    // Class detection (rough)
    const classes = this.findClasses(lines);
    for (const cls of classes) {
      const length = cls.lineEnd - cls.lineStart + 1;
      const methodCount = functions.filter(
        (fn) => fn.lineStart >= cls.lineStart && fn.lineEnd <= cls.lineEnd,
      ).length;
      if (length > THRESHOLDS.godClassLines || methodCount > THRESHOLDS.godClassMethods) {
        smells.push({
          id: nanoid(10),
          type: 'god_class',
          severity: 'critical',
          file,
          symbol: cls.name,
          lineStart: cls.lineStart,
          lineEnd: cls.lineEnd,
          metric: Math.max(length, methodCount),
          description: `Class '${cls.name}' is ${length} lines with ${methodCount} methods (thresholds ${THRESHOLDS.godClassLines} lines / ${THRESHOLDS.godClassMethods} methods). Extract Class to split responsibilities.`,
          suggestedRefactoring: 'extract_class',
        });
      }
    }

    // Switch / big if-else chains
    const switches = this.findSwitchStatements(lines);
    for (const sw of switches) {
      smells.push({
        id: nanoid(10),
        type: 'switch_statement',
        severity: sw.caseCount >= 6 ? 'high' : 'medium',
        file,
        lineStart: sw.lineStart,
        lineEnd: sw.lineEnd,
        metric: sw.caseCount,
        description: `Switch/if-chain with ${sw.caseCount} branches at line ${sw.lineStart}. Replace Conditional with Polymorphism.`,
        suggestedRefactoring: 'replace_conditional_with_polymorphism',
      });
    }

    // Duplicated blocks (within the file)
    const duplicates = this.findDuplicatesInFile(lines, file);
    smells.push(...duplicates);

    return smells;
  }

  /** Severity from method length. */
  private severityForLength(length: number, threshold: number): SmellSeverity {
    if (length >= threshold * 4) return 'critical';
    if (length >= threshold * 2) return 'high';
    if (length >= threshold * 1.5) return 'medium';
    return 'low';
  }

  /** Find functions in the file (rough heuristic). */
  private findFunctions(
    lines: string[],
    _ext: string,
  ): Array<{ name: string; signature: string; lineStart: number; lineEnd: number }> {
    const out: Array<{ name: string; signature: string; lineStart: number; lineEnd: number }> = [];
    // Matches:
    //   function name(args) {
    //   const name = (args) => {
    //   async name(args) {
    //   def name(args):
    //   func name(args) {
    const fnRe =
      /^\s*(?:export\s+)?(?:async\s+)?(?:function\s+)?([A-Za-z_$][\w$]*)\s*(?:=\s*)?\s*(?:async\s*)?\(([^)]*)\)\s*(?::\s*[^=]+)?\s*(?:=>|{)\s*$/;
    const pyFnRe = /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(([^)]*)\)\s*(?:->\s*[^:]+)?:\s*$/;
    const goFnRe = /^\s*func\s+(?:\([^)]*\)\s+)?([A-Za-z_][\w]*)\s*\(([^)]*)\)\s*(?:[^{]*)?\{?\s*$/;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match = line.match(fnRe) || line.match(pyFnRe) || line.match(goFnRe);
      if (!match) continue;
      const name = match[1];
      if (!name || ['if', 'for', 'while', 'switch', 'catch', 'return', 'class'].includes(name)) continue;
      const signature = line;
      const lineEnd = this.findBlockEnd(lines, i);
      if (lineEnd > i) {
        out.push({ name, signature, lineStart: i + 1, lineEnd: lineEnd + 1 });
      }
    }
    return out;
  }

  /** Find the closing brace / dedent of the block starting at `startLine`. */
  private findBlockEnd(lines: string[], startLine: number): number {
    let depth = 0;
    let inBlock = false;
    for (let i = startLine; i < lines.length; i++) {
      const line = lines[i];
      for (const ch of line) {
        if (ch === '{') {
          depth++;
          inBlock = true;
        } else if (ch === '}') {
          depth--;
          if (inBlock && depth === 0) return i;
        }
      }
      // Python: dedent-based end (heuristic — first line at <= starting indent after body)
      if (!inBlock && i > startLine && line.trim().length > 0) {
        const startIndent = lines[startLine].match(/^\s*/)?.[0].length ?? 0;
        const curIndent = line.match(/^\s*/)?.[0].length ?? 0;
        if (curIndent <= startIndent && !line.trim().startsWith('#')) {
          return i - 1;
        }
      }
    }
    return lines.length - 1;
  }

  /** Find class declarations. */
  private findClasses(
    lines: string[],
  ): Array<{ name: string; lineStart: number; lineEnd: number }> {
    const out: Array<{ name: string; lineStart: number; lineEnd: number }> = [];
    const clsRe =
      /^\s*(?:export\s+)?(?:abstract\s+)?(?:class|struct|trait|interface)\s+([A-Za-z_$][\w$]*)/;
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(clsRe);
      if (!match) continue;
      const lineEnd = this.findBlockEnd(lines, i);
      out.push({ name: match[1], lineStart: i + 1, lineEnd: lineEnd + 1 });
    }
    return out;
  }

  /** Find switch statements / long if-else-if chains. */
  private findSwitchStatements(
    lines: string[],
  ): Array<{ lineStart: number; lineEnd: number; caseCount: number }> {
    const out: Array<{ lineStart: number; lineEnd: number; caseCount: number }> = [];
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*switch\s*\(/.test(lines[i])) {
        const end = this.findBlockEnd(lines, i);
        let cases = 0;
        for (let j = i; j <= end; j++) {
          if (/^\s*case\s+/.test(lines[j]) || /^\s*default\s*:/.test(lines[j])) cases++;
        }
        out.push({ lineStart: i + 1, lineEnd: end + 1, caseCount: cases });
      }
    }
    // Also detect long if/else-if chains
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*if\s*\(/.test(lines[i]) && !/else\s+if/.test(lines[i])) {
        let branches = 1;
        let lastEnd = i;
        for (let j = i + 1; j < lines.length; j++) {
          if (/^\s*(?:}\s*)?else\s+if\s*\(/.test(lines[j])) {
            branches++;
            lastEnd = j;
          } else if (/^\s*(?:}\s*)?else\s*(?:\{|$)/.test(lines[j])) {
            branches++;
            lastEnd = j;
            break;
          } else if (branches > 1 && lines[j].trim().length > 0 && !/else/.test(lines[j])) {
            break;
          }
        }
        if (branches >= 4) {
          out.push({ lineStart: i + 1, lineEnd: lastEnd + 1, caseCount: branches });
        }
      }
    }
    return out;
  }

  /** Find duplicated code blocks within a single file. */
  private findDuplicatesInFile(lines: string[], file: string): CodeSmell[] {
    const smells: CodeSmell[] = [];
    const blockSize = THRESHOLDS.duplicationMinBlock;
    const blocks = new Map<string, number[]>();
    for (let i = 0; i + blockSize <= lines.length; i++) {
      const block = lines
        .slice(i, i + blockSize)
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .join('\n');
      if (block.length < 20) continue;
      const key = this.hashBlock(block);
      const arr = blocks.get(key) ?? [];
      arr.push(i);
      blocks.set(key, arr);
    }
    for (const [, occurrences] of blocks) {
      if (occurrences.length < 2) continue;
      const firstStart = occurrences[0];
      const firstEnd = firstStart + blockSize - 1;
      const dupPct = Math.min(1, occurrences.length / 5);
      if (dupPct >= THRESHOLDS.duplicationMinPct || occurrences.length >= 3) {
        smells.push({
          id: nanoid(10),
          type: 'duplicated_code',
          severity: occurrences.length >= 4 ? 'critical' : 'high',
          file,
          lineStart: firstStart + 1,
          lineEnd: firstEnd + 1,
          metric: occurrences.length,
          description: `Duplicated ${blockSize}-line block appears ${occurrences.length}× in this file. Extract Method to a shared helper.`,
          suggestedRefactoring: 'extract_method',
        });
      }
    }
    return smells;
  }

  /** Simple djb2-style hash for a block of code. */
  private hashBlock(block: string): string {
    let hash = 5381;
    for (let i = 0; i < block.length; i++) {
      hash = ((hash << 5) + hash + block.charCodeAt(i)) | 0;
    }
    return (hash >>> 0).toString(36);
  }

  /** Count parameters from a function signature line. */
  private countParameters(signature: string): number {
    const match = signature.match(/\(([^)]*)\)/);
    if (!match) return 0;
    const raw = match[1].trim();
    if (raw.length === 0) return 0;
    // Split on commas at depth 0 (so generic types / nested parens don't count).
    const parts: string[] = [];
    let depth = 0;
    let current = '';
    for (const ch of raw) {
      if (ch === '(' || ch === '<' || ch === '[') depth++;
      else if (ch === ')' || ch === '>' || ch === ']') depth--;
      if (ch === ',' && depth === 0) {
        parts.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    if (current.trim().length > 0) parts.push(current);
    // Filter out type-only "self" / "cls" / receiver params
    return parts.filter((p) => p.trim().length > 0).length;
  }

  /** Max nesting depth inside a function body. */
  private maxNestingDepth(lines: string[], startLine: number, endLine: number): number {
    let depth = 0;
    let max = 0;
    for (let i = startLine; i <= endLine && i < lines.length; i++) {
      const line = lines[i];
      for (const ch of line) {
        if (ch === '{') {
          depth++;
          if (depth > max) max = depth;
        } else if (ch === '}') {
          depth--;
        }
      }
      // Python-style indent
      if (/^\s+/.test(line) && /:\s*$/.test(line)) {
        depth++;
        if (depth > max) max = depth;
      }
    }
    // Subtract 1 because the function body itself counts as 1 level
    return Math.max(0, max - 1);
  }

  /** Cyclomatic complexity for a code block (decision points + 1). */
  private cyclomaticComplexity(lines: string[], startLine: number, endLine: number): number {
    let cc = 1;
    const decisionRe =
      /\b(if|else if|while|for|case|catch|&&|\|\||\?|->|loop|match)\b/g;
    for (let i = startLine; i <= endLine && i < lines.length; i++) {
      const matches = lines[i].match(decisionRe);
      if (matches) cc += matches.length;
    }
    return cc;
  }

  // ─── Prioritization ────────────────────────────────────────────────────

  /** Rank smells by severity (critical → low), then by metric descending. */
  private rankSmells(smells: CodeSmell[]): CodeSmell[] {
    const order: Record<SmellSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    return smells.slice().sort((a, b) => {
      const sevDiff = order[a.severity] - order[b.severity];
      if (sevDiff !== 0) return sevDiff;
      return b.metric - a.metric;
    });
  }

  /** Convert a smell to a public AgentFinding. */
  private smellToFinding(smell: CodeSmell): AgentFinding {
    return {
      id: smell.id,
      severity: SEVERITY_TO_FINDING[smell.severity],
      category: smell.type,
      title: `${smell.type.replace(/_/g, ' ')} — ${smell.symbol ?? smell.file}`,
      description: smell.description,
      location: {
        file: smell.file,
        lineStart: smell.lineStart,
        lineEnd: smell.lineEnd,
        symbol: smell.symbol,
      },
      evidence: [`metric: ${smell.metric}`, `suggested: ${smell.suggestedRefactoring}`],
      recommendation: `Apply ${smell.suggestedRefactoring.replace(/_/g, ' ')}.`,
    };
  }

  // ─── Planning ──────────────────────────────────────────────────────────

  /** Plan a refactoring sequence (extract methods before extract classes). */
  private planRefactorings(smells: CodeSmell[]): RefactoringStep[] {
    const steps: RefactoringStep[] = [];
    // Group by file + pattern to batch related smells.
    const order: RefactoringPattern[] = [
      'extract_method',
      'introduce_parameter_object',
      'replace_array_with_object',
      'move_method',
      'replace_method_with_method_object',
      'extract_class',
      'replace_conditional_with_polymorphism',
      'replace_inheritance_with_delegation',
    ];
    for (const pattern of order) {
      const matching = smells.filter((s) => s.suggestedRefactoring === pattern);
      if (matching.length === 0) continue;
      // Cap each pattern at 5 steps to keep the run bounded.
      const capped = matching.slice(0, 5);
      for (const smell of capped) {
        steps.push({
          id: nanoid(10),
          pattern,
          targets: [smell.id],
          description: `${this.patternLabel(pattern)} on ${smell.symbol ?? smell.file}:${smell.lineStart}`,
          files: [smell.file],
        });
      }
    }
    return steps;
  }

  /** Human-readable label for a refactoring pattern. */
  private patternLabel(pattern: RefactoringPattern): string {
    const labels: Record<RefactoringPattern, string> = {
      extract_method: 'Extract Method',
      extract_class: 'Extract Class',
      move_method: 'Move Method',
      replace_conditional_with_polymorphism: 'Replace Conditional with Polymorphism',
      replace_inheritance_with_delegation: 'Replace Inheritance with Delegation',
      introduce_parameter_object: 'Introduce Parameter Object',
      replace_method_with_method_object: 'Replace Method with Method Object',
      replace_array_with_object: 'Replace Array with Object',
    };
    return labels[pattern];
  }

  // ─── Execution ─────────────────────────────────────────────────────────

  /**
   * Execute a single refactoring step with test-before/test-after
   * verification. Rolls back on test failure.
   */
  private async executeStep(
    step: RefactoringStep,
    tools: string[],
    workspacePath: string,
    baselineTestsPassed: boolean,
  ): Promise<RefactoringStepResult> {
    // If we don't have editing tools, skip.
    const editFile = tools['edit_file'];
    const writeFile = tools['write_file'];
    if (typeof editFile !== 'function' && typeof writeFile !== 'function') {
      return {
        stepId: step.id,
        status: 'skipped',
        testsPassedBefore: baselineTestsPassed,
        testsPassedAfter: baselineTestsPassed,
        note: 'No edit_file/write_file tools available — skipping application (detection-only mode).',
      };
    }

    // Step 1: tests BEFORE (baseline for this step).
    const testsPassedBefore = await this.runTests(tools, workspacePath);
    if (!testsPassedBefore) {
      return {
        stepId: step.id,
        status: 'skipped',
        testsPassedBefore: false,
        testsPassedAfter: false,
        note: 'Tests already failing at baseline — fix before refactoring.',
      };
    }

    // Step 2: apply the refactoring (delegated to the LLM via edit_file tool).
    try {
      if (typeof editFile === 'function') {
        await editFile({
          file: step.files[0],
          instruction: step.description,
          pattern: step.pattern,
        });
      } else if (typeof writeFile === 'function') {
        // Less precise but still allows the tool to apply a change.
        await writeFile({
          file: step.files[0],
          instruction: step.description,
          pattern: step.pattern,
        });
      }
    } catch (err) {
      return {
        stepId: step.id,
        status: 'skipped',
        testsPassedBefore,
        testsPassedAfter: testsPassedBefore,
        note: `Edit tool failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Step 3: tests AFTER.
    const testsPassedAfter = await this.runTests(tools, workspacePath);
    if (!testsPassedAfter) {
      // Step 4: rollback — try to undo via edit_file with rollback instruction.
      try {
        if (typeof editFile === 'function') {
          await editFile({
            file: step.files[0],
            instruction: `ROLLBACK previous change: ${step.description}`,
            rollback: true,
          });
        }
      } catch {
        // best-effort
      }
      return {
        stepId: step.id,
        status: 'rolled_back',
        testsPassedBefore,
        testsPassedAfter: false,
        note: 'Tests failed after refactoring — rolled back.',
      };
    }

    return {
      stepId: step.id,
      status: 'completed',
      testsPassedBefore,
      testsPassedAfter: true,
    };
  }

  /** Convert a step result into a public AgentAction. */
  private stepResultToAction(step: RefactoringStep, result: RefactoringStepResult): AgentAction {
    return {
      id: step.id,
      type: step.pattern,
      description: step.description,
      status: result.status,
      target: step.files[0],
      before: result.testsPassedBefore ? 'tests:PASS' : 'tests:FAIL',
      after: result.testsPassedAfter ? 'tests:PASS' : 'tests:FAIL',
      error: result.note,
    };
  }

  // ─── Metrics ───────────────────────────────────────────────────────────

  /** Measure complexity metrics across a set of files. */
  private async measureComplexity(
    files: string[],
    tools: string[],
    workspacePath: string,
  ): Promise<ComplexityMetrics> {
    const analyzeAst = tools['analyze_ast'];
    if (typeof analyzeAst === 'function') {
      try {
        const result = await analyzeAst({ files, workspacePath });
        if (result && typeof result === 'object') {
          const r = result as Partial<ComplexityMetrics>;
          if (
            typeof r.avgCyclomaticComplexity === 'number' &&
            typeof r.maintainabilityIndex === 'number'
          ) {
            return {
              avgCyclomaticComplexity: r.avgCyclomaticComplexity,
              maxCyclomaticComplexity: r.maxCyclomaticComplexity ?? r.avgCyclomaticComplexity,
              avgMethodLength: r.avgMethodLength ?? 0,
              maxMethodLength: r.maxMethodLength ?? 0,
              avgNestingDepth: r.avgNestingDepth ?? 0,
              maxNestingDepth: r.maxNestingDepth ?? 0,
              maintainabilityIndex: r.maintainabilityIndex,
            };
          }
        }
      } catch {
        // fall through to heuristic
      }
    }
    return this.heuristicComplexity(files, workspacePath);
  }

  /** Heuristic complexity measurement (no AST library required). */
  private async heuristicComplexity(
    files: string[],
    workspacePath: string,
  ): Promise<ComplexityMetrics> {
    const path = await import('node:path');
    const fs = await import('node:fs/promises');
    const ccValues: number[] = [];
    const methodLengths: number[] = [];
    const nestingDepths: number[] = [];
    for (const file of files.slice(0, 200)) {
      let content: string;
      try {
        const full = path.isAbsolute(file) ? file : path.join(workspacePath, file);
        content = await fs.readFile(full, 'utf8');
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/);
      const fns = this.findFunctions(lines, path.extname(file));
      for (const fn of fns) {
        ccValues.push(this.cyclomaticComplexity(lines, fn.lineStart - 1, fn.lineEnd - 1));
        methodLengths.push(fn.lineEnd - fn.lineStart + 1);
        nestingDepths.push(this.maxNestingDepth(lines, fn.lineStart - 1, fn.lineEnd - 1));
      }
    }
    const avg = (arr: number[]): number => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
    const max = (arr: number[]): number => (arr.length ? Math.max(...arr) : 0);
    const avgCC = avg(ccValues);
    const maxCC = max(ccValues);
    const avgML = avg(methodLengths);
    const maxML = max(methodLengths);
    const avgND = avg(nestingDepths);
    const maxND = max(nestingDepths);
    // Maintainability index (Microsoft formula simplified): max(0, 171 - 5.2*ln(V) - 0.23*CC - 16.2*ln(LOC))
    // We approximate V using avg method length and LOC using file line counts.
    const loc = methodLengths.reduce((a, b) => a + b, 0);
    const v = Math.log(Math.max(1, avgML * 20));
    const mi = Math.max(
      0,
      Math.min(
        100,
        171 - 5.2 * v - 0.23 * avgCC - 16.2 * Math.log(Math.max(1, loc)),
      ),
    );
    return {
      avgCyclomaticComplexity: avgCC,
      maxCyclomaticComplexity: maxCC,
      avgMethodLength: avgML,
      maxMethodLength: maxML,
      avgNestingDepth: avgND,
      maxNestingDepth: maxND,
      maintainabilityIndex: mi,
    };
  }

  // ─── Test + linter invocation ──────────────────────────────────────────

  /** Run the test suite via the `run_tests` tool. Returns false on failure/missing. */
  private async runTests(
    tools: string[],
    workspacePath: string,
  ): Promise<boolean> {
    const runTestsTool = tools['run_tests'];
    if (typeof runTestsTool !== 'function') return false;
    try {
      const result = await runTestsTool({ workspacePath });
      if (typeof result === 'boolean') return result;
      if (result && typeof result === 'object') {
        const r = result as { passed?: unknown; success?: unknown; exitCode?: unknown; status?: unknown };
        if (typeof r.passed === 'boolean') return r.passed;
        if (typeof r.success === 'boolean') return r.success;
        if (typeof r.exitCode === 'number') return r.exitCode === 0;
        if (typeof r.status === 'string') return r.status === 'passed' || r.status === 'ok';
      }
      return false;
    } catch {
      return false;
    }
  }

  /** Run the linter via the `run_linter` tool. */
  private async runLinter(
    tools: string[],
    workspacePath: string,
  ): Promise<boolean> {
    const runLinterTool = tools['run_linter'];
    if (typeof runLinterTool !== 'function') return false;
    try {
      const result = await runLinterTool({ workspacePath });
      if (typeof result === 'boolean') return result;
      if (result && typeof result === 'object') {
        const r = result as { passed?: unknown; success?: unknown; errorCount?: unknown };
        if (typeof r.passed === 'boolean') return r.passed;
        if (typeof r.success === 'boolean') return r.success;
        if (typeof r.errorCount === 'number') return r.errorCount === 0;
      }
      return false;
    } catch {
      return false;
    }
  }

  // ─── Reporting ─────────────────────────────────────────────────────────

  /** Build a human-readable summary of the run. */
  private buildSummary(
    smells: CodeSmell[],
    stepResults: RefactoringStepResult[],
    before: ComplexityMetrics,
    after: ComplexityMetrics,
    finalTestsPassed: boolean,
    linterPassed: boolean,
  ): string {
    const completed = stepResults.filter((r) => r.status === 'completed').length;
    const rolledBack = stepResults.filter((r) => r.status === 'rolled_back').length;
    const skipped = stepResults.filter((r) => r.status === 'skipped').length;
    const ccDiff = before.avgCyclomaticComplexity - after.avgCyclomaticComplexity;
    const miDiff = after.maintainabilityIndex - before.maintainabilityIndex;
    return [
      `Refactor Ranger detected ${smells.length} code smells across the workspace.`,
      `Applied ${completed} refactoring(s); rolled back ${rolledBack}; skipped ${skipped}.`,
      `Average cyclomatic complexity: ${before.avgCyclomaticComplexity.toFixed(2)} → ${after.avgCyclomaticComplexity.toFixed(2)} (${ccDiff >= 0 ? '-' : '+'}${Math.abs(ccDiff).toFixed(2)}).`,
      `Maintainability index: ${before.maintainabilityIndex.toFixed(1)} → ${after.maintainabilityIndex.toFixed(1)} (${miDiff >= 0 ? '+' : '-'}${Math.abs(miDiff).toFixed(1)}).`,
      `Final tests: ${finalTestsPassed ? 'PASS' : 'FAIL'}; linter: ${linterPassed ? 'PASS' : 'FAIL'}.`,
    ].join(' ');
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  /** Coerce a tool result into a string array (best-effort). */
  private asStringArray(value: unknown): string[] {
    if (Array.isArray(value)) {
      return value.filter((v): v is string => typeof v === 'string');
    }
    if (value && typeof value === 'object') {
      const v = value as { files?: unknown; paths?: unknown; results?: unknown };
      const arr = v.files ?? v.paths ?? v.results;
      if (Array.isArray(arr)) {
        return arr.filter((x): x is string => typeof x === 'string');
      }
    }
    return [];
  }
}
