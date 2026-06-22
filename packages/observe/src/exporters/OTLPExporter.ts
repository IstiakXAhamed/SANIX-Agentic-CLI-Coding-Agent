/**
 * @file OTLPExporter.ts
 * @description POSTs finalized spans as OTLP/JSON to an OTLP HTTP collector
 * (default `http://localhost:4318/v1/traces`). Batches up to `batchSize`
 * spans and flushes at most every `flushIntervalMs` (default 5s). Degrades
 * gracefully — if the collector is unreachable, the batch is dropped
 * (with a stderr warning) and the exporter continues.
 *
 * @packageDocumentation
 */

import type {
  Exporter,
  OTLPExporterOptions,
  SerializedSpan,
} from '../types.js';

/**
 * Default collector endpoint.
 */
const DEFAULT_ENDPOINT = 'http://localhost:4318/v1/traces';

/**
 * Create an OTLP exporter that POSTs batches of spans to an OTLP HTTP
 * collector.
 *
 * @param opts - See {@link OTLPExporterOptions}.
 * @returns An {@link Exporter}.
 *
 * @example
 * ```ts
 * const exporter = createOTLPExporter({ endpoint: 'http://localhost:4318/v1/traces' });
 * tracer.on('span:end', async () => {
 *   await exporter.export(tracer.serialize().filter(s => s.endTime));
 * });
 * // On shutdown:
 * await exporter.flush();
 * ```
 */
export function createOTLPExporter(
  opts: OTLPExporterOptions = {},
): Exporter {
  const endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
  const batchSize = opts.batchSize ?? 64;
  const flushIntervalMs = opts.flushIntervalMs ?? 5_000;
  const authHeader = opts.authHeader;
  const serviceName = opts.serviceName ?? 'sanix';

  const batch: SerializedSpan[] = [];
  let flushTimer: NodeJS.Timeout | null = null;
  let flushing = false;

  const buildPayload = (spans: SerializedSpan[]): unknown => {
    const traceId = makeTraceId();
    return {
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: serviceName } },
            ],
          },
          scopeSpans: [
            {
              scope: { name: '@sanix/observe', version: '1.0.0' },
              spans: spans.map((s) => ({
                traceId,
                spanId: makeSpanId(s.id),
                parentSpanId: s.parentId ? makeSpanId(s.parentId) : undefined,
                name: s.name,
                kind: 0,
                startTimeUnixNano: String(BigInt(s.startTime) * 1_000_000n),
                endTimeUnixNano: s.endTime !== undefined
                  ? String(BigInt(s.endTime) * 1_000_000n)
                  : String(BigInt(s.startTime) * 1_000_000n),
                attributes: Object.entries(s.attributes).map(([k, v]) => ({
                  key: k,
                  value: toOTLPValue(v),
                })),
                events: s.events.map((e) => ({
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
              })),
            },
          ],
        },
      ],
    };
  };

  const flush = async (): Promise<void> => {
    if (flushing || batch.length === 0) return;
    flushing = true;
    const sending = batch.splice(0, batch.length);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authHeader ? { Authorization: authHeader } : {}),
        },
        body: JSON.stringify(buildPayload(sending)),
      });
      if (!res.ok) {
        // eslint-disable-next-line no-console
        console.error(
          `[sanix/observe/otlp] collector returned HTTP ${res.status} ${res.statusText}; dropping ${sending.length} spans`,
        );
      }
    } catch (err) {
      // Degrade gracefully: log and drop. We do NOT re-enqueue because
      // an unreachable collector would cause unbounded memory growth.
      // eslint-disable-next-line no-console
      console.error(
        `[sanix/observe/otlp] failed to POST ${sending.length} spans to ${endpoint}:`,
        err,
      );
    } finally {
      flushing = false;
      if (batch.length >= batchSize) void flush();
    }
  };

  // Start the periodic flush timer.
  flushTimer = setInterval(() => {
    void flush();
  }, flushIntervalMs);
  // Don't keep the process alive for the timer.
  if (flushTimer.unref) flushTimer.unref();

  return {
    name: 'otlp',
    async export(spans: SerializedSpan[]): Promise<void> {
      if (spans.length === 0) return;
      batch.push(...spans);
      if (batch.length >= batchSize) {
        await flush();
      }
    },
    async flush(): Promise<void> {
      if (flushTimer) {
        clearInterval(flushTimer);
        flushTimer = null;
      }
      await flush();
    },
  };
}

/**
 * Convert a span attribute value into an OTLP value object.
 */
function toOTLPValue(v: unknown):
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean } {
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return { intValue: String(v) };
    return { doubleValue: v };
  }
  return { stringValue: JSON.stringify(v) };
}

/**
 * Generate a 32-char lowercase hex traceId (16 bytes).
 */
function makeTraceId(): string {
  return (
    Math.random().toString(16).slice(2, 10).padEnd(8, '0') +
    Math.random().toString(16).slice(2, 10).padEnd(8, '0') +
    Math.random().toString(16).slice(2, 10).padEnd(8, '0') +
    Math.random().toString(16).slice(2, 10).padEnd(8, '0')
  ).slice(0, 32);
}

/**
 * Derive an 8-byte (16-char hex) spanId from a nanoid string. We hash the
 * id deterministically so the same span always maps to the same spanId.
 */
function makeSpanId(id: string): string {
  let h1 = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h1 ^= id.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193);
  }
  const hex = (h1 >>> 0).toString(16).padStart(8, '0');
  return (hex + hex + hex + hex).slice(0, 16);
}
