/**
 * @file _http.ts
 * @description Shared HTTP helpers used by every REST-based adapter
 * (Gemini, Mistral, Groq, Together, DeepSeek, Ollama, LM Studio, OpenAICompat).
 *
 * Design goals:
 *  - Single fetch wrapper that normalizes errors via `classifyHttpError`.
 *  - Default 30s timeout, AbortSignal-aware (caller signal wins).
 *  - Streaming SSE parser that yields parsed JSON objects from `data: {...}` lines,
 *    terminating cleanly on `data: [DONE]`.
 *  - Zero `any` — all external payloads enter as `unknown` and are narrowed with
 *    runtime guards before being read.
 */

import { ProviderNetworkError, classifyHttpError } from '../errors.js';

/** Default request timeout when neither caller nor adapter overrides it. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Minimal JSON value type — anything that JSON.parse can return. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Headers map keyed by lowercase header name. */
export type HeaderMap = Record<string, string>;

/**
 * Combine a caller-supplied AbortSignal with an internal timeout signal.
 * Whichever fires first wins. Returns undefined when neither is supplied.
 */
function linkSignals(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): { signal: AbortSignal | undefined; clear: () => void } {
  const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (timeout <= 0) {
    return { signal: callerSignal, clear: () => {} };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('sanix-timeout')), timeout);
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort(callerSignal.reason);
    else callerSignal.addEventListener('abort', () => controller.abort(callerSignal.reason), { once: true });
  }
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/** True when the value looks like a parseable JSON object/array/primitive. */
function isJsonValue(v: unknown): v is JsonValue {
  if (v === null) return true;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return true;
  if (Array.isArray(v)) return v.every(isJsonValue);
  if (typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>).every(
      ([k, val]) => typeof k === 'string' && isJsonValue(val),
    );
  }
  return false;
}

/**
 * Type-safe JSON HTTP fetch.
 *
 * @param providerId  Id used in error messages / classification.
 * @param url         Full URL to POST or GET.
 * @param init        Method, headers, body, optional caller AbortSignal + timeout.
 * @returns           Parsed JSON body (narrowed to JsonValue).
 * @throws            ProviderError subclass on non-2xx, network, or timeout failure.
 */
export async function fetchJson(
  providerId: string,
  url: string,
  init: {
    method?: 'GET' | 'POST' | 'DELETE' | 'PUT';
    headers?: HeaderMap;
    body?: unknown;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<JsonValue> {
  const { signal, clear } = linkSignals(init.signal, init.timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? 'GET',
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal,
    });
  } catch (err) {
    clear();
    if (err instanceof Error && err.name === 'AbortError') {
      throw new ProviderNetworkError(providerId, `Request aborted: ${err.message ?? 'no message'}`);
    }
    throw new ProviderNetworkError(
      providerId,
      `Network failure contacting ${providerId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  clear();

  const bodyText = await res.text();
  if (!res.ok) {
    const retryAfter = res.headers.get('retry-after') ?? undefined;
    throw classifyHttpError(providerId, res.status, bodyText, retryAfter ?? undefined);
  }

  if (!bodyText) return null;
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (!isJsonValue(parsed)) {
      throw new ProviderNetworkError(providerId, `Non-JSON response from ${providerId}`);
    }
    return parsed;
  } catch (err) {
    throw new ProviderNetworkError(
      providerId,
      `Bad JSON from ${providerId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Stream Server-Sent-Events from a POST endpoint, yielding each parsed
 * `data: {...}` payload as a JsonValue. Stops at `data: [DONE]` or stream end.
 *
 * Honors the caller's AbortSignal via the same linked-controller pattern as
 * {@link fetchJson}. Lines that are not `data:` prefixed (comments, event
 * names) are silently skipped.
 *
 * @yields JsonValue parsed from each `data:` line.
 */
export async function* streamSSE(
  providerId: string,
  url: string,
  init: {
    headers?: HeaderMap;
    body?: unknown;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): AsyncGenerator<JsonValue, void, unknown> {
  const { signal, clear } = linkSignals(init.signal, init.timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...(init.headers ?? {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal,
    });
  } catch (err) {
    clear();
    if (err instanceof Error && err.name === 'AbortError') {
      throw new ProviderNetworkError(providerId, `Stream aborted: ${err.message ?? 'no message'}`);
    }
    throw new ProviderNetworkError(
      providerId,
      `Network failure streaming from ${providerId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!res.ok) {
    clear();
    const bodyText = await res.text().catch(() => '');
    const retryAfter = res.headers.get('retry-after') ?? undefined;
    throw classifyHttpError(providerId, res.status, bodyText, retryAfter ?? undefined);
  }

  if (!res.body) {
    clear();
    throw new ProviderNetworkError(providerId, `${providerId} returned no response body for stream`);
  }

  // We close over `clear` in a finally below; track whether we've cleaned up.
  let cleanedUp = false;
  const cleanup = () => {
    if (!cleanedUp) {
      cleanedUp = true;
      clear();
    }
  };

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          throw new ProviderNetworkError(providerId, `Stream aborted: ${err.message ?? 'no message'}`);
        }
        throw new ProviderNetworkError(
          providerId,
          `Read failure streaming from ${providerId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });

      // SSE events are separated by a blank line. Process complete events.
      let sepIdx: number;
      while ((sepIdx = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, sepIdx);
        buffer = buffer.slice(sepIdx + 2);
        const dataLines = rawEvent
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart());
        if (dataLines.length === 0) continue;
        const data = dataLines.join('\n');
        if (data === '[DONE]') return;
        try {
          const parsed: unknown = JSON.parse(data);
          if (isJsonValue(parsed)) yield parsed;
        } catch {
          // Skip malformed lines but keep streaming.
        }
      }
    }
  } finally {
    cleanup();
    try {
      reader.releaseLock();
    } catch {
      // ignored — already released or stream closed
    }
  }
}

/**
 * Helper for adapters that need a raw reachability ping (HEAD/GET to a
 * health endpoint) for `available()`. Resolves boolean; never throws.
 */
export async function pingUrl(
  url: string,
  init: { headers?: HeaderMap; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<boolean> {
  const { signal, clear } = linkSignals(init.signal, init.timeoutMs ?? 5_000);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: init.headers,
      signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clear();
  }
}
