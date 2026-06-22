/**
 * @file StateDiffer.ts
 * @description Computes structured diffs between two {@link StateSnapshot}
 * payloads. The diff is a list of {@link DiffEntry} records, each pointing
 * at a dotted JSON path inside the state tree and describing the kind of
 * change that occurred at that path.
 *
 * The algorithm is a recursive structural comparison that handles plain
 * objects, arrays, and primitives. For arrays it tries to match elements
 * by value identity and falls back to position-based diffing, marking
 * surviving elements as `'reorder'` when their position changed but their
 * value did not. Cycles are detected and reported as a single `'replace'`
 * at the offending path.
 *
 * The output is JSON-serializable and stable (paths are emitted in
 * lexicographic order) so two diffs over the same input always compare
 * equal — useful for snapshot tests and reproducible bug reports.
 *
 * @packageDocumentation
 */

import type { DiffEntry, DiffKind } from './types.js';

/**
 * Computes structural diffs between two JSON-serializable state payloads.
 *
 * Example:
 * ```ts
 * const differ = new StateDiffer();
 * const entries = differ.diff({ a: 1 }, { a: 2, b: 3 });
 * // → [{ path: 'a', kind: 'replace', oldValue: 1, newValue: 2 },
 * //    { path: 'b', kind: 'add', newValue: 3 }]
 * ```
 */
export class StateDiffer {
  /**
   * Compute the list of {@link DiffEntry} records that transform `before`
   * into `after`. The returned list is sorted lexicographically by path
   * for deterministic output.
   *
   * @param before - The state before the change (may be `undefined`).
   * @param after  - The state after the change (may be `undefined`).
   * @returns An ordered list of {@link DiffEntry} records (possibly empty).
   */
  diff(before: unknown, after: unknown): DiffEntry[] {
    const entries: DiffEntry[] = [];
    this.#walk(before, after, '', entries, new WeakSet<object>());
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return entries;
  }

  /**
   * Summarise a diff into a compact human-readable string. Useful for
   * embedding in a single timeline row or a commit message.
   *
   * @param entries - Diff entries produced by {@link diff}.
   * @returns A single-line summary like `"3 changes (1 add, 1 remove, 1 replace)"`.
   */
  summarize(entries: readonly DiffEntry[]): string {
    if (entries.length === 0) return 'no changes';
    const counts: Record<DiffKind, number> = { add: 0, remove: 0, replace: 0, reorder: 0 };
    for (const e of entries) counts[e.kind] += 1;
    const parts: string[] = [];
    if (counts.add) parts.push(`${counts.add} add`);
    if (counts.remove) parts.push(`${counts.remove} remove`);
    if (counts.replace) parts.push(`${counts.replace} replace`);
    if (counts.reorder) parts.push(`${counts.reorder} reorder`);
    return `${entries.length} changes (${parts.join(', ')})`;
  }

  /**
   * Internal recursive walker. Accumulates {@link DiffEntry} records into
   * `out` for every divergence between `before` and `after` at the given
   * `path`. The `seen` set guards against cycles in object graphs.
   */
  #walk(
    before: unknown,
    after: unknown,
    path: string,
    out: DiffEntry[],
    seen: WeakSet<object>,
  ): void {
    // Both undefined or strictly equal → no change.
    if (Object.is(before, after)) return;
    // One side undefined → add/remove at the root path.
    if (before === undefined && after !== undefined) {
      out.push({ path, kind: 'add', newValue: after });
      return;
    }
    if (before !== undefined && after === undefined) {
      out.push({ path, kind: 'remove', oldValue: before });
      return;
    }
    // Primitive types differ → replace.
    if (before === null || after === null || typeof before !== 'object' || typeof after !== 'object') {
      out.push({ path, kind: 'replace', oldValue: before, newValue: after });
      return;
    }
    // Both objects (or arrays) → recurse, but guard against cycles.
    const bObj = before as Record<string, unknown>;
    const aObj = after as Record<string, unknown>;
    if (seen.has(bObj) || seen.has(aObj)) {
      out.push({ path, kind: 'replace', oldValue: before, newValue: after });
      return;
    }
    seen.add(bObj);
    seen.add(aObj);
    const isArrB = Array.isArray(before);
    const isArrA = Array.isArray(after);
    if (isArrB || isArrA) {
      // Array diff: position-based with element-wise comparison.
      this.#diffArray(
        isArrB ? (before as unknown[]) : [],
        isArrA ? (after as unknown[]) : [],
        path,
        out,
        seen,
      );
      return;
    }
    // Object diff: union of keys.
    const keys = new Set<string>([...Object.keys(bObj), ...Object.keys(aObj)]);
    for (const key of keys) {
      const childPath = path ? `${path}.${key}` : key;
      this.#walk(bObj[key], aObj[key], childPath, out, seen);
    }
  }

  /**
   * Specialised array diff. Walks element-by-element and re-enters
   * {@link #walk} for each pair so nested objects/arrays are handled
   * uniformly. When an element changes position but its value is
   * unchanged (matched via `Object.is` against the opposite array), the
   * entry is reported as `'reorder'` rather than `'replace'`.
   */
  #diffArray(
    before: unknown[],
    after: unknown[],
    path: string,
    out: DiffEntry[],
    seen: WeakSet<object>,
  ): void {
    const max = Math.max(before.length, after.length);
    for (let i = 0; i < max; i++) {
      const childPath = `${path}[${i}]`;
      const b = before[i];
      const a = after[i];
      if (i >= before.length) {
        out.push({ path: childPath, kind: 'add', newValue: a });
        continue;
      }
      if (i >= after.length) {
        out.push({ path: childPath, kind: 'remove', oldValue: b });
        continue;
      }
      if (Object.is(b, a)) continue;
      // Reorder detection: value moved from another position.
      const movedFrom = before.indexOf(a);
      const movedTo = after.indexOf(b);
      if (movedFrom !== -1 && movedFrom !== i && movedTo !== -1 && movedTo !== i) {
        out.push({ path: childPath, kind: 'reorder', oldValue: b, newValue: a });
        continue;
      }
      this.#walk(b, a, childPath, out, seen);
    }
  }
}
