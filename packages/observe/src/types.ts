/**
 * @file types.ts
 * @description Shared types for `@sanix/observe` — the Span, Metric, and
 * Exporter contracts used by the tracer, metrics registry, agent observer,
 * and exporters.
 *
 * @packageDocumentation
 */

/**
 * Status of a span. `unset` until {@link Span.end} is called (which
 * sets `ok` by default) or {@link Span.setStatus} is invoked explicitly.
 */
export type SpanStatus = 'ok' | 'error' | 'unset';

/**
 * A timestamped event attached to a span (analogous to OTel's `addEvent`).
 */
export interface SpanEvent {
  /** Event name. */
  name: string;
  /** Unix ms timestamp. */
  timestamp: number;
  /** Optional event attributes. */
  attributes?: Record<string, unknown>;
}

/**
 * A span — the unit of work in distributed tracing. Mirrors a subset of
 * the OpenTelemetry Span API, but implemented in pure TypeScript with no
 * `@opentelemetry/api` runtime dependency.
 *
 * Spans are created via {@link SanixTracer.startSpan} or
 * {@link SanixTracer.withSpan}, and they live in an in-memory tree owned
 * by the tracer. The {@link end} method finalizes the span (sets
 * `endTime`, marks it exported-eligible).
 */
export interface Span {
  /** Stable unique id (nanoid). */
  id: string;
  /** Human-readable span name (e.g. `llm:chat`, `tool:read_file`). */
  name: string;
  /** Parent span id, or undefined for a root span. */
  parentId?: string;
  /** Unix ms timestamp when the span started. */
  startTime: number;
  /** Unix ms timestamp when the span ended (set by {@link end}). */
  endTime?: number;
  /** Span attributes (free-form key/value). */
  attributes: Map<string, unknown>;
  /** Timestamped events attached to the span. */
  events: SpanEvent[];
  /** Span status (ok / error / unset). */
  status: SpanStatus;
  /** Mark the span's status. */
  setStatus: (s: SpanStatus) => void;
  /** Set a single attribute. */
  setAttribute: (key: string, value: unknown) => void;
  /** Add a timestamped event (optionally with attributes). */
  addEvent: (name: string, attributes?: Record<string, unknown>) => void;
  /** Finalize the span (set endTime, mark `ok` if status was `unset`). */
  end: () => void;
}

/**
 * JSON-serialized form of a Span (as produced by {@link SanixTracer.exportJSON}
 * and consumed by the JSONL exporter).
 */
export interface SerializedSpan {
  id: string;
  name: string;
  parentId?: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  attributes: Record<string, unknown>;
  events: SpanEvent[];
  status: SpanStatus;
}

/**
 * Chrome Trace Event format object. See
 * https://docs.google.com/document/d/1CvAClvFfyA5R5PhMUUQzpE7GEcx0MnS5KZfA_lXQPxA
 */
export interface TraceEvent {
  /** Event type. `X` for complete (begin+end) events. */
  ph: 'X' | 'B' | 'E' | 'i' | 'M';
  /** Process id (we use 1). */
  pid: number;
  /** Thread id (we use 1). */
  tid: number;
  /** Event timestamp in microseconds. */
  ts: number;
  /** Event duration in microseconds (only for `ph: 'X'`). */
  dur?: number;
  /** Event name. */
  name: string;
  /** Event arguments / attributes. */
  args?: Record<string, unknown>;
  /** Optional category. */
  cat?: string;
}

/**
 * OpenTelemetry OTLP/JSON shape (a strict subset — enough to be ingested
 * by Jaeger, Tempo, and Honeycomb's OTLP collectors).
 *
 * @see https://opentelemetry.io/docs/specs/otlp/
 */
export interface OTLPExport {
  resourceSpans: Array<{
    resource: {
      attributes: Array<{ key: string; value: { stringValue: string } }>;
    };
    scopeSpans: Array<{
      scope: { name: string; version?: string };
      spans: Array<{
        traceId: string;
        spanId: string;
        parentSpanId?: string;
        name: string;
        kind: number;
        startTimeUnixNano: string;
        endTimeUnixNano: string;
        attributes: Array<{ key: string; value: OTLPValue }>;
        events: Array<{
          name: string;
          timeUnixNano: string;
          attributes?: Array<{ key: string; value: OTLPValue }>;
        }>;
        status: { code: number; message?: string };
      }>;
    }>;
  }>;
}

/**
 * OTLP attribute value (one of the tagged union members).
 */
export type OTLPValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean };

// ─── Metrics ─────────────────────────────────────────────────────────────────

/**
 * A counter — monotonically increasing value. Returned by
 * {@link MetricsRegistry.counter}.
 */
export interface Counter {
  /** Increment by 1 (default) or `n`. */
  inc: (n?: number) => void;
  /** Current value. */
  value: () => number;
}

/**
 * A gauge — a value that can go up or down. Returned by
 * {@link MetricsRegistry.gauge}.
 */
export interface Gauge {
  /** Set the gauge to a specific value. */
  set: (n: number) => void;
  /** Increment / decrement the gauge. */
  inc: (n?: number) => void;
  /** Decrement the gauge. */
  dec: (n?: number) => void;
  /** Current value. */
  value: () => number;
}

/**
 * A histogram — observes a distribution of values. Tracks count, sum,
 * min, max, and a configurable set of buckets. Returned by
 * {@link MetricsRegistry.histogram}.
 */
export interface Histogram {
  /** Observe a single value. */
  observe: (n: number) => void;
  /** Number of observations so far. */
  count: () => number;
  /** Sum of all observations. */
  sum: () => number;
  /** Minimum observed value. */
  min: () => number;
  /** Maximum observed value. */
  max: () => number;
}

/**
 * Per-label-set snapshot of a counter or gauge.
 */
export interface LabeledValueSnapshot {
  /** The value. */
  value: number;
  /** The label set that produced this value. */
  labels: Record<string, string>;
}

/**
 * Per-label-set snapshot of a histogram.
 */
export interface HistogramSnapshot {
  /** Number of observations. */
  count: number;
  /** Sum of observations. */
  sum: number;
  /** Minimum observed value. */
  min: number;
  /** Maximum observed value. */
  max: number;
  /** Cumulative counts per bucket boundary. */
  buckets: Record<string, number>;
  /** The label set that produced this snapshot. */
  labels: Record<string, string>;
}

/**
 * A complete snapshot of the metrics registry at a point in time.
 * Returned by {@link MetricsRegistry.snapshot}.
 */
export interface MetricsSnapshot {
  /** Counters keyed by metric name; values are per-label snapshots. */
  counters: Record<string, LabeledValueSnapshot[]>;
  /** Gauges keyed by metric name; values are per-label snapshots. */
  gauges: Record<string, LabeledValueSnapshot[]>;
  /** Histograms keyed by metric name; values are per-label snapshots. */
  histograms: Record<string, HistogramSnapshot[]>;
}

// ─── Exporters ───────────────────────────────────────────────────────────────

/**
 * The shape of any exporter. Exporters receive a batch of finalized
 * spans and ship them somewhere (console, JSONL file, OTLP collector).
 */
export interface Exporter {
  /** A human-readable name (for logging). */
  readonly name: string;
  /**
   * Export a batch of spans. Should be idempotent and never throw —
   * exporters must degrade gracefully (e.g. log to stderr) on failure.
   */
  export: (spans: SerializedSpan[]) => Promise<void>;
  /** Flush any buffered state and free resources. */
  flush: () => Promise<void>;
}

/**
 * Constructor options for `createExporter('otlp', opts)`.
 */
export interface OTLPExporterOptions {
  /** Collector endpoint. Default `http://localhost:4318/v1/traces`. */
  endpoint?: string;
  /** Batch size (default 64). */
  batchSize?: number;
  /** Flush interval in ms (default 5000). */
  flushIntervalMs?: number;
  /** Optional Authorization header value (e.g. `Bearer ...`). */
  authHeader?: string;
  /** Optional service.name for the OTLP resource (default `sanix`). */
  serviceName?: string;
}

/**
 * Constructor options for `createExporter('jsonl', opts)`.
 */
export interface JSONLExporterOptions {
  /** Output file path. Default `~/.sanix/traces.jsonl`. */
  filePath?: string;
}

/**
 * Constructor options for `createExporter('console', opts)`.
 */
export interface ConsoleExporterOptions {
  /** Optional output stream (default `process.stdout`). */
  stream?: { write: (s: string) => void };
}
