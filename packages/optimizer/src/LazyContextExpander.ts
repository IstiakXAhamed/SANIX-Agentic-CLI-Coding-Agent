/**
 * @file LazyContextExpander.ts
 * @description Lazy context expansion. Starts with minimal context
 * (just system + current task) and expands only when the agent signals
 * it needs more — tool errors, ambiguous LLM responses, or explicit
 * "I need more context" requests.
 *
 * The expander is a stateful coordinator: it tracks which expansion
 * strategies have been tried (so it doesn't re-load the same file
 * section twice) and enforces a cooldown (won't expand more than once
 * per iteration).
 *
 * Expansion strategies (applied in order until the signal is satisfied
 * or all are exhausted):
 *   1. **Adjacent file sections** — when a tool error references a
 *      file/symbol, load the surrounding lines (±50 lines from the
 *      referenced location).
 *   2. **More memories** — re-call the memory router with a broader
 *      limit (2x the previous limit).
 *   3. **Older history** — pull in messages from before the current
 *      context window (the ones the ContextPruner dropped).
 *
 * Each strategy is a callback supplied by the caller — the expander
 * itself is transport-agnostic and doesn't know about the file system
 * or memory router.
 *
 * @packageDocumentation
 */

import type { BuiltContext } from './types.js';

/**
 * The kind of signal that triggered the expansion. The expander uses
 * the type to pick the right strategy.
 */
export type ExpansionSignalType =
  | 'tool_error'
  | 'llm_ambiguous'
  | 'llm_request_info'
  | 'retry';

/**
 * A signal from the agent loop that more context is needed.
 */
export interface ExpansionSignal {
  /** The kind of signal. */
  type: ExpansionSignalType;
  /** Free-text details (e.g. the tool error message, the LLM's
   * "I need to see the auth module" request). */
  details: string;
  /**
   * Optional iteration the signal originated from. Used by the
   * cooldown check — the expander won't fire twice in the same
   * iteration.
   */
  iteration?: number;
}

/**
 * Options for {@link LazyContextExpander.expand}. Each callback is
 * optional; absent callbacks simply skip that expansion strategy.
 */
export interface ExpansionOptions {
  /**
   * Load adjacent file sections. Called when the signal references a
   * file path or symbol. Should return the new context string to add
   * (the expander will append it to `context`). Returning an empty
   * string signals "nothing to add".
   */
  loadAdjacentSections?: (signal: ExpansionSignal) => Promise<string>;
  /**
   * Recall more memories. Should return the new memory text to append
   * to `memory`. Returning an empty string signals "no new memories".
   */
  recallMoreMemories?: (signal: ExpansionSignal) => Promise<string>;
  /**
   * Pull in older history messages. Should return additional messages
   * to prepend to `history` (in chronological order).
   */
  recallOlderHistory?: (signal: ExpansionSignal) => Promise<import('@sanix/providers').LLMMessage[]>;
  /**
   * Maximum number of expansions per session. Once this is reached,
   * `shouldExpand` returns false and `expand` returns the input
   * unchanged. Default 5.
   */
  maxExpansions?: number;
  /**
   * Cooldown in milliseconds. After an expansion, subsequent
   * `shouldExpand` calls within this window return false. Default
   * 0 (cooldown is per-iteration, not per-wall-clock).
   */
  cooldownMs?: number;
}

/**
 * Patterns that indicate the signal details reference a file path or
 * symbol — used to decide whether {@link loadAdjacentSections} is
 * worth calling.
 */
const FILE_PATH_SIGNAL = /(?:at\s+)?(?:[./][^\s:]+|[A-Za-z_][\w-]*\.[a-z]{1,5}):(\d+)/;

/**
 * Patterns that indicate the LLM is explicitly asking for more
 * information (vs. just being ambiguous).
 */
const REQUEST_INFO_SIGNAL =
  /\b(?:need|missing|require|want)\s+(?:more\s+)?(?:context|info|information|details|files?|history)\b/i;

/**
 * Lazy context expander.
 *
 * @example
 * ```ts
 * const expander = new LazyContextExpander();
 * // ... agent loop iteration ...
 * const signal = { type: 'tool_error', details: 'at src/auth.ts:42' };
 * if (expander.shouldExpand(signal)) {
 *   const expanded = await expander.expand(ctx, signal, {
 *     loadAdjacentSections: async (s) => loadFileAround(s.details),
 *   });
 *   // use expanded context for the next LLM call
 * }
 * ```
 */
export class LazyContextExpander {
  /** Total expansions performed so far this session. */
  private expansionCount = 0;
  /** Iteration of the last expansion (for cooldown). */
  private lastExpansionIteration = -1;
  /** Wall-clock time of the last expansion (for cooldownMs). */
  private lastExpansionTime = 0;
  /** Strategies already tried for the current signal (dedupe). */
  private triedStrategies: Set<string> = new Set();

  /**
   * Decide whether to expand based on the signal + cooldown state.
   * Returns `false` if:
   *   - The signal type is `retry` (retries should not trigger
   *     expansion — they're a transport-level concern).
   *   - We've already expanded in this iteration.
   *   - We've hit `maxExpansions`.
   *   - We're inside the cooldown window.
   *
   * @example
   * ```ts
   * if (expander.shouldExpand(signal)) {
   *   ctx = await expander.expand(ctx, signal, opts);
   * }
   * ```
   */
  shouldExpand(signal: ExpansionSignal, opts: ExpansionOptions = {}): boolean {
    // `retry` signals are transport-level (e.g. provider rate-limit
    // retry) — they don't indicate a context problem.
    if (signal.type === 'retry') return false;

    const maxExpansions = opts.maxExpansions ?? 5;
    if (this.expansionCount >= maxExpansions) return false;

    // Per-iteration cooldown: don't expand twice in the same iteration.
    if (
      signal.iteration !== undefined &&
      signal.iteration === this.lastExpansionIteration
    ) {
      return false;
    }

    // Wall-clock cooldown (default 0 = disabled).
    const cooldownMs = opts.cooldownMs ?? 0;
    if (cooldownMs > 0 && Date.now() - this.lastExpansionTime < cooldownMs) {
      return false;
    }

    // For `llm_ambiguous` signals, only expand if the details actually
    // mention needing context (avoids expanding on every uncertain
    // response).
    if (signal.type === 'llm_ambiguous' && !REQUEST_INFO_SIGNAL.test(signal.details)) {
      return false;
    }

    return true;
  }

  /**
   * Expand the context per the signal. Tries each strategy in order;
   * the first that yields new content wins (we don't pile on multiple
   * expansions for a single signal — that would bloat the context).
   *
   * If no strategy yields new content, returns the input unchanged.
   *
   * @param current The current built context.
   * @param signal The expansion signal.
   * @param opts Strategy callbacks + limits.
   * @returns A new {@link BuiltContext} (the input is not mutated).
   */
  async expand(
    current: BuiltContext,
    signal: ExpansionSignal,
    opts: ExpansionOptions = {},
  ): Promise<BuiltContext> {
    // Strategy 1: adjacent file sections. Only try if the signal
    // references a file/symbol.
    if (
      opts.loadAdjacentSections &&
      !this.triedStrategies.has('adjacent') &&
      FILE_PATH_SIGNAL.test(signal.details)
    ) {
      this.triedStrategies.add('adjacent');
      try {
        const extra = await opts.loadAdjacentSections(signal);
        if (extra.trim().length > 0) {
          this.recordExpansion(signal);
          return {
            ...current,
            context: current.context
              ? `${current.context}\n\n--- Expanded: adjacent sections ---\n${extra}`
              : extra,
          };
        }
      } catch {
        // Strategy failed; fall through to the next.
      }
    }

    // Strategy 2: more memories.
    if (
      opts.recallMoreMemories &&
      !this.triedStrategies.has('memories')
    ) {
      this.triedStrategies.add('memories');
      try {
        const extra = await opts.recallMoreMemories(signal);
        if (extra.trim().length > 0) {
          this.recordExpansion(signal);
          return {
            ...current,
            memory: current.memory
              ? `${current.memory}\n\n--- Expanded: more memories ---\n${extra}`
              : extra,
          };
        }
      } catch {
        // fall through
      }
    }

    // Strategy 3: older history.
    if (
      opts.recallOlderHistory &&
      !this.triedStrategies.has('history')
    ) {
      this.triedStrategies.add('history');
      try {
        const extra = await opts.recallOlderHistory(signal);
        if (extra.length > 0) {
          this.recordExpansion(signal);
          return {
            ...current,
            // Prepend older history to the existing history.
            history: [...extra, ...current.history],
          };
        }
      } catch {
        // fall through
      }
    }

    // No strategy yielded new content — return unchanged.
    return current;
  }

  /**
   * Record that an expansion happened (bumps the count + sets the
   * cooldown markers).
   */
  private recordExpansion(signal: ExpansionSignal): void {
    this.expansionCount++;
    if (signal.iteration !== undefined) {
      this.lastExpansionIteration = signal.iteration;
    }
    this.lastExpansionTime = Date.now();
  }

  /**
   * Reset the tried-strategies set. Called automatically when a new
   * signal arrives (so each signal gets a fresh strategy attempt).
   * Callers can also invoke this manually (e.g. between sessions).
   */
  resetStrategies(): void {
    this.triedStrategies.clear();
  }

  /**
   * Total expansions performed so far this session.
   */
  get totalExpansions(): number {
    return this.expansionCount;
  }

  /**
   * The iteration of the last expansion (or -1 if none).
   */
  get lastExpansionAt(): number {
    return this.lastExpansionIteration;
  }

  /**
   * Full reset: count, cooldowns, and tried strategies.
   */
  reset(): void {
    this.expansionCount = 0;
    this.lastExpansionIteration = -1;
    this.lastExpansionTime = 0;
    this.triedStrategies.clear();
  }
}
