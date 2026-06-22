/**
 * @file GoalHeader — goal display with inline iteration counter.
 *
 * The iteration counter color-shifts as the budget approaches the cap:
 *   muted   : ratio < 70%
 *   amber   : 70% ≤ ratio < 90%
 *   red     : ratio ≥ 90%
 */
import React from 'react';
import { Box, Text } from 'ink';
import type { SanixTheme } from '../themes/theme.types.js';
import { sanixTheme } from '../themes/sanix.theme.js';

/** Props for {@link GoalHeader}. */
export interface GoalHeaderProps {
  /** User-supplied high-level goal. */
  readonly goal: string;
  /** Current iteration counter (1-indexed). */
  readonly iteration: number;
  /** Hard iteration cap. */
  readonly maxIterations: number;
  /** Theme override. */
  readonly theme?: SanixTheme;
}

/** Fixed-width divider that matches the spec's separator line. */
const DIVIDER = '─'.repeat(73);

/**
 * Compute the iteration counter color for a `iteration / maxIterations`
 * ratio.
 *
 * @internal
 */
export function iterationColor(
  iteration: number,
  maxIterations: number,
  theme: SanixTheme,
): string {
  const ratio = maxIterations > 0 ? iteration / maxIterations : 0;
  if (ratio >= 0.9) return theme.error;
  if (ratio >= 0.7) return theme.secondary;
  return theme.muted;
}

/**
 * Render the goal header: the goal text on the first row with an
 * inline iteration counter, followed by a divider line.
 *
 * @example
 * ```tsx
 * <GoalHeader goal="Refactor auth module to use JWT" iteration={7} maxIterations={100} />
 * ```
 */
export const GoalHeader: React.FC<GoalHeaderProps> = ({
  goal,
  iteration,
  maxIterations,
  theme = sanixTheme,
}) => {
  const iterColor = iterationColor(iteration, maxIterations, theme);
  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Box>
          <Text color={theme.primary} bold>
            Goal:{' '}
          </Text>
          <Text color={theme.fg}>{goal}</Text>
        </Box>
        <Box>
          <Text color={theme.muted}>Iter: </Text>
          <Text color={iterColor} bold>
            {iteration}/{maxIterations}
          </Text>
        </Box>
      </Box>
      <Box>
        <Text color={theme.dim}>{DIVIDER}</Text>
      </Box>
    </Box>
  );
};

export default GoalHeader;
