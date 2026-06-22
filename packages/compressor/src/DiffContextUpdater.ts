/**
 * @file DiffContextUpdater.ts
 * @description When the context changes between agent iterations (e.g.
 * a file was edited), this module computes a minimal unified diff and
 * only sends the changed portions — instead of re-sending the whole
 * file every iteration.
 *
 * The diff is computed via the `diff` package (already a `@sanix/core`
 * dep, also declared as a `@sanix/compressor` dep here). We use
 * `structuredPatch` to get a structured hunk list (rather than the
 * raw text patch from `createPatch`) so the consumer can render the
 * diff in any format they like.
 *
 * ## Lifecycle
 *
 *   1. {@link recordSnapshot} — capture the current state of a file
 *      (or any text content) under a string id.
 *   2. {@link computeDiff} — given the same id + new content, compute
 *      a {@link DiffResult}. Returns `null` if no snapshot exists for
 *      the id or if the content is unchanged.
 *   3. {@link formatDiffAsContext} — render the diff as a unified-diff
 *      string suitable for injection into the LLM context.
 *
 * The manager keeps only the *latest* snapshot per id (no history
 * chain) — agent loops typically only need the previous iteration's
 * state to compute the delta.
 *
 * @packageDocumentation
 */

// Lazy-load `diff` (it's a CJS/ESM hybrid; we use dynamic import to
// avoid any resolution surprises at module load time).

/**
 * The minimal surface we use from the `diff` package. Declared locally
 * so this file type-checks even if the dep is missing at runtime —
 * the dynamic `import()` is wrapped in try/catch and degrades to a
 * "no diff available" result.
 */
interface DiffModule {
  structuredPatch: (
    oldFileName: string,
    newFileName: string,
    oldStr: string,
    newStr: string,
    oldHeader?: string,
    newHeader?: string,
    options?: { context?: number },
  ) => {
    oldFileName?: string;
    newFileName?: string;
    oldHeader?: string;
    newHeader?: string;
    hunks: Array<{
      oldStart: number;
      oldLines: number;
      newStart: number;
      newLines: number;
      lines: string[];
      linedelimiters?: string[];
    }>;
  };
}

let diffModule: DiffModule | null | undefined = undefined;
let diffLoadAttempted = false;

/**
 * Lazily load the `diff` package. Cached after first load; `null` if
 * unavailable.
 */
async function loadDiff(): Promise<DiffModule | null> {
  if (diffLoadAttempted) return diffModule ?? null;
  diffLoadAttempted = true;
  try {
    const mod = (await import('diff')) as Partial<DiffModule>;
    if (mod && typeof mod.structuredPatch === 'function') {
      diffModule = mod as DiffModule;
      return diffModule;
    }
    diffModule = null;
    return null;
  } catch {
    diffModule = null;
    return null;
  }
}

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * A single hunk in a unified diff. The hunk covers a contiguous range
 * of changed lines (with optional surrounding context).
 */
export interface DiffHunk {
  /** 1-based start line in the old (original) file. */
  oldStart: number;
  /** Number of lines the hunk covers in the old file. */
  oldLines: number;
  /** 1-based start line in the new (edited) file. */
  newStart: number;
  /** Number of lines the hunk covers in the new file. */
  newLines: number;
  /** The hunk's body lines, each prefixed with ` `, `+`, or `-`. */
  changes: string[];
}

/**
 * Result of {@link DiffContextUpdater.computeDiff}. Carries the
 * structured hunk list plus aggregate added/removed line counts.
 */
export interface DiffResult {
  /** The snapshot id this diff was computed against. */
  id: string;
  /** The hunks (in source order). Empty when content is unchanged. */
  hunks: DiffHunk[];
  /** Total lines added across all hunks. */
  addedLines: number;
  /** Total lines removed across all hunks. */
  removedLines: number;
}

// ─── DiffContextUpdater ─────────────────────────────────────────────────────

/**
 * Computes minimal unified diffs between successive snapshots of the
 * same content id. Used to send only the changed portions of a file
 * (or any text) to the LLM, rather than re-sending the whole thing
 * every iteration.
 *
 * @example
 * ```ts
 * import { DiffContextUpdater } from '@sanix/compressor';
 *
 * const updater = new DiffContextUpdater();
 * updater.recordSnapshot('src/auth.ts', originalSource);
 *
 * // ... user edits the file ...
 * const diff = await updater.computeDiff('src/auth.ts', newSource);
 * if (diff) {
 *   const ctx = updater.formatDiffAsContext(diff);
 *   // Inject `ctx` into the LLM context instead of the whole file.
 * }
 * ```
 */
export class DiffContextUpdater {
  /**
   * Snapshot store: id → content. Only the latest snapshot per id is
   * kept (no history chain) — agent loops typically only need the
   * previous iteration's state to compute the delta.
   */
  private readonly snapshots: Map<string, string> = new Map();

  /**
   * Number of context lines to include around each hunk. The unified
   * diff convention is 3; we use 3 by default (matches `git diff`).
   */
  private readonly contextLines: number;

  /**
   * @param opts - Optional config.
   * @param opts.contextLines - Number of context lines around each
   *   hunk. Default 3 (matches `git diff`).
   */
  constructor(opts: { contextLines?: number } = {}) {
    this.contextLines = opts.contextLines ?? 3;
  }

  /**
   * Capture the current state of a content id. Subsequent
   * {@link computeDiff} calls will diff against this snapshot.
   *
   * @param id - The snapshot id (typically the file path).
   * @param content - The content text.
   */
  recordSnapshot(id: string, content: string): void {
    this.snapshots.set(id, content);
  }

  /**
   * Compute the diff between the recorded snapshot for `id` and
   * `newContent`. Returns `null` when:
   *   - no snapshot exists for `id` (caller hasn't called
   *     {@link recordSnapshot} yet), or
   *   - the content is unchanged, or
   *   - the `diff` package isn't available at runtime.
   *
   * After computing the diff, the snapshot is *updated* to
   * `newContent` so the next {@link computeDiff} call diffs against
   * the latest state. (Pass `opts.updateSnapshot: false` to keep the
   * old snapshot — useful when you want to compute multiple diffs
   * against the same baseline.)
   *
   * @param id - The snapshot id.
   * @param newContent - The new content text.
   * @param opts - Optional config.
   * @param opts.updateSnapshot - When true (default), updates the
   *   stored snapshot to `newContent` after computing the diff.
   * @returns The {@link DiffResult}, or `null` if no diff could be
   *   computed.
   */
  async computeDiff(
    id: string,
    newContent: string,
    opts: { updateSnapshot?: boolean } = {},
  ): Promise<DiffResult | null> {
    const old = this.snapshots.get(id);
    if (old === undefined) return null;
    if (old === newContent) {
      // No changes — return an empty diff (still update the snapshot
      // so the next call is consistent, though it's a no-op).
      return { id, hunks: [], addedLines: 0, removedLines: 0 };
    }
    const diff = await loadDiff();
    if (!diff) return null;
    const patch = diff.structuredPatch(
      id,
      id,
      old,
      newContent,
      undefined,
      undefined,
      { context: this.contextLines },
    );
    const hunks: DiffHunk[] = patch.hunks.map((h) => ({
      oldStart: h.oldStart,
      oldLines: h.oldLines,
      newStart: h.newStart,
      newLines: h.newLines,
      changes: [...h.lines],
    }));
    let added = 0;
    let removed = 0;
    for (const h of hunks) {
      for (const line of h.changes) {
        if (line.startsWith('+')) added++;
        else if (line.startsWith('-')) removed++;
      }
    }
    if (opts.updateSnapshot !== false) {
      this.snapshots.set(id, newContent);
    }
    return {
      id,
      hunks,
      addedLines: added,
      removedLines: removed,
    };
  }

  /**
   * Render a {@link DiffResult} as a unified-diff string suitable for
   * injection into the LLM context. The format mirrors `git diff`:
   *
   * ```
   * --- src/auth.ts
   * +++ src/auth.ts
   * @@ -10,3 +10,5 @@
   *   context line
   * -removed line
   * +added line
   * +added line
   *   context line
   * ```
   *
   * Empty hunks (no changes) produce an empty string.
   *
   * @param diff - The {@link DiffResult} to render.
   * @returns The unified-diff string. Empty when `diff.hunks` is empty.
   */
  formatDiffAsContext(diff: DiffResult): string {
    if (diff.hunks.length === 0) return '';
    const lines: string[] = [];
    lines.push(`--- ${diff.id}`);
    lines.push(`+++ ${diff.id}`);
    for (const h of diff.hunks) {
      lines.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
      for (const change of h.changes) {
        lines.push(change);
      }
    }
    return lines.join('\n');
  }

  /**
   * Drop the snapshot for `id`. Useful when a file is deleted or no
   * longer relevant to the agent's context.
   *
   * @param id - The snapshot id to drop.
   * @returns True if a snapshot was dropped, false if none existed.
   */
  dropSnapshot(id: string): boolean {
    return this.snapshots.delete(id);
  }

  /**
   * Drop all snapshots. Useful when resetting between sessions.
   */
  clear(): void {
    this.snapshots.clear();
  }

  /** Number of snapshots currently stored. */
  get size(): number {
    return this.snapshots.size;
  }

  /**
   * Check whether a snapshot exists for `id`. Useful for callers that
   * want to decide whether to send a full file (no snapshot) or a
   * diff (snapshot exists).
   */
  hasSnapshot(id: string): boolean {
    return this.snapshots.has(id);
  }
}
