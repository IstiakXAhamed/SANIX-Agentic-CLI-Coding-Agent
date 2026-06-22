/**
 * @file LMStudioAdapter.ts
 * @description IProvider adapter for a local LM Studio server
 * (http://localhost:1234/v1). LM Studio exposes an OpenAI-compatible API,
 * so this class extends {@link OpenAICompatBase}. The `available()` check
 * pings `/v1/models` to detect whether the local server is running.
 */

import { IProvider, LLMRequest, LLMResponse } from '../interfaces/IProvider.js';
import { OpenAICompatBase } from './_openaiCompat.js';
import { pingUrl } from './_http.js';

const LMSTUDIO_DEFAULT_URL = 'http://localhost:1234/v1';

/** Constructor options for {@link LMStudioAdapter}. */
export interface LMStudioAdapterOptions {
  /** Base URL. Defaults to http://localhost:1234/v1. */
  baseURL?: string;
  /** Stable alias id (defaults to 'lmstudio-default'). */
  modelId?: string;
  /** Concrete LM Studio model id (defaults to 'local-model'). */
  concreteModel?: string;
  /** Override the display name shown in the TUI. */
  displayName?: string;
  /** Per-request default timeout in ms. */
  defaultTimeoutMs?: number;
}

/**
 * Adapter for a local LM Studio instance. LM Studio requires no API key
 * (it runs on localhost), so the only configuration knob is the base URL.
 *
 * `available()` performs a real GET against `/v1/models` because the
 * server may not be running; we never want the router to prefer a
 * local-only provider that is offline.
 */
export class LMStudioAdapter extends OpenAICompatBase implements IProvider {
  constructor(opts: LMStudioAdapterOptions = {}) {
    const modelId = opts.modelId ?? 'lmstudio-default';
    super({
      providerId: modelId,
      baseURL: opts.baseURL ?? LMSTUDIO_DEFAULT_URL,
      apiKey: undefined, // local, no auth
      model: opts.concreteModel ?? 'local-model',
      displayName: opts.displayName ?? 'LM Studio (local)',
      capabilityId: 'lmstudio-default',
      isLocal: true,
      defaultTimeoutMs: opts.defaultTimeoutMs ?? 60_000,
    });
  }

  /** @inheritdoc — ping /models to detect a running server. */
  override async available(): Promise<boolean> {
    const modelsUrl = `${this.opts.baseURL.replace(/\/$/, '')}/models`;
    return pingUrl(modelsUrl, { timeoutMs: 3_000 });
  }

  override async chat(req: LLMRequest): Promise<LLMResponse> {
    return super.chat(req);
  }

  override async *chatStream(req: LLMRequest): AsyncIterable<string> {
    yield* super.chatStream(req);
  }
}
