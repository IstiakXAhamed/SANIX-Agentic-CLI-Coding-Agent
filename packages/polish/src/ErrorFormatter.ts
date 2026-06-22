/**
 * @file ErrorFormatter.ts
 * @description Format an error as a rounded box with the error name +
 * message + (optional) stack excerpt + (optional) suggestions. The box
 * uses Unicode box-drawing characters and the SANIX rose color for the
 * border (to signal severity).
 *
 * @packageDocumentation
 */

import { SANIX_PALETTE } from './brand.js';
import { rgb, bold, dim, stripAnsi, visibleWidth, type RGB } from './ansi.js';

/** Options for {@link ErrorFormatter.format}. */
export interface ErrorFormatterOptions {
  /** Output stream (default `process.stderr`). */
  stream?: { write: (s: string) => void };
  /** Whether to print directly (default true). If false, returns the string. */
  print?: boolean;
  /** Border color (default rose). */
  borderColor?: RGB;
  /** Max stack frames to show (default 5). */
  maxStackFrames?: number;
  /** Optional suggestions to append. */
  suggestions?: string[];
}

/**
 * Format an error as a rounded box.
 *
 * @example
 * ```ts
 * ErrorFormatter.format(new TypeError('x is undefined'), {
 *   suggestions: ['Check the value of `x` before using it.'],
 * });
 * ```
 */
export const ErrorFormatter = {
  /**
   * @param err The error.
   * @param opts See {@link ErrorFormatterOptions}.
   * @returns The formatted string (also printed unless `print: false`).
   */
  format(
    err: unknown,
    opts: ErrorFormatterOptions = {},
  ): string {
    const stream = opts.stream ?? process.stderr;
    const print = opts.print ?? true;
    const borderColor = opts.borderColor ?? SANIX_PALETTE.rose;
    const maxStack = opts.maxStackFrames ?? 5;
    const suggestions = opts.suggestions ?? [];

    const e = toErrorLike(err);
    const lines: string[] = [];
    lines.push(bold(`${e.name}: ${e.message}`));
    if (e.stack) {
      const frames = e.stack.split('\n').slice(1, 1 + maxStack);
      for (const f of frames) lines.push(dim(f.trim()));
    }
    if (suggestions.length > 0) {
      lines.push('');
      lines.push(bold('Suggested fixes:'));
      for (const s of suggestions) lines.push(`  ${rgb('→', SANIX_PALETTE.teal)} ${s}`);
    }

    const out = renderRoundedBox(lines, borderColor);
    if (print) stream.write(out + '\n');
    return out;
  },
};

/**
 * Render a list of pre-styled lines inside a rounded Unicode box.
 *
 * @param lines Pre-styled lines (may include ANSI codes).
 * @param borderColor Box border color.
 */
export function renderRoundedBox(lines: string[], borderColor: RGB = SANIX_PALETTE.rose): string {
  const innerWidth = Math.max(0, ...lines.map(visibleWidth)) + 2; // 1-col padding each side
  const top = rgb(`╭${'─'.repeat(innerWidth)}╮`, borderColor);
  const bot = rgb(`╰${'─'.repeat(innerWidth)}╯`, borderColor);
  const side = rgb('│', borderColor);
  const out: string[] = [top];
  for (const line of lines) {
    const pad = innerWidth - visibleWidth(line) - 2;
    out.push(`${side} ${line}${' '.repeat(Math.max(0, pad))} ${side}`);
  }
  out.push(bot);
  return out.join('\n');
}

/** Coerce an unknown thrown value into an Error-like shape. */
function toErrorLike(err: unknown): { name: string; message: string; stack?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message, stack: err.stack };
  if (typeof err === 'string') return { name: 'Error', message: err };
  if (err !== null && typeof err === 'object') {
    const o = err as { name?: unknown; message?: unknown; stack?: unknown };
    return {
      name: typeof o.name === 'string' ? o.name : 'Error',
      message: typeof o.message === 'string' ? o.message : JSON.stringify(err),
      stack: typeof o.stack === 'string' ? o.stack : undefined,
    };
  }
  return { name: 'Error', message: String(err) };
}

/** Visible (no ANSI) join helper for diagnostics. */
export function stripForLog(s: string): string {
  return stripAnsi(s);
}
