/**
 * @file App — root TUI component. Composes every panel into the
 * signature SANIX layout:
 *
 * ```
 *   ┌─ AgentStatus (logo + provider + latency) ──────────────────────┐
 *   │  GoalHeader                                                    │
 *   │  TaskGraph                                                     │
 *   │  ContextMeter                                                  │
 *   │  Memory / Sub-agent / Iter summary line                        │
 *   │  SubAgentTracker                                               │
 *   │  MemoryPanel (toggleable with `m`)                             │
 *   │  ToolCall (currentTool, if any)                                │
 *   │  MessageStream                                                 │
 *   │  StatusBar                                                     │
 *   └────────────────────────────────────────────────────────────────┘
 * ```
 *
 * Keybinds (handled via `useInput`): `q` quit, `p` pause, `s` skip,
 * `m` toggle memory panel, `i` interactive mode.
 */
import React, { useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import type { SanixTheme } from './themes/theme.types.js';
import { sanixTheme } from './themes/sanix.theme.js';
import type { AgentStateView } from './types.js';
import { AgentStatus } from './components/AgentStatus.js';
import { GoalHeader } from './components/GoalHeader.js';
import { TaskGraph } from './components/TaskGraph.js';
import { ContextMeter } from './components/ContextMeter.js';
import { MemoryPanel } from './components/MemoryPanel.js';
import { SubAgentTracker } from './components/SubAgentTracker.js';
import { ToolCall } from './components/ToolCall.js';
import { MessageStream } from './components/MessageStream.js';
import { StatusBar } from './components/StatusBar.js';

/** Props for {@link App}. */
export interface AppProps {
  /** Snapshot of the agent loop state. */
  readonly agentState: AgentStateView;
  /** Called when the user presses `q` (after Ink has been told to exit). */
  readonly onQuit: () => void;
  /** Called when the user presses `p`. */
  readonly onPause?: () => void;
  /** Called when the user presses `s`. */
  readonly onSkip?: () => void;
  /** Called when the user presses `m` (after the memory panel has been toggled). */
  readonly onMemory?: () => void;
  /** Called when the user presses `i`. */
  readonly onInteractive?: () => void;
  /** Theme override. Defaults to {@link sanixTheme}. */
  readonly theme?: SanixTheme;
}

/** Fixed-width divider matching the spec's separator lines. */
const DIVIDER = '─'.repeat(73);

/**
 * Root SANIX TUI component.
 *
 * @example
 * ```tsx
 * import { render } from 'ink';
 * import { App } from '@sanix/tui';
 *
 * render(<App agentState={state} onQuit={() => process.exit(0)} />);
 * ```
 */
export const App: React.FC<AppProps> = ({
  agentState,
  onQuit,
  onPause,
  onSkip,
  onMemory,
  onInteractive,
  theme = sanixTheme,
}) => {
  const { exit } = useApp();
  const [showMemory, setShowMemory] = useState<boolean>(false);

  useInput((input) => {
    switch (input) {
      case 'q':
      case 'Q':
        exit();
        onQuit();
        break;
      case 'p':
      case 'P':
        onPause?.();
        break;
      case 's':
      case 'S':
        onSkip?.();
        break;
      case 'm':
      case 'M':
        setShowMemory((v) => !v);
        onMemory?.();
        break;
      case 'i':
      case 'I':
        onInteractive?.();
        break;
      default:
        break;
    }
  });

  const s = agentState;
  const activeSubs = s.subAgents.filter((a) => a.status === 'running').length;

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={theme.border}
      paddingX={1}
    >
      <AgentStatus provider={s.provider} latencyMs={s.latencyMs} theme={theme} />
      <Box>
        <Text color={theme.dim}>{DIVIDER}</Text>
      </Box>
      <GoalHeader
        goal={s.goal}
        iteration={s.iteration}
        maxIterations={s.maxIterations}
        theme={theme}
      />
      <Box marginTop={1}>
        <TaskGraph tasks={s.plan} theme={theme} />
      </Box>
      <Box marginTop={1}>
        <ContextMeter used={s.tokenUsed} total={s.tokenTotal} theme={theme} />
      </Box>
      <Box>
        <Text color={theme.muted}>
          Memory: {s.memoryFacts.length} facts loaded  │  Sub-agents: {activeSubs} active  │  Iter: {s.iteration}/{s.maxIterations}
        </Text>
      </Box>
      <Box marginTop={1}>
        <SubAgentTracker agents={s.subAgents} theme={theme} />
      </Box>
      {showMemory ? (
        <Box marginTop={1}>
          <MemoryPanel facts={s.memoryFacts} theme={theme} />
        </Box>
      ) : null}
      {s.currentTool ? (
        <Box marginTop={1} flexDirection="column">
          <Box>
            <Text color={theme.dim}>{DIVIDER}</Text>
          </Box>
          <ToolCall
            toolName={s.currentTool.toolName}
            input={s.currentTool.input}
            output={s.currentTool.output}
            diff={s.currentTool.diff}
            durationMs={s.currentTool.durationMs}
            status={s.currentTool.status}
            theme={theme}
          />
        </Box>
      ) : null}
      <Box marginTop={1}>
        <MessageStream messages={s.messages} theme={theme} />
      </Box>
      <Box marginTop={1}>
        <StatusBar paused={s.paused} theme={theme} />
      </Box>
    </Box>
  );
};

export default App;
