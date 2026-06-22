/**
 * @file ProviderStatus — active provider + model + latency + token I/O.
 *
 * A denser alternative to {@link AgentStatus} for the sub-agent and
 * tool-call panels.
 */
import React from 'react';
import { Box, Text } from 'ink';
import type { SanixTheme } from '../themes/theme.types.js';
import { sanixTheme } from '../themes/sanix.theme.js';

/** Props for {@link ProviderStatus}. */
export interface ProviderStatusProps {
  /** Active provider id. */
  readonly provider: string;
  /** Concrete model name. */
  readonly model: string;
  /** Last measured round-trip latency in milliseconds. */
  readonly latencyMs: number;
  /** Cumulative input tokens for the active session. */
  readonly tokensIn: number;
  /** Cumulative output tokens for the active session. */
  readonly tokensOut: number;
  /** Theme override. */
  readonly theme?: SanixTheme;
}

/**
 * Render `Provider: <provider>/<model>  in: <n>  out: <n>  latency: <n>ms`.
 *
 * @example
 * ```tsx
 * <ProviderStatus provider="anthropic" model="claude-sonnet-4"
 *   latencyMs={1247} tokensIn={8421} tokensOut={1024} />
 * ```
 */
export const ProviderStatus: React.FC<ProviderStatusProps> = ({
  provider,
  model,
  latencyMs,
  tokensIn,
  tokensOut,
  theme = sanixTheme,
}) => {
  return (
    <Box gap={1}>
      <Text color={theme.muted}>Provider:</Text>
      <Text color={theme.secondary}>{provider}</Text>
      <Text color={theme.dim}>/{model}</Text>
      <Text color={theme.muted}>in:</Text>
      <Text color={theme.fg}>{tokensIn}</Text>
      <Text color={theme.muted}>out:</Text>
      <Text color={theme.fg}>{tokensOut}</Text>
      <Text color={theme.muted}>latency:</Text>
      <Text color={theme.primary}>{latencyMs}ms</Text>
    </Box>
  );
};

export default ProviderStatus;
