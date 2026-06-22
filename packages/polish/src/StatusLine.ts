/**
 * @file StatusLine.ts
 * @description A vim-style bottom status line. Renders a single fixed-
 * height line at the bottom of the terminal with three sections (left,
 * center, right) and a colored mode indicator. Re-renders in place via
 * ANSI cursor control.
 *
 * @packageDocumentation
 */

import { SANIX_PALETTE } from './brand.js';
import { rgb, bgRgb, bold, clearLine, cursorToCol0, type RGB } from './ansi.js';

/** Vim-style mode label. */
export type StatusMode = 'NORMAL' | 'INSERT' | 'VISUAL' | 'COMMAND' | 'WAIT';

/** Per-mode color. */
const MODE_COLOR: Readonly<Record<StatusMode, RGB>> = {
  NORMAL: SANIX_PALETTE.teal,
  INSERT: SANIX_PALETTE.amber,
  VISUAL: SANIX_PALETTE.violet,
  COMMAND: SANIX_PALETTE.rose,
  WAIT: { r: 148, g: 163, b: 184 }, // slate-400
};

/** Options for {@link StatusLine}. */
export interface StatusLineOptions {
  /** Output stream (default `process.stderr`). */
  stream?: { write: (s: string) => void };
  /** Terminal width (default `process.stdout.columns` or 80). */
  width?: number;
}

/**
 * A vim-style bottom status line.
 *
 * @example
 * ```ts
 * const sl = new StatusLine();
 * sl.render({ mode: 'NORMAL', left: 'main.ts', center: 'UTF-8', right: '12:34' });
 * ```
 */
export class StatusLine {
  private readonly stream: { write: (s: string) => void };
  private readonly width: number;

  constructor(opts: StatusLineOptions = {}) {
    this.stream = opts.stream ?? process.stderr;
    this.width = opts.width ?? (() => {
      try { return process.stdout.columns || 80; } catch { return 80; }
    })();
  }

  /**
   * Render the status line. Overwrites the previous render in place.
   *
   * @param state The status-line state.
   */
  render(state: StatusLineState): void {
    const mode = state.mode;
    const color = MODE_COLOR[mode] ?? SANIX_PALETTE.teal;
    const modeLabel = bgRgb(' ' + mode + ' ', toBgColor(color));

    const left = state.left ?? '';
    const center = state.center ?? '';
    const right = state.right ?? '';

    // Lay out: [mode] [left]  [center]  [right]
    // Total width is fixed; we pad to fill.
    const remaining = Math.max(0, this.width - visibleLen(modeLabel) - visibleLen(right));
    const leftPad = Math.max(0, remaining - visibleLen(left) - visibleLen(center));
    const centerPad = Math.max(0, Math.floor(leftPad / 2));
    const leftStr = ` ${left}${' '.repeat(centerPad)}`;
    const centerStr = center;
    const rightStr = `${' '.repeat(centerPad)}${right} `;

    const line = modeLabel + rgb(leftStr, color) + rgb(centerStr, color) + rgb(rightStr, color);
    this.stream.write(clearLine() + cursorToCol0() + line);
  }
}

/** The state passed to {@link StatusLine.render}. */
export interface StatusLineState {
  /** Vim-style mode label. */
  mode: StatusMode;
  /** Left section (e.g. current file). */
  left?: string;
  /** Center section (e.g. encoding). */
  center?: string;
  /** Right section (e.g. cursor pos / time). */
  right?: string;
}

/** Visible length of an ANSI-laden string. */
function visibleLen(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').length;
}

/** Convert a fg RGB to a bg RGB (same shape; used for bg-colored sections). */
function toBgColor(c: RGB): RGB {
  return c;
}

/** Re-export bg helper for callers that want colored sections. */
export const coloredSection = (s: string, c: RGB): string => rgb(s, c);

/** Re-export bold helper for callers that want bold sections. */
export const boldSection = (s: string): string => bold(s);
