/**
 * @file lib/api.ts — Typed fetch wrapper for the SANIX REST API.
 *
 * - Base URL configurable via the settings store (default `http://127.0.0.1:7331`).
 * - Auto-injects `Authorization: Bearer <token>` from the settings store.
 * - Throws `ApiError` on non-2xx responses with the parsed body.
 * - Includes an SSE client (`streamRunEvents`) for `/v1/runs/:id/events`.
 *
 * All endpoints match @sanix/server (packages/server/src/Server.ts).
 *
 * @packageDocumentation
 */
'use client';

import type {
  AuthStatusResponse,
  ChatRequest,
  ChatResponse,
  ConfigResponse,
  CostResponse,
  GetRunResponse,
  HealthResponse,
  MemoryListResponse,
  MemoryStoreRequest,
  ProviderListResponse,
  ProviderStatusResponse,
  RunEvent,
  ShareRequest,
  ShareResponse,
  StartRunRequest,
  StartRunResponse,
  ToolExecuteRequest,
  ToolExecuteResponse,
  ToolListResponse,
} from './types';
import { ApiError } from './types';
import { readSettings } from './settings';

/** Build the Authorization header from the current settings. */
function authHeaders(): Record<string, string> {
  const { authToken } = readSettings();
  if (!authToken) return {};
  return { Authorization: `Bearer ${authToken}` };
}

/** Resolve the API base URL (stripped of trailing slashes). */
function baseUrl(): string {
  return readSettings().serverUrl.replace(/\/+$/, '');
}

/** Internal typed fetch wrapper. */
async function apiFetch<T>(
  path: string,
  init: RequestInit & { signal?: AbortSignal } = {},
): Promise<T> {
  const url = path.startsWith('http') ? path : `${baseUrl()}${path}`;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...authHeaders(),
    ...(init.headers as Record<string, string> | undefined),
  };
  if (init.body !== undefined && !(init.body instanceof FormData) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers });
  } catch (err) {
    throw new ApiError(
      err instanceof Error ? err.message : 'Network request failed',
      0,
      { cause: String(err) },
    );
  }
  const text = await res.text();
  let body: unknown = undefined;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const msg =
      (body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : typeof body === 'string'
          ? body
          : `HTTP ${res.status}`) || `HTTP ${res.status}`;
    throw new ApiError(msg, res.status, body);
  }
  return body as T;
}

/* ============================================================================
 * /health
 * ========================================================================== */
export const healthApi = {
  /** GET /health — server status. */
  get(signal?: AbortSignal): Promise<HealthResponse> {
    return apiFetch<HealthResponse>('/health', { signal });
  },
};

/* ============================================================================
 * /v1/chat
 * ========================================================================== */
export const chatApi = {
  /** POST /v1/chat — single LLM turn (no agent loop). */
  send(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    return apiFetch<ChatResponse>('/v1/chat', {
      method: 'POST',
      body: JSON.stringify(req),
      signal,
    });
  },
};

/* ============================================================================
 * /v1/run + /v1/runs
 * ========================================================================== */
export const runsApi = {
  /** POST /v1/run — start a new agent run. Returns the run ID immediately. */
  start(req: StartRunRequest, signal?: AbortSignal): Promise<StartRunResponse> {
    return apiFetch<StartRunResponse>('/v1/run', {
      method: 'POST',
      body: JSON.stringify(req),
      signal,
    });
  },

  /** GET /v1/runs/:id — current run state. */
  get(id: string, signal?: AbortSignal): Promise<GetRunResponse> {
    return apiFetch<GetRunResponse>(`/v1/runs/${encodeURIComponent(id)}`, { signal });
  },

  /** POST /v1/runs/:id/abort — abort a running run. */
  abort(id: string, signal?: AbortSignal): Promise<{ runId: string; status: string }> {
    return apiFetch(`/v1/runs/${encodeURIComponent(id)}/abort`, { method: 'POST', signal });
  },

  /**
   * GET /v1/runs/:id/events — Server-Sent Events stream.
   *
   * Returns an async iterable of RunEvents. Calls `onEvent` for each event
   * and `onError` if the stream breaks. Resolves when the stream closes
   * (either the run finishes or the AbortSignal aborts).
   *
   * NOTE: This is a hand-rolled SSE parser (not EventSource) so we can
   * inject the Authorization header.
   */
  async *streamEvents(
    id: string,
    signal?: AbortSignal,
  ): AsyncIterable<RunEvent> {
    const url = `${baseUrl()}/v1/runs/${encodeURIComponent(id)}/events`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        'Cache-Control': 'no-cache',
        ...authHeaders(),
      },
      signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new ApiError(text || `HTTP ${res.status}`, res.status, text);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE events are separated by a blank line.
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const rawEvent = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const evt = parseSSE(rawEvent);
          if (evt) yield evt;
        }
      }
    } finally {
      reader.releaseLock();
    }
  },
};

/** Parse one SSE block (separated by `\n\n`) into a RunEvent. */
function parseSSE(raw: string): RunEvent | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) continue; // comment
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  }
  if (dataLines.length === 0) return null;
  const dataStr = dataLines.join('\n');
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(dataStr) as Record<string, unknown>;
  } catch {
    data = { raw: dataStr };
  }
  return {
    runId: (data['runId'] as string) ?? '',
    type: event as RunEvent['type'],
    timestamp: typeof data['timestamp'] === 'number'
      ? (data['timestamp'] as number)
      : Date.now(),
    data,
  };
}

/* ============================================================================
 * /v1/memory
 * ========================================================================== */
export const memoryApi = {
  /** GET /v1/memory?query=...&tier=... — recall memories. */
  list(opts: { query?: string; tier?: string } = {}, signal?: AbortSignal): Promise<MemoryListResponse> {
    const params = new URLSearchParams();
    if (opts.query) params.set('query', opts.query);
    if (opts.tier) params.set('tier', opts.tier);
    const qs = params.toString();
    return apiFetch<MemoryListResponse>(`/v1/memory${qs ? `?${qs}` : ''}`, { signal });
  },

  /** POST /v1/memory — store a new memory item. */
  store(req: MemoryStoreRequest, signal?: AbortSignal): Promise<{ stored: boolean }> {
    return apiFetch('/v1/memory', { method: 'POST', body: JSON.stringify(req), signal });
  },

  /** DELETE /v1/memory/:id — forget a memory item. */
  delete(id: string, signal?: AbortSignal): Promise<{ deleted: boolean }> {
    return apiFetch(`/v1/memory/${encodeURIComponent(id)}`, { method: 'DELETE', signal });
  },
};

/* ============================================================================
 * /v1/tools
 * ========================================================================== */
export const toolsApi = {
  /** GET /v1/tools — list registered tools. */
  list(signal?: AbortSignal): Promise<ToolListResponse> {
    return apiFetch<ToolListResponse>('/v1/tools', { signal });
  },

  /** POST /v1/tools/:name/execute — execute a tool with input. */
  execute(name: string, req: ToolExecuteRequest, signal?: AbortSignal): Promise<ToolExecuteResponse> {
    return apiFetch<ToolExecuteResponse>(`/v1/tools/${encodeURIComponent(name)}/execute`, {
      method: 'POST',
      body: JSON.stringify(req),
      signal,
    });
  },
};

/* ============================================================================
 * /v1/providers + /v1/auth/status
 * ========================================================================== */
export const providersApi = {
  /** GET /v1/providers — list configured providers. */
  list(signal?: AbortSignal): Promise<ProviderListResponse> {
    return apiFetch<ProviderListResponse>('/v1/providers', { signal });
  },

  /** GET /v1/providers/:id/status — auth status for a specific provider. */
  status(id: string, signal?: AbortSignal): Promise<ProviderStatusResponse> {
    return apiFetch<ProviderStatusResponse>(`/v1/providers/${encodeURIComponent(id)}/status`, { signal });
  },
};

export const authApi = {
  /** GET /v1/auth/status?provider=... — auth status for all or one provider. */
  status(provider?: string, signal?: AbortSignal): Promise<AuthStatusResponse> {
    const qs = provider ? `?provider=${encodeURIComponent(provider)}` : '';
    return apiFetch<AuthStatusResponse>(`/v1/auth/status${qs}`, { signal });
  },
};

/* ============================================================================
 * /v1/cost
 * ========================================================================== */
export const costApi = {
  /** GET /v1/cost — cost summary (totals + breakdowns). */
  get(signal?: AbortSignal): Promise<CostResponse> {
    return apiFetch<CostResponse>('/v1/cost', { signal });
  },
};

/* ============================================================================
 * /v1/config
 * ========================================================================== */
export const configApi = {
  /** GET /v1/config — server config (secrets already redacted). */
  get(signal?: AbortSignal): Promise<ConfigResponse> {
    return apiFetch<ConfigResponse>('/v1/config', { signal });
  },
};

/* ============================================================================
 * /v1/share
 * ========================================================================== */
export const shareApi = {
  /** POST /v1/share — share a file or text snippet. */
  share(req: ShareRequest, signal?: AbortSignal): Promise<ShareResponse> {
    return apiFetch<ShareResponse>('/v1/share', { method: 'POST', body: JSON.stringify(req), signal });
  },
};

/* ============================================================================
 * Aggregate client (also exported as the default for convenience).
 * ========================================================================== */
export const sanixApi = {
  health: healthApi,
  chat: chatApi,
  runs: runsApi,
  memory: memoryApi,
  tools: toolsApi,
  providers: providersApi,
  auth: authApi,
  cost: costApi,
  config: configApi,
  share: shareApi,
};

export default sanixApi;

/* ============================================================================
 * Convenience re-exports for callers that want the raw types.
 * ========================================================================== */
export type {
  AuthStatus,
  AuthStatusResponse,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ConfigResponse,
  CostBreakdown,
  CostResponse,
  GetRunResponse,
  HealthResponse,
  MemoryItem,
  MemoryListResponse,
  MemoryStoreRequest,
  ProviderInfo,
  ProviderListResponse,
  ProviderStatusResponse,
  RunEvent,
  RunEventType,
  RunState,
  ShareRequest,
  ShareResponse,
  StartRunRequest,
  StartRunResponse,
  ToolDef,
  ToolExecuteRequest,
  ToolExecuteResponse,
  ToolListResponse,
} from './types';
