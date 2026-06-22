/**
 * @file OllamaAdapter.ts
 * @description IProvider adapter for a local Ollama server
 * (http://localhost:11434/api/chat). Ollama uses its own JSON-RPC-ish chat
 * format (NOT OpenAI-compatible), so this adapter does not extend
 * {@link OpenAICompatBase}. Streaming is NDJSON (one JSON object per line,
 * not SSE).
 */

import {
  IProvider,
  LLMRequest,
  LLMResponse,
  ToolCall,
  ToolDef,
  type MessageContent,
} from '../interfaces/IProvider.js';
import { getCapability } from '../interfaces/ProviderCapabilities.js';
import {
  ProviderError,
  ProviderNetworkError,
  classifyHttpError,
} from '../errors.js';
import { pingUrl } from './_http.js';

const OLLAMA_DEFAULT_URL = 'http://localhost:11434';

/**
 * Extract the plain-text portion of a {@link MessageContent}. Ollama doesn't
 * support multi-modal content blocks (yet), so image blocks are skipped.
 */
function extractText(content: MessageContent): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as { type?: string; text?: string };
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push(b.text);
    }
  }
  return parts.join('');
}

/** Constructor options for {@link OllamaAdapter}. */
export interface OllamaAdapterOptions {
  /** Base URL. Defaults to http://localhost:11434. */
  baseURL?: string;
  /** Stable alias id (defaults to 'ollama-default'). */
  modelId?: string;
  /** Concrete Ollama model name, e.g. 'llama3.1:8b'. Defaults to 'llama3.1'. */
  concreteModel?: string;
  /** Override the display name shown in the TUI. */
  displayName?: string;
  /** Per-request default timeout in ms. */
  defaultTimeoutMs?: number;
}

/** Ollama message shape (slightly different from OpenAI). */
interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{
    function: { name: string; arguments: Record<string, unknown> };
  }>;
  images?: string[];
}

/** Ollama non-streaming response shape. */
interface OllamaChatResponse {
  model: string;
  message: { role: string; content: string; tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }> };
  done: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

/**
 * Adapter for a local Ollama instance. Ollama runs entirely on localhost
 * and requires no API key. The `available()` check pings `/api/tags`
 * (Ollama's model-listing endpoint) to detect whether the server is
 * running and has at least one model pulled.
 *
 * Ollama's chat endpoint differs from OpenAI's in two important ways:
 *  1. The request path is `/api/chat` (not `/v1/chat/completions`).
 *  2. Streaming uses NDJSON (one JSON object per line), not SSE.
 *
 * This adapter handles both quirks directly via `fetch` + a manual NDJSON
 * reader, so it does not extend {@link OpenAICompatBase}.
 */
export class OllamaAdapter implements IProvider {
  readonly id: string;
  readonly displayName: string;
  readonly isLocal: boolean;
  readonly strengths: string[];
  readonly latencyMs: number;
  readonly costPerMillionTokens: number;
  readonly maxContextTokens: number;

  private readonly baseURL: string;
  private readonly concreteModel: string;
  private readonly defaultTimeoutMs: number;

  constructor(opts: OllamaAdapterOptions = {}) {
    this.id = opts.modelId ?? 'ollama-default';
    this.concreteModel = opts.concreteModel ?? 'llama3.1';
    const cap = getCapability('ollama-default');
    this.displayName = opts.displayName ?? `Ollama (${this.concreteModel})`;
    this.isLocal = true;
    this.strengths = cap.strengths;
    this.latencyMs = cap.latencyMs;
    this.costPerMillionTokens = cap.costPerMillionTokens;
    this.maxContextTokens = cap.maxContextTokens;
    this.baseURL = (opts.baseURL ?? OLLAMA_DEFAULT_URL).replace(/\/$/, '');
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 60_000;
  }

  /** @inheritdoc — ping /api/tags to detect a running server. */
  async available(): Promise<boolean> {
    return pingUrl(`${this.baseURL}/api/tags`, { timeoutMs: 3_000 });
  }

  /** @inheritdoc */
  async chat(req: LLMRequest): Promise<LLMResponse> {
    const startedAt = Date.now();
    const body = this.buildBody(req, false);
    const res = await this.doFetch(`${this.baseURL}/api/chat`, body, req.signal);
    const json = (await res.json()) as unknown;
    if (!isObject(json)) {
      throw new ProviderNetworkError(this.id, 'Ollama returned non-object response');
    }
    const data = json as unknown as OllamaChatResponse;
    const toolCalls = this.extractToolCalls(data.message?.tool_calls);
    return {
      content: data.message?.content ?? '',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        inputTokens: data.prompt_eval_count ?? 0,
        outputTokens: data.eval_count ?? 0,
      },
      model: data.model ?? this.concreteModel,
      latencyMs: Date.now() - startedAt,
      stopReason: data.done ? 'stop' : undefined,
    };
  }

  /** @inheritdoc */
  async *chatStream(req: LLMRequest): AsyncIterable<string> {
    const body = this.buildBody(req, true);
    const res = await this.doFetch(`${this.baseURL}/api/chat`, body, req.signal);
    if (!res.body) {
      throw new ProviderNetworkError(this.id, 'Ollama returned no stream body');
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // NDJSON: each line is a complete JSON object.
        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);
          if (!line) continue;
          try {
            const evt = JSON.parse(line) as unknown;
            if (!isObject(evt)) continue;
            const msg = (evt as { message?: { content?: string } }).message;
            if (msg && typeof msg.content === 'string' && msg.content.length > 0) {
              yield msg.content;
            }
          } catch {
            // skip malformed line
          }
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignored
      }
    }
  }

  // ── internal helpers ───────────────────────────────────────────────

  /** Build the Ollama /api/chat request body. */
  private buildBody(req: LLMRequest, stream: boolean): Record<string, unknown> {
    const messages: OllamaMessage[] = [];
    if (req.systemPrompt) messages.push({ role: 'system', content: req.systemPrompt });
    for (const m of req.messages) {
      if (m.role === 'system') {
        messages.push({ role: 'system', content: extractText(m.content) });
        continue;
      }
      if (m.role === 'user') {
        messages.push({ role: 'user', content: extractText(m.content) });
        continue;
      }
      if (m.role === 'assistant') {
        const out: OllamaMessage = { role: 'assistant', content: extractText(m.content) };
        if (m.tool_calls && m.tool_calls.length > 0) {
          out.tool_calls = m.tool_calls.map((tc) => {
            let args: Record<string, unknown> = {};
            try {
              const parsed: unknown = JSON.parse(tc.function.arguments);
              if (isObject(parsed)) args = parsed as Record<string, unknown>;
            } catch {
              args = {};
            }
            return { function: { name: tc.function.name, arguments: args } };
          });
        }
        messages.push(out);
        continue;
      }
      // tool — Ollama represents tool results as user messages with the tool name.
      messages.push({ role: 'tool', content: extractText(m.content) });
    }
    const body: Record<string, unknown> = {
      model: this.concreteModel,
      messages,
      stream,
    };
    if (req.temperature !== undefined) {
      body.options = { temperature: req.temperature };
    }
    if (req.tools && req.tools.length > 0) {
      body.tools = this.translateTools(req.tools);
    }
    return body;
  }

  /** Translate SANIX ToolDef[] → Ollama tool descriptors. */
  private translateTools(tools: ToolDef[]): unknown[] {
    return tools.map((t) => ({
      type: 'function',
      function: {
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      },
    }));
  }

  /** Coerce Ollama tool_calls (object args) into unified ToolCall[] (string args). */
  private extractToolCalls(
    raw: OllamaChatResponse['message']['tool_calls'] | undefined,
  ): ToolCall[] {
    if (!raw || raw.length === 0) return [];
    return raw.map((tc, idx) => ({
      id: `call_${idx}`,
      type: 'function',
      function: {
        name: tc.function.name,
        arguments: JSON.stringify(tc.function.arguments ?? {}),
      },
    }));
  }

  /**
   * Fetch with timeout + error classification. Ollama never returns 429
   * (local), but it can return 404 (model not pulled) or 500 (model
   * crashed); we classify both via the shared helper.
   */
  private async doFetch(
    url: string,
    body: unknown,
    callerSignal: AbortSignal | undefined,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('sanix-timeout')),
      this.defaultTimeoutMs,
    );
    if (callerSignal) {
      if (callerSignal.aborted) controller.abort(callerSignal.reason);
      else
        callerSignal.addEventListener('abort', () => controller.abort(callerSignal.reason), {
          once: true,
        });
    }
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw classifyHttpError(this.id, res.status, text);
      }
      return res;
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ProviderNetworkError(this.id, `Request aborted: ${err.message ?? 'no message'}`);
      }
      throw new ProviderNetworkError(
        this.id,
        `Ollama network failure: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Type guard for plain objects (not arrays, not null). */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
