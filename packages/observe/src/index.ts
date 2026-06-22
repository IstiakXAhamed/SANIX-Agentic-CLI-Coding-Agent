/**
 * @file index.ts
 * @description Public entry point for `@sanix/observe`. Re-exports the
 * tracer, metrics registry, agent observer, and all shared types.
 *
 * Importing paths:
 *   import { SanixTracer, MetricsRegistry, AgentObserver } from '@sanix/observe';
 *   import { createExporter } from '@sanix/observe/exporters';
 *   import type { Span, MetricsSnapshot } from '@sanix/observe';
 *
 * @packageDocumentation
 */

export { SanixTracer, type TracerEvents } from './Tracer.js';
export {
  MetricsRegistry,
  SANIX_METRICS,
} from './Metrics.js';
export { AgentObserver, type AgentObserverOptions } from './AgentObserver.js';

export type {
  Span,
  SpanEvent,
  SpanStatus,
  SerializedSpan,
  TraceEvent,
  OTLPExport,
  OTLPValue,
  Counter,
  Gauge,
  Histogram,
  LabeledValueSnapshot,
  HistogramSnapshot,
  MetricsSnapshot,
  Exporter,
  ConsoleExporterOptions,
  JSONLExporterOptions,
  OTLPExporterOptions,
} from './types.js';
