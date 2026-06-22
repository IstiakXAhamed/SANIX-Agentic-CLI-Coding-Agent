/**
 * @file TimelineRecorder.ts
 * @description Captures a stream of agent state snapshots into an
 * immutable {@link Timeline}. The recorder is the *write* side of the
 * time-travel debugger: callers call {@link TimelineRecorder.record} (or
 * {@link TimelineRecorder.checkpoint}) at well-defined points in their
 * program and the recorder appends a {@link StateSnapshot} to the
 * timeline, optionally filtering via a user-supplied sampler and evicting
 * the oldest snapshots when the timeline exceeds `maxSnapshots`.
 *
 * The recorder is fully synchronous: it does not perform I/O. Consumers
 * who want persistence can subscribe to the `'snapshot'` event and write
 * each record to disk, or call {@link TimelineRecorder.export} at the end
 * of a session to get the full {@link Timeline} object.
 *
 * @packageDocumentation
 */

import EventEmitter from 'eventemitter3';
import { nanoid } from 'nanoid';
import type {
  RecorderOptions,
  StateSnapshot,
  Timeline,
  TimelineRecorderEvents,
} from './types.js';

/**
 * Captures agent state snapshots into a {@link Timeline}.
 *
 * ```ts
 * const rec = new TimelineRecorder();
 * rec.start();
 * rec.record({ phase: 'plan' }, 'iteration:before');
 * rec.record({ phase: 'act'  }, 'iteration:after');
 * rec.stop();
 * const timeline = rec.export();
 * ```
 */
export class TimelineRecorder extends EventEmitter<TimelineRecorderEvents> {
  /** Recorded snapshots in insertion order (oldest first). */
  #snapshots: StateSnapshot[] = [];
  /** Recorder options resolved at {@link start} time. */
  #options: Required<RecorderOptions> = {
    name: 'main',
    maxSnapshots: 0,
    sampler: () => true,
  };
  /** Timeline id assigned at {@link start}. */
  #id: string = nanoid();
  /** Wall-clock timestamp captured at {@link start}. */
  #startedAt: number = 0;
  /** Wall-clock timestamp captured at {@link stop}. */
  #endedAt: number | undefined = undefined;
  /** Whether recording is currently active. */
  #recording: boolean = false;
  /** Lineage of this timeline (root branch = `[]`). */
  #lineage: string[] = [];

  /**
   * Begin recording. Subsequent calls to {@link record} will append
   * snapshots until {@link stop} is called. Calling `start` while already
   * recording is a no-op and returns the current timeline.
   *
   * @param options - Recorder configuration (see {@link RecorderOptions}).
   * @returns The timeline as it stands at the start of recording (empty).
   */
  start(options: RecorderOptions = {}): Timeline {
    if (this.#recording) return this.#snapshot();
    this.#options = {
      name: options.name ?? 'main',
      maxSnapshots: options.maxSnapshots ?? 0,
      sampler: options.sampler ?? (() => true),
    };
    this.#id = nanoid();
    this.#startedAt = Date.now();
    this.#endedAt = undefined;
    this.#snapshots = [];
    this.#recording = true;
    const timeline = this.#snapshot();
    this.emit('start', timeline);
    return timeline;
  }

  /**
   * Stop recording. The timeline is frozen (no more snapshots can be
   * appended) and the `'stop'` event is emitted. Calling `stop` while not
   * recording is a no-op.
   *
   * @returns The final frozen timeline.
   */
  stop(): Timeline {
    if (!this.#recording) return this.#snapshot();
    this.#recording = false;
    this.#endedAt = Date.now();
    const timeline = this.#snapshot();
    this.emit('stop', timeline);
    return timeline;
  }

  /**
   * Append a snapshot of `state` to the timeline. The optional `event`
   * label is recorded alongside the snapshot for filtering and display.
   * If the recorder's sampler returns `false`, the snapshot is silently
   * dropped. When `maxSnapshots > 0` and the timeline is full, the oldest
   * snapshot is evicted.
   *
   * @param state - JSON-serializable state to capture.
   * @param event - Free-form label (e.g. `"tool:after"`). Defaults to `'record'`.
   * @param note  - Optional short human-readable note.
   * @returns The appended snapshot, or `undefined` if it was filtered or
   *          recording is stopped.
   */
  record(state: unknown, event: string = 'record', note?: string): StateSnapshot | undefined {
    if (!this.#recording) return undefined;
    if (!this.#options.sampler(state, event)) return undefined;
    const snapshot: StateSnapshot = {
      id: nanoid(),
      index: this.#snapshots.length,
      timestamp: Date.now(),
      event,
      state,
      note,
    };
    this.#snapshots.push(snapshot);
    if (this.#options.maxSnapshots > 0 && this.#snapshots.length > this.#options.maxSnapshots) {
      this.#snapshots.shift();
    }
    this.emit('snapshot', snapshot);
    return snapshot;
  }

  /**
   * Convenience method that calls {@link record} with event `'checkpoint'`.
   *
   * @param state - JSON-serializable state to capture.
   * @param note  - Optional short human-readable note.
   * @returns The appended snapshot, or `undefined` if filtered.
   */
  checkpoint(state: unknown, note?: string): StateSnapshot | undefined {
    return this.record(state, 'checkpoint', note);
  }

  /**
   * Return a frozen view of the current timeline. The returned object is
   * a shallow copy; mutations to it do not affect the recorder.
   *
   * @returns The current timeline.
   */
  export(): Timeline {
    return this.#snapshot();
  }

  /** Whether the recorder is currently active. */
  get isRecording(): boolean {
    return this.#recording;
  }

  /** Number of snapshots currently held by the recorder. */
  get length(): number {
    return this.#snapshots.length;
  }

  /**
   * Internal helper that constructs a {@link Timeline} value from the
   * recorder's current state. Used by every public method that returns a
   * timeline to ensure a consistent shape.
   */
  #snapshot(): Timeline {
    return {
      id: this.#id,
      name: this.#options.name,
      startedAt: this.#startedAt,
      endedAt: this.#endedAt,
      snapshots: [...this.#snapshots],
      lineage: [...this.#lineage],
    };
  }
}
