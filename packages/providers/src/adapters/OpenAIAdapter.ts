/**
 * @file OpenAIAdapter.ts
 * @description IProvider adapter for OpenAI's chat completions API
 * (GPT-4o, o1, o3, GPT-4.1) via the official `openai` SDK. Supports
 * streaming and function/tool calling.
 *
 * Note on reasoning models (o1, o3): these do not accept `temperature`
 * and historically did not accept `tools`/`system` messages in the same
 * shape. We defensively strip `temperature` for the o-series and let the
 * SDK surface any further incompatibilities.
 *
 * ## Prompt caching
 * OpenAI's prompt caching is **automatic** — the API transparently caches
 * the longest cached prefix of the prompt and discounts the cached tokens
 * at ~50% of the input price. There is no `cache_control` parameter to
 * set; the only requirement is that the prompt exceeds **1024 tokens**.
 *
 * This adapter surfaces cache accounting back to the caller via the
 * `LLMResponse.usage.cachedTokens` field (parsed from
 * `usage.prompt_tokens_details.cached_tokens`). When that value is > 0 we
 * also set `LLMResponse.cacheHit = true` so downstream cost-tracking code
 * can compute savings without re-parsing the response.
 *
 * Because OpenAI caching is automatic, no opt-in / opt-out toggle is
 * exposed on this adapter (unlike the Anthropic adapter's
 * `disableCache()`).
 */

import OpenAI from 'openai';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  IProvider,
  LLMRequest,
  LLMResponse,
  ToolCall,
  ToolDef,
  ContentBlock,
  MessageContent,
} from '../interfaces/IProvider.js';
import { getCapability } from '../interfaces/ProviderCapabilities.js';
import { ProviderError, ProviderNetworkError } from '../errors.js';

/**
 * Extract the plain-text portion of a {@link MessageContent} (string or
 * array of content blocks). Multi-modal content blocks of type `image_*`
 * are skipped.
 *
 * @example
 * ```ts
 * extractText('hello');                       // 'hello'
 * extractText([{ type: 'text', text: 'hi' }]); // 'hi'
 * extractText([
 *   { type: 'text', text: 'see this:' },
 *   { type: 'image_url', image_url: { url: '...' } },
 * ]); // 'see this:'
 * ```
 */
function extractText(content: unknown): string {
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

/**
 * Read an image file from disk and return its base64-encoded data + media type.
 * Returns null if the file cannot be read or isn't a recognized image type.
 *
 * Media type is inferred from the file extension (`.png` / `.jpg` / `.jpeg`
 * / `.gif` / `.webp`).
 *
 * @example
 * ```ts
 * const img = await readImageAsBase64('./cat.png');
 * if (img) {
 *   console.log(img.mediaType); // 'image/png'
 *   console.log(img.data.length); // base64 string length
 * }
 * ```
 */
async function readImageAsBase64(
  filePath: string,
): Promise<{ data: string; mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' } | null> {
  try {
    const ext = path.extname(filePath).toLowerCase();
    const mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | null =
      ext === '.png' ? 'image/png' :
      ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
      ext === '.gif' ? 'image/gif' :
      ext === '.webp' ? 'image/webp' :
      null;
    if (!mediaType) return null;
    const buf = await fs.readFile(filePath);
    return { data: buf.toString('base64'), mediaType };
  } catch {
    return null;
  }
}

/** Constructor options for {@link OpenAIAdapter}. */
export interface OpenAIAdapterOptions {
  /** API key. Falls back to env `OPENAI_API_KEY` when omitted. */
  apiKey?: string;
  /** Stable alias id (defaults to 'gpt-4o'). */
  modelId?: string;
  /** Override the concrete OpenAI model id (defaults to alias). */
  concreteModel?: string;
  /** Override the display name shown in the TUI. */
  displayName?: string;
  /** Base URL override (rare; for Azure or proxies). */
  baseURL?: string;
  /** Per-request default timeout in ms. */
  defaultTimeoutMs?: number;
}

const DEFAULT_MODEL_ID = 'gpt-4o';

/**
 * Adapter for OpenAI chat-completion models. Maps the unified SANIX
 * protocol onto OpenAI's `chat.completions` shape (which is essentially
 * the same shape, modulo streaming chunk envelope differences).
 */
export class OpenAIAdapter implements IProvider {
  readonly id: string;
  readonly displayName: string;
  readonly isLocal: boolean;
  readonly strengths: string[];
  readonly latencyMs: number;
  readonly costPerMillionTokens: number;
  readonly maxContextTokens: number;

  private readonly client: OpenAI;
  private readonly concreteModel: string;
  private readonly defaultTimeoutMs: number;
  private readonly apiKey: string | undefined;
  /** True for o1/o3 reasoning models that disallow temperature + tools quirks. */
  private readonly isReasoningModel: boolean;

  constructor(opts: OpenAIAdapterOptions = {}) {
    this.id = opts.modelId ?? DEFAULT_MODEL_ID;
    this.concreteModel = opts.concreteModel ?? this.id;
    const cap = getCapability(this.id);
    this.displayName = opts.displayName ?? `OpenAI ${this.id}`;
    this.isLocal = cap.isLocal;
    this.strengths = cap.strengths;
    this.latencyMs = cap.latencyMs;
    this.costPerMillionTokens = cap.costPerMillionTokens;
    this.maxContextTokens = cap.maxContextTokens;

    this.apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 30_000;
    this.client = new OpenAI({
      apiKey: this.apiKey ?? '',
      baseURL: opts.baseURL,
      timeout: this.defaultTimeoutMs,
      maxRetries: 0,
    });
    this.isReasoningModel = /^o[13](\b|$|-)/.test(this.concreteModel);
  }

  /** @inheritdoc */
  async available(): Promise<boolean> {
    if (!this.apiKey) return false;
    return true;
  }

  /** @inheritdoc */
  async chat(req: LLMRequest): Promise<LLMResponse> {
    const startedAt = Date.now();
    const params = await this.buildParams(req, /* stream */ false);
    try {
      const res = await this.client.chat.completions.create(
        params as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
        { signal: req.signal },
      );
      const choice = res.choices?.[0];
      const msg = choice?.message;
      const toolCalls = this.extractToolCalls(msg?.tool_calls);

      // Parse cache accounting from `usage.prompt_tokens_details.cached_tokens`.
      // OpenAI exposes this on the `prompt_tokens_details` sub-object when the
      // API served any tokens from its automatic cached prefix.
      const promptDetails =
        (res.usage as
          | { prompt_tokens_details?: { cached_tokens?: number } }
          | null
          | undefined)?.prompt_tokens_details;
      const cachedTokens = promptDetails?.cached_tokens ?? 0;

      return {
        content: msg?.content ?? '',
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        usage: {
          inputTokens: res.usage?.prompt_tokens ?? 0,
          outputTokens: res.usage?.completion_tokens ?? 0,
          cachedTokens: cachedTokens > 0 ? cachedTokens : undefined,
        },
        model: res.model,
        latencyMs: Date.now() - startedAt,
        stopReason: choice?.finish_reason ?? undefined,
        cacheHit: cachedTokens > 0,
      };
    } catch (err) {
      throw this.wrapError(err);
    }
  }

  /** @inheritdoc */
  async *chatStream(req: LLMRequest): AsyncIterable<string> {
    const params = await this.buildParams(req, /* stream */ true);
    try {
      const stream = await this.client.chat.completions.create(
        params as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
        { signal: req.signal },
      );
      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta.length > 0) yield delta;
      }
    } catch (err) {
      throw this.wrapError(err);
    }
  }

  // ── internal helpers ───────────────────────────────────────────────

  /** Build the OpenAI request params, applying reasoning-model quirks. */
  private async buildParams(
    req: LLMRequest,
    stream: boolean,
  ): Promise<Record<string, unknown>> {
    const messages = await this.translateMessages(req);
    const params: Record<string, unknown> = {
      model: this.concreteModel,
      messages,
      stream,
    };
    if (req.maxTokens !== undefined) {
      // o-series renamed max_tokens → max_completion_tokens.
      params[this.isReasoningModel ? 'max_completion_tokens' : 'max_tokens'] = req.maxTokens;
    }
    if (req.temperature !== undefined && !this.isReasoningModel) {
      params.temperature = req.temperature;
    }
    if (req.tools && req.tools.length > 0 && !this.isReasoningModel) {
      params.tools = this.translateTools(req.tools);
    }
    return params;
  }

  /** Translate SANIX messages into OpenAI chat-completion messages. */
  private async translateMessages(
    req: LLMRequest,
  ): Promise<OpenAI.Chat.Completions.ChatCompletionMessageParam[]> {
    const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
    if (req.systemPrompt) {
      out.push({ role: 'system', content: req.systemPrompt });
    }
    for (const m of req.messages) {
      if (m.role === 'system') {
        out.push({ role: 'system', content: extractText(m.content) });
        continue;
      }
      if (m.role === 'user') {
        out.push(await this.buildUserMessage(m.content));
        continue;
      }
      if (m.role === 'assistant') {
        const text = extractText(m.content);
        const assistantMsg: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
          role: 'assistant',
          content: text || null,
        };
        if (m.tool_calls && m.tool_calls.length > 0) {
          assistantMsg.tool_calls = m.tool_calls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.function.name, arguments: tc.function.arguments },
          }));
        }
        out.push(assistantMsg);
        continue;
      }
      // tool
      out.push({
        role: 'tool',
        content: extractText(m.content),
        tool_call_id: m.tool_call_id ?? '',
      });
    }
    return out;
  }

  /**
   * Build a user message param. Plain-string content is sent verbatim;
   * multi-modal `ContentBlock[]` content is translated to OpenAI's
   * `content` array shape (`{ type: 'text', text }` and
   * `{ type: 'image_url', image_url: { url, detail } }`).
   *
   * OpenAI accepts image URLs directly (it fetches them server-side), so
   * `image_url` blocks are forwarded unchanged. `image_base64` and
   * `image_file` blocks are converted to `data:` URLs.
   */
  private async buildUserMessage(
    content: MessageContent,
  ): Promise<OpenAI.Chat.Completions.ChatCompletionUserMessageParam> {
    if (typeof content === 'string') {
      return { role: 'user', content };
    }
    const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
    for (const block of content) {
      const translated = await this.translateContentBlock(block);
      if (translated) parts.push(translated);
    }
    return { role: 'user', content: parts };
  }

  /**
   * Translate a single SANIX {@link ContentBlock} into OpenAI's
   * `ChatCompletionContentPart` shape.
   *
   * - `text` → `{ type: 'text', text }`
   * - `image_url` → forwarded as-is (`{ type: 'image_url', image_url: { url, detail } }`)
   * - `image_base64` → converted to a `data:<mediaType>;base64,<data>` URL
   * - `image_file` → read from disk, then converted to a `data:` URL
   */
  private async translateContentBlock(
    block: ContentBlock,
  ): Promise<OpenAI.Chat.Completions.ChatCompletionContentPart | null> {
    if (block.type === 'text') {
      const text = block.text ?? '';
      if (!text) return null;
      return { type: 'text', text };
    }
    if (block.type === 'image_url' && block.image_url) {
      const { url, detail } = block.image_url;
      if (!url) return null;
      return {
        type: 'image_url',
        image_url: { url, detail: detail ?? 'auto' },
      };
    }
    if (block.type === 'image_base64' && block.image_base64) {
      const { data, mediaType } = block.image_base64;
      if (!data) return null;
      return {
        type: 'image_url',
        image_url: { url: `data:${mediaType};base64,${data}`, detail: 'auto' },
      };
    }
    if (block.type === 'image_file' && block.image_file) {
      const filePath = block.image_file.path;
      if (!filePath) return null;
      const encoded = await readImageAsBase64(filePath);
      if (!encoded) return null;
      return {
        type: 'image_url',
        image_url: {
          url: `data:${encoded.mediaType};base64,${encoded.data}`,
          detail: 'auto',
        },
      };
    }
    return null;
  }

  /** Translate SANIX ToolDef[] into OpenAI tool descriptors. */
  private translateTools(tools: ToolDef[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
    return tools.map((t) => ({
      type: 'function',
      function: {
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters as OpenAI.Chat.Completions.ChatCompletionTool['function']['parameters'],
      },
    }));
  }

  /** Coerce OpenAI's tool-call array into the unified ToolCall shape. */
  private extractToolCalls(
    toolCalls: ReadonlyArray<OpenAI.Chat.Completions.ChatCompletionMessageToolCall> | undefined,
  ): ToolCall[] {
    if (!toolCalls || toolCalls.length === 0) return [];
    return toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function',
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments ?? '',
      },
    }));
  }

  /** Map an OpenAI SDK / fetch error into our typed hierarchy. */
  private wrapError(err: unknown): ProviderError {
    if (err instanceof ProviderError) return err;
    if (err instanceof Error && err.name === 'AbortError') {
      return new ProviderNetworkError(this.id, `Request aborted: ${err.message ?? 'no message'}`);
    }
    if (err instanceof OpenAI.APIError) {
      const status = (err as unknown as { status?: number }).status ?? 0;
      const msg = err.message ?? 'OpenAI API error';
      const retryable = status === 429 || (status >= 500 && status < 600);
      return new ProviderError(this.id, msg, status, retryable);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return new ProviderNetworkError(this.id, `Unexpected OpenAI failure: ${msg}`);
  }
}
