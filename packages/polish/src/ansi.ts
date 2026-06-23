/**
 * @file ansi.ts
 * @description Tiny ANSI escape-sequence helpers. We deliberately avoid
 * pulling in `chalk` / `kleur` / `picocolors` — the SANIX brand has a
 * fixed 4-color palette and a small set of styles, so a hand-rolled
 * helper is both smaller and dependency-free.
 *
 * Detects TTY automatically; non-TTY streams get plain text (no escapes).
 *
 * @packageDocumentation
 */

/** A 24-bit RGB color. */
export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** Common ANSI SGR codes. */
const enum SGR {
  Reset = 0,
  Bold = 1,
  Dim = 2,
  Italic = 3,
  Underline = 4,
  Inverse = 7,
  FgBlack = 30,
  FgRed = 31,
  FgGreen = 32,
  FgYellow = 33,
  FgBlue = 34,
  FgMagenta = 35,
  FgCyan = 36,
  FgWhite = 37,
  FgDefault = 39,
  BgBlack = 40,
  BgRed = 41,
  BgGreen = 42,
  BgYellow = 43,
  BgBlue = 44,
  BgMagenta = 45,
  BgCyan = 46,
  BgWhite = 47,
  BgDefault = 49,
}

/** Whether ANSI colors are enabled. Defaults to TTY detection. */
let colorEnabled: boolean = (() => {
  try {
    return !!process.stdout?.isTTY;
  } catch {
    return false;
  }
})();

/** Globally enable / disable ANSI colors. */
export function setColorEnabled(v: boolean): void {
  colorEnabled = v;
}

/** Whether ANSI colors are currently enabled. */
export function isColorEnabled(): boolean {
  return colorEnabled;
}

/** Wrap `s` in SGR escape codes (or return as-is when disabled). */
function wrap(s: string, ...codes: number[]): string {
  if (!colorEnabled || codes.length === 0) return s;
  return `\x1b[${codes.join(';')}m${s}\x1b[${SGR.Reset}m`;
}

// ── Styles ────────────────────────────────────────────────────────────────

/** Apply bold. */
export const bold = (s: string): string => wrap(s, SGR.Bold);
/** Apply dim. */
export const dim = (s: string): string => wrap(s, SGR.Dim);
/** Apply italic. */
export const italic = (s: string): string => wrap(s, SGR.Italic);
/** Apply underline. */
export const underline = (s: string): string => wrap(s, SGR.Underline);
/** Apply inverse (swap fg + bg). */
export const inverse = (s: string): string => wrap(s, SGR.Inverse);

// ── 16-color fg / bg ──────────────────────────────────────────────────────

/** Foreground color helpers (16-color). */
export const fg = {
  black: (s: string): string => wrap(s, SGR.FgBlack),
  red: (s: string): string => wrap(s, SGR.FgRed),
  green: (s: string): string => wrap(s, SGR.FgGreen),
  yellow: (s: string): string => wrap(s, SGR.FgYellow),
  blue: (s: string): string => wrap(s, SGR.FgBlue),
  magenta: (s: string): string => wrap(s, SGR.FgMagenta),
  cyan: (s: string): string => wrap(s, SGR.FgCyan),
  white: (s: string): string => wrap(s, SGR.FgWhite),
  default: (s: string): string => wrap(s, SGR.FgDefault),
} as const;

/** Background color helpers (16-color). */
export const bg = {
  black: (s: string): string => wrap(s, SGR.BgBlack),
  red: (s: string): string => wrap(s, SGR.BgRed),
  green: (s: string): string => wrap(s, SGR.BgGreen),
  yellow: (s: string): string => wrap(s, SGR.BgYellow),
  blue: (s: string): string => wrap(s, SGR.BgBlue),
  magenta: (s: string): string => wrap(s, SGR.BgMagenta),
  cyan: (s: string): string => wrap(s, SGR.BgCyan),
  white: (s: string): string => wrap(s, SGR.BgWhite),
  default: (s: string): string => wrap(s, SGR.BgDefault),
} as const;

// ── 24-bit RGB fg / bg ────────────────────────────────────────────────────

/** Apply a 24-bit RGB foreground color. */
export function rgb(s: string, c: RGB): string {
  if (!colorEnabled) return s;
  return `\x1b[38;2;${c.r};${c.g};${c.b}m${s}\x1b[${SGR.Reset}m`;
}

/** Apply a 24-bit RGB background color. */
export function bgRgb(s: string, c: RGB): string {
  if (!colorEnabled) return s;
  return `\x1b[48;2;${c.r};${c.g};${c.b}m${s}\x1b[${SGR.Reset}m`;
}

/** Apply a linear-gradient approximation by per-character RGB. */
export function gradient(s: string, from: RGB, to: RGB): string {
  if (!colorEnabled) return s;
  const chars = [...s];
  const n = chars.length;
  if (n === 0) return '';
  return chars
    .map((ch, i) => {
      const t = n === 1 ? 0 : i / (n - 1);
      const c: RGB = {
        r: Math.round(from.r + (to.r - from.r) * t),
        g: Math.round(from.g + (to.g - from.g) * t),
        b: Math.round(from.b + (to.b - from.b) * t),
      };
      return rgb(ch, c);
    })
    .join('');
}

// ── Cursor / screen control ───────────────────────────────────────────────

/** Move cursor up `n` lines. */
export const cursorUp = (n = 1): string => `\x1b[${n}A`;
/** Move cursor down `n` lines. */
export const cursorDown = (n = 1): string => `\x1b[${n}B`;
/** Move cursor right `n` columns. */
export const cursorRight = (n = 1): string => `\x1b[${n}C`;
/** Move cursor left `n` columns. */
export const cursorLeft = (n = 1): string => `\x1b[${n}D`;
/** Clear the current line. */
export const clearLine = (): string => '\x1b[2K';
/** Clear from cursor to end of line. */
export const clearToEnd = (): string => '\x1b[0K';
/** Move cursor to column 0 of the current line. */
export const cursorToCol0 = (): string => '\x1b[0G';
/** Hide the cursor. */
export const hideCursor = (): string => '\x1b[?25l';
/** Show the cursor. */
export const showCursor = (): string => '\x1b[?25h';
/** Save cursor position. */
export const saveCursor = (): string => '\x1b7';
/** Restore cursor position. */
export const restoreCursor = (): string => '\x1b8';
/** Clear the entire screen and move cursor to (0,0). */
export const clearScreen = (): string => '\x1b[2J\x1b[H';

/**
 * Strip all ANSI escape sequences from a string (e.g. for log files).
 *
 * @param s The input string.
 */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

// ── Glow / breathing helpers ──────────────────────────────────────────────

/**
 * Apply a "bright" version of an RGB color (moves toward white by 40%).
 * Useful for glow/pulse effects where we alternate between normal and bright.
 */
export function brightRgb(c: RGB): RGB {
  return {
    r: Math.min(255, Math.round(c.r + (255 - c.r) * 0.4)),
    g: Math.min(255, Math.round(c.g + (255 - c.g) * 0.4)),
    b: Math.min(255, Math.round(c.b + (255 - c.b) * 0.4)),
  };
}

/**
 * Apply a "dim" version of an RGB color (moves toward black by 50%).
 */
export function dimRgb(c: RGB): RGB {
  return {
    r: Math.round(c.r * 0.5),
    g: Math.round(c.g * 0.5),
    b: Math.round(c.b * 0.5),
  };
}

/**
 * Render text with a "glowing" effect by applying bold + bright color
 * (creates the illusion of glow in the terminal).
 *
 * @param s   The text to render.
 * @param c   The base RGB color.
 * @returns   ANSI-escaped text with bold + bright color.
 */
export function glow(s: string, c: RGB): string {
  if (!colorEnabled) return s;
  const bright = brightRgb(c);
  return `\x1b[1m\x1b[38;2;${bright.r};${bright.g};${bright.b}m${s}\x1b[${SGR.Reset}m`;
}

/**
 * Breathing modes for the text glow animation.
 * - 'in'  : bright/bold (inhale — visible)
 * - 'out' : dim/normal (exhale — faded)
 * - 'hold': normal (neutral)
 */
export type BreathPhase = 'in' | 'out' | 'hold';

/**
 * Apply a breathing glow to text based on the current phase.
 * `in` → bright + bold, `hold` → normal color, `out` → dim color.
 *
 * @param s     The text.
 * @param c     The base RGB color.
 * @param phase Current breathing phase.
 */
export function breathe(s: string, c: RGB, phase: BreathPhase): string {
  if (!colorEnabled || phase === 'hold') return rgb(s, c);
  if (phase === 'in') return glow(s, c);
  return rgb(s, dimRgb(c));
}

/**
 * A small string that acts as a visual "pulse" indicator (3 dots).
 * When `phase` is `in`, dots are bold; when `out`, they're dim.
 */
export function breathDots(c: RGB, phase: BreathPhase): string {
  return breathe('···', c, phase);
}

/** Visible width of a string, ignoring ANSI escapes and combining marks. */
export function visibleWidth(s: string): number {
  return [...stripAnsi(s)].length;
}
