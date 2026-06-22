/**
 * @sanix/tui — SANIX terminal UI (Ink v5) plus a plain-text non-TUI
 * renderer for CI / `--no-tui` mode.
 *
 * Public surface:
 *   - {@link App} / {@link AppProps} — root TUI component.
 *   - {@link AgentStateView} and friends — view-model types.
 *   - {@link SanixTheme} / {@link sanixTheme} — signature dark palette.
 *   - 11 standalone components (AgentStatus, TaskGraph, ContextMeter,
 *     MemoryPanel, ToolCall, DiffViewer, ProviderStatus, SubAgentTracker,
 *     StatusBar, GoalHeader, MessageStream).
 *   - {@link NonTuiRenderer} — chalk-based renderer for CI mode.
 *   - {@link renderApp} / {@link renderNonTui} — TTY-aware entry points.
 *
 * @packageDocumentation
 */

// Root component.
export { App, type AppProps } from './App.js';

// View-model types.
export {
  type TaskStatus,
  type ToolCallStatus,
  type SubAgentStatus,
  type MessageRole,
  type TaskNodeView,
  type ToolCallView,
  type SubAgentView,
  type MessageView,
  type MemoryFactView,
  type AgentStateView,
} from './types.js';

// Themes.
export { type SanixTheme, sanixTheme } from './themes/index.js';

// Components.
export {
  AgentStatus,
  type AgentStatusProps,
  latencyDotsFilled,
} from './components/AgentStatus.js';
export { TaskGraph, type TaskGraphProps, TASK_STATUS_ICON, TASK_STATUS_LABEL } from './components/TaskGraph.js';
export {
  ContextMeter,
  type ContextMeterProps,
  contextMeterColor,
} from './components/ContextMeter.js';
export { MemoryPanel, type MemoryPanelProps, scoreBar } from './components/MemoryPanel.js';
export { DiffViewer, type DiffViewerProps, parseDiff } from './components/DiffViewer.js';
export {
  ToolCall,
  type ToolCallProps,
  TOOL_STATUS_ICON,
} from './components/ToolCall.js';
export { ProviderStatus, type ProviderStatusProps } from './components/ProviderStatus.js';
export {
  SubAgentTracker,
  type SubAgentTrackerProps,
  SUBAGENT_STATUS_ICON,
} from './components/SubAgentTracker.js';
export {
  StatusBar,
  type StatusBarProps,
  type Keybind,
  DEFAULT_KEYBINDS,
} from './components/StatusBar.js';
export { GoalHeader, type GoalHeaderProps, iterationColor } from './components/GoalHeader.js';
export {
  MessageStream,
  type MessageStreamProps,
  ROLE_PREFIX,
} from './components/MessageStream.js';

// Non-TUI renderer.
export {
  NonTuiRenderer,
  type NonTuiRendererOptions,
} from './NonTuiRenderer.js';

// Render entry points.
export {
  renderApp,
  renderNonTui,
  type RenderOptions,
  type RenderResult,
} from './render.js';
