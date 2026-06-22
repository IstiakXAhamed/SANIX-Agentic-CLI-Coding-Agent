/**
 * @file BannerRenderer.ts
 * @description Render banners with three animation styles:
 *
 *   - `typewriter` — characters appear one at a time.
 *   - `fade`       — characters fade in via dim → normal.
 *   - `slide`      — the banner slides in from the right.
 *
 * Each animation is driven by a small async loop that writes to a stream
 * with appropriate ANSI cursor control. The renderer is awaitable and
 * resolves when the animation completes.
 *
 * @packageDocumentation
 */

import { SANIX_PALETTE } from './brand.js';
import { rgb, dim, gradient, cursorToCol0, clearLine, type RGB } from './ansi.js';

/** Animation style. */
export type BannerAnimation = 'typewriter' | 'fade' | 'slide';

/** Options for {@link BannerRenderer.render}. */
export interface BannerRenderOptions {
  /** Output stream (default `process.stdout`). */
  stream?: { write: (s: string) => void };
  /** Animation style. Default `typewriter`. */
  animation?: BannerAnimation;
  /** Per-step delay ms. Default 25. */
  stepMs?: number;
  /** Whether to color the banner (default true). */
  color?: boolean;
  /** Gradient endpoints (default teal → violet). */
  gradientFrom?: RGB;
  gradientTo?: RGB;
}

/**
 * Render animated banners.
 *
 * @example
 * ```ts
 * await BannerRenderer.render('SANIX ready', { animation: 'typewriter' });
 * ```
 */
export const BannerRenderer = {
  /**
   * Render a banner.
   *
   * @param text The banner text.
   * @param opts See {@link BannerRenderOptions}.
   */
  async render(text: string, opts: BannerRenderOptions = {}): Promise<void> {
    const stream = opts.stream ?? process.stdout;
    const animation = opts.animation ?? 'typewriter';
    const stepMs = opts.stepMs ?? 25;
    const color = opts.color ?? true;
    const from = opts.gradientFrom ?? SANIX_PALETTE.teal;
    const to = opts.gradientTo ?? SANIX_PALETTE.violet;

    const colored = color ? gradient(text, from, to) : text;
    const chars = [...text];

    if (animation === 'typewriter') {
      stream.write(cursorToCol0() + clearLine());
      for (let i = 1; i <= chars.length; i++) {
        const slice = chars.slice(0, i).join('');
        stream.write(cursorToCol0() + clearLine());
        stream.write(color ? rgb(slice, SANIX_PALETTE.teal) : slice);
        await sleep(stepMs);
      }
      stream.write('\n');
      return;
    }

    if (animation === 'fade') {
      // 3 fade steps: dim → normal → bold (final).
      stream.write(cursorToCol0() + clearLine());
      stream.write(dim(text));
      await sleep(stepMs * 4);
      stream.write(cursorToCol0() + clearLine());
      stream.write(colored);
      await sleep(stepMs * 2);
      stream.write('\n');
      return;
    }

    // slide: write one character at a time, with cursor moving from right.
    stream.write(cursorToCol0() + clearLine());
    for (let i = 0; i < chars.length; i++) {
      const slice = chars.slice(chars.length - 1 - i, chars.length).join('');
      // Pad the left so it looks like the text is sliding in from the right.
      const pad = ' '.repeat(chars.length - 1 - i);
      stream.write(cursorToCol0() + clearLine());
      stream.write(pad + (color ? rgb(slice, SANIX_PALETTE.teal) : slice));
      await sleep(stepMs);
    }
    stream.write('\n');
  },
};

/** Promise-based sleep. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
