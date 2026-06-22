/**
 * @file types.ts
 * @description Shared type definitions for `@sanix/timetravel`. Every class
 * in this package operates on the value types declared here so consumers
 * can import the shape of a timeline, snapshot, diff, or branch from a
 * single location.
 *
 * The model is intentionally minimal and serializable so timelines can be
 * persisted to disk, shipped over a network, or piped through
 * {@link TimelineVisualizer} for rendering.
 *
 * @packageDocumentation
 */

/**
 * A structured change between two snapshots. The `path` is a dotted JSON
 * pointer (e.g. `"memory.working.items[2].content"`), `oldValue`/`newValue`
 * are the JSON-serializable values before/after the change, and `kind`
 * classifies the operation.
 */
export interface DiffEntry {
  /** Dotted JSON pointer to the changed field (empty string for the root). */
  readonly path: string;
  /** Type of change applied at `path`. */
  readonly kind: DiffKind;
  /** Value before the change (absent when `kind === 'add'`). */
  readonly oldValue?: unknown;
  /** Value after the change (absent when `kind === 'remove'`). */
  readonly newValue?: unknown;
}

/** The set of operations {@link StateDiffer} can report. */
export type DiffKind = 'add' | 'remove' | 'replace' | 'reorder';

/**
 * An immutable point-in-time capture of the agent's observable state.
 *
 * Snapshots carry both a `state` payload (the JSON-serializable subject
 * under inspection) and a `metadata` bag for bookkeeping fields the
 * recorder attaches (iteration index, event label, wall clock, optional
 * parent pointer used by branches).
 */
export interface StateSnapshot {
  /** Stable unique id (nanoid). */
  readonly id: string;
  /** Monotonically increasing index inside the owning timeline. */
  readonly index: number;
  /** Wall-clock timestamp in milliseconds since the Unix epoch. */
  readonly timestamp: number;
  /** Free-form event label that triggered this snapshot (e.g. `"tool:after"`). */
  readonly event: string;
  /** The JSON-serializable state payload captured at this point. */
  readonly state: unknown;
  /** Optional parent snapshot id (set on branched timelines). */
  readonly parentId?: string;
  /** Optional short human-readable note attached by the recorder. */
  readonly note?: string;
}

/**
 * A named, ordered sequence of {@link StateSnapshot}s. Branches are
 * represented as separate timelines that reference a parent snapshot in
 * the main timeline via {@link StateSnapshot.parentId}.
 */
export interface Timeline {
  /** Stable unique id (nanoid). */
  readonly id: string;
  /** Human-readable timeline name (e.g. `"main"` or `"experiment-A"`). */
  readonly name: string;
  /** ISO timestamp of when recording started. */
  readonly startedAt: number;
  /** ISO timestamp of when recording ended (undefined while still recording). */
  readonly endedAt?: number;
  /** Ordered list of snapshots, oldest first. */
  readonly snapshots: readonly StateSnapshot[];
  /** Branch lineage: list of timeline ids from root to self. */
  readonly lineage: readonly string[];
}

/** Events emitted by {@link TimelineRecorder} and {@link TimeTravelPlayer}. */
export interface TimelineRecorderEvents {
  /** Fired when a new snapshot is appended to the timeline. */
  snapshot: (snapshot: StateSnapshot) => void;
  /** Fired when recording starts. */
  start: (timeline: Timeline) => void;
  /** Fired when recording stops. */
  stop: (timeline: Timeline) => void;
  /** Fired when the cursor moves during playback. */
  cursor: (snapshot: StateSnapshot) => void;
  /** Fired when playback reaches either end. */
  ended: (at: 'start' | 'end') => void;
}

/** Events emitted by {@link BranchExplorer}. */
export interface BranchExplorerEvents {
  /** Fired when a new branch is created. */
  branch: (branch: Timeline) => void;
  /** Fired when the active branch changes. */
  switch: (branch: Timeline) => void;
  /** Fired when a branch is merged back into its parent. */
  merge: (info: MergeInfo) => void;
}

/** Information returned from a {@link BranchExplorer.mergeBranch} call. */
export interface MergeInfo {
  /** Id of the branch that was merged. */
  readonly branchId: string;
  /** Id of the timeline the branch was merged into. */
  readonly targetId: string;
  /** Index in the target timeline where the merge was applied. */
  readonly targetIndex: number;
  /** Number of snapshots copied from the branch into the target. */
  readonly mergedCount: number;
}

/** Options accepted by {@link TimelineRecorder.start}. */
export interface RecorderOptions {
  /** Initial timeline name (defaults to `"main"`). */
  readonly name?: string;
  /** Maximum number of snapshots to retain before oldest are evicted. */
  readonly maxSnapshots?: number;
  /** Sampling function; if it returns `false` a snapshot is dropped. */
  readonly sampler?: (state: unknown, event: string) => boolean;
}

/** Options accepted by {@link TimeTravelPlayer.play}. */
export interface PlaybackOptions {
  /** Replay speed multiplier (1 = real-time, 2 = 2x, etc.). Default 1. */
  readonly speed?: number;
  /** Direction of playback. Default `'forward'`. */
  readonly direction?: 'forward' | 'backward';
  /** Maximum number of steps before auto-pausing. `0` = unlimited. */
  readonly maxSteps?: number;
}

/** Render target supported by {@link TimelineVisualizer}. */
export type VisualizerFormat = 'ascii' | 'markdown' | 'compact' | 'json';

/** Options accepted by {@link TimelineVisualizer.render}. */
export interface VisualizerOptions {
  /** Output format. Default `'ascii'`. */
  readonly format?: VisualizerFormat;
  /** Maximum number of snapshots to render (`0` = all). Default `0`. */
  readonly limit?: number;
  /** Render compact diffs under each snapshot when `true`. Default `false`. */
  readonly showDiffs?: boolean;
  /** Render absolute wall-clock timestamps when `true`. Default `false`. */
  readonly showTimestamps?: boolean;
}
