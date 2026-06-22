/**
 * @file logo.ts
 * @description The SANIX ASCII logo + chalk-colored `printLogo()` helper.
 *
 * The logo is taken verbatim from the brand-identity section of the spec:
 *
 * ```
 *  ███████╗ █████╗ ███╗   ██╗██╗██╗  ██╗
 *  ██╔════╝██╔══██╗████╗  ██║██║╚██╗██╔╝
 *  ███████╗███████║██╔██╗ ██║██║ ╚███╔╝
 *  ╚════██║██╔══██║██║╚██╗██║██║ ██╔██╗
 *  ███████║██║  ██║██║ ╚████║██║██╔╝ ██╗
 *  ╚══════╝╚═╝  ╚═╝╚═╝  ╚═══╝╚═╝╚═╝  ╚═╝
 *  Agentic Neural Intelligence eXecutor
 *  by Istiak Ahamed • v1.0.0
 * ```
 *
 * Colors per spec:
 *  - Primary accent: `#00D4FF` (electric cyan — "the signal")
 *  - Secondary:      `#FFB347` (amber — "the warmth")
 *
 * The chalk library is used so colors degrade gracefully on terminals
 * without truecolor support, and so the `--no-color` global flag (which
 * sets `FORCE_COLOR=0` via Commander) just works.
 *
 * @packageDocumentation
 */

import chalk from 'chalk';

/** The raw (uncolored) ASCII logo block, exactly as it appears in the spec. */
export const SANIX_LOGO: string = [
  ' ███████╗ █████╗ ███╗   ██╗██╗██╗  ██╗',
  ' ██╔════╝██╔══██╗████╗  ██║██║╚██╗██╔╝',
  ' ███████╗███████║██╔██╗ ██║██║ ╚███╔╝ ',
  ' ╚════██║██╔══██║██║╚██╗██║██║ ██╔██╗ ',
  ' ███████║██║  ██║██║ ╚████║██║██╔╝ ██╗',
  ' ╚══════╝╚═╝  ╚═╝╚═╝  ╚═══╝╚═╝╚═╝  ╚═╝',
].join('\n');

/** The tagline printed beneath the logo. */
export const SANIX_TAGLINE: string =
  "Agentic Neural Intelligence eXecutor";

/** The by-line printed beneath the tagline. */
export const SANIX_BYLINE: string = 'by Istiak Ahamed • v1.0.0';

/**
 * The full colored banner: cyan logo, amber tagline + byline.
 *
 * Returned as a single string with embedded ANSI codes; callers should
 * `console.log` it directly. Use {@link printLogo} for the common case.
 */
export function coloredBanner(): string {
  const logo = chalk.hex('#00D4FF')(SANIX_LOGO);
  const tagline = chalk.hex('#FFB347')(SANIX_TAGLINE);
  const byline = chalk.hex('#FFB347').dim(SANIX_BYLINE);
  return `${logo}\n${tagline}\n${byline}`;
}

/**
 * Print the SANIX banner to stdout. Respects chalk's auto-detection of
 * color support (so `--no-color` and `FORCE_COLOR=0` both suppress color).
 *
 * @example
 * ```ts
 * import { printLogo } from './logo.js';
 * printLogo();
 * ```
 */
export function printLogo(): void {
  process.stdout.write(coloredBanner() + '\n');
}
