/**
 * @file SSE — Server-Sent Events helpers.
 *
 * Format: `event: <type>\ndata: <json>\n\n`
 *
 * @packageDocumentation
 */

import type { ServerResponse } from 'node:http';

export interface SSEMessage {
  event?: string;
  data: unknown;
  id?: string;
  retry?: number;
}

/**
 * Write a single SSE message to a response.
 * Caller must have already set headers (Content-Type: text/event-stream).
 */
export function writeSSE(res: ServerResponse, msg: SSEMessage): void {
  if (msg.event) res.write(`event: ${msg.event}\n`);
  if (msg.id) res.write(`id: ${msg.id}\n`);
  if (msg.retry !== undefined) res.write(`retry: ${msg.retry}\n`);
  const dataStr = typeof msg.data === 'string' ? msg.data : JSON.stringify(msg.data);
  // Multi-line data must be split across multiple `data:` lines per SSE spec.
  for (const line of dataStr.split('\n')) {
    res.write(`data: ${line}\n`);
  }
  res.write('\n');
}

/**
 * Pipe an async iterable of events to the response as SSE messages.
 * Sets up SSE headers, sends a `ready` event immediately, then streams.
 *
 * Caller is responsible for closing the response after the iterable
 * completes (this function calls `res.end()` itself).
 */
export async function streamEvents(
  res: ServerResponse,
  events: AsyncIterable<{ event: string; data: unknown }>,
): Promise<void> {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Initial keep-alive event so the client knows the stream is open.
  writeSSE(res, { event: 'ready', data: { ok: true } });

  try {
    for await (const evt of events) {
      writeSSE(res, { event: evt.event, data: evt.data });
      // Flush immediately (Node doesn't flush automatically for HTTP responses).
      // No-op if res.flush exists (Express) — we use raw http.
      if (typeof (res as unknown as { flush?: () => void }).flush === 'function') {
        (res as unknown as { flush: () => void }).flush();
      }
    }
    writeSSE(res, { event: 'done', data: { ok: true } });
  } catch (err) {
    writeSSE(res, {
      event: 'error',
      data: { error: err instanceof Error ? err.message : String(err) },
    });
  } finally {
    res.end();
  }
}

/**
 * Send a periodic comment-based heartbeat (every 15s) to keep the connection alive.
 * Returns a stop function — call it when the stream completes or the client disconnects.
 */
export function startHeartbeat(res: ServerResponse): () => void {
  const interval = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      // Socket closed — clear the interval below.
      clearInterval(interval);
    }
  }, 15_000);
  return () => clearInterval(interval);
}
