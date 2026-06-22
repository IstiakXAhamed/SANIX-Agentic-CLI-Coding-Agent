/**
 * @file BranchExplorer.ts
 * @description Manages branches off a root {@link Timeline}. A branch is
 * just another {@link Timeline} whose snapshots reference a parent
 * snapshot in another timeline via {@link StateSnapshot.parentId}. The
 * explorer tracks the *active* branch, lets callers switch between
 * branches, and supports merging a branch back into its parent at a
 * chosen index.
 *
 * Branches are identified by nanoid and stored in an in-memory map. The
 * explorer never mutates the root timeline directly; merges produce new
 * snapshots appended to the target timeline.
 *
 * @packageDocumentation
 */

import EventEmitter from 'eventemitter3';
import { nanoid } from 'nanoid';
import type {
  BranchExplorerEvents,
  MergeInfo,
  StateSnapshot,
  Timeline,
} from './types.js';

/**
 * Manages branch creation, switching, and merging for a root timeline.
 *
 * ```ts
 * const explorer = new BranchExplorer(rootTimeline);
 * const branch = explorer.createBranch(5, 'experiment-A');
 * explorer.switchTo(branch.id);
 * explorer.mergeBranch(branch.id, 5);
 * ```
 */
export class BranchExplorer extends EventEmitter<BranchExplorerEvents> {
  /** All known timelines (root + branches) keyed by id. */
  readonly #timelines: Map<string, Timeline> = new Map();
  /** Branches keyed by id pointing at their parent timeline id. */
  readonly #parents: Map<string, string> = new Map();
  /** Currently active timeline id. */
  #activeId: string;

  /**
   * @param root - The root timeline the explorer branches off of.
   */
  constructor(root: Timeline) {
    super();
    const frozen: Timeline = { ...root, snapshots: [...root.snapshots] };
    this.#timelines.set(frozen.id, frozen);
    this.#activeId = frozen.id;
  }

  /**
   * Create a new branch off the active timeline starting at `fromIndex`.
   * The branch initially contains a single snapshot that points back to
   * the parent snapshot via `parentId`.
   *
   * @param fromIndex - Index in the parent timeline to branch from.
   * @param name      - Human-readable branch name.
   * @returns The new branch timeline.
   */
  createBranch(fromIndex: number, name: string): Timeline {
    const parent = this.#timelines.get(this.#activeId);
    if (!parent) throw new Error(`Active timeline ${this.#activeId} not found`);
    const parentSnap = parent.snapshots[fromIndex];
    if (!parentSnap) throw new Error(`Index ${fromIndex} out of range for ${parent.id}`);
    const branchId = nanoid();
    const rootSnapshot: StateSnapshot = {
      id: nanoid(),
      index: 0,
      timestamp: Date.now(),
      event: 'branch:start',
      state: parentSnap.state,
      parentId: parentSnap.id,
      note: `Branched from ${parent.name}@${fromIndex}`,
    };
    const branch: Timeline = {
      id: branchId,
      name,
      startedAt: Date.now(),
      snapshots: [rootSnapshot],
      lineage: [...parent.lineage, parent.id],
    };
    this.#timelines.set(branchId, branch);
    this.#parents.set(branchId, parent.id);
    this.emit('branch', branch);
    return branch;
  }

  /**
   * Append a new snapshot to the active branch. Mirrors the
   * {@link TimelineRecorder.record} API but operates on the explorer's
   * in-memory branch.
   *
   * @param state - JSON-serializable state.
   * @param event - Free-form event label.
   * @returns The appended snapshot.
   */
  appendToActive(state: unknown, event: string = 'record'): StateSnapshot {
    const active = this.#timelines.get(this.#activeId);
    if (!active) throw new Error(`Active timeline ${this.#activeId} not found`);
    const snaps = [...active.snapshots];
    const snap: StateSnapshot = {
      id: nanoid(),
      index: snaps.length,
      timestamp: Date.now(),
      event,
      state,
    };
    snaps.push(snap);
    const updated: Timeline = { ...active, snapshots: snaps };
    this.#timelines.set(updated.id, updated);
    return snap;
  }

  /**
   * Make `branchId` the active timeline. Subsequent calls to
   * {@link appendToActive} and {@link createBranch} operate on the new
   * active timeline.
   *
   * @param branchId - Id of the timeline to activate.
   */
  switchTo(branchId: string): void {
    const target = this.#timelines.get(branchId);
    if (!target) throw new Error(`Timeline ${branchId} not found`);
    this.#activeId = branchId;
    this.emit('switch', target);
  }

  /**
   * Merge the snapshots of `branchId` into its parent timeline at
   * `targetIndex`. The merge appends copies of every snapshot in the
   * branch (except the root pointer snapshot) to the parent timeline,
   * preserving order. The parent's snapshots are not mutated in place —
   * a new timeline value is stored.
   *
   * @param branchId    - Id of the branch to merge.
   * @param targetIndex - Index in the parent where the merge is anchored.
   *                      Must be the same index the branch was created from.
   * @returns A {@link MergeInfo} record describing the merge.
   */
  mergeBranch(branchId: string, targetIndex: number): MergeInfo {
    const branch = this.#timelines.get(branchId);
    const parentId = this.#parents.get(branchId);
    if (!branch || !parentId) throw new Error(`Branch ${branchId} not found`);
    const parent = this.#timelines.get(parentId);
    if (!parent) throw new Error(`Parent ${parentId} not found`);
    const parentSnap = parent.snapshots[targetIndex];
    if (!parentSnap) throw new Error(`Target index ${targetIndex} out of range`);
    // Skip the branch root snapshot (it just points at the parent).
    const toMerge = branch.snapshots.slice(1);
    const newSnaps = [...parent.snapshots];
    for (const snap of toMerge) {
      newSnaps.push({
        ...snap,
        id: nanoid(),
        index: newSnaps.length,
        parentId: snap.parentId,
        note: `Merged from ${branch.name}`,
      });
    }
    const updated: Timeline = { ...parent, snapshots: newSnaps };
    this.#timelines.set(parent.id, updated);
    const info: MergeInfo = {
      branchId,
      targetId: parent.id,
      targetIndex,
      mergedCount: toMerge.length,
    };
    this.emit('merge', info);
    return info;
  }

  /**
   * Return the timeline with the given id, or `undefined`.
   *
   * @param id - Timeline id.
   */
  get(id: string): Timeline | undefined {
    return this.#timelines.get(id);
  }

  /** All known timelines (root + branches), unordered. */
  listBranches(): Timeline[] {
    return [...this.#timelines.values()];
  }

  /** The currently active timeline. */
  get active(): Timeline {
    const t = this.#timelines.get(this.#activeId);
    if (!t) throw new Error('Active timeline disappeared');
    return t;
  }
}
