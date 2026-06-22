/**
 * @file mockProvider.ts
 * @description A mock `IProvider` for testing. Returns canned responses,
 * optionally echoes input, supports per-call latency, and tracks every
 * call so tests can assert on usage.
 */
import type {
  IProvider,
  LLMRequest,
  LLMResponse,
} from '@sanix/providers';

export interface MockProviderOptions {
  /**
   * Either a fixed canned response (string), a list of canned
   * responses (consumed in order — the last item is reused after the
   * list is exhausted), or a function that produces a response from
   * the request. When omitted, the provider echoes the last user
   * message back to the caller.
   */
  responses?: string | string[] | ((req: LLMRequest) => string);
  /** Simulated latency in ms. Default 0 (instant). */
  latencyMs?: number;
  /** Reported token usage on each response. Default {10, 20}. */
  usage?: { inputTokens: number; outputTokens: number };
  /** Reported cost in USD on each response. Default 0. */
  costUsd?: number;
  /** The provider id (used by router/cache code paths). Default 'mock'. */
  id?: string;
  /** Strengths tags. Default ['general']. */
  strengths?: string[];
}

export interface MockProvider extends IProvider {
  /** Every request the provider has received, in order. */
  calls: LLMRequest[];
  /** Number of calls received (== calls.length). */
  callCount: number;
  /** Reset the call log + reset the canned-response cursor to 0. */
  reset(): void;
}

/**
 * Create a mock `IProvider` for testing. The returned object is a full
 * `IProvider` (chat / chatStream / available) plus a `calls` array and
 * `callCount` accessor for assertions.
 *
 * @example
 * ```ts
 * const provider = createMockProvider({
 *   responses: ['hello', 'world'],
 *   usage: { inputTokens: 5, outputTokens: 7 },
 * });
 * const r = await provider.chat({ messages: [{ role: 'user', content: 'hi' }] });
 * expect(r.content).toBe('hello');
 * expect(provider.callCount).toBe(1);
 * ```
 */
export function createMockProvider(
  opts: MockProviderOptions = {},
): MockProvider {
  const responses = opts.responses;
  const latencyMs = opts.latencyMs ?? 0;
  const defaultUsage = opts.usage ?? { inputTokens: 10, outputTokens: 20 };
  const costUsd = opts.costUsd ?? 0;
  const id = opts.id ?? 'mock';
  const strengths = opts.strengths ?? ['general'];

  const calls: LLMRequest[] = [];
  let cursor = 0;

  const pickResponse = (req: LLMRequest): string => {
    if (typeof responses === 'function') return responses(req);
    if (typeof responses === 'string') return responses;
    if (Array.isArray(responses)) {
      const r = responses[Math.min(cursor, responses.length - 1)] ?? '';
      cursor++;
      return r;
    }
    // Echo the last user message back.
    for (let i = req.messages.length - 1; i >= 0; i--) {
      const m = req.messages[i]!;
      if (m.role === 'user') {
        if (typeof m.content === 'string') return m.content;
        if (Array.isArray(m.content)) {
          const text = m.content
            .map((b) => (b.type === 'text' ? b.text ?? '' : ''))
            .join(' ');
          return text;
        }
      }
    }
    return '';
  };

  const sleep = (ms: number): Promise<void> =>
    new Promise((r) => setTimeout(r, ms));

  const provider: MockProvider = {
    id,
    displayName: `Mock (${id})`,
    isLocal: true,
    strengths,
    latencyMs,
    costPerMillionTokens: 0,
    maxContextTokens: 8192,
    calls,
    get callCount(): number {
      return calls.length;
    },
    reset(): void {
      calls.length = 0;
      cursor = 0;
    },
    async chat(req: LLMRequest): Promise<LLMResponse> {
      calls.push(req);
      if (latencyMs > 0) await sleep(latencyMs);
      const content = pickResponse(req);
      const usage = {
        inputTokens: defaultUsage.inputTokens,
        outputTokens: defaultUsage.outputTokens,
      };
      return {
        content,
        usage,
        model: `${id}-mock`,
        latencyMs,
        stopReason: 'stop',
        cacheHit: false,
        costUsd,
      };
    },
    async *chatStream(req: LLMRequest): AsyncIterable<string> {
      calls.push(req);
      const content = pickResponse(req);
      // Yield word-by-word so streaming callers can consume deltas.
      const tokens = content.split(/(\s+)/);
      for (const tok of tokens) {
        if (latencyMs > 0) await sleep(Math.min(10, latencyMs));
        yield tok;
      }
    },
    async available(): Promise<boolean> {
      return true;
    },
  };

  return provider;
}
