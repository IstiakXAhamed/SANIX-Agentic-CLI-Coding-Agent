/**
 * @file Default SANIX dark theme — the signature palette.
 *
 * Matches the brand identity section of the spec exactly:
 *   - Background: #0D1117 (deep space)
 *   - Primary:    #00D4FF (electric cyan — "the signal")
 *   - Secondary:  #FFB347 (amber — "the warmth")
 *   - Success:    #39D353 (matrix green)
 *   - Error:      #FF4D4D
 *   - Muted:      #8B949E
 */
import type { SanixTheme } from './theme.types.js';

/** Default SANIX theme — deep-space dark with electric cyan accents. */
export const sanixTheme: SanixTheme = {
  bg: '#0D1117',
  fg: '#E6EDF3',
  primary: '#00D4FF',
  secondary: '#FFB347',
  success: '#39D353',
  error: '#FF4D4D',
  muted: '#8B949E',
  border: '#30363D',
  dim: '#6E7681',
};
