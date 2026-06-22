/**
 * @file _http.ts
 * @description Internal fetch helpers shared by every network adapter.
 *   Combines caller-supplied `AbortSignal`s with a wall-clock timeout,
 *   and normalizes the various `fetch` failure modes into `ShareError`.
 *
 *   Node ≥ 20 ships a global `fetch` and supports `AbortSignal.any`, so we
 *   don't need any external HTTP library. If a caller wants to swap in a
 *   custom fetch (e.g. for tests), they pass it via `ShareManagerOptions`
 *   and it propagates here as `fetchImpl`.
 *
 * @packageDocumentation
 */

import { ShareError } from './types.js';

/** Default upload/download timeout (30s), per spec. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Merge a caller-supplied signal with a timeout signal.
 *
 * Uses `AbortSignal.any` when available (Node ≥ 20). Falls back to manual
 * propagation if the API is missing. Returns `undefined` when neither is
 * active (caller should pass `undefined` to fetch — `fetch` doesn't accept
 * `null` for `signal`).
 */
function mergeSignals(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal | undefined; clear: () => void } {
  const controller =
    timeoutMs > 0 && timeoutMs !== Number.POSITIVE_INFINITY
      ? new AbortController()
      : null;
  let timer: NodeJS.Timeout | null = null;
  if (controller) {
    timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  }
  const clear = (): void => {
    if (timer) clearTimeout(timer);
  };
  if (!signal && !controller) return { signal: undefined, clear };
  if (!signal) return { signal: controller!.signal, clear };
  if (!controller) return { signal, clear };
  // Both present. Prefer AbortSignal.any when available.
  type AbortSignalCtor = typeof AbortSignal & {
    any?: (signals: AbortSignal[]) => AbortSignal;
  };
  const ctor = AbortSignal as AbortSignalCtor;
  if (typeof ctor.any === 'function') {
    return { signal: ctor.any([signal, controller.signal]), clear };
  }
  // Manual fallback: forward either abort.
  const merged = new AbortController();
  const forward = (reason: unknown): void => merged.abort(reason);
  signal.addEventListener('abort', () => forward(signal.reason));
  controller.signal.addEventListener('abort', () =>
    forward(controller.signal.reason),
  );
  return { signal: merged.signal, clear };
}

/**
 * Options for {@link fetchWithTimeout}.
 */
export interface FetchWithTimeoutOptions extends RequestInit {
  /** Per-request timeout, in ms. Default: {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Caller-supplied abort signal (in addition to the timeout). */
  signal?: AbortSignal;
  /** Custom fetch implementation (defaults to the global). */
  fetchImpl?: typeof fetch;
}

/**
 * Run a `fetch` call that auto-aborts after `timeoutMs` and never throws
 * a raw `TypeError` — every failure is wrapped in a `ShareError` with a
 * stable code.
 *
 * @param url - URL to fetch.
 * @param opts - Standard `RequestInit` + `timeoutMs`.
 * @returns The `Response`. Caller is responsible for reading the body.
 * @throws {ShareError} `SHARE_TIMEOUT` / `SHARE_ABORTED` / `SHARE_NETWORK`.
 */
export async function fetchWithTimeout(
  url: string,
  opts: FetchWithTimeoutOptions = {},
): Promise<Response> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
    fetchImpl,
    ...rest
  } = opts;
  const fetchFn = fetchImpl ?? fetch;
  const { signal: merged, clear } = mergeSignals(signal, timeoutMs);
  try {
    return await fetchFn(url, { ...rest, signal: merged });
  } catch (err) {
    // Distinguish timeout vs caller-abort vs network failure.
    const reason = (err as Error)?.message ?? String(err);
    if (signal?.aborted) {
      throw new ShareError('SHARE_ABORTED', `Request aborted by caller: ${reason}`);
    }
    if (reason === 'timeout' || (err as Error)?.name === 'TimeoutError') {
      throw new ShareError(
        'SHARE_TIMEOUT',
        `Request to ${url} timed out after ${timeoutMs}ms`,
      );
    }
    if ((err as Error)?.name === 'AbortError') {
      throw new ShareError(
        'SHARE_TIMEOUT',
        `Request to ${url} aborted (timeout=${timeoutMs}ms): ${reason}`,
      );
    }
    throw new ShareError(
      'SHARE_NETWORK',
      `Network error fetching ${url}: ${reason}`,
    );
  } finally {
    clear();
  }
}

/**
 * Read the entire response body as a `Buffer`. Throws a `ShareError` if
 * the response status is not in the 2xx range.
 *
 * @param res - The fetch `Response`.
 * @param url - Source URL (for error messages).
 * @param kind - Optional expected content type (for error messages).
 */
export async function readBodyBuffer(
  res: Response,
  url: string,
  kind?: string,
): Promise<Buffer> {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ShareError(
      'SHARE_HTTP_ERROR',
      `HTTP ${res.status} ${res.statusText} from ${url}` +
        (kind ? ` (${kind})` : '') +
        (text ? `: ${text.slice(0, 500)}` : ''),
    );
  }
  const buf = await res.arrayBuffer();
  return Buffer.from(buf);
}
