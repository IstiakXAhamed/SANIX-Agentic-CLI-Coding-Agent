/**
 * @file GroqAdapter.ts
 * @description IProvider adapter for Groq's OpenAI-compatible
 * chat-completions endpoint (Llama 3.3 70B, Qwen 2.5 72B, etc.). Groq
 * specializes in ultra-low-latency inference and is the router's
 * preferred provider for `fast_lookup` tasks.
 */

import { IProvider, LLMRequest, LLMResponse } from '../interfaces/IProvider.js';
import { OpenAICompatBase } from './_openaiCompat.js';

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

/** Constructor options for {@link GroqAdapter}. */
export interface GroqAdapterOptions {
  /** API key. Falls back to env `GROQ_API_KEY` when omitted. */
  apiKey?: string;
  /** Stable alias id (defaults to 'llama-3.3-70b'). */
  modelId?: string;
  /** Concrete model id posted to Groq. */
  concreteModel?: string;
  /** Override the display name shown in the TUI. */
  displayName?: string;
  /** Per-request default timeout in ms. */
  defaultTimeoutMs?: number;
}

/**
 * Adapter for Groq-hosted models. Groq's OpenAI-compatible endpoint is
 * identical in shape to OpenAI's, so this class only customizes the
 * constructor.
 *
 * The default concrete model string mirrors Groq's published ids
 * (e.g. `llama-3.3-70b-versatile`) — callers may override via
 * `concreteModel` when Groq renames a model.
 */
export class GroqAdapter extends OpenAICompatBase implements IProvider {
  constructor(opts: GroqAdapterOptions = {}) {
    const modelId = opts.modelId ?? 'llama-3.3-70b';
    const defaultConcrete =
      modelId === 'llama-3.3-70b'
        ? 'llama-3.3-70b-versatile'
        : modelId === 'qwen-2.5-72b'
          ? 'qwen-2.5-72b-versatile'
          : modelId;
    super({
      providerId: modelId,
      baseURL: GROQ_BASE_URL,
      apiKey: opts.apiKey ?? process.env.GROQ_API_KEY,
      model: opts.concreteModel ?? defaultConcrete,
      displayName: opts.displayName ?? `Groq ${modelId}`,
      capabilityId: modelId,
      defaultTimeoutMs: opts.defaultTimeoutMs ?? 30_000,
    });
  }

  override async chat(req: LLMRequest): Promise<LLMResponse> {
    return super.chat(req);
  }

  override async *chatStream(req: LLMRequest): AsyncIterable<string> {
    yield* super.chatStream(req);
  }
}
