/**
 * @file Transport.ts
 * @description Built-in {@link Transport} implementations:
 *
 *   - `console` — pretty-print events to a stream (default `process.stderr`).
 *   - `http`    — POST events to a Sentry-compatible envelope endpoint.
 *   - `jsonl`   — append events as newline-delimited JSON to a file.
 *   - `noop`    — discard all events (useful for tests).
 *
 * Use `createTransport(kind, opts)` to construct one.
 *
 * @packageDocumentation
 */

import { mkdirSync, appendFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { homedir } from 'node:os';
import type {
  ConsoleTransportOptions,
  ErrorEvent,
  HTTPTransportOptions,
  JSONLTransportOptions,
  Transport,
} from './types.js';

/** Severity ordering (for `minLevel` filtering). */
const SEVERITY_RANK: Record<string, number> = {
  debug: 10,
  info: 20,
  warning: 30,
  error: 40,
  fatal: 50,
};

/**
 * Construct a built-in transport.
 *
 * @param kind `'console'` | `'http'` | `'jsonl'` | `'noop'`.
 * @param opts Transport-specific options.
 *
 * @example
 * ```ts
 * const t = createTransport('console', { minLevel: 'warning' });
 * const h = createTransport('http', { endpoint: 'https://sentry.io/api/1/envelope/' });
 * ```
 */
export function createTransport(
  kind: 'console',
  opts?: ConsoleTransportOptions,
): Transport;
export function createTransport(
  kind: 'http',
  opts: HTTPTransportOptions,
): Transport;
export function createTransport(
  kind: 'jsonl',
  opts?: JSONLTransportOptions,
): Transport;
export function createTransport(kind: 'noop'): Transport;
export function createTransport(
  kind: 'console' | 'http' | 'jsonl' | 'noop',
  opts?: ConsoleTransportOptions | HTTPTransportOptions | JSONLTransportOptions,
): Transport {
  switch (kind) {
    case 'console':
      return new ConsoleTransport(opts as ConsoleTransportOptions | undefined);
    case 'http':
      return new HTTPTransport(opts as HTTPTransportOptions);
    case 'jsonl':
      return new JSONLTransport(opts as JSONLTransportOptions | undefined);
    case 'noop':
      return new NoopTransport();
    default:
      throw new Error(`unknown transport kind: ${kind}`);
  }
}

/** Pretty-print events to a stream. */
class ConsoleTransport implements Transport {
  readonly name = 'console';
  private readonly stream: { write: (s: string) => void };
  private readonly minLevel: number;

  constructor(opts: ConsoleTransportOptions = {}) {
    this.stream = opts.stream ?? process.stderr;
    this.minLevel = SEVERITY_RANK[opts.minLevel ?? 'warning'] ?? 30;
  }

  async send(event: ErrorEvent): Promise<void> {
    if ((SEVERITY_RANK[event.level] ?? 40) < this.minLevel) return;
    const line = `[${event.level.toUpperCase()}] ${event.name}: ${event.message} (${event.fingerprint})\n`;
    this.stream.write(line);
  }
  async flush(): Promise<void> { /* no buffering */ }
  async close(): Promise<void> { /* no resources */ }
}

/** POST events to a Sentry-compatible envelope endpoint. */
class HTTPTransport implements Transport {
  readonly name = 'http';
  private readonly endpoint: string;
  private readonly authHeader?: string;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly buffer: ErrorEvent[] = [];
  private timer?: ReturnType<typeof setInterval>;

  constructor(opts: HTTPTransportOptions) {
    this.endpoint = opts.endpoint;
    this.authHeader = opts.authHeader;
    this.batchSize = opts.batchSize ?? 10;
    this.flushIntervalMs = opts.flushIntervalMs ?? 5000;
    this.timer = setInterval(() => { void this.flush(); }, this.flushIntervalMs);
    // Don't keep the event loop alive solely for this timer.
    this.timer.unref?.();
  }

  async send(event: ErrorEvent): Promise<void> {
    this.buffer.push(event);
    if (this.buffer.length >= this.batchSize) await this.flush();
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0, this.buffer.length);
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (this.authHeader) headers.authorization = this.authHeader;
      await fetch(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(batch),
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[telemetry] http transport failed:`, err);
    }
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }
}

/** Append events as newline-delimited JSON to a file. */
class JSONLTransport implements Transport {
  readonly name = 'jsonl';
  private readonly filePath: string;

  constructor(opts: JSONLTransportOptions = {}) {
    this.filePath = opts.filePath ?? resolvePath(homedir(), '.sanix', 'telemetry.jsonl');
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
    } catch {
      // ignore — write will fail loudly below.
    }
  }

  async send(event: ErrorEvent): Promise<void> {
    try {
      appendFileSync(this.filePath, JSON.stringify(event) + '\n', { encoding: 'utf8' });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[telemetry] jsonl transport failed:`, err);
    }
  }
  async flush(): Promise<void> { /* appendFileSync is unbuffered */ }
  async close(): Promise<void> { /* no resources */ }
}

/** Discard all events. */
class NoopTransport implements Transport {
  readonly name = 'noop';
  async send(): Promise<void> { /* discard */ }
  async flush(): Promise<void> { /* discard */ }
  async close(): Promise<void> { /* discard */ }
}
