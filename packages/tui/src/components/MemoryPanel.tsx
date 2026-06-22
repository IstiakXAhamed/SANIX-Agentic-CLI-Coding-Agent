/**
 * @file MemoryPanel — active memory display with per-fact score bars.
 */
import React from 'react';
import { Box, Text } from 'ink';
import type { SanixTheme } from '../themes/theme.types.js';
import { sanixTheme } from '../themes/sanix.theme.js';
import type { MemoryFactView } from '../types.js';

/** Props for {@link MemoryPanel}. */
export interface MemoryPanelProps {
  /** Recalled memory facts (highest-score first recommended). */
  readonly facts: readonly MemoryFactView[];
  /** Cap on number of facts rendered. Older extras are summarized. */
  readonly maxDisplay?: number;
  /** Theme override. */
  readonly theme?: SanixTheme;
  /** Score-bar width in cells. Defaults to 8. */
  readonly barWidth?: number;
}

/**
 * Build a Unicode score bar plus its color for a 0..1 score.
 *
 * @internal
 */
export function scoreBar(
  score: number,
  width: number,
  theme: SanixTheme,
): { readonly bar: string; readonly color: string } {
  const clamped = Math.max(0, Math.min(1, score));
  const filled = Math.round(clamped * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  let color: string;
  if (clamped >= 0.7) color = theme.success;
  else if (clamped >= 0.4) color = theme.secondary;
  else color = theme.muted;
  return { bar, color };
}

/**
 * Render the active memory facts with score bars. Truncated with a
 * "… +N more" line when `facts.length > maxDisplay`.
 *
 * @example
 * ```tsx
 * <MemoryPanel facts={[{ id: 'f1', content: 'User prefers tabs', score: 0.92 }]} />
 * ```
 */
export const MemoryPanel: React.FC<MemoryPanelProps> = ({
  facts,
  maxDisplay = 5,
  theme = sanixTheme,
  barWidth = 8,
}) => {
  const shown = facts.slice(0, maxDisplay);
  const hidden = facts.length - shown.length;
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.primary} bold>
          MEMORY
        </Text>
        <Text color={theme.muted}> ({facts.length} facts)</Text>
      </Box>
      {shown.length === 0 ? (
        <Text color={theme.dim}>No active memories.</Text>
      ) : (
        shown.map((f) => {
          const { bar, color } = scoreBar(f.score, barWidth, theme);
          return (
            <Box key={f.id}>
              <Text color={color}>{bar}</Text>
              <Text> </Text>
              <Text color={theme.fg}>{f.content}</Text>
            </Box>
          );
        })
      )}
      {hidden > 0 ? <Text color={theme.dim}>… +{hidden} more</Text> : null}
    </Box>
  );
};

export default MemoryPanel;
