/**
 * @file Theme type definitions for the SANIX terminal UI.
 *
 * A theme is a flat record of hex color strings consumed by every Ink
 * component (via the `color` prop on `<Text>`) and by the non-TUI renderer
 * (via `chalk.hex()`). All colors are 6-digit hex (`#RRGGBB`) so they
 * render identically in both modes.
 */

/**
 * SANIX terminal UI theme.
 *
 * Every field is a 6-digit hex color string (e.g. `#00D4FF`).
 */
export interface SanixTheme {
  /** Background fill — deep space (#0D1117). */
  readonly bg: string;
  /** Default foreground text. */
  readonly fg: string;
  /** Primary accent — electric cyan "the signal". */
  readonly primary: string;
  /** Secondary accent — amber "the warmth". */
  readonly secondary: string;
  /** Success / done state — matrix green. */
  readonly success: string;
  /** Error / failed state. */
  readonly error: string;
  /** Muted UI text (labels, counts). */
  readonly muted: string;
  /** Border / divider color. */
  readonly border: string;
  /** Dim / low-emphasis text (context lines, separators). */
  readonly dim: string;
}
