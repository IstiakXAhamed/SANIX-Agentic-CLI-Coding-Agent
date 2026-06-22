/**
 * @file ConversationStateTracker.ts
 * @description Explicit state machine for SANIX conversations. Rather
 * than treating the conversation as a flat `LLMMessage[]`, the tracker
 * maintains a structured view of what the agent is doing right now:
 *
 *   - the **current goal** + sub-goals completed
 *   - the **current phase** (understanding / planning / executing /
 *     reviewing / complete)
 *   - **decisions made** (so the agent stays consistent)
 *   - **facts learned** (with source + confidence)
 *   - **tools used** (with success rates)
 *   - **errors encountered** (so the agent doesn't repeat them)
 *   - **open questions** (so the agent knows what to ask the user)
 *
 * The tracker observes every message + tool result via heuristics and
 * builds a compact `[STATE]` block that the ContextBuilder injects at
 * the top of the system prompt — so the model always has a concise
 * picture of where it is in the conversation.
 *
 * ## Cycle-free
 *
 * The tracker declares a local `ToolResult`-like type so it doesn't
 * pull in `@sanix/core` (which would create a runtime cycle: core
 * imports compressor for the ContextBuilder wiring, compressor would
 * import core for the ToolResult type). TypeScript's structural typing
 * means callers can pass their `@sanix/core`-typed `ToolResult`
 * objects directly — the shapes line up.
 *
 * @packageDocumentation
 */

import type { LLMMessage, MessageContent } from '@sanix/providers';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * The conversation's current phase. Mirrors the OODA loop's mental
 * model: the agent starts by understanding the goal, plans a course
 * of action, executes the plan, reviews its progress, and either
 * completes or loops back.
 */
export type ConversationPhase =
  | 'understanding'
  | 'planning'
  | 'executing'
  | 'reviewing'
  | 'complete';

/**
 * A recorded decision (so the agent stays consistent across iterations).
 */
export interface RecordedDecision {
  /** The topic the decision pertains to (e.g. "auth approach"). */
  topic: string;
  /** The decision itself (free text). */
  decision: string;
  /** Unix-millis timestamp. */
  timestamp: number;
}

/**
 * A learned fact (with provenance + confidence).
 */
export interface LearnedFact {
  /** The fact text. */
  fact: string;
  /** Where the fact came from (tool name, file path, "user", ...). */
  source: string;
  /** 0..1 confidence score. */
  confidence: number;
}

/**
 * Per-tool usage stats. `successRate` is a running average
 * (successes / count).
 */
export interface ToolUsageStats {
  /** Number of times the tool was called. */
  count: number;
  /** Unix-millis timestamp of the most recent call. */
  lastUsed: number;
  /** Running success rate (successes / count), 0..1. */
  successRate: number;
}

/**
 * A snapshot of the conversation state. The tracker returns this from
 * {@link ConversationStateTracker.snapshot} and accepts it in
 * {@link ConversationStateTracker.merge}.
 */
export interface ConversationState {
  /** The current top-level goal, or `null` if not yet set. */
  currentGoal: string | null;
  /** Sub-goals that have been completed (in completion order). */
  completedSubGoals: string[];
  /** Open questions awaiting the user's answer. */
  pendingQuestions: string[];
  /** Decisions made so far (newest last). */
  decisionsMade: RecordedDecision[];
  /** Facts learned so far (newest last). */
  factsLearned: LearnedFact[];
  /** Per-tool usage stats (keyed by tool name). */
  toolsUsed: Record<string, ToolUsageStats>;
  /** Error messages encountered (newest last). */
  errorsEncountered: string[];
  /** The current phase. */
  currentPhase: ConversationPhase;
}

/**
 * Local minimal `ToolResult`-like type. Structurally compatible with
 * `@sanix/core`'s `ToolResult<T>` so callers can pass their typed
 * objects without an adapter. We accept `unknown` for the output
 * payload — we never inspect it.
 */
export interface ObservedToolResult {
  /** Whether the tool call succeeded. */
  success: boolean;
  /** Optional error message (present on failure). */
  error?: string;
  /** Tokens consumed (unused by the tracker but part of the shape). */
  tokensUsed?: number;
  /** Wall-clock duration (unused by the tracker but part of the shape). */
  durationMs?: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Coerce message content (string or ContentBlock[]) to plain text.
 * Image / file blocks are dropped (we only inspect text for
 * heuristic phase detection).
 */
function toText(content: MessageContent): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as { type?: string; text?: string };
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push(b.text);
    }
  }
  return parts.join('');
}

/**
 * Phrases that indicate the assistant is starting to execute (so the
 * tracker transitions to the `executing` phase).
 */
const EXECUTING_PHRASES: ReadonlyArray<string> = [
  "i'll",
  'i will',
  "let me",
  'let us',
  'next',
  'now i',
  'starting',
  'going to',
  'i am going',
  "i'm going",
];

/**
 * Phrases that indicate the assistant has completed the work (so the
 * tracker transitions to the `complete` phase).
 */
const COMPLETE_PHRASES: ReadonlyArray<string> = [
  'done',
  'complete',
  'completed',
  'finished',
  'all set',
  'task complete',
  'goal achieved',
  'finished successfully',
];

/**
 * Phrases that indicate the assistant is in the `reviewing` phase
 * (self-critique, summary, retrospective).
 */
const REVIEWING_PHRASES: ReadonlyArray<string> = [
  'review',
  'reflect',
  'looking back',
  'in summary',
  'to summarize',
  'recap',
  'retrospective',
  'critique',
];

/**
 * Phrases that indicate the assistant is in the `planning` phase.
 */
const PLANNING_PHRASES: ReadonlyArray<string> = [
  'plan',
  'plan is',
  'steps:',
  'approach:',
  'my approach',
  'first,',
  'then i',
  'after that',
  'decompose',
];

/**
 * Test whether `text` (lowercased) contains any of the phrases.
 */
function containsAny(text: string, phrases: ReadonlyArray<string>): boolean {
  return phrases.some((p) => text.includes(p));
}

/**
 * Extract a "question" from a user message: any sentence ending in `?`
 * is treated as a question. Returns the trimmed question text(s).
 */
function extractQuestions(text: string): string[] {
  const questions: string[] = [];
  // Match sentences ending in `?` (greedy on non-? chars).
  const re = /([^.!?\n]*\?)/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const q = m[1]?.trim();
    if (q && q.length > 0) questions.push(q);
  }
  return questions;
}

/**
 * Default empty state.
 */
function emptyState(): ConversationState {
  return {
    currentGoal: null,
    completedSubGoals: [],
    pendingQuestions: [],
    decisionsMade: [],
    factsLearned: [],
    toolsUsed: {},
    errorsEncountered: [],
    currentPhase: 'understanding',
  };
}

// ─── ConversationStateTracker ───────────────────────────────────────────────

/**
 * Maintains an explicit state machine for the conversation, not just a
 * message list. Observes every message + tool result via heuristics
 * and produces a compact `[STATE]` block the ContextBuilder injects
 * into the system prompt.
 *
 * @example
 * ```ts
 * import { ConversationStateTracker } from '@sanix/compressor';
 *
 * const tracker = new ConversationStateTracker();
 * tracker.observe({ role: 'user', content: 'Build me an auth module. Should I use JWT or sessions?' });
 * tracker.observeToolCall('write_file', true);
 *
 * const stateBlock = tracker.summarize();
 * // Inject `stateBlock` into the system prompt so the model knows
 * // the current goal + open questions.
 * ```
 */
export class ConversationStateTracker {
  private state: ConversationState = emptyState();
  /**
   * Cap on the number of items kept in each list-shaped field. Older
   * entries are dropped (FIFO) once the cap is hit so the state stays
   * bounded across long sessions.
   */
  private readonly maxListSize: number;

  /**
   * @param opts - Optional config.
   * @param opts.maxListSize - Cap on list-shaped fields (decisions,
   *   facts, errors, completed sub-goals, pending questions). Default
   *   50. Older entries are dropped FIFO.
   * @param opts.initialGoal - Optional initial goal (set when the
   *   tracker is constructed at the start of a run).
   */
  constructor(
    opts: { maxListSize?: number; initialGoal?: string } = {},
  ) {
    this.maxListSize = opts.maxListSize ?? 50;
    if (opts.initialGoal !== undefined) {
      this.state.currentGoal = opts.initialGoal;
    }
  }

  /**
   * Observe a new message and (optionally) the tool result that
   * followed it. Updates the state via heuristics:
   *
   *   - User message with `?` → add to pendingQuestions
   *   - User message that's not a question → if no goal is set, treat
   *     it as the goal (the first user message typically is the goal).
   *   - Assistant message containing "I'll" / "Let me" / "Next" →
   *     currentPhase = 'executing'
   *   - Assistant message containing "Done" / "Complete" / "Finished"
   *     → currentPhase = 'complete'
   *   - Assistant message containing review phrases → currentPhase =
   *     'reviewing'
   *   - Tool result with success=false → errorsEncountered
   *
   * @param message - The new LLM message.
   * @param toolResult - Optional tool result that followed the message.
   */
  observe(message: LLMMessage, toolResult?: ObservedToolResult): void {
    const text = toText(message.content).trim();
    const lower = text.toLowerCase();

    if (message.role === 'user') {
      // Extract questions.
      const questions = extractQuestions(text);
      for (const q of questions) {
        this.pushCapped(this.state.pendingQuestions, q);
      }
      // If no goal is set and the message isn't purely a question,
      // treat it as the goal.
      if (this.state.currentGoal === null && text.length > 0) {
        // Strip trailing question marks / whitespace.
        const goal = text.replace(/\?+\s*$/u, '').trim();
        if (goal.length > 0) this.state.currentGoal = goal;
      }
      // User messages typically transition out of `executing` back to
      // `understanding` (the user is providing new info / feedback).
      if (this.state.currentPhase === 'executing' || this.state.currentPhase === 'complete') {
        this.state.currentPhase = 'understanding';
      }
    } else if (message.role === 'assistant') {
      // Phase detection via phrases.
      if (containsAny(lower, COMPLETE_PHRASES)) {
        this.state.currentPhase = 'complete';
      } else if (containsAny(lower, REVIEWING_PHRASES)) {
        this.state.currentPhase = 'reviewing';
      } else if (containsAny(lower, EXECUTING_PHRASES)) {
        this.state.currentPhase = 'executing';
      } else if (containsAny(lower, PLANNING_PHRASES)) {
        this.state.currentPhase = 'planning';
      }
    } else if (message.role === 'tool' && toolResult) {
      // Tool result attached to a tool-role message.
      if (!toolResult.success && toolResult.error) {
        this.pushCapped(this.state.errorsEncountered, toolResult.error);
      }
    }

    // If a tool result was passed alongside the message, observe it
    // too (covers the case where the caller passes the tool result
    // for an assistant message that triggered a tool call).
    if (toolResult) {
      // Tool errors recorded regardless of message role.
      if (!toolResult.success && toolResult.error && message.role !== 'tool') {
        this.pushCapped(this.state.errorsEncountered, toolResult.error);
      }
    }
  }

  /**
   * Observe a tool call (independent of a message). Updates the
   * per-tool usage stats (count, lastUsed, successRate) and records
   * failures in errorsEncountered.
   *
   * @param name - The tool name.
   * @param success - Whether the call succeeded.
   */
  observeToolCall(name: string, success: boolean): void {
    const now = Date.now();
    const prev = this.state.toolsUsed[name];
    if (prev) {
      const newCount = prev.count + 1;
      // Running average: newRate = (oldRate * oldCount + outcome) / newCount.
      const newRate = (prev.successRate * prev.count + (success ? 1 : 0)) / newCount;
      this.state.toolsUsed[name] = {
        count: newCount,
        lastUsed: now,
        successRate: newRate,
      };
    } else {
      this.state.toolsUsed[name] = {
        count: 1,
        lastUsed: now,
        successRate: success ? 1 : 0,
      };
    }
  }

  /**
   * Observe a decision (so the agent stays consistent across iterations).
   *
   * @param topic - The topic the decision pertains to.
   * @param decision - The decision text.
   */
  observeDecision(topic: string, decision: string): void {
    this.pushCapped(this.state.decisionsMade, {
      topic,
      decision,
      timestamp: Date.now(),
    });
  }

  /**
   * Observe a learned fact (with provenance + confidence).
   *
   * @param fact - The fact text.
   * @param source - Where the fact came from (tool name, file path, "user", ...).
   * @param confidence - 0..1 confidence score.
   */
  observeFact(fact: string, source: string, confidence: number): void {
    const clamped = Math.max(0, Math.min(1, confidence));
    this.pushCapped(this.state.factsLearned, { fact, source, confidence: clamped });
  }

  /**
   * Mark a sub-goal as completed. Adds it to `completedSubGoals` (and
   * transitions to `reviewing` if we were `executing`).
   *
   * @param subGoal - The completed sub-goal description.
   */
  observeCompletedSubGoal(subGoal: string): void {
    this.pushCapped(this.state.completedSubGoals, subGoal);
    if (this.state.currentPhase === 'executing') {
      this.state.currentPhase = 'reviewing';
    }
  }

  /**
   * Set the current goal explicitly (overrides any goal inferred from
   * the first user message).
   *
   * @param goal - The new goal.
   */
  setGoal(goal: string): void {
    this.state.currentGoal = goal;
  }

  /**
   * Resolve a pending question (removes it from `pendingQuestions`).
   * No-op if the question wasn't pending.
   *
   * @param question - The question to resolve (must match an entry
   *   verbatim).
   */
  resolveQuestion(question: string): void {
    const idx = this.state.pendingQuestions.indexOf(question);
    if (idx >= 0) this.state.pendingQuestions.splice(idx, 1);
  }

  /**
   * Return a snapshot of the current state. The returned object is a
   * deep copy — callers can mutate it without affecting the tracker.
   */
  snapshot(): ConversationState {
    return this.cloneState(this.state);
  }

  /**
   * Render the state as a compact `[STATE]` block for injection into
   * the LLM context. Empty fields are omitted to keep the block tight.
   *
   * The block format is:
   *
   * ```
   * [STATE]
   * Goal: <currentGoal>
   * Phase: <currentPhase>
   * Completed: <completedSubGoals joined with '; '>
   * Decisions: <decisions joined with '; '>
   * Facts: <facts joined with '; '>
   * Open questions: <pendingQuestions joined with '; '>
   * Tools used: <name xN (success%)>, ...
   * [/STATE]
   * ```
   *
   * @returns The state block string. Empty when there's no goal AND
   *   no other state to report.
   *
   * @example
   * ```ts
   * const block = tracker.summarize();
   * systemPrompt += '\n\n' + block;
   * ```
   */
  summarize(): string {
    const s = this.state;
    const lines: string[] = ['[STATE]'];
    if (s.currentGoal !== null) lines.push(`Goal: ${s.currentGoal}`);
    lines.push(`Phase: ${s.currentPhase}`);
    if (s.completedSubGoals.length > 0) {
      lines.push(`Completed: ${s.completedSubGoals.join('; ')}`);
    }
    if (s.decisionsMade.length > 0) {
      const parts = s.decisionsMade.map((d) => `${d.topic}: ${d.decision}`);
      lines.push(`Decisions: ${parts.join('; ')}`);
    }
    if (s.factsLearned.length > 0) {
      const parts = s.factsLearned.map((f) => `${f.fact} (${f.source}, ${Math.round(f.confidence * 100)}%)`);
      lines.push(`Facts: ${parts.join('; ')}`);
    }
    if (s.pendingQuestions.length > 0) {
      lines.push(`Open questions: ${s.pendingQuestions.join('; ')}`);
    }
    const toolEntries = Object.entries(s.toolsUsed);
    if (toolEntries.length > 0) {
      const parts = toolEntries.map(([name, st]) => `${name} x${st.count} (${Math.round(st.successRate * 100)}%)`);
      lines.push(`Tools used: ${parts.join(', ')}`);
    }
    if (s.errorsEncountered.length > 0) {
      lines.push(`Errors: ${s.errorsEncountered.slice(-3).join('; ')}`);
    }
    lines.push('[/STATE]');
    // If only the brackets + Phase line are present (no goal, no other
    // state), return empty — there's nothing meaningful to inject.
    if (s.currentGoal === null &&
        s.completedSubGoals.length === 0 &&
        s.decisionsMade.length === 0 &&
        s.factsLearned.length === 0 &&
        s.pendingQuestions.length === 0 &&
        toolEntries.length === 0 &&
        s.errorsEncountered.length === 0) {
      return '';
    }
    return lines.join('\n');
  }

  /**
   * Serialize the state to a JSON string. Useful for checkpointing
   * the tracker alongside the agent state.
   */
  serialize(): string {
    return JSON.stringify(this.state);
  }

  /**
   * Deserialize the state from a JSON string (as produced by
   * {@link serialize}). Replaces the tracker's current state
   * entirely.
   *
   * @throws if `json` is not valid JSON or doesn't match the
   *   {@link ConversationState} shape.
   */
  deserialize(json: string): void {
    const parsed = JSON.parse(json) as unknown;
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('ConversationStateTracker.deserialize: not an object');
    }
    const obj = parsed as Record<string, unknown>;
    // Validate the required fields exist with the right types.
    if (typeof obj.currentGoal !== 'string' && obj.currentGoal !== null) {
      throw new Error('ConversationStateTracker.deserialize: invalid currentGoal');
    }
    if (!Array.isArray(obj.completedSubGoals) ||
        !Array.isArray(obj.pendingQuestions) ||
        !Array.isArray(obj.decisionsMade) ||
        !Array.isArray(obj.factsLearned) ||
        !Array.isArray(obj.errorsEncountered) ||
        typeof obj.toolsUsed !== 'object' || obj.toolsUsed === null ||
        typeof obj.currentPhase !== 'string') {
      throw new Error('ConversationStateTracker.deserialize: invalid shape');
    }
    this.state = obj as unknown as ConversationState;
  }

  /**
   * Merge another tracker's state into this one. Used when a sub-agent
   * finishes and the parent wants to fold the sub-agent's learned
   * facts / decisions / tool stats back into its own state.
   *
   * Merge rules:
   *   - `currentGoal`: kept from `this` (parent's goal wins).
   *   - `completedSubGoals`: unioned (deduplicated, this's order first).
   *   - `pendingQuestions`: unioned (deduplicated).
   *   - `decisionsMade`: concatenated (other's appended).
   *   - `factsLearned`: concatenated (other's appended).
   *   - `toolsUsed`: counts summed, success rates recomputed as
   *     weighted averages.
   *   - `errorsEncountered`: concatenated (other's appended).
   *   - `currentPhase`: kept from `this` unless `this` is `complete`
   *     and `other` is also `complete` (then `complete`); otherwise
   *     the "earlier" phase wins (understanding < planning < executing
   *     < reviewing < complete).
   *
   * @param other - The tracker to merge in.
   */
  merge(other: ConversationStateTracker): void {
    const otherState = other.snapshot();
    // Goal: keep this's goal.
    // Completed sub-goals: union.
    for (const sg of otherState.completedSubGoals) {
      if (!this.state.completedSubGoals.includes(sg)) {
        this.pushCapped(this.state.completedSubGoals, sg);
      }
    }
    // Pending questions: union.
    for (const q of otherState.pendingQuestions) {
      if (!this.state.pendingQuestions.includes(q)) {
        this.pushCapped(this.state.pendingQuestions, q);
      }
    }
    // Decisions: concatenate.
    for (const d of otherState.decisionsMade) {
      this.pushCapped(this.state.decisionsMade, d);
    }
    // Facts: concatenate.
    for (const f of otherState.factsLearned) {
      this.pushCapped(this.state.factsLearned, f);
    }
    // Errors: concatenate.
    for (const e of otherState.errorsEncountered) {
      this.pushCapped(this.state.errorsEncountered, e);
    }
    // Tools: sum counts + recompute rates.
    for (const [name, otherStats] of Object.entries(otherState.toolsUsed)) {
      const mine = this.state.toolsUsed[name];
      if (mine) {
        const newCount = mine.count + otherStats.count;
        const mySuccesses = mine.successRate * mine.count;
        const otherSuccesses = otherStats.successRate * otherStats.count;
        const newRate = (mySuccesses + otherSuccesses) / newCount;
        this.state.toolsUsed[name] = {
          count: newCount,
          lastUsed: Math.max(mine.lastUsed, otherStats.lastUsed),
          successRate: newRate,
        };
      } else {
        this.state.toolsUsed[name] = { ...otherStats };
      }
    }
    // Phase: take the earlier phase.
    this.state.currentPhase = earlierPhase(this.state.currentPhase, otherState.currentPhase);
  }

  /**
   * Reset the tracker to its initial empty state. The goal (if set
   * via the constructor's `initialGoal`) is preserved.
   *
   * @param preserveGoal - When true, `currentGoal` is kept. Default true.
   */
  reset(preserveGoal: boolean = true): void {
    const goal = preserveGoal ? this.state.currentGoal : null;
    this.state = emptyState();
    if (goal !== null) this.state.currentGoal = goal;
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  /**
   * Push an item onto a list, capping its length at {@link maxListSize}.
   * The oldest entry is dropped (FIFO).
   */
  private pushCapped<T>(list: T[], item: T): void {
    list.push(item);
    while (list.length > this.maxListSize) list.shift();
  }

  /**
   * Deep-clone a state. Used by {@link snapshot} so callers can mutate
   * the returned object without affecting the tracker.
   */
  private cloneState(s: ConversationState): ConversationState {
    return {
      currentGoal: s.currentGoal,
      completedSubGoals: [...s.completedSubGoals],
      pendingQuestions: [...s.pendingQuestions],
      decisionsMade: s.decisionsMade.map((d) => ({ ...d })),
      factsLearned: s.factsLearned.map((f) => ({ ...f })),
      toolsUsed: Object.fromEntries(
        Object.entries(s.toolsUsed).map(([k, v]) => [k, { ...v }]),
      ),
      errorsEncountered: [...s.errorsEncountered],
      currentPhase: s.currentPhase,
    };
  }
}

/**
 * Phase ordering (lower = earlier in the conversation). Used by
 * {@link ConversationStateTracker.merge} to pick the "earlier" phase.
 */
const PHASE_ORDER: Record<ConversationPhase, number> = {
  understanding: 0,
  planning: 1,
  executing: 2,
  reviewing: 3,
  complete: 4,
};

/**
 * Return the earlier of two phases.
 */
function earlierPhase(a: ConversationPhase, b: ConversationPhase): ConversationPhase {
  return PHASE_ORDER[a] <= PHASE_ORDER[b] ? a : b;
}
