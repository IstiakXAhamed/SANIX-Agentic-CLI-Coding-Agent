/**
 * @file AnimatedSpinner.ts
 * @description A terminal spinner with 5 SANIX-themed frame sets: dots,
 * bar, earth, moon, pulse. Each frame set is a small array of glyphs;
 * the spinner cycles through them at a fixed interval.
 *
 * The spinner writes directly to `process.stderr` (so it doesn't pollute
 * stdout if the user pipes output) and uses ANSI cursor control to
 * overwrite the previous frame in place.
 *
 * @packageDocumentation
 */

import { SANIX_PALETTE, SPINNER_INTERVAL_MS } from './brand.js';
import { cursorToCol0, clearLine, rgb, hideCursor, showCursor } from './ansi.js';

/** Available spinner frame sets. */
export type SpinnerStyle = 'dots' | 'bar' | 'earth' | 'moon' | 'pulse';

/** The 5 frame sets. */
const FRAMES: Readonly<Record<SpinnerStyle, readonly string[]>> = {
  dots: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  bar: ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█', '▇', '▆', '▅', '▄', '▃', '▂'],
  earth: ['🌍', '🌎', '🌏'],
  moon: ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'],
  pulse: ['◐', '◓', '◑', '◒'],
};

/** Default color per style. */
const STYLE_COLOR: Readonly<Record<SpinnerStyle, typeof SANIX_PALETTE.teal>> = {
  dots: SANIX_PALETTE.teal,
  bar: SANIX_PALETTE.amber,
  earth: SANIX_PALETTE.violet,
  moon: SANIX_PALETTE.rose,
  pulse: SANIX_PALETTE.teal,
};

/** Options for {@link AnimatedSpinner}. */
export interface AnimatedSpinnerOptions {
  /** Style. Default `dots`. */
  style?: SpinnerStyle;
  /** Frame interval ms. Default {@link SPINNER_INTERVAL_MS}. */
  intervalMs?: number;
  /** Output stream. Default `process.stderr`. */
  stream?: { write: (s: string) => void };
  /** Whether to hide the cursor while spinning. Default true. */
  hideCursorWhileSpinning?: boolean;
}

/**
 * An animated terminal spinner.
 *
 * @example
 * ```ts
 * const s = new AnimatedSpinner({ text: 'Loading...' });
 * s.start();
 * await longTask();
 * s.succeed('Done!');
 * ```
 */
export class AnimatedSpinner {
  private readonly style: SpinnerStyle;
  private readonly intervalMs: number;
  private readonly stream: { write: (s: string) => void };
  private readonly hideCursorWhileSpinning: boolean;
  private text: string;
  private timer?: ReturnType<typeof setInterval>;
  private frameIdx = 0;

  constructor(opts: AnimatedSpinnerOptions & { text?: string } = {}) {
    this.style = opts.style ?? 'dots';
    this.intervalMs = opts.intervalMs ?? SPINNER_INTERVAL_MS;
    this.stream = opts.stream ?? process.stderr;
    this.hideCursorWhileSpinning = opts.hideCursorWhileSpinning ?? true;
    this.text = opts.text ?? '';
  }

  /** Update the spinner's status text (without restarting it). */
  setText(text: string): void {
    this.text = text;
    if (this.timer) this.render();
  }

  /** Start spinning. */
  start(text?: string): void {
    if (text !== undefined) this.text = text;
    if (this.timer) return;
    if (this.hideCursorWhileSpinning) this.stream.write(hideCursor());
    this.frameIdx = 0;
    this.render();
    this.timer = setInterval(() => {
      this.frameIdx = (this.frameIdx + 1) % FRAMES[this.style].length;
      this.render();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  /** Stop spinning and clear the line. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.stream.write(clearLine() + cursorToCol0());
    if (this.hideCursorWhileSpinning) this.stream.write(showCursor());
  }

  /** Stop with a green check mark and `text`. */
  succeed(text?: string): void {
    this.stop();
    if (text !== undefined) this.text = text;
    this.stream.write(`${rgb('✓', { r: 45, g: 212, b: 191 })} ${this.text}\n`);
  }

  /** Stop with a red X and `text`. */
  fail(text?: string): void {
    this.stop();
    if (text !== undefined) this.text = text;
    this.stream.write(`${rgb('✗', { r: 251, g: 113, b: 133 })} ${this.text}\n`);
  }

  /** Stop with an amber warning and `text`. */
  warn(text?: string): void {
    this.stop();
    if (text !== undefined) this.text = text;
    this.stream.write(`${rgb('⚠', { r: 251, g: 191, b: 36 })} ${this.text}\n`);
  }

  /** Render the current frame. */
  private render(): void {
    const frame = FRAMES[this.style][this.frameIdx] ?? '';
    const color = STYLE_COLOR[this.style];
    this.stream.write(clearLine() + cursorToCol0() + rgb(frame, color) + ' ' + this.text);
  }
}
