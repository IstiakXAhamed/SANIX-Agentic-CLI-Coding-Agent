/**
 * @file render — entry point helpers for rendering the SANIX state.
 *
 * `renderApp` auto-detects TTY: if `process.stdout.isTTY` is true (or
 * `forceTui` is set), it boots the Ink TUI; otherwise (or if
 * `forceNonTui` is set) it returns the plain-text render from
 * {@link NonTuiRenderer}.
 */
import React from 'react';
import { render as inkRender, type Instance } from 'ink';
import { App, type AppProps } from './App.js';
import { NonTuiRenderer } from './NonTuiRenderer.js';
import type { AgentStateView } from './types.js';

/** Options for {@link renderApp} / {@link renderNonTui}. */
export interface RenderOptions {
  /** Force the Ink TUI even when stdout is not a TTY. */
  readonly forceTui?: boolean;
  /** Force the non-TUI chalk renderer even when stdout is a TTY. */
  readonly forceNonTui?: boolean;
  /** Whether the non-TUI renderer should emit color. Defaults to `true`. */
  readonly color?: boolean;
  /** Forwarded to {@link AppProps.onQuit}. */
  readonly onQuit?: AppProps['onQuit'];
  /** Forwarded to {@link AppProps.onPause}. */
  readonly onPause?: AppProps['onPause'];
  /** Forwarded to {@link AppProps.onSkip}. */
  readonly onSkip?: AppProps['onSkip'];
  /** Forwarded to {@link AppProps.onMemory}. */
  readonly onMemory?: AppProps['onMemory'];
  /** Forwarded to {@link AppProps.onInteractive}. */
  readonly onInteractive?: AppProps['onInteractive'];
}

/** Result of {@link renderApp}. */
export interface RenderResult {
  /** Which mode was selected. */
  readonly mode: 'tui' | 'nontui';
  /** Ink instance — only present when `mode === 'tui'`. */
  readonly instance?: Instance;
  /** Rendered text — only present when `mode === 'nontui'`. */
  readonly text?: string;
}

/**
 * Resolve the effective render mode from the options and TTY state.
 *
 * @internal
 */
function resolveMode(opts: RenderOptions): 'tui' | 'nontui' {
  if (opts.forceTui) return 'tui';
  if (opts.forceNonTui) return 'nontui';
  return process.stdout.isTTY ? 'tui' : 'nontui';
}

/**
 * Render the agent state. If stdout is a TTY, mount the Ink TUI and
 * return its instance (with an `unmount()` for cleanup). Otherwise,
 * return the chalk-rendered text.
 *
 * @example
 * ```ts
 * const r = renderApp(state, { onQuit: () => process.exit(0) });
 * if (r.mode === 'nontui') console.log(r.text);
 * ```
 */
export function renderApp(state: AgentStateView, opts: RenderOptions = {}): RenderResult {
  const mode = resolveMode(opts);
  if (mode === 'tui') {
    const instance = inkRender(
      React.createElement(App, {
        agentState: state,
        onQuit: opts.onQuit ?? (() => {}),
        onPause: opts.onPause,
        onSkip: opts.onSkip,
        onMemory: opts.onMemory,
        onInteractive: opts.onInteractive,
      }),
    );
    return { mode: 'tui', instance };
  }
  const renderer = new NonTuiRenderer({ color: opts.color ?? true });
  return { mode: 'nontui', text: renderer.render(state) };
}

/**
 * Always use the non-TUI chalk renderer — handy for tests and `--no-tui`.
 */
export function renderNonTui(state: AgentStateView, opts: RenderOptions = {}): string {
  const renderer = new NonTuiRenderer({ color: opts.color ?? true });
  return renderer.render(state);
}
