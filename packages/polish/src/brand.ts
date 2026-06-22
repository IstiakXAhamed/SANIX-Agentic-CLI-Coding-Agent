/**
 * @file brand.ts
 * @description The SANIX brand constants: palette, logo ASCII art, tagline,
 * and the brand-name gradient. Used by every other polish module to keep
 * the look consistent.
 *
 * @packageDocumentation
 */

import type { RGB } from './ansi.js';

/**
 * The SANIX 4-color brand palette. Calibrated for AAA contrast on a dark
 * background.
 */
export const SANIX_PALETTE: Readonly<Record<'teal' | 'amber' | 'violet' | 'rose', RGB>> = Object.freeze({
  /** Primary teal — used for the logo and active UI elements. */
  teal: { r: 45, g: 212, b: 191 }, // #2dd4bf
  /** Accent amber — used for highlights, warnings, progress. */
  amber: { r: 251, g: 191, b: 36 }, // #fbbf24
  /** Deep violet — used for secondary actions. */
  violet: { r: 167, g: 139, b: 250 }, // #a78bfa
  /** Soft rose — used for errors, destructive actions. */
  rose: { r: 251, g: 113, b: 133 }, // #fb7185
});

/**
 * The SANIX logo as multi-line ASCII art (5 lines × 41 columns).
 */
export const SANIX_LOGO: readonly string[] = Object.freeze([
  ' ███████ ███   ██  █████  ██   ██',
  ' ██      ████  ██ ██   ██ ██  ██ ',
  ' █████   ██ ██ ██ ███████ █████  ',
  ' ██      ██  ████ ██   ██ ██  ██ ',
  ' ███████ ██   ███ ██   ██ ██   ██',
]);

/** The SANIX tagline. */
export const SANIX_TAGLINE = 'Sanim\'s Agentic Neural Intelligence eXecutor';

/** The default brand-name gradient endpoints (teal → violet). */
export const SANIX_GRADIENT_FROM: RGB = SANIX_PALETTE.teal;
export const SANIX_GRADIENT_TO: RGB = SANIX_PALETTE.violet;

/** The version line shown by the onboarding wizard. */
export const SANIX_VERSION_LINE = (version: string): string => `SANIX v${version} — ${SANIX_TAGLINE}`;

/** Default spinner frame interval (ms). */
export const SPINNER_INTERVAL_MS = 80;

/** Default progress-bar update interval (ms). */
export const PROGRESS_INTERVAL_MS = 60;
