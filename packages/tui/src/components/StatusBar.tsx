/**
 * @file StatusBar — bottom keybind bar.
 *
 *   [i] Interactive  [p] Pause  [s] Skip task  [m] Memory  [q] Quit
 */
import React from 'react';
import { Box, Text } from 'ink';
import type { SanixTheme } from '../themes/theme.types.js';
import { sanixTheme } from '../themes/sanix.theme.js';

/** A single keybind entry. */
export interface Keybind {
  readonly key: string;
  readonly label: string;
}

/** Props for {@link StatusBar}. */
export interface StatusBarProps {
  /** Whether the loop is currently paused — shows a `⏸ PAUSED` badge. */
  readonly paused?: boolean;
  /** Theme override. */
  readonly theme?: SanixTheme;
  /** Custom keybind entries; defaults to the SANIX standard set. */
  readonly keybinds?: ReadonlyArray<Keybind>;
}

/** Default keybind set, matching the spec layout. */
export const DEFAULT_KEYBINDS: ReadonlyArray<Keybind> = [
  { key: 'i', label: 'Interactive' },
  { key: 'p', label: 'Pause' },
  { key: 's', label: 'Skip task' },
  { key: 'm', label: 'Memory' },
  { key: 'q', label: 'Quit' },
];

/**
 * Render the bottom keybind bar.
 *
 * @example
 * ```tsx
 * <StatusBar paused={state.paused} />
 * ```
 */
export const StatusBar: React.FC<StatusBarProps> = ({
  paused = false,
  theme = sanixTheme,
  keybinds = DEFAULT_KEYBINDS,
}) => {
  return (
    <Box justifyContent="space-between">
      <Box>
        {keybinds.map((kb, i) => (
          <React.Fragment key={kb.key}>
            {i > 0 ? <Text color={theme.dim}>  </Text> : null}
            <Text color={theme.primary}>[{kb.key}]</Text>
            <Text color={theme.muted}> {kb.label}</Text>
          </React.Fragment>
        ))}
      </Box>
      {paused ? (
        <Text color={theme.secondary} bold>
          ⏸ PAUSED
        </Text>
      ) : null}
    </Box>
  );
};

export default StatusBar;
