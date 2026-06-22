/**
 * @file DeepSeekAdapter.ts
 * @description IProvider adapter for DeepSeek's OpenAI-compatible
 * chat-completions endpoint (DeepSeek V3, DeepSeek R1). Uses REST via
 * the shared {@link OpenAICompatBase}.
 *
 * Note: DeepSeek-R1 is a reasoning model that emits its chain-of-thought
 * inside `<think>...</think>` tags within the `content` field. We do not
 * strip these here — callers (the agent loop) decide whether to surface
 * reasoning to the user.
 */

import { IProvider, LLMRequest, LLMResponse } from '../interfaces/IProvider.js';
import { OpenAICompatBase } from './_openaiCompat.js';

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';

/** Constructor options for {@link DeepSeekAdapter}. */
export interface DeepSeekAdapterOptions {
  /** API key. Falls back to env `DEEPSEEK_API_KEY` when omitted. */
  apiKey?: string;
  /** Stable alias id (defaults to 'deepseek-v3'). */
  modelId?: string;
  /** Concrete DeepSeek model id (defaults to alias). */
  concreteModel?: string;
  /** Override the display name shown in the TUI. */
  displayName?: string;
  /** Per-request default timeout in ms. */
  defaultTimeoutMs?: number;
}

/**
 * Adapter for DeepSeek cloud models. DeepSeek's API is OpenAI-compatible
 * (including tool calling and streaming), so this class only customizes
 * the constructor.
 */
export class DeepSeekAdapter extends OpenAICompatBase implements IProvider {
  constructor(opts: DeepSeekAdapterOptions = {}) {
    const modelId = opts.modelId ?? 'deepseek-v3';
    const defaultConcrete = modelId === 'deepseek-r1' ? 'deepseek-reasoner' : 'deepseek-chat';
    super({
      providerId: modelId,
      baseURL: DEEPSEEK_BASE_URL,
      apiKey: opts.apiKey ?? process.env.DEEPSEEK_API_KEY,
      model: opts.concreteModel ?? defaultConcrete,
      displayName: opts.displayName ?? `DeepSeek ${modelId}`,
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
