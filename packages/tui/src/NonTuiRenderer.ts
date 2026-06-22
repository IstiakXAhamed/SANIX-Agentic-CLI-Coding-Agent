/**
 * @file NonTuiRenderer — plain-text renderer for `--no-tui` / CI mode.
 *
 * Produces the same content as the Ink TUI but as a single
 * newline-delimited string colored with `chalk.hex()`. When `color: false`
 * is set (or the destination is not a TTY and the caller opts out), all
 * color escapes are stripped so the output is pipe-safe.
 */
import chalk from 'chalk';
import type {
  AgentStateView,
  ToolCallView,
  TaskNodeView,
  TaskStatus,
  ToolCallStatus,
  SubAgentStatus,
  MessageRole,
} from './types.js';

/** Renderer options. */
export interface NonTuiRendererOptions {
  /** Whether to emit ANSI color. Defaults to `true`. */
  readonly color?: boolean;
}

/** Brand palette (mirror of {@link sanixTheme}). */
const PALETTE = {
  primary: '#00D4FF',
  secondary: '#FFB347',
  success: '#39D353',
  error: '#FF4D4D',
  muted: '#8B949E',
  dim: '#6E7681',
} as const;

/** Role → display prefix. */
const ROLE_PREFIX: Record<MessageRole, string> = {
  agent: 'Agent',
  assistant: 'Agent',
  user: 'User',
  system: 'System',
};

/** Role → color hex. */
const ROLE_COLOR: Record<MessageRole, string> = {
  agent: PALETTE.primary,
  assistant: PALETTE.primary,
  user: PALETTE.secondary,
  system: PALETTE.dim,
};

/** Task status → icon. */
const TASK_ICON: Record<TaskStatus, string> = {
  done: '[✓]',
  active: '[▶]',
  pending: '[ ]',
  failed: '[✗]',
};

/** Task status → color hex. */
const TASK_COLOR: Record<TaskStatus, string> = {
  done: PALETTE.success,
  active: PALETTE.primary,
  pending: PALETTE.muted,
  failed: PALETTE.error,
};

/** Task status → label. */
const TASK_LABEL: Record<TaskStatus, string> = {
  done: 'done',
  active: 'active',
  pending: 'pending',
  failed: 'failed',
};

/** Tool status → icon. */
const TOOL_ICON: Record<ToolCallStatus, string> = {
  running: '…',
  success: '✓',
  error: '✗',
};

/** Tool status → color hex. */
const TOOL_COLOR: Record<ToolCallStatus, string> = {
  running: PALETTE.secondary,
  success: PALETTE.success,
  error: PALETTE.error,
};

/** Sub-agent status → icon. */
const SUBAGENT_ICON: Record<SubAgentStatus, string> = {
  running: '▶',
  complete: '✓',
  failed: '✗',
};

/** Sub-agent status → color hex. */
const SUBAGENT_COLOR: Record<SubAgentStatus, string> = {
  running: PALETTE.secondary,
  complete: PALETTE.success,
  failed: PALETTE.error,
};

/** Latency → filled-dot count (matches {@link AgentStatus} buckets). */
function latencyFilled(latencyMs: number): number {
  if (latencyMs < 500) return 5;
  if (latencyMs < 1000) return 4;
  if (latencyMs < 2000) return 3;
  if (latencyMs < 5000) return 2;
  return 1;
}

/** Locale-aware thousands formatting. */
function formatTokens(n: number): string {
  return n.toLocaleString('en-US');
}

/** Fixed-width separator line. */
const DIVIDER = '─'.repeat(73);

/**
 * Plain-text renderer for SANIX state. Drop-in for the Ink TUI in CI /
 * `--no-tui` mode.
 *
 * @example
 * ```ts
 * import { NonTuiRenderer } from '@sanix/tui';
 * const out = new NonTuiRenderer().render(state);
 * console.log(out);
 * ```
 */
export class NonTuiRenderer {
  private readonly color: boolean;

  constructor(opts: NonTuiRendererOptions = {}) {
    this.color = opts.color ?? true;
  }

  /** Colorize `text` with `hex`, or return it bare when color is off. */
  private c(text: string, hex: string): string {
    if (!this.color) return text;
    return chalk.hex(hex)(text);
  }

  /** Render a 5-dot latency gauge. */
  private latencyDots(latencyMs: number): string {
    const filled = latencyFilled(latencyMs);
    return Array.from({ length: 5 }, (_, i) => (i < filled ? '●' : '○')).join('');
  }

  /** Render a Unicode progress bar. */
  private bar(filled: number, total: number): string {
    return '█'.repeat(filled) + '░'.repeat(Math.max(0, total - filled));
  }

  /** Render the full agent state as a colored string. */
  render(state: AgentStateView): string {
    const lines: string[] = [];

    // Header.
    lines.push(
      `${this.c('⟡ SANIX', PALETTE.primary)} ${this.c('v1.0.0', PALETTE.muted)}  ` +
        `${this.c('Provider:', PALETTE.muted)} ${this.c(state.provider, PALETTE.secondary)}  ` +
        `${this.c(`[${this.latencyDots(state.latencyMs)}]`, PALETTE.primary)} ` +
        `${this.c(`${state.latencyMs}ms`, PALETTE.muted)}`,
    );
    lines.push(this.c(DIVIDER, PALETTE.dim));

    // Goal.
    lines.push(`${this.c('Goal:', PALETTE.primary)} ${state.goal}`);
    lines.push('');

    // Plan.
    lines.push(this.c('PLAN                         STATUS', PALETTE.primary));
    state.plan.forEach((node, i) => {
      this.renderTaskNode(node, '', i === state.plan.length - 1, lines);
    });
    lines.push('');

    // Context budget.
    const ratio = state.tokenTotal > 0 ? state.tokenUsed / state.tokenTotal : 0;
    const filled = Math.min(20, Math.round(ratio * 20));
    let barColor: string;
    if (ratio < 0.7) barColor = PALETTE.success;
    else if (ratio < 0.9) barColor = PALETTE.secondary;
    else barColor = PALETTE.error;
    lines.push(
      `${this.c('CONTEXT BUDGET', PALETTE.primary)}  ` +
        `[${this.c(this.bar(filled, 20), barColor)}] ` +
        `${formatTokens(state.tokenUsed)} / ${formatTokens(state.tokenTotal)} tokens`,
    );
    const activeSubs = state.subAgents.filter((a) => a.status === 'running').length;
    lines.push(
      `${this.c(`Memory: ${state.memoryFacts.length} facts loaded`, PALETTE.muted)}  │  ` +
        `${this.c(`Sub-agents: ${activeSubs} active`, PALETTE.muted)}  │  ` +
        `${this.c(`Iter: ${state.iteration}/${state.maxIterations}`, PALETTE.muted)}`,
    );
    lines.push('');

    // Sub-agents.
    if (state.subAgents.length > 0) {
      lines.push(this.c('SUB-AGENTS', PALETTE.primary));
      state.subAgents.forEach((a) => {
        lines.push(
          `${this.c(`[${SUBAGENT_ICON[a.status]}]`, SUBAGENT_COLOR[a.status])} ` +
            `#${a.id} ${a.task}` +
            (a.progress !== undefined
              ? `  ${this.c(this.bar(Math.round(a.progress * 8), 8), PALETTE.primary)}`
              : ''),
        );
      });
      lines.push('');
    }

    // Tool call.
    if (state.currentTool) {
      lines.push(this.c(DIVIDER, PALETTE.dim));
      lines.push(this.renderToolCall(state.currentTool));
      lines.push('');
    }

    // Messages.
    if (state.messages.length > 0) {
      lines.push(this.c('STREAM', PALETTE.primary));
      state.messages.slice(-10).forEach((m) => {
        lines.push(`${this.c(`${ROLE_PREFIX[m.role]}:`, ROLE_COLOR[m.role])} ${m.content}`);
      });
      lines.push('');
    }

    // Status bar.
    lines.push(
      `${this.c('[i]', PALETTE.primary)} ${this.c('Interactive', PALETTE.muted)}  ` +
        `${this.c('[p]', PALETTE.primary)} ${this.c('Pause', PALETTE.muted)}  ` +
        `${this.c('[s]', PALETTE.primary)} ${this.c('Skip task', PALETTE.muted)}  ` +
        `${this.c('[m]', PALETTE.primary)} ${this.c('Memory', PALETTE.muted)}  ` +
        `${this.c('[q]', PALETTE.primary)} ${this.c('Quit', PALETTE.muted)}`,
    );

    return lines.join('\n');
  }

  /** Recursively render a plan task node. */
  private renderTaskNode(
    node: TaskNodeView,
    prefix: string,
    isLast: boolean,
    lines: string[],
  ): void {
    const connector = isLast ? '└─' : '├─';
    lines.push(
      `${this.c(`${prefix}${connector} `, PALETTE.dim)}` +
        `${this.c(`${TASK_ICON[node.status]}`, TASK_COLOR[node.status])} ` +
        `${node.title}  ` +
        `${this.c(TASK_LABEL[node.status], PALETTE.muted)}` +
        (node.detail ? `  ${this.c(node.detail, PALETTE.secondary)}` : ''),
    );
    const children = node.children ?? [];
    children.forEach((child, i) => {
      this.renderTaskNode(
        child,
        prefix + (isLast ? '  ' : '│ '),
        i === children.length - 1,
        lines,
      );
    });
  }

  /** Render a single tool call. */
  renderToolCall(tc: ToolCallView): string {
    const lines: string[] = [];
    lines.push(
      `${this.c('TOOL:', PALETTE.primary)} ${this.c(tc.toolName, PALETTE.secondary)} ` +
        `${this.c(`[${TOOL_ICON[tc.status]}]`, TOOL_COLOR[tc.status])}` +
        (tc.durationMs !== undefined
          ? ` ${this.c(`${tc.durationMs}ms`, PALETTE.muted)}`
          : ''),
    );
    if (tc.input !== undefined) {
      lines.push(`${this.c('in:', PALETTE.dim)} ${this.c(this.safeJson(tc.input), PALETTE.muted)}`);
    }
    if (tc.diff) {
      lines.push(this.renderDiff(tc.diff));
    }
    if (tc.output !== undefined) {
      lines.push(
        `${this.c('out:', PALETTE.dim)} ${this.c(this.safeJson(tc.output), PALETTE.muted)}`,
      );
    }
    return lines.join('\n');
  }

  /** Render a unified diff string. */
  renderDiff(diff: string): string {
    return diff
      .split('\n')
      .map((line) => {
        if (line.startsWith('@@')) return this.c(line, PALETTE.primary);
        if (line.startsWith('+++') || line.startsWith('---')) {
          return this.c(line, PALETTE.muted);
        }
        if (line.startsWith('+')) return this.c(`+${line.slice(1)}`, PALETTE.success);
        if (line.startsWith('-')) return this.c(`-${line.slice(1)}`, PALETTE.error);
        return this.c(` ${line}`, PALETTE.dim);
      })
      .join('\n');
  }

  /** Safe JSON stringification — never throws. */
  private safeJson(value: unknown): string {
    if (value === undefined) return '';
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
}

export default NonTuiRenderer;
