/**
 * @file MessageStream — streaming agent / user / system message log.
 *
 * Role prefixes:
 *   - agent / assistant → cyan "Agent:"
 *   - user              → amber "User:"
 *   - system            → dim   "System:"
 */
import React from 'react';
import { Box, Text } from 'ink';
import type { SanixTheme } from '../themes/theme.types.js';
import { sanixTheme } from '../themes/sanix.theme.js';
import type { MessageRole, MessageView } from '../types.js';

/** Props for {@link MessageStream}. */
export interface MessageStreamProps {
  /** Streaming messages (newest last). */
  readonly messages: readonly MessageView[];
  /** Cap on number of messages rendered (keeps the newest). Defaults to 10. */
  readonly maxMessages?: number;
  /** Theme override. */
  readonly theme?: SanixTheme;
}

/** Display prefix per role. */
export const ROLE_PREFIX: Record<MessageRole, string> = {
  agent: 'Agent:',
  assistant: 'Agent:',
  user: 'User:',
  system: 'System:',
};

/** Theme color key per role. */
const ROLE_COLOR_KEY: Record<MessageRole, keyof SanixTheme> = {
  agent: 'primary',
  assistant: 'primary',
  user: 'secondary',
  system: 'dim',
};

/** Format an epoch-millis timestamp as `HH:MM:SS`. */
function formatTime(ts: number | undefined): string {
  if (ts === undefined) return '';
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/**
 * Render the streaming message log. Keeps only the last `maxMessages`
 * entries to avoid runaway terminal height.
 *
 * @example
 * ```tsx
 * <MessageStream messages={[{ role: 'agent', content: 'Working…' }]} />
 * ```
 */
export const MessageStream: React.FC<MessageStreamProps> = ({
  messages,
  maxMessages = 10,
  theme = sanixTheme,
}) => {
  const shown = messages.slice(-maxMessages);
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.primary} bold>
          STREAM
        </Text>
      </Box>
      {shown.length === 0 ? (
        <Text color={theme.dim}>No messages yet.</Text>
      ) : (
        shown.map((m, i) => {
          const color = theme[ROLE_COLOR_KEY[m.role]];
          const prefix = ROLE_PREFIX[m.role];
          const time = formatTime(m.ts);
          return (
            <Box key={i}>
              {time ? <Text color={theme.dim}>{time} </Text> : null}
              <Text color={color} bold>
                {prefix}{' '}
              </Text>
              <Text color={theme.fg}>{m.content}</Text>
            </Box>
          );
        })
      )}
    </Box>
  );
};

export default MessageStream;
