/**
 * @file llm.ts
 * @description Tiny helper around `IProvider.chat()` that adds timeout +
 * retry semantics (required by the spec: "All LLM calls must have timeout
 * + retry").
 *
 * @packageDocumentation
 */

import type { IProvider, LLMMessage, LLMResponse } from '@sanix/providers';

/**
 * Options for {@link chatWithRetry}.
 */
export interface ChatOptions {
  /** Wall-clock timeout per attempt (ms). Default 30_000. */
  timeoutMs?: number;
  /** Max attempts (including the first). Default 3. */
  maxAttempts?: number;
  /** Base backoff (ms); doubled each retry. Default 1_000. */
  backoffMs?: number;
  /** Optional abort signal. */
  signal?: AbortSignal;
  /** Max output tokens. */
  maxTokens?: number;
  /** Temperature. */
  temperature?: number;
}

/**
 * Send a single user-prompt to the provider, with timeout + retry.
 *
 * @example
 * ```ts
 * const reply = await chatWithRetry(provider, 'Rewrite: hello', { maxAttempts: 3 });
 * ```
 */
export async function chatWithRetry(
  provider: IProvider,
  userMessage: string,
  opts: ChatOptions = {},
): Promise<LLMResponse> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseBackoff = opts.backoffMs ?? 1_000;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  let lastErr: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Allow caller cancellation too.
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    try {
      const messages: LLMMessage[] = [{ role: 'user', content: userMessage }];
      const res = await provider.chat({
        messages,
        signal: controller.signal,
        maxTokens: opts.maxTokens,
        temperature: opts.temperature,
      });
      clearTimeout(timer);
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err instanceof Error ? err : new Error(String(err));
      // Exponential backoff before the next attempt.
      if (attempt < maxAttempts) {
        const wait = baseBackoff * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw lastErr ?? new Error('chatWithRetry: exhausted retries');
}

/**
 * Send a system-prompt + user-prompt to the provider, with timeout + retry.
 */
export async function chatWithSystem(
  provider: IProvider,
  systemPrompt: string,
  userMessage: string,
  opts: ChatOptions = {},
): Promise<LLMResponse> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseBackoff = opts.backoffMs ?? 1_000;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  let lastErr: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    try {
      const messages: LLMMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ];
      const res = await provider.chat({
        messages,
        signal: controller.signal,
        maxTokens: opts.maxTokens,
        temperature: opts.temperature,
      });
      clearTimeout(timer);
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxAttempts) {
        const wait = baseBackoff * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw lastErr ?? new Error('chatWithSystem: exhausted retries');
}
