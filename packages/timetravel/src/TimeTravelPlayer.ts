/**
 * @file TimeTravelPlayer.ts
 * @description Plays back a recorded {@link Timeline} forward or backward
 * at a configurable speed. The player is the *read* side of the
 * time-travel debugger: it holds a cursor, exposes step/play/pause/goto
 * operations, and emits `'cursor'` events as the cursor moves so
 * observers can re-render their UI against the snapshot at the cursor.
 *
 * Playback is driven by a `setInterval` timer; speed multipliers are
 * implemented by scaling the interval duration (`1000ms / speed`).
 *
 * @packageDocumentation
 */

import EventEmitter from 'eventemitter3';
import type {
  PlaybackOptions,
  StateSnapshot,
  Timeline,
  TimelineRecorderEvents,
} from './types.js';

/**
 * Plays back a {@link Timeline} forward or backward.
 *
 * ```ts
 * const player = new TimeTravelPlayer(timeline);
 * player.on('cursor', (snap) => render(snap.state));
 * player.goto(10);            // jump to index 10
 * player.play({ speed: 2 });  // 2x forward playback
 * ```
 */
export class TimeTravelPlayer extends EventEmitter<TimelineRecorderEvents> {
  /** The timeline being played back. */
  readonly timeline: Timeline;
  /** Current cursor position (index into `timeline.snapshots`). */
  #cursor: number = 0;
  /** Active playback timer handle, or `null` when paused. */
  #timer: ReturnType<typeof setInterval> | null = null;
  /** Resolved playback options for the current playback run. */
  #playback: Required<PlaybackOptions> = {
    speed: 1,
    direction: 'forward',
    maxSteps: 0,
  };
  /** Number of steps taken since the current playback started. */
  #stepsTaken: number = 0;

  /**
   * @param timeline - The timeline to play back. A defensive copy is made
   *                   so mutations to the source after construction do not
   *                   affect the player.
   */
  constructor(timeline: Timeline) {
    super();
    this.timeline = {
      ...timeline,
      snapshots: [...timeline.snapshots],
    };
  }

  /**
   * Move the cursor to the snapshot at `index`. Emits a `'cursor'` event
   * with the new snapshot. Out-of-range indices are clamped to `[0, length-1]`.
   *
   * @param index - Target snapshot index.
   * @returns The snapshot at the new cursor, or `undefined` if the timeline is empty.
   */
  goto(index: number): StateSnapshot | undefined {
    const clamped = Math.max(0, Math.min(index, this.timeline.snapshots.length - 1));
    this.#cursor = clamped;
    const snap = this.timeline.snapshots[clamped];
    if (snap) this.emit('cursor', snap);
    return snap;
  }

  /**
   * Advance the cursor by one snapshot in the forward direction. Emits
   * `'cursor'` and, if at the end, `'ended'` with `at: 'end'`.
   *
   * @returns The snapshot at the new cursor, or `undefined` if at the end.
   */
  stepForward(): StateSnapshot | undefined {
    if (this.#cursor >= this.timeline.snapshots.length - 1) {
      this.emit('ended', 'end');
      return undefined;
    }
    return this.goto(this.#cursor + 1);
  }

  /**
   * Move the cursor back by one snapshot. Emits `'cursor'` and, if at
   * the start, `'ended'` with `at: 'start'`.
   *
   * @returns The snapshot at the new cursor, or `undefined` if at the start.
   */
  stepBackward(): StateSnapshot | undefined {
    if (this.#cursor <= 0) {
      this.emit('ended', 'start');
      return undefined;
    }
    return this.goto(this.#cursor - 1);
  }

  /**
   * Begin automatic playback. The cursor advances every
   * `1000 / speed` milliseconds in the configured direction until
   * `maxSteps` is reached or the timeline ends. Calling `play` while
   * already playing resets the timer with the new options.
   *
   * @param options - Playback configuration (see {@link PlaybackOptions}).
   */
  play(options: PlaybackOptions = {}): void {
    this.pause();
    this.#playback = {
      speed: options.speed ?? 1,
      direction: options.direction ?? 'forward',
      maxSteps: options.maxSteps ?? 0,
    };
    this.#stepsTaken = 0;
    if (this.timeline.snapshots.length === 0) return;
    const intervalMs = Math.max(1, Math.floor(1000 / this.#playback.speed));
    this.#timer = setInterval(() => this.#tick(), intervalMs);
  }

  /** Stop automatic playback. The cursor stays at its current position. */
  pause(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /** Whether playback is currently active. */
  get isPlaying(): boolean {
    return this.#timer !== null;
  }

  /** Current cursor index. */
  get cursor(): number {
    return this.#cursor;
  }

  /** Snapshot at the current cursor, or `undefined` if the timeline is empty. */
  getCurrentSnapshot(): StateSnapshot | undefined {
    return this.timeline.snapshots[this.#cursor];
  }

  /** Internal playback tick: advances the cursor by one step. */
  #tick(): void {
    if (this.#playback.maxSteps > 0 && this.#stepsTaken >= this.#playback.maxSteps) {
      this.pause();
      return;
    }
    this.#stepsTaken += 1;
    if (this.#playback.direction === 'forward') {
      const snap = this.stepForward();
      if (!snap) this.pause();
    } else {
      const snap = this.stepBackward();
      if (!snap) this.pause();
    }
  }
}
