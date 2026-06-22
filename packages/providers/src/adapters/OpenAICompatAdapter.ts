/**
 * @file OpenAICompatAdapter.ts
 * @description Generic IProvider adapter for any OpenAI-compatible
 * endpoint (vLLM, llama.cpp server, LocalAI, custom OpenAI proxies).
 *
 * Unlike the curated adapters (Groq, Together, etc.), this one takes all
 * configuration from the caller — there is no hardcoded base URL or
 * default model. It is what `sanix providers add <name> --url <url>`
 * constructs under the hood.
 */

import { IProvider, LLMRequest, LLMResponse } from '../interfaces/IProvider.js';
import { OpenAICompatBase, type OpenAICompatBaseOptions } from './_openaiCompat.js';

/** Constructor options for {@link OpenAICompatAdapter}. */
export interface OpenAICompatAdapterOptions {
  /** Stable unique id used by the router and TUI. */
  id: string;
  /** Full base URL, e.g. http://localhost:8000/v1 or https://my-proxy.com/v1. */
  baseURL: string;
  /** Concrete model id posted in the request body. */
  model: string;
  /** Display name shown in the TUI. */
  displayName?: string;
  /** Optional API key (omitted for no-auth local servers). */
  apiKey?: string;
  /** Override capability lookup (defaults to `model`). */
  capabilityId?: string;
  /** Auth header name (default 'Authorization'). */
  authHeaderName?: string;
  /** Auth scheme prefix (default 'Bearer '). */
  authScheme?: string;
  /** Chat path appended to baseURL (default '/chat/completions'). */
  chatPath?: string;
  /** Whether this endpoint is local. Defaults to URL-derived heuristic. */
  isLocal?: boolean;
  /** Per-request default timeout in ms. */
  defaultTimeoutMs?: number;
}

/**
 * Generic OpenAI-compatible adapter. Same wire protocol as Mistral/Groq/
 * Together/DeepSeek/LM Studio — this class just doesn't bake in any
 * defaults, so it can target any custom endpoint.
 */
export class OpenAICompatAdapter extends OpenAICompatBase implements IProvider {
  constructor(opts: OpenAICompatAdapterOptions) {
    const isLocal =
      opts.isLocal ?? /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)/i.test(opts.baseURL);
    super({
      providerId: opts.id,
      baseURL: opts.baseURL,
      apiKey: opts.apiKey,
      model: opts.model,
      displayName: opts.displayName ?? opts.id,
      capabilityId: opts.capabilityId ?? opts.model,
      authHeaderName: opts.authHeaderName,
      authScheme: opts.authScheme,
      chatPath: opts.chatPath,
      isLocal,
      defaultTimeoutMs: opts.defaultTimeoutMs ?? 30_000,
    } satisfies OpenAICompatBaseOptions);
  }

  override async chat(req: LLMRequest): Promise<LLMResponse> {
    return super.chat(req);
  }

  override async *chatStream(req: LLMRequest): AsyncIterable<string> {
    yield* super.chatStream(req);
  }
}
