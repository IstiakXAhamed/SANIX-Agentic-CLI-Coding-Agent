/**
 * @file MistralAdapter.ts
 * @description IProvider adapter for Mistral AI's OpenAI-compatible
 * chat-completions endpoint (Mistral Large, Codestral). Uses REST via
 * the shared {@link OpenAICompatBase}; no SDK required.
 */

import { IProvider, LLMRequest, LLMResponse } from '../interfaces/IProvider.js';
import { OpenAICompatBase } from './_openaiCompat.js';

const MISTRAL_BASE_URL = 'https://api.mistral.ai/v1';

/** Constructor options for {@link MistralAdapter}. */
export interface MistralAdapterOptions {
  /** API key. Falls back to env `MISTRAL_API_KEY` when omitted. */
  apiKey?: string;
  /** Stable alias id (defaults to 'mistral-large'). */
  modelId?: string;
  /** Concrete model id posted to Mistral (defaults to alias). */
  concreteModel?: string;
  /** Override the display name shown in the TUI. */
  displayName?: string;
  /** Per-request default timeout in ms. */
  defaultTimeoutMs?: number;
}

/**
 * Adapter for Mistral AI models. Mistral's `/v1/chat/completions` endpoint
 * is OpenAI-compatible, so this class is a thin specialization of
 * {@link OpenAICompatBase}.
 */
export class MistralAdapter extends OpenAICompatBase implements IProvider {
  constructor(opts: MistralAdapterOptions = {}) {
    const modelId = opts.modelId ?? 'mistral-large';
    super({
      providerId: modelId,
      baseURL: MISTRAL_BASE_URL,
      apiKey: opts.apiKey ?? process.env.MISTRAL_API_KEY,
      model: opts.concreteModel ?? modelId,
      displayName: opts.displayName ?? `Mistral ${modelId}`,
      capabilityId: modelId,
      defaultTimeoutMs: opts.defaultTimeoutMs ?? 30_000,
    });
  }

  // Inherits chat / chatStream / available from OpenAICompatBase.
  // Re-declared here only to satisfy the IProvider contract on the public type.
  override async chat(req: LLMRequest): Promise<LLMResponse> {
    return super.chat(req);
  }

  override async *chatStream(req: LLMRequest): AsyncIterable<string> {
    yield* super.chatStream(req);
  }
}
