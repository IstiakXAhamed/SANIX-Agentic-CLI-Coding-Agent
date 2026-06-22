/**
 * @file IProvider.ts
 * @description Unified LLM provider interface and shared message/response types
 * used by every adapter in @sanix/providers. Designed to be transport-agnostic so
 * that cloud (Anthropic, OpenAI, Gemini, Mistral, Groq, Together, DeepSeek) and
 * local (Ollama, LM Studio, generic OpenAI-compat) providers share one contract.
 */

/**
 * A single tool call requested by the model. Mirrors the OpenAI tool-call shape
 * so it can be round-tripped through the most popular providers unchanged.
 */
export interface ToolCall {
  /** Provider-issued unique id for the call (used to correlate the tool result). */
  id: string;
  /** Always 'function' for now; reserved for future tool types. */
  type: 'function';
  /** The function invocation the model wants to make. */
  function: {
    name: string;
    /** Raw JSON string of arguments; caller parses with the tool's schema. */
    arguments: string;
  };
}

/**
 * A single content block within a multi-modal message. A message's `content`
 * may be either a plain `string` (the legacy, text-only shape) or an array
 * of these blocks (for multi-modal messages containing text + images).
 *
 * Block types:
 * - `text`           — a textual chunk (analogous to plain-string content).
 * - `image_url`      — an image referenced by a public URL. Some providers
 *   (OpenAI) fetch the URL themselves; others (Anthropic) require the
 *   adapter to download and base64-encode it before sending.
 * - `image_base64`   — an image supplied as raw base64 data plus its media
 *   type. Universally supported.
 * - `image_file`     — an image on the local filesystem; the adapter reads
 *   and base64-encodes it before sending.
 */
export interface ContentBlock {
  /** Discriminator for the content block shape. */
  type: 'text' | 'image_url' | 'image_base64' | 'image_file';
  /** Text content (present when `type === 'text'`). */
  text?: string;
  /** Image URL block (present when `type === 'image_url'`). */
  image_url?: {
    /** The image URL (http/https or `data:` URL). */
    url: string;
    /** OpenAI-style detail hint; some providers ignore it. */
    detail?: 'low' | 'high' | 'auto';
  };
  /** Base64 image block (present when `type === 'image_base64'`). */
  image_base64?: {
    /** Raw base64-encoded image data (no `data:` prefix). */
    data: string;
    /** Media type. */
    mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  };
  /** Local file path block (present when `type === 'image_file'`). */
  image_file?: {
    /** Absolute or cwd-relative filesystem path to the image. */
    path: string;
  };
}

/**
 * The content payload of an {@link LLMMessage}. Either a plain `string`
 * (backward-compatible text-only shape) or an array of typed
 * {@link ContentBlock}s (for multi-modal messages).
 */
export type MessageContent = string | ContentBlock[];

/**
 * A chat message in the unified SANIX protocol. The `role` field covers the
 * four standard roles; tool messages carry `tool_call_id` to correlate with a
 * prior ToolCall, and assistant messages may carry `tool_calls` when the
 * model wants to invoke tools.
 *
 * Multi-modal support: `content` is a {@link MessageContent} — either a
 * plain `string` (legacy) or an array of {@link ContentBlock}s (text +
 * images). Plain-string content remains fully supported and is the
 * recommended shape for text-only messages; adapters special-case the
 * string form to keep wire payloads minimal.
 */
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: MessageContent;
  /** Set when role==='tool' — must match a prior ToolCall.id. */
  tool_call_id?: string;
  /** Set when role==='assistant' and the model emitted tool calls. */
  tool_calls?: ToolCall[];
  /** Optional name attached to the message (used for tool-call attribution). */
  name?: string;
}

/**
 * A tool/function definition handed to the model so it knows what it can call.
 * The `parameters` field is a JSON-Schema object describing accepted arguments.
 */
export interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    /** JSON-Schema parameters object (passed verbatim to providers). */
    parameters: object;
  };
}

/**
 * The set of high-level task categories the router uses to score providers.
 * - `code` — code generation, refactoring, debugging
 * - `reasoning` — multi-step planning, math, analysis
 * - `fast_lookup` — classification, lookup, simple Q&A where latency dominates
 * - `embeddings` — vector embedding (handled by a separate embeddings path)
 * - `general` — default catch-all
 */
export type TaskType = 'code' | 'reasoning' | 'fast_lookup' | 'embeddings' | 'general';

/**
 * A request to a provider. All fields are optional except `messages`.
 * `signal` lets callers cancel mid-flight; `preferLocal` biases the router
 * toward local providers (offline / privacy mode).
 */
export interface LLMRequest {
  messages: LLMMessage[];
  tools?: ToolDef[];
  maxTokens?: number;
  temperature?: number;
  taskType?: TaskType;
  stream?: boolean;
  signal?: AbortSignal;
  /** When true, the router adds a +50 score to local providers. */
  preferLocal?: boolean;
  /** Optional system prompt prepended (also accepted inside `messages`). */
  systemPrompt?: string;
}

/**
 * Normalized token-usage accounting. All providers map their native usage
 * objects into this shape so the budget manager can reason uniformly.
 *
 * The cache-related fields are optional and provider-specific:
 * - `cacheCreationTokens` — Anthropic: tokens written to the prompt cache
 *   (billed at ~125% of input price).
 * - `cacheReadTokens`     — Anthropic: tokens served from the prompt cache
 *   (billed at ~10% of input price).
 * - `cachedTokens`        — OpenAI: tokens served from the cached prefix
 *   (billed at ~50% of input price).
 *
 * All three fields are optional so existing callers that only read
 * `inputTokens` / `outputTokens` continue to compile and behave unchanged.
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Anthropic: tokens written to the prompt cache this call. */
  cacheCreationTokens?: number;
  /** Anthropic: tokens read from the prompt cache this call (discounted). */
  cacheReadTokens?: number;
  /** OpenAI: tokens served from the cached prefix this call (discounted). */
  cachedTokens?: number;
}

/**
 * Alias for {@link TokenUsage} covering the cache-aware shape. Exported so
 * callers can refer to the documented "LLMUsage" name from the spec; under
 * the hood it is the same interface as `TokenUsage` for backward compat.
 */
export type LLMUsage = TokenUsage;

/**
 * The unified LLM response. `toolCalls` is undefined when the model returned
 * plain text; populated when the model requested tool invocations instead.
 *
 * Cache-aware fields:
 * - `cacheHit`  — true if any tokens were served from a cache this call
 *   (Anthropic `cache_read_input_tokens > 0` or OpenAI `cached_tokens > 0`).
 * - `costUsd`   — computed cost in USD for this call (filled in by the
 *   CostTracker when wired into the agent loop; undefined when uncomputed).
 */
export interface LLMResponse {
  content: string;
  toolCalls?: ToolCall[];
  usage: TokenUsage;
  /** The concrete model id that served the request (after alias resolution). */
  model: string;
  /** End-to-end latency in milliseconds (from call entry to response). */
  latencyMs: number;
  /** Provider-native stop reason (stop, length, tool_use, etc.). */
  stopReason?: string;
  /** True if any tokens were served from a prompt cache this call. */
  cacheHit?: boolean;
  /** Computed cost in USD for this call (filled in by CostTracker). */
  costUsd?: number;
}

/**
 * The contract every SANIX provider adapter must implement.
 *
 * Adapters wrap a single underlying LLM endpoint (cloud or local) and expose
 * a uniform interface so the {@link ProviderRouter} can score, select, and
 * fall back across heterogeneous backends without the caller caring which
 * provider actually served the request.
 */
export interface IProvider {
  /** Stable unique id, e.g. 'claude-sonnet-4', 'groq-llama-3.3-70b'. */
  readonly id: string;
  /** Human-friendly label for TUI display. */
  readonly displayName: string;
  /** True for Ollama/LM Studio/local OpenAI-compat endpoints. */
  readonly isLocal: boolean;
  /** Strength tags: 'code', 'reasoning', 'fast_lookup', 'embeddings', 'general'. */
  readonly strengths: string[];
  /** Typical p50 latency in ms (used by the router for fast_lookup scoring). */
  readonly latencyMs: number;
  /** Blended cost per million tokens (input + output averaged), USD. */
  readonly costPerMillionTokens: number;
  /** Maximum context window in tokens. */
  readonly maxContextTokens: number;

  /**
   * Perform a single non-streaming chat request.
   * Must respect `req.signal` and throw {@link ProviderError} subclasses on
   * rate-limit / server / network failures.
   */
  chat(req: LLMRequest): Promise<LLMResponse>;

  /**
   * Perform a streaming chat request, yielding text deltas as they arrive.
   * Tool calls are NOT surfaced mid-stream — callers that need tool calls
   * should use {@link chat} instead. The generator must close cleanly on
   * completion, error, or abort.
   */
  chatStream(req: LLMRequest): AsyncIterable<string>;

  /**
   * Lightweight reachability check (no model invocation). Used by the
   * router's circuit breaker and `sanix providers test`. Should resolve
   * quickly (sub-second) and never throw — return false on failure.
   */
  available(): Promise<boolean>;
}
