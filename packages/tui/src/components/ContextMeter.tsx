/**
 * @file ContextMeter — token budget bar with green / amber / red
 * color shifts.
 *
 *   green  : ratio < 70%
 *   amber  : 70% ≤ ratio < 90%
 *   red    : ratio ≥ 90%
 */
import React from 'react';
import { Box, Text } from 'ink';
import type { SanixTheme } from '../themes/theme.types.js';
import { sanixTheme } from '../themes/sanix.theme.js';

/** Props for {@link ContextMeter}. */
export interface ContextMeterProps {
  /** Tokens consumed so far. */
  readonly used: number;
  /** Token budget cap. */
  readonly total: number;
  /** Left-hand label. Defaults to `CONTEXT BUDGET`. */
  readonly label?: string;
  /** Theme override. */
  readonly theme?: SanixTheme;
  /** Bar width in cells. Defaults to 20. */
  readonly barWidth?: number;
}

/** Locale-aware thousands formatting. */
function formatTokens(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * Compute the bar color for a usage ratio.
 *
 * @internal
 */
export function contextMeterColor(ratio: number, theme: SanixTheme): string {
  if (ratio < 0.7) return theme.success;
  if (ratio < 0.9) return theme.secondary;
  return theme.error;
}

/**
 * Render `[████████░░░░] used / total tokens` with a color-shifting bar.
 *
 * @example
 * ```tsx
 * <ContextMeter used={3847} total={4096} />
 * ```
 */
export const ContextMeter: React.FC<ContextMeterProps> = ({
  used,
  total,
  label = 'CONTEXT BUDGET',
  theme = sanixTheme,
  barWidth = 20,
}) => {
  const ratio = total > 0 ? used / total : 0;
  const filled = Math.min(barWidth, Math.round(ratio * barWidth));
  const empty = Math.max(0, barWidth - filled);
  const barColor = contextMeterColor(ratio, theme);
  const bar = '█'.repeat(filled) + '░'.repeat(empty);

  return (
    <Box>
      <Text color={theme.primary} bold>
        {label}{' '}
      </Text>
      <Text>[</Text>
      <Text color={barColor}>{bar}</Text>
      <Text>] </Text>
      <Text color={theme.fg}>
        {formatTokens(used)} / {formatTokens(total)} tokens
      </Text>
    </Box>
  );
};

export default ContextMeter;
