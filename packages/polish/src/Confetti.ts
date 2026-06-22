/**
 * @file Confetti.ts
 * @description Physics-based confetti. Each particle has a position,
 * velocity, rotation, and color; on each tick we apply gravity + drag
 * and render. The renderer writes one frame at a time to a stream and
 * uses ANSI cursor control to overlay the previous frame.
 *
 * This is best-effort terminal confetti — works great in iTerm2 /
 * modern terminals; degrades gracefully (a static burst) in others.
 *
 * @packageDocumentation
 */

import { SANIX_PALETTE } from './brand.js';
import { rgb, cursorToCol0, cursorUp, clearLine, type RGB } from './ansi.js';

/** A single confetti particle. */
interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vrot: number;
  color: RGB;
  glyph: string;
  life: number;
}

/** Options for {@link Confetti.burst}. */
export interface ConfettiOptions {
  /** Output stream (default `process.stdout`). */
  stream?: { write: (s: string) => void };
  /** Number of particles (default 60). */
  count?: number;
  /** Animation duration ms (default 1500). */
  durationMs?: number;
  /** Frame interval ms (default 33). */
  frameMs?: number;
  /** Terminal width (default `process.stdout.columns` or 80). */
  width?: number;
  /** Terminal height (default `process.stdout.rows` or 24). */
  height?: number;
  /** Glyphs to pick from (default confetti shapes). */
  glyphs?: readonly string[];
  /** Colors to pick from (default SANIX palette). */
  colors?: readonly RGB[];
  /** Gravity (cells / frame²). Default 0.15. */
  gravity?: number;
  /** Drag (per-frame velocity multiplier). Default 0.99. */
  drag?: number;
}

/**
 * Render a confetti burst.
 *
 * @example
 * ```ts
 * await Confetti.burst({ count: 80, durationMs: 2000 });
 * ```
 */
export const Confetti = {
  /**
   * @param opts See {@link ConfettiOptions}.
   */
  async burst(opts: ConfettiOptions = {}): Promise<void> {
    const stream = opts.stream ?? process.stdout;
    const count = opts.count ?? 60;
    const durationMs = opts.durationMs ?? 1500;
    const frameMs = opts.frameMs ?? 33;
    const width = opts.width ?? (() => { try { return process.stdout.columns || 80; } catch { return 80; } })();
    const height = opts.height ?? (() => { try { return process.stdout.rows || 24; } catch { return 24; } })();
    const glyphs = opts.glyphs ?? ['*', '•', '✦', '✺', '◆', '▼'];
    const colors = opts.colors ?? [SANIX_PALETTE.teal, SANIX_PALETTE.amber, SANIX_PALETTE.violet, SANIX_PALETTE.rose];
    const gravity = opts.gravity ?? 0.15;
    const drag = opts.drag ?? 0.99;

    const particles: Particle[] = [];
    const cx = Math.floor(width / 2);
    const cy = Math.floor(height / 3);
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 4 + Math.random() * 8;
      particles.push({
        x: cx,
        y: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 4,
        rot: Math.random() * Math.PI,
        vrot: (Math.random() - 0.5) * 0.4,
        color: colors[Math.floor(Math.random() * colors.length)]!,
        glyph: glyphs[Math.floor(Math.random() * glyphs.length)]!,
        life: 1,
      });
    }

    const frames = Math.ceil(durationMs / frameMs);
    for (let f = 0; f < frames; f++) {
      // Erase the previous frame (height lines).
      for (let i = 0; i < height; i++) stream.write(cursorUp(1) + clearLine());
      stream.write(cursorToCol0());
      // Render this frame into a grid.
      const grid: string[][] = Array.from({ length: height }, () => new Array<string>(width).fill(''));
      for (const p of particles) {
        p.vx *= drag;
        p.vy = p.vy * drag + gravity;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vrot;
        p.life = 1 - f / frames;
        const xi = Math.floor(p.x);
        const yi = Math.floor(p.y);
        if (yi >= 0 && yi < height && xi >= 0 && xi < width) {
          grid[yi]![xi] = rgb(p.glyph, p.color);
        }
      }
      for (let y = 0; y < height; y++) {
        stream.write(grid[y]!.join('') + '\n');
      }
      await sleep(frameMs);
    }
    // Clear the confetti at the end.
    for (let i = 0; i < height; i++) stream.write(cursorUp(1) + clearLine());
    stream.write(cursorToCol0());
  },
};

/** Promise-based sleep. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
