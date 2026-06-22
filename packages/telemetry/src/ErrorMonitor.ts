/**
 * @file ErrorMonitor.ts
 * @description Capture errors, compute a stable fingerprint (so similar
 * errors group together), attach the current breadcrumbs, and forward
 * the resulting {@link ErrorEvent} to one or more {@link Transport}s.
 *
 * @packageDocumentation
 */

import { Breadcrumbs } from './Breadcrumbs.js';
import type { Breadcrumb, ErrorEvent, Severity, Transport } from './types.js';

/** Options for {@link ErrorMonitor}. */
export interface ErrorMonitorOptions {
  /** Release / version tag attached to every event. */
  release?: string;
  /** Environment tag (e.g. `production`). */
  environment?: string;
  /** Default tags attached to every event. */
  tags?: Record<string, string>;
  /** Breadcrumb capacity. Default 50. */
  breadcrumbCapacity?: number;
  /** Stable id generator (defaults to crypto.randomUUID). */
  idGenerator?: () => string;
}

/**
 * Capture errors and forward them to transports.
 *
 * @example
 * ```ts
 * const m = new ErrorMonitor({ release: '1.2.3' }, [transport]);
 * m.captureError(new TypeError('x is undefined'));
 * m.addBreadcrumb('ui', 'user clicked save');
 * ```
 */
export class ErrorMonitor {
  private readonly release?: string;
  private readonly environment?: string;
  private readonly tags?: Record<string, string>;
  private readonly breadcrumbs: Breadcrumbs;
  private readonly transports: Transport[] = [];
  private readonly idGenerator: () => string;

  constructor(opts: ErrorMonitorOptions = {}, transports: Transport[] = []) {
    this.release = opts.release;
    this.environment = opts.environment;
    this.tags = opts.tags;
    this.breadcrumbs = new Breadcrumbs({ maxSize: opts.breadcrumbCapacity ?? 50 });
    this.idGenerator = opts.idGenerator ?? (() => safeRandomUUID());
    for (const t of transports) this.transports.push(t);
  }

  /** Add a transport. */
  addTransport(t: Transport): void {
    this.transports.push(t);
  }

  /**
   * Add a breadcrumb to the buffer.
   *
   * @param category Category.
   * @param message Message.
   * @param level Severity. Default `info`.
   * @param data Optional structured data.
   */
  addBreadcrumb(category: string, message: string, level: Severity = 'info', data?: Record<string, unknown>): void {
    this.breadcrumbs.add(category, message, level, data);
  }

  /** Snapshot of current breadcrumbs. */
  getBreadcrumbs(): Breadcrumb[] {
    return this.breadcrumbs.snapshot();
  }

  /**
   * Capture an error and forward it to all transports. Never throws —
   * transport failures are swallowed (and reported via `console.error`).
   *
   * @param err The error (or error-like object).
   * @param opts.level Severity. Default `error`.
   * @param opts.extra Extra context.
   * @param opts.tags Per-event tags (merged with default tags).
   * @returns The constructed {@link ErrorEvent}.
   */
  captureError(
    err: unknown,
    opts: { level?: Severity; extra?: Record<string, unknown>; tags?: Record<string, string> } = {},
  ): ErrorEvent {
    const e = toErrorLike(err);
    const event: ErrorEvent = {
      id: this.idGenerator(),
      fingerprint: fingerprint(e.name, e.message, e.stack),
      name: e.name,
      message: e.message,
      stack: e.stack,
      level: opts.level ?? 'error',
      timestamp: Date.now(),
      release: this.release,
      environment: this.environment,
      tags: { ...this.tags, ...opts.tags },
      extra: opts.extra,
      breadcrumbs: this.breadcrumbs.snapshot(),
    };
    // Fire-and-forget; never let transport errors escape.
    for (const t of this.transports) {
      Promise.resolve().then(() => t.send(event)).catch((sendErr) => {
        // eslint-disable-next-line no-console
        console.error(`[telemetry] transport ${t.name} failed:`, sendErr);
      });
    }
    return event;
  }

  /** Flush all transports (e.g. before a clean shutdown). */
  async flush(): Promise<void> {
    await Promise.allSettled(this.transports.map((t) => t.flush()));
  }

  /** Close all transports. */
  async close(): Promise<void> {
    await Promise.allSettled(this.transports.map((t) => t.close()));
  }
}

/** Coerce an unknown thrown value into an Error-like shape. */
function toErrorLike(err: unknown): { name: string; message: string; stack?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message, stack: err.stack };
  if (typeof err === 'string') return { name: 'Error', message: err };
  if (err !== null && typeof err === 'object') {
    const o = err as { name?: unknown; message?: unknown; stack?: unknown };
    return {
      name: typeof o.name === 'string' ? o.name : 'Error',
      message: typeof o.message === 'string' ? o.message : JSON.stringify(err),
      stack: typeof o.stack === 'string' ? o.stack : undefined,
    };
  }
  return { name: 'Error', message: String(err) };
}

/**
 * Compute a stable fingerprint from name + message + the first stack frame.
 * Two errors with the same name+message+top-of-stack will share a fingerprint.
 */
function fingerprint(name: string, message: string, stack?: string): string {
  // Use first non-empty stack frame for location; fall back to message.
  let loc = '';
  if (stack) {
    const lines = stack.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length > 1) loc = lines[1] ?? '';
  }
  const raw = `${name}|${message}|${loc}`;
  // FNV-1a 32-bit hash → hex string.
  let h = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Safe UUID v4 generator (falls back to Math.random if crypto is missing). */
function safeRandomUUID(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // fall through
  }
  // RFC-4122 v4-ish fallback.
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}
