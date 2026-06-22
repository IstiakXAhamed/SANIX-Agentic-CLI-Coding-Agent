/**
 * @file TimelineVisualizer.ts
 * @description Renders a {@link Timeline} into a human-readable string in
 * one of four formats:
 *
 *   - **`ascii`**   — A monospaced ASCII chart with one row per snapshot,
 *     a cursor marker, an event label, and a state summary. Best for
 *     terminal output.
 *   - **`markdown`** — A fenced code block containing the ASCII chart plus
 *     a Markdown table of snapshot metadata. Best for documentation.
 *   - **`compact`** — A single line per snapshot, no decorations. Best
 *     for grep-friendly logs.
 *   - **`json`**    — Pretty-printed JSON of the timeline. Best for
 *     piping into other tools.
 *
 * The visualizer can optionally include diffs between adjacent snapshots
 * (computed via {@link StateDiffer}) under each row, which is invaluable
 * for spotting exactly what changed at each step.
 *
 * @packageDocumentation
 */

import { StateDiffer } from './StateDiffer.js';
import type {
  StateSnapshot,
  Timeline,
  VisualizerFormat,
  VisualizerOptions,
} from './types.js';

/**
 * Renders a {@link Timeline} as a string in the requested format.
 *
 * ```ts
 * const viz = new TimelineVisualizer();
 * console.log(viz.render(timeline, { format: 'ascii', showDiffs: true }));
 * ```
 */
export class TimelineVisualizer {
  /** State differ used when `showDiffs` is enabled. */
  readonly differ: StateDiffer;

  /**
   * @param differ - Optional pre-configured {@link StateDiffer}. A fresh
   *                 instance is created when not supplied.
   */
  constructor(differ?: StateDiffer) {
    this.differ = differ ?? new StateDiffer();
  }

  /**
   * Render `timeline` according to `options`. See the file-level
   * documentation for the supported formats.
   *
   * @param timeline - The timeline to render.
   * @param options  - Render configuration (see {@link VisualizerOptions}).
   * @returns The rendered string.
   */
  render(timeline: Timeline, options: VisualizerOptions = {}): string {
    const format: VisualizerFormat = options.format ?? 'ascii';
    const limit = options.limit ?? 0;
    const snaps = limit > 0 ? timeline.snapshots.slice(0, limit) : timeline.snapshots;
    switch (format) {
      case 'json':
        return JSON.stringify({ ...timeline, snapshots: snaps }, null, 2);
      case 'compact':
        return this.#renderCompact(timeline, snaps, options);
      case 'markdown':
        return this.#renderMarkdown(timeline, snaps, options);
      case 'ascii':
      default:
        return this.#renderAscii(timeline, snaps, options);
    }
  }

  /**
   * Render the ASCII chart format. Each snapshot is one row:
   * ```
   *  [00] ▌ 1698247654321  iteration:before  note: "planning"
   *       └─ 2 changes (1 add, 1 replace)
   * ```
   */
  #renderAscii(
    timeline: Timeline,
    snaps: readonly StateSnapshot[],
    options: VisualizerOptions,
  ): string {
    const lines: string[] = [];
    lines.push(`╔══ Timeline: ${timeline.name} (${timeline.id}) ══╗`);
    lines.push(`║  snapshots: ${snaps.length}  started: ${new Date(timeline.startedAt).toISOString()}`);
    if (timeline.lineage.length > 0) {
      lines.push(`║  lineage: ${timeline.lineage.join(' → ')}`);
    }
    lines.push('╚═══════════════════════════════════════╝');
    for (let i = 0; i < snaps.length; i++) {
      const snap = snaps[i];
      const cursor = i === snaps.length - 1 ? '▌' : '│';
      const idx = String(i).padStart(2, '0');
      const ts = options.showTimestamps ? String(snap.timestamp) : '';
      const note = snap.note ? `  note: "${snap.note}"` : '';
      lines.push(`  [${idx}] ${cursor} ${ts}  ${snap.event}${note}`);
      if (options.showDiffs && i > 0) {
        const prev = snaps[i - 1];
        const entries = this.differ.diff(prev.state, snap.state);
        const summary = this.differ.summarize(entries);
        lines.push(`       └─ ${summary}`);
        for (const e of entries.slice(0, 5)) {
          lines.push(`          • ${e.kind.padEnd(7)} ${e.path}`);
        }
        if (entries.length > 5) {
          lines.push(`          • … and ${entries.length - 5} more`);
        }
      }
    }
    return lines.join('\n');
  }

  /**
   * Render the Markdown format: a fenced ASCII chart followed by a table
   * of snapshot metadata.
   */
  #renderMarkdown(
    timeline: Timeline,
    snaps: readonly StateSnapshot[],
    options: VisualizerOptions,
  ): string {
    const lines: string[] = [];
    lines.push(`# Timeline: ${timeline.name}`);
    lines.push('');
    lines.push(`- **id**: \`${timeline.id}\``);
    lines.push(`- **snapshots**: ${snaps.length}`);
    lines.push(`- **started**: ${new Date(timeline.startedAt).toISOString()}`);
    if (timeline.endedAt) {
      lines.push(`- **ended**: ${new Date(timeline.endedAt).toISOString()}`);
    }
    if (timeline.lineage.length > 0) {
      lines.push(`- **lineage**: ${timeline.lineage.map((l) => `\`${l}\``).join(' → ')}`);
    }
    lines.push('');
    lines.push('```');
    lines.push(this.#renderAscii(timeline, snaps, options));
    lines.push('```');
    lines.push('');
    lines.push('| # | id | event | timestamp | note |');
    lines.push('|---|----|-------|-----------|------|');
    for (let i = 0; i < snaps.length; i++) {
      const snap = snaps[i];
      const note = (snap.note ?? '').replace(/\|/g, '\\|');
      lines.push(`| ${i} | \`${snap.id}\` | ${snap.event} | ${snap.timestamp} | ${note} |`);
    }
    return lines.join('\n');
  }

  /**
   * Render the compact format: one line per snapshot, no decorations.
   */
  #renderCompact(
    _timeline: Timeline,
    snaps: readonly StateSnapshot[],
    options: VisualizerOptions,
  ): string {
    const lines: string[] = [];
    for (let i = 0; i < snaps.length; i++) {
      const snap = snaps[i];
      const ts = options.showTimestamps ? `${snap.timestamp}\t` : '';
      const note = snap.note ? `\t${snap.note}` : '';
      lines.push(`${ts}${i}\t${snap.event}\t${snap.id}${note}`);
    }
    return lines.join('\n');
  }
}
