/**
 * @file SubAgentTracker — sub-agent lifecycle view with per-agent
 * progress bars.
 */
import React from 'react';
import { Box, Text } from 'ink';
import type { SanixTheme } from '../themes/theme.types.js';
import { sanixTheme } from '../themes/sanix.theme.js';
import type { SubAgentStatus } from '../types.js';

/** Props for {@link SubAgentTracker}. */
export interface SubAgentTrackerProps {
  /** Live sub-agents. */
  readonly agents: ReadonlyArray<{
    readonly id: string;
    readonly task: string;
    readonly status: SubAgentStatus;
    readonly progress?: number;
  }>;
  /** Theme override. */
  readonly theme?: SanixTheme;
  /** Progress-bar width in cells. Defaults to 8. */
  readonly barWidth?: number;
}

/** Status icon per {@link SubAgentStatus}. */
export const SUBAGENT_STATUS_ICON: Record<SubAgentStatus, string> = {
  running: '▶',
  complete: '✓',
  failed: '✗',
};

/** Theme color key per {@link SubAgentStatus}. */
const SUBAGENT_STATUS_COLOR_KEY: Record<SubAgentStatus, keyof SanixTheme> = {
  running: 'secondary',
  complete: 'success',
  failed: 'error',
};

function progressBar(
  progress: number | undefined,
  width: number,
  theme: SanixTheme,
): { readonly bar: string; readonly color: string } | null {
  if (progress === undefined) return null;
  const clamped = Math.max(0, Math.min(1, progress));
  const filled = Math.round(clamped * width);
  return {
    bar: '█'.repeat(filled) + '░'.repeat(width - filled),
    color: theme.primary,
  };
}

/**
 * Render the sub-agent panel. Each agent gets a status icon, id, task,
 * and optional progress bar.
 *
 * @example
 * ```tsx
 * <SubAgentTracker agents={[
 *   { id: 'a1', task: 'Write tests', status: 'running', progress: 0.42 },
 * ]} />
 * ```
 */
export const SubAgentTracker: React.FC<SubAgentTrackerProps> = ({
  agents,
  theme = sanixTheme,
  barWidth = 8,
}) => {
  const activeCount = agents.filter((a) => a.status === 'running').length;
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.primary} bold>
          SUB-AGENTS
        </Text>
        <Text color={theme.muted}> ({activeCount} active)</Text>
      </Box>
      {agents.length === 0 ? (
        <Text color={theme.dim}>No sub-agents running.</Text>
      ) : (
        agents.map((a) => {
          const color = theme[SUBAGENT_STATUS_COLOR_KEY[a.status]];
          const icon = SUBAGENT_STATUS_ICON[a.status];
          const pb = progressBar(a.progress, barWidth, theme);
          return (
            <Box key={a.id} gap={1}>
              <Text color={color}>[{icon}]</Text>
              <Text color={theme.muted}>#{a.id}</Text>
              <Text color={theme.fg}>{a.task}</Text>
              {pb ? <Text color={pb.color}>{pb.bar}</Text> : null}
            </Box>
          );
        })
      )}
    </Box>
  );
};

export default SubAgentTracker;
