/**
 * @file ToolCall — renders a single tool invocation header, optional
 * input/output JSON, optional inline diff, and a status icon.
 */
import React from 'react';
import { Box, Text } from 'ink';
import type { SanixTheme } from '../themes/theme.types.js';
import { sanixTheme } from '../themes/sanix.theme.js';
import { DiffViewer } from './DiffViewer.js';
import type { ToolCallStatus } from '../types.js';

/** Props for {@link ToolCall}. */
export interface ToolCallProps {
  readonly toolName: string;
  /** Arbitrary tool input. Narrowed via `unknown`. */
  readonly input?: unknown;
  /** Arbitrary tool output. Narrowed via `unknown`. */
  readonly output?: unknown;
  /** Optional unified diff for filesystem edits. */
  readonly diff?: string;
  /** Wall-clock duration in milliseconds. */
  readonly durationMs?: number;
  readonly status: ToolCallStatus;
  /** Theme override. */
  readonly theme?: SanixTheme;
  /** Initial expand state for the embedded {@link DiffViewer}. */
  readonly expanded?: boolean;
  /** Max diff lines rendered when collapsed. */
  readonly maxDiffLines?: number;
}

/** Status icon per {@link ToolCallStatus}. */
export const TOOL_STATUS_ICON: Record<ToolCallStatus, string> = {
  running: '…',
  success: '✓',
  error: '✗',
};

/** Theme color key per {@link ToolCallStatus}. */
const TOOL_STATUS_COLOR_KEY: Record<ToolCallStatus, keyof SanixTheme> = {
  running: 'secondary',
  success: 'success',
  error: 'error',
};

/** Safe JSON stringification — never throws. */
function formatJson(value: unknown): string {
  if (value === undefined) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Render a tool call header followed by optional input JSON, inline
 * diff, and output JSON.
 *
 * @example
 * ```tsx
 * <ToolCall toolName="edit_file" status="success"
 *   input={{ path: 'src/auth/jwt.ts' }}
 *   diff={unifiedDiffString}
 *   durationMs={42} />
 * ```
 */
export const ToolCall: React.FC<ToolCallProps> = ({
  toolName,
  input,
  output,
  diff,
  durationMs,
  status,
  theme = sanixTheme,
  expanded,
  maxDiffLines,
}) => {
  const color = theme[TOOL_STATUS_COLOR_KEY[status]];
  const icon = TOOL_STATUS_ICON[status];
  const inputStr = formatJson(input);
  const outputStr = formatJson(output);

  return (
    <Box flexDirection="column">
      <Box gap={1}>
        <Text color={theme.primary} bold>
          TOOL:
        </Text>
        <Text color={theme.secondary} bold>
          {toolName}
        </Text>
        <Text color={color}>[{icon}]</Text>
        {durationMs !== undefined ? <Text color={theme.muted}>{durationMs}ms</Text> : null}
      </Box>
      {inputStr ? (
        <Box>
          <Text color={theme.dim}>in: </Text>
          <Text color={theme.muted}>{inputStr}</Text>
        </Box>
      ) : null}
      {diff ? (
        <DiffViewer
          diff={diff}
          expanded={expanded}
          maxLines={maxDiffLines ?? 50}
          theme={theme}
        />
      ) : null}
      {outputStr ? (
        <Box>
          <Text color={theme.dim}>out: </Text>
          <Text color={theme.muted}>{outputStr}</Text>
        </Box>
      ) : null}
    </Box>
  );
};

export default ToolCall;
