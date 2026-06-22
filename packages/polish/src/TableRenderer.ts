/**
 * @file TableRenderer.ts
 * @description A small table renderer with 4 themes: `ascii`, `rounded`,
 * `minimal`, `heavy`. Auto-sizes columns to fit content; wraps long
 * cells to a max column width.
 *
 * @packageDocumentation
 */

import { SANIX_PALETTE } from './brand.js';
import { rgb, type RGB } from './ansi.js';

/** Available table themes. */
export type TableTheme = 'ascii' | 'rounded' | 'minimal' | 'heavy';

/** Box-drawing character sets per theme. */
const THEME_CHARS: Readonly<Record<TableTheme, {
  topLeft: string; topRight: string; bottomLeft: string; bottomRight: string;
  horizontal: string; vertical: string; cross: string; leftTee: string; rightTee: string; topTee: string; bottomTee: string;
}>> = {
  ascii: { topLeft: '+', topRight: '+', bottomLeft: '+', bottomRight: '+', horizontal: '-', vertical: '|', cross: '+', leftTee: '+', rightTee: '+', topTee: '+', bottomTee: '+' },
  rounded: { topLeft: '╭', topRight: '╮', bottomLeft: '╰', bottomRight: '╯', horizontal: '─', vertical: '│', cross: '┼', leftTee: '├', rightTee: '┤', topTee: '┬', bottomTee: '┴' },
  minimal: { topLeft: ' ', topRight: ' ', bottomLeft: ' ', bottomRight: ' ', horizontal: ' ', vertical: ' ', cross: ' ', leftTee: ' ', rightTee: ' ', topTee: ' ', bottomTee: ' ' },
  heavy: { topLeft: '┏', topRight: '┓', bottomLeft: '┗', bottomRight: '┛', horizontal: '━', vertical: '┃', cross: '╋', leftTee: '┣', rightTee: '┫', topTee: '┳', bottomTee: '┻' },
};

/** Options for {@link TableRenderer.render}. */
export interface TableRenderOptions {
  /** Theme. Default `rounded`. */
  theme?: TableTheme;
  /** Max column width before wrapping (default 40). */
  maxColWidth?: number;
  /** Header color (default teal). */
  headerColor?: RGB;
  /** Output stream (default `process.stdout`). If omitted, returns string. */
  stream?: { write: (s: string) => void };
}

/** A single table row (array of cell strings). */
export type TableRow = readonly string[];

/**
 * Render a table.
 *
 * @example
 * ```ts
 * TableRenderer.render({
 *   headers: ['Name', 'Status'],
 *   rows: [['build', '✓'], ['test', '✓']],
 *   theme: 'rounded',
 * });
 * ```
 */
export const TableRenderer = {
  /**
   * @param opts.headers Column headers.
   * @param opts.rows Data rows.
   * @param opts.theme See {@link TableTheme}.
   * @param opts.maxColWidth Max column width (default 40).
   * @param opts.stream Optional output stream. If omitted, returns string.
   * @returns The rendered string (also written to `stream` if provided).
   */
  render(
    opts: { headers: readonly string[]; rows: readonly TableRow[] } & TableRenderOptions,
  ): string {
    const theme = opts.theme ?? 'rounded';
    const chars = THEME_CHARS[theme];
    const maxCol = opts.maxColWidth ?? 40;
    const headerColor = opts.headerColor ?? SANIX_PALETTE.teal;

    const nCols = opts.headers.length;
    // Compute per-column widths.
    const widths = new Array<number>(nCols).fill(0);
    for (let i = 0; i < nCols; i++) {
      widths[i] = Math.min(maxCol, opts.headers[i]!.length);
    }
    for (const row of opts.rows) {
      for (let i = 0; i < nCols; i++) {
        const v = row[i] ?? '';
        widths[i] = Math.min(maxCol, Math.max(widths[i] ?? 0, v.length));
      }
    }

    const out: string[] = [];
    const hline = (left: string, mid: string, right: string, tee: string): string => {
      const parts = widths.map((w) => chars.horizontal.repeat(w + 2));
      return left + parts.join(tee) + right;
    };

    out.push(hline(chars.topLeft, chars.topTee, chars.topRight, chars.cross));
    out.push(formatRow(opts.headers, widths, chars.vertical, headerColor));
    out.push(hline(chars.leftTee, chars.cross, chars.rightTee, chars.cross));
    for (const row of opts.rows) {
      out.push(formatRow(row, widths, chars.vertical));
    }
    out.push(hline(chars.bottomLeft, chars.bottomTee, chars.bottomRight, chars.cross));

    const text = out.join('\n');
    if (opts.stream) opts.stream.write(text + '\n');
    return text;
  },
};

/** Format a single row with vertical separators + padding. */
function formatRow(
  row: readonly string[],
  widths: readonly number[],
  vertical: string,
  color?: RGB,
): string {
  const cells: string[] = [];
  for (let i = 0; i < widths.length; i++) {
    const v = (row[i] ?? '').padEnd(widths[i]!);
    const truncated = v.length > widths[i]! ? v.slice(0, widths[i]!) : v;
    const cell = ` ${truncated} `;
    cells.push(color ? rgb(cell, color) : cell);
  }
  return vertical + cells.join(vertical) + vertical;
}
