/**
 * @file TogetherAdapter.ts
 * @description IProvider adapter for Together AI's OpenAI-compatible
 * chat-completions endpoint. Together hosts many open-source models
 * (Llama, Qwen, DeepSeek, DBRX, etc.) behind a uniform API.
 */

import { IProvider, LLMRequest, LLMResponse } from '../interfaces/IProvider.js';
import { OpenAICompatBase } from './_openaiCompat.js';

const TOGETHER_BASE_URL = 'https://api.together.xyz/v1';

/** Constructor options for {@link TogetherAdapter}. */
export interface TogetherAdapterOptions {
  /** API key. Falls back to env `TOGETHER_API_KEY` when omitted. */
  apiKey?: string;
  /** Stable alias id (defaults to 'together-default'). */
  modelId?: string;
  /** Concrete Together model id, e.g. `meta-llama/Llama-3.3-70B-Instruct-Turbo`. */
  concreteModel?: string;
  /** Override the display name shown in the TUI. */
  displayName?: string;
  /** Override capability id used for cost/latency scoring. */
  capabilityId?: string;
  /** Per-request default timeout in ms. */
  defaultTimeoutMs?: number;
}

/**
 * Adapter for Together AI. Because Together's catalog is large and shifts
 * frequently, the caller MUST supply a `concreteModel` (Together's
 * `org/model-name` string). The alias id is used for routing/display only.
 */
export class TogetherAdapter extends OpenAICompatBase implements IProvider {
  constructor(opts: TogetherAdapterOptions = {}) {
    const modelId = opts.modelId ?? 'together-default';
    super({
      providerId: modelId,
      baseURL: TOGETHER_BASE_URL,
      apiKey: opts.apiKey ?? process.env.TOGETHER_API_KEY,
      model: opts.concreteModel ?? modelId,
      displayName: opts.displayName ?? `Together ${modelId}`,
      capabilityId: opts.capabilityId ?? modelId,
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
