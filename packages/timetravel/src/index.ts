/**
 * @file index.ts
 * @description Public entry point for `@sanix/timetravel`. Re-exports the
 * recorder, player, differ, branch explorer, visualizer, hook adapter,
 * and all shared types.
 *
 * Importing paths:
 * ```ts
 * import {
 *   TimelineRecorder,
 *   TimeTravelPlayer,
 *   StateDiffer,
 *   BranchExplorer,
 *   TimelineVisualizer,
 *   TimelineHook,
 * } from '@sanix/timetravel';
 * import type { Timeline, StateSnapshot, DiffEntry } from '@sanix/timetravel';
 * ```
 *
 * @packageDocumentation
 */

export { TimelineRecorder } from './TimelineRecorder.js';
export { TimeTravelPlayer } from './TimeTravelPlayer.js';
export { StateDiffer } from './StateDiffer.js';
export { BranchExplorer } from './BranchExplorer.js';
export { TimelineVisualizer } from './TimelineVisualizer.js';
export {
  TimelineHook,
  DEFAULT_TIMELINE_EVENTS,
  type HookManagerLike,
  type StateExtractor,
  type TimelineHookOptions,
} from './TimelineHook.js';

export type {
  DiffEntry,
  DiffKind,
  StateSnapshot,
  Timeline,
  TimelineRecorderEvents,
  BranchExplorerEvents,
  MergeInfo,
  RecorderOptions,
  PlaybackOptions,
  VisualizerFormat,
  VisualizerOptions,
} from './types.js';
