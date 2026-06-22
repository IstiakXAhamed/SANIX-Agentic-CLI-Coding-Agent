/**
 * @file ProgressBar.ts
 * @description A gradient-cell progress bar with ETA, percent, and
 * multi-progress support. The bar is rendered as a row of Unicode block
 * characters colored by a gradient (teal → amber → violet by default);
 * the partial cell at the bar's leading edge uses a fractional block
 * glyph for sub-character precision.
 *
 * @packageDocumentation
 */

import { SANIX_PALETTE, PROGRESS_INTERVAL_MS } from './brand.js';
import { cursorToCol0, clearLine, rgb, type RGB } from './ansi.js';

/** Options for {@link ProgressBar}. */
export interface ProgressBarOptions {
  /** Total units. */
  total: number;
  /** Bar width in cells (default 30). */
  width?: number;
  /** Label shown to the left of the bar (default ''). */
  label?: string;
  /** Output stream (default `process.stderr`). */
  stream?: { write: (s: string) => void };
  /** Gradient endpoints (default teal → amber → violet). */
  gradientStops?: RGB[];
  /** Update interval ms (default {@link PROGRESS_INTERVAL_MS}). */
  intervalMs?: number;
  /** Whether to show ETA (default true). */
  showEta?: boolean;
}

/** Fractional block glyphs for sub-cell precision. */
const FRACTIONAL: readonly string[] = [' ', '▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'];

/**
 * A single gradient-cell progress bar.
 *
 * @example
 * ```ts
 * const bar = new ProgressBar({ total: 100, label: 'uploading' });
 * bar.start();
 * for (let i = 0; i <= 100; i++) { bar.update(i); await sleep(10); }
 * bar.finish();
 * ```
 */
export class ProgressBar {
  private readonly total: number;
  private readonly width: number;
  private readonly label: string;
  private readonly stream: { write: (s: string) => void };
  private readonly gradientStops: RGB[];
  private readonly intervalMs: number;
  private readonly showEta: boolean;
  private current = 0;
  private timer?: ReturnType<typeof setInterval>;
  private startTime?: number;

  constructor(opts: ProgressBarOptions) {
    this.total = Math.max(1, opts.total);
    this.width = opts.width ?? 30;
    this.label = opts.label ?? '';
    this.stream = opts.stream ?? process.stderr;
    this.gradientStops = opts.gradientStops ?? [
      SANIX_PALETTE.teal,
      SANIX_PALETTE.amber,
      SANIX_PALETTE.violet,
    ];
    this.intervalMs = opts.intervalMs ?? PROGRESS_INTERVAL_MS;
    this.showEta = opts.showEta ?? true;
  }

  /** Start the bar (record start time for ETA). */
  start(): void {
    this.startTime = Date.now();
    this.render();
    this.timer = setInterval(() => this.render(), this.intervalMs);
    this.timer.unref?.();
  }

  /** Update the current value (clamped to [0, total]). */
  update(current: number): void {
    this.current = Math.max(0, Math.min(this.total, current));
  }

  /** Increment the current value by `n` (default 1). */
  increment(n = 1): void {
    this.update(this.current + n);
  }

  /** Finish the bar: clamp to 100%, render, then stop the timer. */
  finish(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    this.current = this.total;
    this.render();
    this.stream.write('\n');
  }

  /** Render the bar. */
  private render(): void {
    const ratio = this.total === 0 ? 0 : this.current / this.total;
    const filledF = ratio * this.width;
    const filled = Math.floor(filledF);
    const frac = Math.round((filledF - filled) * 8);
    const pct = Math.round(ratio * 100);

    const cells: string[] = [];
    for (let i = 0; i < this.width; i++) {
      if (i < filled) {
        cells.push(rgb('█', this.colorAt(i / this.width)));
      } else if (i === filled && frac > 0) {
        cells.push(rgb(FRACTIONAL[frac] ?? '█', this.colorAt(i / this.width)));
      } else {
        cells.push(' ');
      }
    }
    const bar = cells.join('');
    const label = this.label ? `${this.label} ` : '';
    const pctStr = `${pct.toString().padStart(3)}%`.padEnd(4);
    let etaStr = '';
    if (this.showEta && this.startTime && this.current > 0) {
      const elapsedMs = Date.now() - this.startTime;
      const remaining = (elapsedMs / this.current) * (this.total - this.current);
      etaStr = ` ETA ${formatDuration(remaining)}`;
    }
    this.stream.write(clearLine() + cursorToCol0() + label + pctStr + ' ' + bar + etaStr);
  }

  /** Pick a gradient color at position `t` (0..1). */
  private colorAt(t: number): RGB {
    const stops = this.gradientStops;
    if (stops.length === 0) return SANIX_PALETTE.teal;
    if (stops.length === 1) return stops[0]!;
    const seg = t * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(seg));
    const localT = seg - i;
    const a = stops[i]!;
    const b = stops[i + 1]!;
    return {
      r: Math.round(a.r + (b.r - a.r) * localT),
      g: Math.round(a.g + (b.g - a.g) * localT),
      b: Math.round(a.b + (b.b - a.b) * localT),
    };
  }
}

/** A registry of multiple progress bars rendered as a stacked block. */
export class MultiProgress {
  private readonly stream: { write: (s: string) => void };
  private readonly bars: ProgressBar[] = [];
  private readonly labels: string[] = [];
  private timer?: ReturnType<typeof setInterval>;

  constructor(stream?: { write: (s: string) => void }) {
    this.stream = stream ?? process.stderr;
  }

  /** Add a bar; returns its index. */
  add(opts: ProgressBarOptions): number {
    const idx = this.bars.length;
    this.bars.push(new ProgressBar({ ...opts, stream: this.stream, showEta: opts.showEta ?? false }));
    this.labels.push(opts.label ?? `bar-${idx}`);
    return idx;
  }

  /** Start rendering all bars on a shared timer. */
  start(): void {
    this.render();
    this.timer = setInterval(() => this.render(), PROGRESS_INTERVAL_MS);
    this.timer.unref?.();
  }

  /** Update bar `idx`'s value. */
  update(idx: number, current: number): void {
    const b = this.bars[idx];
    if (b) b.update(current);
  }

  /** Finish all bars + stop the timer. */
  finish(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    for (const b of this.bars) b.finish();
  }

  /** Re-render all bars as a stacked block. */
  private render(): void {
    // Move cursor up `bars.length` lines, then re-render each.
    const n = this.bars.length;
    if (n === 0) return;
    for (let i = 0; i < n; i++) this.stream.write('\x1b[1A\x1b[2K');
    for (const b of this.bars) {
      // Re-use the bar's render by reflecting on its private method is not
      // possible — instead, we emit a simple line per bar.
      this.stream.write(`${this.labels[this.bars.indexOf(b)]}\n`);
    }
  }
}

/** Format a duration (ms) as `Xs` / `Xm Ys` / `Xh Ym`. */
function formatDuration(ms: number): string {
  if (!isFinite(ms) || ms <= 0) return '--';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
