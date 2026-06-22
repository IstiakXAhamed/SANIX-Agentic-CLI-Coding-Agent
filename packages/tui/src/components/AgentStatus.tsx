/**
 * @file AgentStatus — top header bar showing the SANIX logo, version,
 * active provider, and a 5-dot latency indicator.
 *
 * Latency buckets (per spec §9):
 *   <500ms  → 5 dots filled
 *   <1s     → 4 dots
 *   <2s     → 3 dots
 *   <5s     → 2 dots
 *   else    → 1 dot
 */
import React from 'react';
import { Box, Text } from 'ink';
import type { SanixTheme } from '../themes/theme.types.js';
import { sanixTheme } from '../themes/sanix.theme.js';

/** Props for {@link AgentStatus}. */
export interface AgentStatusProps {
  /** Active provider id (e.g. `claude-sonnet-4`). */
  readonly provider: string;
  /** Last measured round-trip latency in milliseconds. */
  readonly latencyMs: number;
  /** Displayed SANIX version. Defaults to `1.0.0`. */
  readonly version?: string;
  /** Theme override. Falls back to {@link sanixTheme}. */
  readonly theme?: SanixTheme;
}

/**
 * Map a latency reading to a 0..5 "dots filled" count.
 *
 * @internal
 */
export function latencyDotsFilled(latencyMs: number): number {
  if (latencyMs < 500) return 5;
  if (latencyMs < 1000) return 4;
  if (latencyMs < 2000) return 3;
  if (latencyMs < 5000) return 2;
  return 1;
}

/**
 * Top status bar. Renders:
 * ```
 *   ⟡ SANIX  v1.0.0          Provider: claude-sonnet-4  [●●●○○] 1247ms
 * ```
 *
 * @example
 * ```tsx
 * <AgentStatus provider="claude-sonnet-4" latencyMs={1247} />
 * ```
 */
export const AgentStatus: React.FC<AgentStatusProps> = ({
  provider,
  latencyMs,
  version = '1.0.0',
  theme = sanixTheme,
}) => {
  const filled = latencyDotsFilled(latencyMs);
  const dots = Array.from({ length: 5 }, (_, i) => (i < filled ? '●' : '○')).join('');
  return (
    <Box justifyContent="space-between">
      <Box>
        <Text color={theme.primary} bold>
          ⟡ SANIX
        </Text>
        <Text color={theme.muted}> v{version}</Text>
      </Box>
      <Box gap={1}>
        <Text color={theme.muted}>Provider:</Text>
        <Text color={theme.secondary}>{provider}</Text>
        <Text color={theme.primary}>[{dots}]</Text>
        <Text color={theme.muted}>{latencyMs}ms</Text>
      </Box>
    </Box>
  );
};

export default AgentStatus;
