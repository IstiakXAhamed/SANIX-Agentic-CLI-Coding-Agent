/**
 * @file _openaiCompat.ts
 * @description Shared base logic for REST adapters that speak the OpenAI
 * chat-completions wire format (Mistral, Groq, Together, DeepSeek, LM Studio,
 * and the generic OpenAICompatAdapter). Each adapter just supplies its
 * baseURL + apiKey + model + providerId; this module handles message
 * translation, request shaping, response parsing, streaming, and error
 * classification via `_http.ts`.
 *
 * We deliberately do NOT depend on the `openai` SDK here — REST adapters
 * must remain transport-light (no SDK download cost) and use only `fetch`.
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
import { fetchJson, streamSSE, pingUrl, type JsonValue, type HeaderMap } from './_http.js';

/**
 * Extract the plain-text portion of a {@link MessageContent}. Most
 * OpenAI-compat endpoints (Groq / Together / DeepSeek / Mistral / LM Studio)
 * accept plain text only — image blocks would need conversion to data URLs
 * which we skip here. Use {@link OpenAIAdapter} for full multi-modal support.
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

/** Native OpenAI-compat message shape we post to the endpoint. */
interface OaiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

/** Native OpenAI-compat tool descriptor we post to the endpoint. */
interface OaiTool {
  type: 'function';
  function: { name: string; description: string; parameters: object };
}

/** Native OpenAI-compat request body. */
interface OaiRequestBody {
  model: string;
  messages: OaiMessage[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  tools?: OaiTool[];
}

/** Constructor options for {@link OpenAICompatBase}. */
export interface OpenAICompatBaseOptions {
  /** Stable unique id used in errors and the router. */
  providerId: string;
  /** Full base URL, e.g. https://api.groq.com/openai/v1. */
  baseURL: string;
  /** Chat completions path appended to baseURL; defaults to '/chat/completions'. */
  chatPath?: string;
  /** API key (omitted for local no-auth endpoints like Ollama). */
  apiKey?: string;
  /** Model id posted in the request body. */
  model: string;
  /** Display name for the TUI. */
  displayName: string;
  /** Override capability lookup (defaults to `getCapability(model)`). */
  capabilityId?: string;
  /** Bearer token header name override (default 'Authorization'). */
  authHeaderName?: string;
  /** Auth scheme prefix (default 'Bearer '). Pass '' for raw keys. */
  authScheme?: string;
  /** Per-request timeout (default 30s). */
  defaultTimeoutMs?: number;
  /** Whether this endpoint is local. Defaults to false. */
  isLocal?: boolean;
}

/**
 * Shared base class for all OpenAI-compatible REST adapters. Adapters in
 * this family are thin subclasses (or direct instances) that only customize
 * the constructor options; all chat/stream/translate logic lives here.
 */
export class OpenAICompatBase implements IProvider {
  readonly id: string;
  readonly displayName: string;
  readonly isLocal: boolean;
  readonly strengths: string[];
  readonly latencyMs: number;
  readonly costPerMillionTokens: number;
  readonly maxContextTokens: number;

  protected readonly opts: OpenAICompatBaseOptions;
  protected readonly chatUrl: string;

  constructor(opts: OpenAICompatBaseOptions) {
    this.opts = opts;
    this.id = opts.providerId;
    this.displayName = opts.displayName;
    const cap = getCapability(opts.capabilityId ?? opts.model);
    this.isLocal = opts.isLocal ?? cap.isLocal;
    this.strengths = cap.strengths;
    this.latencyMs = cap.latencyMs;
    this.costPerMillionTokens = cap.costPerMillionTokens;
    this.maxContextTokens = cap.maxContextTokens;
    const path = opts.chatPath ?? '/chat/completions';
    this.chatUrl = `${opts.baseURL.replace(/\/$/, '')}${path}`;
  }

  /** @inheritdoc */
  async available(): Promise<boolean> {
    // Default: assume available when an API key is set OR no key is required
    // (local endpoints). Subclasses may override with a real ping endpoint.
    if (this.opts.apiKey) return true;
    // For local endpoints without auth, attempt a models ping.
    if (this.isLocal) {
      const modelsUrl = `${this.opts.baseURL.replace(/\/$/, '')}/models`;
      return pingUrl(modelsUrl, { headers: this.authHeaders(), timeoutMs: 3_000 });
    }
    return false;
  }

  /** @inheritdoc */
  async chat(req: LLMRequest): Promise<LLMResponse> {
    const startedAt = Date.now();
    const body: OaiRequestBody = {
      model: this.opts.model,
      messages: this.translateMessages(req),
      stream: false,
    };
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.tools && req.tools.length > 0) body.tools = this.translateTools(req.tools);

    const json = await fetchJson(this.id, this.chatUrl, {
      method: 'POST',
      headers: this.authHeaders(),
      body,
      signal: req.signal,
      timeoutMs: this.opts.defaultTimeoutMs,
    });

    return this.parseResponse(json, startedAt);
  }

  /** @inheritdoc */
  async *chatStream(req: LLMRequest): AsyncIterable<string> {
    const body: OaiRequestBody = {
      model: this.opts.model,
      messages: this.translateMessages(req),
      stream: true,
    };
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    if (req.temperature !== undefined) body.temperature = req.temperature;

    for await (const evt of streamSSE(this.id, this.chatUrl, {
      headers: this.authHeaders(),
      body,
      signal: req.signal,
      timeoutMs: this.opts.defaultTimeoutMs,
    })) {
      const delta = this.extractDelta(evt);
      if (delta) yield delta;
    }
  }

  // ── internal helpers ───────────────────────────────────────────────

  /** Build the auth headers for fetch (Authorization: Bearer ... by default). */
  protected authHeaders(): HeaderMap {
    const headers: HeaderMap = {};
    if (this.opts.apiKey) {
      const name = this.opts.authHeaderName ?? 'Authorization';
      const scheme = this.opts.authScheme ?? 'Bearer ';
      headers[name] = `${scheme}${this.opts.apiKey}`;
    }
    return headers;
  }

  /** Translate SANIX LLMMessage[] → OpenAI-compat OaiMessage[]. */
  protected translateMessages(req: LLMRequest): OaiMessage[] {
    const out: OaiMessage[] = [];
    if (req.systemPrompt) out.push({ role: 'system', content: req.systemPrompt });
    for (const m of req.messages) {
      if (m.role === 'system') {
        out.push({ role: 'system', content: extractText(m.content) });
        continue;
      }
      if (m.role === 'user') {
        out.push({ role: 'user', content: extractText(m.content) });
        continue;
      }
      if (m.role === 'assistant') {
        const text = extractText(m.content);
        const oaiMsg: OaiMessage = { role: 'assistant', content: text || null };
        if (m.tool_calls && m.tool_calls.length > 0) {
          oaiMsg.tool_calls = m.tool_calls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.function.name, arguments: tc.function.arguments },
          }));
        }
        out.push(oaiMsg);
        continue;
      }
      // tool
      out.push({ role: 'tool', content: extractText(m.content), tool_call_id: m.tool_call_id ?? '' });
    }
    return out;
  }

  /** Translate SANIX ToolDef[] → OpenAI-compat tool descriptors. */
  protected translateTools(tools: ToolDef[]): OaiTool[] {
    return tools.map((t) => ({
      type: 'function',
      function: {
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      },
    }));
  }

  /** Parse a non-streaming chat-completion JSON response. */
  protected parseResponse(json: JsonValue, startedAt: number): LLMResponse {
    const obj = json as { [k: string]: JsonValue };
    const choices = obj.choices as { [k: string]: JsonValue }[] | undefined;
    const choice = choices?.[0];
    const message = (choice?.message ?? {}) as { [k: string]: JsonValue };
    const content = typeof message.content === 'string' ? message.content : '';
    const toolCalls = this.extractToolCalls(message.tool_calls);

    const usage = (obj.usage ?? {}) as { [k: string]: JsonValue };
    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        inputTokens: this.toNumber(usage.prompt_tokens),
        outputTokens: this.toNumber(usage.completion_tokens),
      },
      model: typeof obj.model === 'string' ? obj.model : this.opts.model,
      latencyMs: Date.now() - startedAt,
      stopReason:
        typeof choice?.finish_reason === 'string' ? (choice.finish_reason as string) : undefined,
    };
  }

  /** Extract a text delta from a single SSE chunk. */
  protected extractDelta(evt: JsonValue): string {
    const obj = evt as { [k: string]: JsonValue };
    const choices = obj.choices as { [k: string]: JsonValue }[] | undefined;
    const delta = choices?.[0]?.delta as { [k: string]: JsonValue } | undefined;
    const content = delta?.content;
    return typeof content === 'string' ? content : '';
  }

  /** Coerce OpenAI tool_calls array into unified ToolCall[]. */
  protected extractToolCalls(raw: JsonValue | undefined): ToolCall[] {
    if (!Array.isArray(raw)) return [];
    const out: ToolCall[] = [];
    for (const item of raw) {
      if (typeof item !== 'object' || item === null) continue;
      const obj = item as { [k: string]: JsonValue };
      const fn = obj.function as { [k: string]: JsonValue } | undefined;
      if (!fn) continue;
      const name = typeof fn.name === 'string' ? fn.name : '';
      const args = typeof fn.arguments === 'string' ? fn.arguments : '';
      const id = typeof obj.id === 'string' ? obj.id : '';
      out.push({ id, type: 'function', function: { name, arguments: args } });
    }
    return out;
  }

  /** Coerce a JsonValue that should be numeric into a finite number (default 0). */
  protected toNumber(v: JsonValue | undefined): number {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
    return 0;
  }
}
