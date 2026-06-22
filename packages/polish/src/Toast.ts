/**
 * @file Toast.ts
 * @description VS Code-style toast notifications. Toasts appear at the
 * bottom-right of the terminal, stack vertically, and auto-dismiss after
 * a configurable timeout. Four severities: info, success, warning, error.
 *
 * Each toast is rendered as a single line with an icon + message + (optional)
 * action key. The renderer manages a small in-memory queue and redraws the
 * stack on each push / dismiss.
 *
 * @packageDocumentation
 */

import { SANIX_PALETTE } from './brand.js';
import { rgb, bold, cursorUp, clearLine, cursorToCol0, type RGB } from './ansi.js';

/** Toast severity. */
export type ToastSeverity = 'info' | 'success' | 'warning' | 'error';

/** Per-severity icon + color. */
const SEVERITY_STYLE: Readonly<Record<ToastSeverity, { icon: string; color: RGB }>> = {
  info: { icon: 'ℹ', color: SANIX_PALETTE.teal },
  success: { icon: '✓', color: { r: 74, g: 222, b: 128 } }, // green-400
  warning: { icon: '⚠', color: SANIX_PALETTE.amber },
  error: { icon: '✗', color: SANIX_PALETTE.rose },
};

/** Options for a single toast. */
export interface ToastOptions {
  /** Severity. Default `info`. */
  severity?: ToastSeverity;
  /** Auto-dismiss ms (default 4000). 0 = sticky. */
  durationMs?: number;
  /** Optional action key (e.g. `[R] retry`). */
  action?: string;
}

/** A managed toast instance. */
interface ToastInstance {
  id: number;
  message: string;
  severity: ToastSeverity;
  action?: string;
  timer?: ReturnType<typeof setTimeout>;
}

/** Options for {@link ToastManager}. */
export interface ToastManagerOptions {
  /** Output stream (default `process.stderr`). */
  stream?: { write: (s: string) => void };
  /** Max toasts on screen at once. Default 5. */
  maxVisible?: number;
}

/**
 * VS Code-style toast notifications.
 *
 * @example
 * ```ts
 * const t = new ToastManager();
 * t.push('Build complete', { severity: 'success' });
 * t.push('Failed to fetch', { severity: 'error', action: '[R] retry' });
 * ```
 */
export class ToastManager {
  private readonly stream: { write: (s: string) => void };
  private readonly maxVisible: number;
  private readonly toasts: ToastInstance[] = [];
  private counter = 0;

  constructor(opts: ToastManagerOptions = {}) {
    this.stream = opts.stream ?? process.stderr;
    this.maxVisible = opts.maxVisible ?? 5;
  }

  /**
   * Push a toast. Returns the toast id (use with {@link dismiss}).
   *
   * @param message The toast message.
   * @param opts See {@link ToastOptions}.
   */
  push(message: string, opts: ToastOptions = {}): number {
    const id = ++this.counter;
    const severity = opts.severity ?? 'info';
    const durationMs = opts.durationMs ?? 4000;
    const inst: ToastInstance = { id, message, severity, action: opts.action };
    this.toasts.push(inst);
    if (durationMs > 0) {
      inst.timer = setTimeout(() => this.dismiss(id), durationMs);
      inst.timer.unref?.();
    }
    this.render();
    return id;
  }

  /**
   * Dismiss a toast by id.
   *
   * @param id The toast id returned by {@link push}.
   */
  dismiss(id: number): void {
    const idx = this.toasts.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const [removed] = this.toasts.splice(idx, 1);
    if (removed?.timer) clearTimeout(removed.timer);
    this.render();
  }

  /** Dismiss all toasts. */
  clear(): void {
    for (const t of this.toasts) if (t.timer) clearTimeout(t.timer);
    this.toasts.length = 0;
    this.render();
  }

  /** Re-render the visible toast stack. */
  private render(): void {
    // Erase previous render (maxVisible lines).
    for (let i = 0; i < this.maxVisible; i++) this.stream.write(cursorUp(1) + clearLine());
    this.stream.write(cursorToCol0());
    const visible = this.toasts.slice(-this.maxVisible);
    for (const t of visible) {
      const style = SEVERITY_STYLE[t.severity];
      const icon = rgb(style.icon, style.color);
      const msg = t.severity === 'error' ? bold(t.message) : t.message;
      const action = t.action ? ` ${rgb(t.action, style.color)}` : '';
      this.stream.write(`${icon} ${msg}${action}\n`);
    }
    // If we have fewer toasts than maxVisible, pad with blank lines.
    for (let i = visible.length; i < this.maxVisible; i++) {
      this.stream.write('\n');
    }
  }
}
