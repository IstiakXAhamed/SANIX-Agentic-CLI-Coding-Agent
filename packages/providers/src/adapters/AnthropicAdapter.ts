/**
 * @file AnthropicAdapter.ts
 * @description IProvider adapter for Anthropic's Claude family
 * (claude-opus-4, claude-sonnet-4, claude-haiku). Uses the official
 * `@anthropic-ai/sdk` package for both chat and streaming, with tool-call
 * translation between the unified SANIX protocol and Anthropic's native
 * content-block format.
 *
 * ## Prompt caching
 * Anthropic supports explicit prompt caching via `cache_control:
 * { type: 'ephemeral' }` markers placed on content blocks. Cached prefixes
 * are billed at ~10% of input price on read and ~125% of input price on
 * write, so for repeated long-context agentic loops (where the system
 * prompt + tool definitions + early turns are stable across iterations)
 * the savings are substantial.
 *
 * Anthropic allows up to 4 cache breakpoints per request. This adapter
 * applies them, in priority order, to:
 *   1. The system prompt (always, when present and >1024 tokens).
 *   2. The first user message (when >1024 tokens).
 *   3. The most recent assistant `tool_use` block (when applicable).
 *   4. (Reserved; the cap is reached by items 1–3 in practice.)
 *
 * Callers can opt out via {@link AnthropicAdapter.disableCache}.
 */

import Anthropic from '@anthropic-ai/sdk';
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

/** Constructor options for {@link AnthropicAdapter}. */
export interface AnthropicAdapterOptions {
  /** API key. Falls back to env `ANTHROPIC_API_KEY` when omitted. */
  apiKey?: string;
  /** Stable alias id (defaults to 'claude-sonnet-4'). */
  modelId?: string;
  /** Override the concrete Anthropic model id (defaults to alias). */
  concreteModel?: string;
  /** Override the display name shown in the TUI. */
  displayName?: string;
  /** Base URL override (rare; for proxies). */
  baseURL?: string;
  /** Per-request default timeout in ms. */
  defaultTimeoutMs?: number;
  /** Whether prompt caching is enabled (default true). */
  cacheEnabled?: boolean;
}

/** Default model alias when none is supplied. */
const DEFAULT_MODEL_ID = 'claude-sonnet-4';

/**
 * Anthropic's prompt-cache minimum threshold (per the public docs). Prefixes
 * shorter than 1024 tokens are not eligible for caching, so we skip the
 * `cache_control` marker on tiny blocks to avoid wasted breakpoints.
 */
const MIN_CACHEABLE_TOKENS = 1024;

/** Anthropic's hard cap on cache breakpoints per request. */
const MAX_CACHE_BREAKPOINTS = 4;

/**
 * Maximum image size (in bytes) the adapter will download from a URL before
 * sending it as base64 to Anthropic. Anthropic rejects images larger than
 * ~5MB; this guard fails fast with a clear error instead of an opaque API
 * rejection.
 */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Map SANIX media types to Anthropic's `media_type` strings (they accept the standard MIME types). */
const MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
type AnthropicMediaType = (typeof MEDIA_TYPES)[number];

/**
 * Result of translating a SANIX request into Anthropic's wire shape. The
 * `system` field is widened from a plain string to a typed array of text
 * blocks so we can attach `cache_control` markers.
 */
interface TranslatedRequest {
  system: string | Anthropic.TextBlockParam[] | undefined;
  messages: Anthropic.MessageParam[];
}

/**
 * Adapter for Anthropic Claude models. Handles the unique aspects of the
 * Anthropic API: system messages are extracted into a separate `system`
 * parameter rather than appearing in `messages`, and tool calls surface as
 * typed content blocks (`text` vs `tool_use`) rather than the OpenAI-style
 * `tool_calls` array.
 */
export class AnthropicAdapter implements IProvider {
  readonly id: string;
  readonly displayName: string;
  readonly isLocal: boolean;
  readonly strengths: string[];
  readonly latencyMs: number;
  readonly costPerMillionTokens: number;
  readonly maxContextTokens: number;

  private readonly client: Anthropic;
  private readonly concreteModel: string;
  private readonly defaultTimeoutMs: number;
  private readonly apiKey: string | undefined;
  /** Whether prompt caching (`cache_control` breakpoints) is active. */
  private cacheEnabled: boolean;

  constructor(opts: AnthropicAdapterOptions = {}) {
    this.id = opts.modelId ?? DEFAULT_MODEL_ID;
    this.concreteModel = opts.concreteModel ?? this.id;
    const cap = getCapability(this.id);
    this.displayName = opts.displayName ?? `Anthropic ${this.id}`;
    this.isLocal = cap.isLocal;
    this.strengths = cap.strengths;
    this.latencyMs = cap.latencyMs;
    this.costPerMillionTokens = cap.costPerMillionTokens;
    this.maxContextTokens = cap.maxContextTokens;

    this.apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 30_000;
    this.cacheEnabled = opts.cacheEnabled ?? true;
    this.client = new Anthropic({
      apiKey: this.apiKey ?? '',
      baseURL: opts.baseURL,
      // SDK accepts ms; we forward our default but per-request signals still win.
      timeout: this.defaultTimeoutMs,
      maxRetries: 0, // router handles retries via p-retry
    });
  }

  /**
   * Disable prompt caching for subsequent calls. Use this when running
   * against a proxy that rejects `cache_control` blocks, or when you want
   * to force a cold-prefix benchmark.
   */
  disableCache(): void {
    this.cacheEnabled = false;
  }

  /** Re-enable prompt caching after a {@link disableCache} call. */
  enableCache(): void {
    this.cacheEnabled = true;
  }

  /** @returns Whether prompt caching is currently active. */
  isCacheEnabled(): boolean {
    return this.cacheEnabled;
  }

  /** @inheritdoc */
  async available(): Promise<boolean> {
    if (!this.apiKey) return false;
    // The Anthropic SDK does not expose a cheap health endpoint, so we
    // treat a configured key as "available" and let the circuit breaker
    // demote providers that fail at call time.
    return true;
  }

  /** @inheritdoc */
  async chat(req: LLMRequest): Promise<LLMResponse> {
    const startedAt = Date.now();
    const { system, messages } = await this.translateMessages(req);
    try {
      const res = await this.client.messages.create(
        {
          model: this.concreteModel,
          max_tokens: req.maxTokens ?? 4096,
          temperature: req.temperature,
          system,
          messages,
          tools: req.tools ? this.translateTools(req.tools) : undefined,
        },
        { signal: req.signal },
      );

      const { text, toolCalls } = this.extractContent(res.content);
      const usage = res.usage as {
        input_tokens: number;
        output_tokens: number;
        cache_creation_input_tokens?: number | null;
        cache_read_input_tokens?: number | null;
      };
      const cacheCreation = usage.cache_creation_input_tokens ?? 0;
      const cacheRead = usage.cache_read_input_tokens ?? 0;
      return {
        content: text,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        usage: {
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          cacheCreationTokens: cacheCreation > 0 ? cacheCreation : undefined,
          cacheReadTokens: cacheRead > 0 ? cacheRead : undefined,
        },
        model: res.model,
        latencyMs: Date.now() - startedAt,
        stopReason: res.stop_reason ?? undefined,
        cacheHit: cacheRead > 0,
      };
    } catch (err) {
      throw this.wrapError(err);
    }
  }

  /** @inheritdoc */
  async *chatStream(req: LLMRequest): AsyncIterable<string> {
    const { system, messages } = await this.translateMessages(req);
    try {
      const stream = this.client.messages.stream(
        {
          model: this.concreteModel,
          max_tokens: req.maxTokens ?? 4096,
          temperature: req.temperature,
          system,
          messages,
        },
        { signal: req.signal },
      );
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield event.delta.text;
        }
      }
    } catch (err) {
      throw this.wrapError(err);
    }
  }

  // ── internal helpers ───────────────────────────────────────────────

  /**
   * Quick token estimate for the cache-eligibility threshold. We use the
   * classic `chars / 4` heuristic — the threshold (1024 tokens) is fuzzy
   * enough that a 10% error margin is irrelevant. (Detailed estimation
   * lives in `@sanix/core`'s TokenBudget; providers stay dependency-free
   * from core.)
   */
  private quickTokenEstimate(text: string): number {
    if (text.length === 0) return 0;
    return Math.ceil(text.length / 4);
  }

  /**
   * Convert SANIX LLMMessage[] into Anthropic's `{ system, messages }`
   * shape. System messages are pulled out and concatenated into the top-
   * level `system` parameter; tool messages are mapped to `tool_result`
   * content blocks; assistant tool_calls become `tool_use` blocks.
   *
   * When prompt caching is enabled, this method also attaches
   * `cache_control: { type: 'ephemeral' }` markers to up to
   * {@link MAX_CACHE_BREAKPOINTS} stable blocks (system prompt, first
   * user message, most-recent assistant tool_use).
   *
   * Multi-modal: user/assistant messages whose `content` is a
   * `ContentBlock[]` are translated to Anthropic content blocks
   * (`text`, `image`). Image URLs are fetched and base64-encoded inline
   * (Anthropic does not accept URL references directly). Image files on
   * disk are read and base64-encoded.
   */
  private async translateMessages(req: LLMRequest): Promise<TranslatedRequest> {
    const systemParts: string[] = [];
    if (req.systemPrompt) systemParts.push(req.systemPrompt);

    const out: Anthropic.MessageParam[] = [];
    let firstUserMessageSeen = false;
    for (const m of req.messages) {
      if (m.role === 'system') {
        systemParts.push(extractText(m.content));
        continue;
      }
      if (m.role === 'user') {
        const isFirstUser = !firstUserMessageSeen;
        firstUserMessageSeen = true;
        out.push(await this.buildUserMessage(m.content, isFirstUser));
        continue;
      }
      if (m.role === 'assistant') {
        if (m.tool_calls && m.tool_calls.length > 0) {
          const blocks: Anthropic.ContentBlockParam[] = [];
          const text = extractText(m.content);
          if (text) blocks.push({ type: 'text', text });
          for (const tc of m.tool_calls) {
            let parsedArgs: unknown = {};
            try {
              parsedArgs = JSON.parse(tc.function.arguments);
            } catch {
              parsedArgs = {};
            }
            blocks.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.function.name,
              input: parsedArgs as Record<string, unknown>,
            });
          }
          out.push({ role: 'assistant', content: blocks });
        } else {
          out.push({ role: 'assistant', content: extractText(m.content) });
        }
        continue;
      }
      if (m.role === 'tool') {
        // Anthropic tool results ride inside a user message as tool_result blocks.
        // Tool results are always text-shaped in the SANIX protocol.
        out.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: m.tool_call_id ?? '',
              content: extractText(m.content),
            } satisfies Anthropic.ToolResultBlockParam,
          ],
        });
      }
    }

    // ── Apply cache_control breakpoints (max 4). ──
    const system = this.applyCacheBreakpoints(systemParts, out);
    return { system, messages: out };
  }

  /**
   * Build a user message param. When `content` is a plain string this
   * applies the existing cache-eligibility logic. When `content` is a
   * `ContentBlock[]`, this translates each block to its Anthropic
   * equivalent (text → text block, image_url / image_base64 / image_file →
   * Anthropic `image` source block, fetched and base64-encoded as needed).
   *
   * Cache breakpoints on multi-modal first-user messages are applied to
   * the *last* block (consistent with the string-content behavior of
   * caching the full message).
   */
  private async buildUserMessage(
    content: MessageContent,
    isFirstUser: boolean,
  ): Promise<Anthropic.MessageParam> {
    if (typeof content === 'string') {
      if (
        this.cacheEnabled &&
        isFirstUser &&
        this.quickTokenEstimate(content) >= MIN_CACHEABLE_TOKENS
      ) {
        const block: Anthropic.TextBlockParam = {
          type: 'text',
          text: content,
          cache_control: { type: 'ephemeral' },
        };
        return { role: 'user', content: [block] };
      }
      return { role: 'user', content };
    }

    // Multi-modal: translate each ContentBlock to its Anthropic equivalent.
    const blocks: Anthropic.ContentBlockParam[] = [];
    for (const block of content) {
      const translated = await this.translateContentBlock(block);
      if (translated) blocks.push(translated);
    }

    // Optionally attach a cache_control marker to the last block for the
    // first user message (Anthropic accepts cache_control on any block).
    if (
      this.cacheEnabled &&
      isFirstUser &&
      blocks.length > 0 &&
      this.quickTokenEstimate(JSON.stringify(content)) >= MIN_CACHEABLE_TOKENS
    ) {
      const last = blocks[blocks.length - 1] as Anthropic.ContentBlockParam & {
        cache_control?: { type: 'ephemeral' };
      };
      last.cache_control = { type: 'ephemeral' };
    }
    return { role: 'user', content: blocks };
  }

  /**
   * Translate a single SANIX {@link ContentBlock} to its Anthropic
   * content-block param. Returns `null` for unsupported / empty blocks
   * (they are simply dropped).
   *
   * - `text` → `{ type: 'text', text }`
   * - `image_base64` → `{ type: 'image', source: { type: 'base64', media_type, data } }`
   * - `image_url` → fetched (5MB cap), then sent as `image` base64.
   * - `image_file` → read from disk, base64-encoded, sent as `image` base64.
   */
  private async translateContentBlock(
    block: ContentBlock,
  ): Promise<Anthropic.ContentBlockParam | null> {
    if (block.type === 'text') {
      const text = block.text ?? '';
      if (!text) return null;
      return { type: 'text', text };
    }
    if (block.type === 'image_base64' && block.image_base64) {
      const { data, mediaType } = block.image_base64;
      if (!data) return null;
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: mediaType as AnthropicMediaType,
          data,
        },
      } as Anthropic.ImageBlockParam;
    }
    if (block.type === 'image_url' && block.image_url) {
      const { url } = block.image_url;
      if (!url) return null;
      // `data:` URLs already carry the base64 payload.
      if (url.startsWith('data:')) {
        const parsed = parseDataUrl(url);
        if (parsed) {
          return {
            type: 'image',
            source: {
              type: 'base64',
              media_type: parsed.mediaType as AnthropicMediaType,
              data: parsed.data,
            },
          } as Anthropic.ImageBlockParam;
        }
      }
      const fetched = await fetchImageAsBase64(url, MAX_IMAGE_BYTES);
      if (!fetched) return null;
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: fetched.mediaType as AnthropicMediaType,
          data: fetched.data,
        },
      } as Anthropic.ImageBlockParam;
    }
    if (block.type === 'image_file' && block.image_file) {
      const filePath = block.image_file.path;
      if (!filePath) return null;
      const encoded = await readImageAsBase64(filePath, MAX_IMAGE_BYTES);
      if (!encoded) return null;
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: encoded.mediaType as AnthropicMediaType,
          data: encoded.data,
        },
      } as Anthropic.ImageBlockParam;
    }
    return null;
  }

  /**
   * Attach `cache_control` markers to the system prompt and the most-
   * recent assistant `tool_use` block. The system prompt marker is
   * applied to the last text block in the system array so the entire
   * system prompt is cached. The assistant marker is applied to the
   * last `tool_use` block of the most-recent assistant message that
   * contains tool_use blocks.
   *
   * Anthropic caps the total number of breakpoints per request at
   * {@link MAX_CACHE_BREAKPOINTS}; this method never exceeds that cap.
   *
   * @returns The system prompt as either a plain string (when no cache
   *          marker is applied) or an array of text blocks (when it is).
   */
  private applyCacheBreakpoints(
    systemParts: string[],
    messages: Anthropic.MessageParam[],
  ): string | Anthropic.TextBlockParam[] | undefined {
    if (systemParts.length === 0) return undefined;
    const systemText = systemParts.join('\n\n');

    if (!this.cacheEnabled) {
      return systemText;
    }

    let breakpointsUsed = 0;
    const systemBlocks: Anthropic.TextBlockParam[] = [
      { type: 'text', text: systemText },
    ];

    // Breakpoint 1: system prompt (when ≥ threshold).
    if (this.quickTokenEstimate(systemText) >= MIN_CACHEABLE_TOKENS) {
      systemBlocks[0]!.cache_control = { type: 'ephemeral' };
      breakpointsUsed++;
    }

    // Breakpoint 2: first user message (already applied in buildUserMessage).
    // We don't double-count here; just note we may have used one there.
    for (const m of messages) {
      if (m.role !== 'user') continue;
      const content = m.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            typeof block === 'object' &&
            block !== null &&
            'cache_control' in block &&
            block.cache_control
          ) {
            breakpointsUsed++;
            break;
          }
        }
      }
      break; // only inspect the first user message
    }

    // Breakpoint 3: most-recent assistant tool_use block.
    if (breakpointsUsed < MAX_CACHE_BREAKPOINTS) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]!;
        if (m.role !== 'assistant') continue;
        const content = m.content;
        if (!Array.isArray(content)) break;
        // Find the last tool_use block in this assistant message.
        for (let j = content.length - 1; j >= 0; j--) {
          const block = content[j] as Anthropic.ContentBlockParam;
          if (block.type === 'tool_use') {
            (block as Anthropic.ToolUseBlockParam).cache_control = { type: 'ephemeral' };
            breakpointsUsed++;
            break;
          }
        }
        break; // only the most-recent assistant message
      }
    }

    // If we never applied a cache marker to the system block, return the
    // system as a plain string (the API accepts both shapes; a plain
    // string is cheaper on the wire).
    if (!systemBlocks[0]!.cache_control) {
      return systemText;
    }
    return systemBlocks;
  }

  /** Convert SANIX ToolDef[] into Anthropic's `tools` parameter. */
  private translateTools(tools: ToolDef[]): Anthropic.Tool[] {
    return tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters as Anthropic.Tool.InputSchema,
    }));
  }

  /** Extract text + tool calls from Anthropic content blocks. */
  private extractContent(blocks: Anthropic.ContentBlock[]): {
    text: string;
    toolCalls: ToolCall[];
  } {
    let text = '';
    const toolCalls: ToolCall[] = [];
    for (const block of blocks) {
      if (block.type === 'text') {
        text += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        });
      }
    }
    return { text, toolCalls };
  }

  /** Map an Anthropic SDK / fetch error into our typed hierarchy. */
  private wrapError(err: unknown): ProviderError {
    if (err instanceof ProviderError) return err;
    if (err instanceof Error && err.name === 'AbortError') {
      return new ProviderNetworkError(this.id, `Request aborted: ${err.message ?? 'no message'}`);
    }
    if (err instanceof Anthropic.APIError) {
      // status is on the instance; message is human-readable.
      const status = (err as unknown as { status?: number }).status ?? 0;
      const msg = err.message ?? 'Anthropic API error';
      if (status === 429 || (status >= 500 && status < 600)) {
        // We can't easily classify into ProviderServerError vs RateLimitError
        // without re-importing; just emit a generic ProviderError with retryable.
        return new ProviderError(this.id, msg, status, true);
      }
      return new ProviderError(this.id, msg, status, false);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return new ProviderNetworkError(this.id, `Unexpected Anthropic failure: ${msg}`);
  }
}

// ── Multi-modal content helpers ────────────────────────────────────────────

/**
 * Extract the textual portion of a {@link MessageContent}. For plain string
 * content this returns the string verbatim. For array content, this
 * concatenates all `text` blocks (in order) with newline separators,
 * silently dropping image blocks (Anthropic does not support images in
 * system or tool-result messages).
 */
function extractText(content: MessageContent): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n');
}

/** Result of parsing a `data:<mediaType>;base64,<data>` URL. */
interface ParsedDataUrl {
  mediaType: string;
  data: string;
}

/**
 * Parse a `data:` URL into its media-type + base64-data components.
 * Returns `null` for malformed URLs.
 */
function parseDataUrl(url: string): ParsedDataUrl | null {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
  if (!match) return null;
  const mediaType = match[1] || 'application/octet-stream';
  const isBase64 = match[2] === ';base64';
  const raw = match[3] ?? '';
  if (!isBase64) return null;
  return { mediaType, data: raw };
}

/**
 * Fetch an image from a URL and return its base64-encoded payload + media
 * type. Enforces a maximum byte size; returns `null` on any failure (the
 * caller drops the block rather than failing the whole request).
 *
 * The media type is read from the `Content-Type` response header; if the
 * server omits it, we infer from the URL extension with a PNG fallback.
 */
async function fetchImageAsBase64(
  url: string,
  maxBytes: number,
): Promise<{ data: string; mediaType: string } | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const contentLength = Number(res.headers.get('content-length') ?? 0);
    if (contentLength > maxBytes) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) return null;
    const mediaType = (res.headers.get('content-type') ?? inferMediaType(url)).split(';')[0]!.trim();
    return { data: buf.toString('base64'), mediaType };
  } catch {
    return null;
  }
}

/**
 * Read an image file from disk and return its base64-encoded payload +
 * media type. Enforces a maximum byte size; returns `null` on any failure.
 */
async function readImageAsBase64(
  filePath: string,
  maxBytes: number,
): Promise<{ data: string; mediaType: string } | null> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return null;
    if (stat.size > maxBytes) return null;
    const buf = await fs.readFile(filePath);
    return { data: buf.toString('base64'), mediaType: inferMediaType(filePath) };
  } catch {
    return null;
  }
}

/** Infer an image media type from a file path / URL extension. */
function inferMediaType(p: string): string {
  const ext = path.extname(p).toLowerCase();
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    default:
      return 'image/png';
  }
}
