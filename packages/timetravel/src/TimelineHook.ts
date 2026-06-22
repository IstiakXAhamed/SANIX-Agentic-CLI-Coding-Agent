/**
 * @file TimelineHook.ts
 * @description Adapts the SANIX core {@link HookManager} event stream into
 * a {@link TimelineRecorder} so agent runs can be recorded for time-travel
 * debugging with zero changes to the agent itself.
 *
 * The hook listens to a configurable subset of well-known hook events
 * (`'iteration:before'`, `'iteration:after'`, `'tool:before'`,
 * `'tool:after'`, `'plan:created'`, `'plan:revised'`, `'error'`) and
 * appends a snapshot of the agent state carried in the hook context to
 * the recorder. The agent state is extracted via a pluggable
 * {@link StateExtractor} so callers can decide what to capture (full
 * state, diff-only, masked secrets, etc.).
 *
 * The hook is *passive*: it never vetoes or modifies the agent flow. It
 * only observes.
 *
 * @packageDocumentation
 */

import type { TimelineRecorder } from './TimelineRecorder.js';
import type { Timeline } from './types.js';

/**
 * Minimal structural interface that any SANIX hook manager must satisfy
 * for {@link TimelineHook} to subscribe to it. Modeled after
 * `@sanix/core`'s `HookManager` but kept structural so this package has
 * no hard dependency on `@sanix/core`.
 */
export interface HookManagerLike {
  /** Register a handler for a named hook event. Returns an unsubscribe function. */
  on(event: string, handler: (ctx: unknown) => unknown): () => void;
}

/**
 * Function that extracts a JSON-serializable state value from the
 * SANIX hook context. The default extractor returns the entire context
 * (assuming it is already serializable); callers can supply a custom
 * extractor to mask sensitive fields or project to a smaller shape.
 */
export type StateExtractor = (ctx: unknown, event: string) => unknown;

/** Options accepted by {@link TimelineHook.install}. */
export interface TimelineHookOptions {
  /** Hook events to record. Defaults to the well-known lifecycle events. */
  readonly events?: readonly string[];
  /** State extractor (see {@link StateExtractor}). */
  readonly extract?: StateExtractor;
}

/** Default events recorded by {@link TimelineHook}. */
export const DEFAULT_TIMELINE_EVENTS: readonly string[] = [
  'iteration:before',
  'iteration:after',
  'tool:before',
  'tool:after',
  'plan:created',
  'plan:revised',
  'error',
];

/**
 * Hook adapter that records agent state into a {@link TimelineRecorder}.
 *
 * ```ts
 * const recorder = new TimelineRecorder();
 * const hook = new TimelineHook(recorder);
 * hook.install(hookManager);  // start recording
 * // … agent runs …
 * hook.uninstall();
 * const timeline = recorder.export();
 * ```
 */
export class TimelineHook {
  /** The recorder this hook feeds. */
  readonly recorder: TimelineRecorder;
  /** Configured options resolved at install time. */
  #options: Required<TimelineHookOptions> = {
    events: DEFAULT_TIMELINE_EVENTS,
    extract: (ctx) => ctx,
  };
  /** Active unsubscribe callbacks, one per subscribed event. */
  #unsubs: Array<() => void> = [];

  /**
   * @param recorder - The recorder to feed.
   */
  constructor(recorder: TimelineRecorder) {
    this.recorder = recorder;
  }

  /**
   * Subscribe to the hook manager and begin recording. Calls
   * {@link TimelineRecorder.start} on the underlying recorder.
   *
   * @param hookManager - The hook manager to subscribe to.
   * @param options     - Hook configuration (see {@link TimelineHookOptions}).
   * @returns The timeline as it stands at the start of recording.
   */
  install(hookManager: HookManagerLike, options: TimelineHookOptions = {}): Timeline {
    this.uninstall();
    this.#options = {
      events: options.events ?? DEFAULT_TIMELINE_EVENTS,
      extract: options.extract ?? ((ctx) => ctx),
    };
    const timeline = this.recorder.start({ name: 'agent-timeline' });
    for (const event of this.#options.events) {
      const unsub = hookManager.on(event, (ctx) => {
        try {
          const state = this.#options.extract(ctx, event);
          this.recorder.record(state, event);
        } catch {
          // Hook errors must never break the agent — swallow and continue.
        }
      });
      this.#unsubs.push(unsub);
    }
    return timeline;
  }

  /**
   * Unsubscribe from the hook manager and stop recording. Safe to call
   * multiple times.
   */
  uninstall(): void {
    for (const unsub of this.#unsubs) {
      try {
        unsub();
      } catch {
        // ignore
      }
    }
    this.#unsubs = [];
    if (this.recorder.isRecording) {
      this.recorder.stop();
    }
  }

  /** Convenience accessor for the events currently being recorded. */
  get events(): readonly string[] {
    return this.#options.events;
  }
}
