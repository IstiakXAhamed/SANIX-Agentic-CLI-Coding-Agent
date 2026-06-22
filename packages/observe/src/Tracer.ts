/**
 * @file Tracer.ts
 * @description Lightweight OpenTelemetry-compatible tracing for SANIX.
 *
 * Rather than pulling in the full `@opentelemetry/api` + SDK graph (which
 * adds ~3 MB of compiled code and ~20 transitive deps), we implement just
 * enough of the API to:
 *
 *   - Build a span tree in memory (`startSpan`, `withSpan`).
 *   - Attach attributes, events, and status to spans.
 *   - Export the span tree in three formats:
 *     - `exportJSON()`        — plain JSON array (for ad-hoc inspection).
 *     - `exportTraceEvent()`  — Chrome Trace Event format (loadable in
 *                                `chrome://tracing`).
 *     - `exportOTLP()`        — OTLP/JSON (for Jaeger, Tempo, Honeycomb).
 *
 * @packageDocumentation
 */

import { EventEmitter } from 'eventemitter3';
import { nanoid } from 'nanoid';
import type {
  OTLPExport,
  OTLPValue,
  SerializedSpan,
  Span,
  SpanEvent,
  SpanStatus,
  TraceEvent,
} from './types.js';

/**
 * Events emitted by {@link SanixTracer}. Subscribers attach via
 * `tracer.on('span:end', (span) => ...)`.
 */
export interface TracerEvents {
  /** Fired when a span starts. */
  'span:start': { span: Span };
  /** Fired when a span ends. */
  'span:end': { span: Span };
}

/**
 * Convert a span attribute value into an OTLP value object.
 */
function toOTLPValue(v: unknown): OTLPValue {
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return { intValue: String(v) };
    return { doubleValue: v };
  }
  // Objects / arrays / null → JSON-stringify.
  return { stringValue: JSON.stringify(v) };
}

/**
 * A lightweight OpenTelemetry-compatible tracer. One instance per SANIX
 * process (or per agent run). Maintains an in-memory span tree and emits
 * `span:start` / `span:end` events.
 *
 * @example
 * ```ts
 * const tracer = new SanixTracer();
 * const root = tracer.startSpan('agent:run', { attributes: { goal: '...' } });
 * const child = tracer.startSpan('llm:chat', { parent: root });
 * // ... do work ...
 * child.end();
 * root.end();
 * console.log(tracer.exportJSON());
 * ```
 */
export class SanixTracer extends EventEmitter<TracerEvents> {
  /** All spans created by this tracer, in creation order. */
  private readonly spans: Span[] = [];
  /** The currently-active span (most recent start, not yet ended). */
  private current: Span | null = null;

  /**
   * Start a new span. If `opts.parent` is provided, the new span is a
   * child of that span; otherwise, if there is a current span, the new
   * span is a child of it (auto-parenting); otherwise, the new span is
   * a root span.
   *
   * @param name - The span name (e.g. `llm:chat`, `tool:read_file`).
   * @param opts - Optional `{ parent?, attributes? }`.
   * @returns The new span.
   *
   * @example
   * ```ts
   * const span = tracer.startSpan('tool:exec', {
   *   attributes: { tool: 'bash', command: 'ls' },
   * });
   * try {
   *   // ... do work ...
   *   span.setStatus('ok');
   * } catch (e) {
   *   span.setStatus('error');
   *   span.setAttribute('error.message', (e as Error).message);
   *   throw e;
   * } finally {
   *   span.end();
   * }
   * ```
   */
  startSpan(
    name: string,
    opts: { parent?: Span; attributes?: Record<string, unknown> } = {},
  ): Span {
    const parent = opts.parent ?? this.current;
    const span: Span = this.createSpan(name, parent?.id);
    if (opts.attributes) {
      for (const [k, v] of Object.entries(opts.attributes)) {
        span.setAttribute(k, v);
      }
    }
    this.spans.push(span);
    this.current = span;
    this.emit('span:start', { span });
    return span;
  }

  /**
   * Get the currently-active span (most recent start, not yet ended).
   */
  getCurrentSpan(): Span | null {
    return this.current;
  }

  /**
   * Convenience wrapper for the common pattern of starting a span,
   * running an async function, and ending the span (with status
   * `error` if the function throws).
   *
   * @param name - The span name.
   * @param fn   - The async function to run. Receives the new span.
   * @param opts - Optional `{ attributes? }`.
   * @returns Whatever `fn` returns.
   *
   * @example
   * ```ts
   * const result = await tracer.withSpan(
   *   'llm:chat',
   *   async (span) => {
   *     const r = await provider.chat(req);
   *     span.setAttribute('tokens.in', r.usage.inputTokens);
   *     span.setAttribute('tokens.out', r.usage.outputTokens);
   *     return r;
   *   },
   *   { attributes: { provider: provider.id } },
   * );
   * ```
   */
  async withSpan<T>(
    name: string,
    fn: (span: Span) => Promise<T>,
    opts: { attributes?: Record<string, unknown> } = {},
  ): Promise<T> {
    const span = this.startSpan(name, opts);
    const prev = this.current;
    try {
      this.current = span;
      const result = await fn(span);
      if (span.status === 'unset') span.setStatus('ok');
      return result;
    } catch (err) {
      span.setStatus('error');
      if (err instanceof Error) {
        span.setAttribute('error.message', err.message);
        span.setAttribute('error.type', err.name);
      } else {
        span.setAttribute('error.message', String(err));
      }
      throw err;
    } finally {
      span.end();
      this.current = prev;
    }
  }

  /**
   * Export all spans as a JSON array (the {@link SerializedSpan} shape).
   * Useful for ad-hoc inspection or as input to a custom exporter.
   */
  exportJSON(): string {
    return JSON.stringify(this.serialize(), null, 2);
  }

  /**
   * Export all spans in Chrome Trace Event format (loadable in
   * `chrome://tracing`). Each span becomes a complete (`ph: 'X'`)
   * event with `ts`/`dur` in microseconds.
   */
  exportTraceEvent(): string {
    const events: TraceEvent[] = [];
    for (const span of this.spans) {
      const ts = Math.floor(span.startTime * 1000);
      const dur =
        span.endTime !== undefined
          ? Math.max(0, Math.floor((span.endTime - span.startTime) * 1000))
          : 0;
      const args: Record<string, unknown> = {};
      for (const [k, v] of span.attributes) args[k] = v;
      if (span.parentId) args['parentId'] = span.parentId;
      events.push({
        ph: 'X',
        pid: 1,
        tid: 1,
        ts,
        dur,
        name: span.name,
        args,
        cat: 'sanix',
      });
    }
    return JSON.stringify(events, null, 2);
  }

  /**
   * Export all spans in OTLP/JSON format (POSTable to any OTLP HTTP
   * collector). Each span gets a deterministic 16-byte traceId shared
   * across the tree, an 8-byte spanId, and (if applicable) a parentSpanId.
   */
  exportOTLP(): OTLPExport {
    const traceId = nanoid(16).padEnd(16, '0').slice(0, 16);
    const spans = this.serialize();
    return {
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: 'sanix' } },
            ],
          },
          scopeSpans: [
            {
              scope: { name: '@sanix/observe', version: '1.0.0' },
              spans: spans.map((s) => {
                const spanId = s.id.padEnd(8, '0').slice(0, 8);
                return {
                  traceId,
                  spanId,
                  parentSpanId: s.parentId
                    ? s.parentId.padEnd(8, '0').slice(0, 8)
                    : undefined,
                  name: s.name,
                  kind: 0, // INTERNAL
                  startTimeUnixNano: String(BigInt(s.startTime) * 1_000_000n),
                  endTimeUnixNano: s.endTime !== undefined
                    ? String(BigInt(s.endTime) * 1_000_000n)
                    : String(BigInt(s.startTime) * 1_000_000n),
                  attributes: Object.entries(s.attributes).map(([k, v]) => ({
                    key: k,
                    value: toOTLPValue(v),
                  })),
                  events: s.events.map((e: SpanEvent) => ({
                    name: e.name,
                    timeUnixNano: String(BigInt(e.timestamp) * 1_000_000n),
                    attributes: e.attributes
                      ? Object.entries(e.attributes).map(([k, v]) => ({
                          key: k,
                          value: toOTLPValue(v),
                        }))
                      : undefined,
                  })),
                  status: {
                    code: s.status === 'error' ? 2 : s.status === 'ok' ? 1 : 0,
                  },
                };
              }),
            },
          ],
        },
      ],
    };
  }

  /**
   * Return a serialized snapshot of all spans (no JSON string). Useful
   * for programmatic consumers (e.g. the exporters).
   */
  serialize(): SerializedSpan[] {
    return this.spans.map((s) => ({
      id: s.id,
      name: s.name,
      parentId: s.parentId,
      startTime: s.startTime,
      endTime: s.endTime,
      durationMs:
        s.endTime !== undefined ? s.endTime - s.startTime : undefined,
      attributes: Object.fromEntries(s.attributes),
      events: s.events,
      status: s.status,
    }));
  }

  /**
   * Drop all spans. Mainly useful in tests.
   */
  reset(): void {
    this.spans.length = 0;
    this.current = null;
  }

  /**
   * Return all live (non-serialized) span objects. Mainly useful for
   * in-process inspection by exporters.
   */
  spans_(): Span[] {
    return [...this.spans];
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  /**
   * Construct a span object. The span's `end()` method finalizes the span
   * and emits `span:end`; it also pops the current-span pointer if it
   * matches.
   */
  private createSpan(name: string, parentId?: string): Span {
    const id = nanoid(8);
    const startTime = Date.now();
    const attributes = new Map<string, unknown>();
    const events: SpanEvent[] = [];
    let status: SpanStatus = 'unset';
    let endTime: number | undefined;
    const self = this;
    const span: Span = {
      id,
      name,
      parentId,
      startTime,
      endTime,
      attributes,
      events,
      status,
      setStatus(s: SpanStatus) {
        status = s;
        this.status = s;
      },
      setAttribute(key: string, value: unknown) {
        attributes.set(key, value);
      },
      addEvent(eventName: string, attrs?: Record<string, unknown>) {
        events.push({
          name: eventName,
          timestamp: Date.now(),
          attributes: attrs,
        });
      },
      end() {
        if (endTime !== undefined) return; // idempotent
        endTime = Date.now();
        this.endTime = endTime;
        if (status === 'unset') {
          status = 'ok';
          this.status = 'ok';
        }
        if (self.current === this) self.current = parentId ? self.findById(parentId) : null;
        self.emit('span:end', { span: this });
      },
    };
    return span;
  }

  /**
   * Find a span by id (used to restore the parent as the current span
   * when a child ends).
   */
  private findById(id: string): Span | null {
    for (let i = this.spans.length - 1; i >= 0; i--) {
      if (this.spans[i]!.id === id) return this.spans[i]!;
    }
    return null;
  }
}
