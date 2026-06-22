/**
 * @file ExactTokenizer.ts
 * @description Exact BPE-based token counting for SANIX. Wraps the
 * `gpt-tokenizer` package (pure-JS, no native deps) to provide accurate
 * GPT-4 / GPT-3.5 (cl100k_base) token counts. Also exposes provider-
 * specific estimation: OpenAI uses the exact BPE encoder, Anthropic uses
 * a ~3.5 chars/token heuristic (Claude's tokenizer is not public), Gemini
 * uses a ~4 chars/token approximation, and `generic` falls back to the
 * detailedEstimate-style heuristic.
 *
 * All counts are LRU-cached (5000 entries by default) so repeated
 * measurements of the same string (extremely common during iterative
 * context building) are O(1) after the first call.
 *
 * The `gpt-tokenizer` import is lazy + wrapped in try/catch so the
 * optimizer package never crashes if the optional dep is missing — it
 * degrades to a char-based fallback. This mirrors how `@sanix/core`'s
 * TokenBudget guards its optimizer integration.
 *
 * @packageDocumentation
 */

import { createRequire } from 'node:module';
import type { LLMMessage } from '@sanix/providers';

// `require` is the standard ESM escape hatch for optional, possibly-missing
// CommonJS deps. `gpt-tokenizer` ships as CJS; using `createRequire` lets us
// load it synchronously and wrap the load in try/catch so a missing dep
// doesn't crash the whole optimizer package.
const nodeRequire = createRequire(import.meta.url);

/**
 * The set of providers the tokenizer can target. Each has a different
 * token-counting strategy (see {@link ExactTokenizer.countFor}).
 */
export type TokenizerProvider = 'anthropic' | 'openai' | 'gemini' | 'generic';

/**
 * The lazily-resolved `gpt-tokenizer` module surface. We only depend on
 * the two functions `encode` and `decode`, so the type is intentionally
 * narrow to keep the contract obvious and avoid accidental coupling to
 * the package's other exports.
 */
interface GptTokenizerModule {
  encode: (text: string) => number[];
  decode: (tokens: number[]) => string;
}

/**
 * A simple bounded LRU cache. Uses `Map`'s insertion-order preservation
 * for eviction: on every hit the entry is moved to the most-recently-used
 * end; when full, the first (least-recently-used) key is dropped.
 *
 * Kept deliberately tiny and dependency-free so the tokenizer doesn't
 * pull in anything heavier than `gpt-tokenizer` itself.
 */
class LruCache<K, V> {
  private readonly store: Map<K, V> = new Map();
  private readonly capacity: number;
  private hits = 0;
  private misses = 0;

  /**
   * @param capacity Maximum entries. Must be >= 1.
   */
  constructor(capacity: number) {
    if (capacity < 1) {
      throw new Error(`LruCache capacity must be >= 1 (got ${capacity})`);
    }
    this.capacity = capacity;
  }

  /**
   * Look up `key`, returning the cached value or `undefined` on miss.
   * On hit the entry is moved to the MRU end.
   */
  get(key: K): V | undefined {
    const v = this.store.get(key);
    if (v === undefined) {
      this.misses++;
      return undefined;
    }
    // Move to MRU.
    this.store.delete(key);
    this.store.set(key, v);
    this.hits++;
    return v;
  }

  /**
   * Insert `value` under `key`. Evicts the LRU entry when at capacity.
   */
  set(key: K, value: V): void {
    if (this.store.has(key)) this.store.delete(key);
    else if (this.store.size >= this.capacity) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, value);
  }

  /** Clear all entries. */
  clear(): void {
    this.store.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /** Current entry count. */
  get size(): number {
    return this.store.size;
  }

  /** Cache hits since last clear. */
  get hitCount(): number {
    return this.hits;
  }

  /** Cache misses since last clear. */
  get missCount(): number {
    return this.misses;
  }
}

/**
 * The default cache capacity for `count()` calls. 5000 strings covers a
 * typical agent session's working set (system prompt + plan + many file
 * chunks + recent history) without bloating memory.
 */
const DEFAULT_CACHE_CAPACITY = 5000;

/**
 * Per-message overhead added by the OpenAI Chat Completions API: each
 * message carries ~4 framing tokens (role tags, separators) on top of
 * the content tokens. We use the same constant the OpenAI cookbook uses.
 */
const PER_MESSAGE_OVERHEAD = 4;

/**
 * Anthropic's tokenizer is not public. Empirically Claude models land at
 * roughly 3.5 chars/token for English text (slightly denser than GPT-4
 * because Claude's vocabulary is larger). We use that as the conversion
 * factor when targeting Anthropic.
 */
const ANTHROPIC_CHARS_PER_TOKEN = 3.5;

/**
 * Gemini's tokenizer is also not public. Google's published guidance is
 * ~4 chars/token for English — close to the classic GPT-3 heuristic.
 */
const GEMINI_CHARS_PER_TOKEN = 4;

/**
 * The generic char-per-token ratio used when `gpt-tokenizer` is not
 * available (e.g. the optional dep failed to load). Matches the
 * `chars / 4` heuristic baked into `@sanix/core`'s `estimateTokens`
 * so counts stay consistent across the fallback path.
 */
const FALLBACK_CHARS_PER_TOKEN = 4;

/**
 * Detect whether a string looks like JSON (used to tighten the generic
 * fallback — JSON is denser than prose). Mirrors the heuristic in
 * `@sanix/core`'s TokenBudget so both paths agree.
 */
function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    // fall through
  }
  if (trimmed[0] !== '{' && trimmed[0] !== '[') return false;
  const markers = (trimmed.match(/"\s*:/g) ?? []).length;
  const density = markers / (trimmed.length / 200);
  return density >= 1;
}

/**
 * A char-based token estimate used as the ultimate fallback when
 * `gpt-tokenizer` is unavailable. Picks 3.5 chars/token for JSON,
 * 4 chars/token otherwise — close enough that downstream budget math
 * stays sensible without ever over-counting by more than ~30%.
 */
function charBasedEstimate(text: string, charsPerToken: number): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / charsPerToken);
}

/**
 * Pick the appropriate chars-per-token factor for a provider when we
 * can't (or choose not to) run the BPE encoder.
 */
function fallbackFactor(provider: TokenizerProvider): number {
  switch (provider) {
    case 'anthropic':
      return ANTHROPIC_CHARS_PER_TOKEN;
    case 'gemini':
      return GEMINI_CHARS_PER_TOKEN;
    case 'openai':
      // OpenAI without the BPE encoder — use the classic 4 chars/token.
      return FALLBACK_CHARS_PER_TOKEN;
    case 'generic':
    default:
      return FALLBACK_CHARS_PER_TOKEN;
  }
}

/**
 * Exact BPE tokenizer with provider-specific estimation.
 *
 * The class is intentionally stateless beyond the LRU cache — callers
 * can use the exported {@link tokenizer} singleton or instantiate their
 * own (e.g. to get an isolated cache for tests).
 *
 * @example
 * ```ts
 * import { tokenizer } from '@sanix/optimizer';
 *
 * const text = 'Hello, world! This is a test.';
 * console.log(tokenizer.count(text));                   // BPE-exact count
 * console.log(tokenizer.countFor('openai', text));      // same as count()
 * console.log(tokenizer.countFor('anthropic', text));   // chars/3.5
 *
 * const msgs = [
 *   { role: 'user', content: 'Hi' },
 *   { role: 'assistant', content: 'Hello!' },
 * ];
 * console.log(tokenizer.countMessages(msgs));           // incl. per-msg overhead
 * ```
 */
export class ExactTokenizer {
  /** LRU cache for `count()` results. */
  private readonly cache: LruCache<string, number>;

  /**
   * Lazily-resolved `gpt-tokenizer` module. `null` before first access,
   * `undefined` (permanently) if the package failed to load.
   */
  private gptModule: GptTokenizerModule | null | undefined = null;

  /**
   * Whether we've already attempted to load `gpt-tokenizer`. Used to
   * avoid retrying on every call once we know it's unavailable.
   */
  private loadAttempted = false;

  /**
   * The provider used by `count()` when no provider is specified.
   * Defaults to `'openai'` (exact BPE) but can be switched via
   * {@link setDefaultProvider}.
   */
  private defaultProvider: TokenizerProvider = 'openai';

  /**
   * @param cacheCapacity Maximum number of strings to cache (default 5000).
   */
  constructor(cacheCapacity: number = DEFAULT_CACHE_CAPACITY) {
    this.cache = new LruCache<string, number>(cacheCapacity);
  }

  /**
   * Lazily load `gpt-tokenizer`. Returns `null` if the package is not
   * installed or failed to import — the caller then falls back to a
   * char-based estimate. This is the single point of integration with
   * the optional dep so the rest of the class stays clean.
   */
  private loadGptTokenizer(): GptTokenizerModule | null {
    if (this.loadAttempted) return this.gptModule ?? null;
    this.loadAttempted = true;
    try {
      // Dynamic require so the dep is truly optional: callers that don't
      // need exact counts (e.g. tests) can run without `gpt-tokenizer`
      // installed and still get sensible char-based estimates.
      const mod = nodeRequire('gpt-tokenizer') as GptTokenizerModule;
      if (mod && typeof mod.encode === 'function' && typeof mod.decode === 'function') {
        this.gptModule = mod;
        return mod;
      }
      this.gptModule = null;
      return null;
    } catch {
      this.gptModule = null;
      return null;
    }
  }

  /**
   * Whether the BPE encoder is available. When `false`, `count()` and
   * `countFor('openai', ...)` will fall back to char-based estimates.
   */
  isExact(): boolean {
    return this.loadGptTokenizer() !== null;
  }

  /**
   * Switch the default provider used by {@link count}. Has no effect on
   * explicit {@link countFor} calls.
   *
   * @example
   * ```ts
   * tokenizer.setDefaultProvider('anthropic');
   * tokenizer.count(text); // now uses chars/3.5
   * ```
   */
  setDefaultProvider(provider: TokenizerProvider): void {
    this.defaultProvider = provider;
  }

  /**
   * The current default provider (settable via {@link setDefaultProvider}).
   */
  getDefaultProvider(): TokenizerProvider {
    return this.defaultProvider;
  }

  /**
   * Encode `text` to a list of BPE token ids. Falls back to a synthetic
   * single-token-per-char encoding when `gpt-tokenizer` is unavailable
   * (so callers that need *some* token list to round-trip can still
   * operate, though counts will be wildly off).
   */
  encode(text: string): number[] {
    const mod = this.loadGptTokenizer();
    if (mod) return mod.encode(text);
    // Fallback: one synthetic id per char (ids 0..n-1). This is only
    // useful for round-trip tests; for accurate counts use `count()`.
    return Array.from(text, (_c, i) => i);
  }

  /**
   * Decode a list of BPE token ids back to text. When `gpt-tokenizer` is
   * unavailable, joins the ids with spaces (best-effort round trip).
   */
  decode(tokens: number[]): string {
    const mod = this.loadGptTokenizer();
    if (mod) return mod.decode(tokens);
    // Fallback: can't truly decode synthetic ids; just stringify.
    return tokens.join(' ');
  }

  /**
   * Exact token count for `text` using the default provider
   * (OpenAI BPE unless {@link setDefaultProvider} was called). Results
   * are LRU-cached.
   *
   * @example
   * ```ts
   * tokenizer.count('Hello, world!'); // ~4 (BPE) or 4 (chars/4 fallback)
   * ```
   */
  count(text: string): number {
    if (text.length === 0) return 0;
    const provider = this.defaultProvider;
    // Cache key includes the provider so switching providers doesn't
    // return stale results.
    const key = `${provider}\0${text}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const tokens = this.computeCount(provider, text);
    this.cache.set(key, tokens);
    return tokens;
  }

  /**
   * Provider-specific token count for `text`. Bypasses the cache key's
   * default-provider encoding by being explicit. Still cached.
   *
   * - `openai` — exact BPE via `gpt-tokenizer` (or chars/4 fallback).
   * - `anthropic` — chars/3.5 (Claude's tokenizer is not public).
   * - `gemini` — chars/4 (Google's published approximation).
   * - `generic` — chars/4, with a JSON-detection tweak (chars/3.5 for
   *   dense structured data).
   *
   * @example
   * ```ts
   * tokenizer.countFor('anthropic', 'Hello, world!'); // 4 (14/3.5)
   * tokenizer.countFor('openai', 'Hello, world!');    // ~4 (BPE)
   * ```
   */
  countFor(provider: TokenizerProvider, text: string): number {
    if (text.length === 0) return 0;
    const key = `${provider}\0${text}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const tokens = this.computeCount(provider, text);
    this.cache.set(key, tokens);
    return tokens;
  }

  /**
   * The uncached compute kernel — picks the right algorithm per
   * provider. Extracted so `count` and `countFor` share one path.
   */
  private computeCount(provider: TokenizerProvider, text: string): number {
    if (provider === 'openai') {
      const mod = this.loadGptTokenizer();
      if (mod) {
        try {
          return mod.encode(text).length;
        } catch {
          // BPE can throw on malformed surrogate pairs; fall through to
          // the char-based fallback rather than crashing the agent loop.
        }
      }
      return charBasedEstimate(text, FALLBACK_CHARS_PER_TOKEN);
    }
    if (provider === 'anthropic') {
      return charBasedEstimate(text, ANTHROPIC_CHARS_PER_TOKEN);
    }
    if (provider === 'gemini') {
      return charBasedEstimate(text, GEMINI_CHARS_PER_TOKEN);
    }
    // generic — JSON gets a slightly tighter factor.
    const factor = looksLikeJson(text) ? 3.5 : FALLBACK_CHARS_PER_TOKEN;
    return charBasedEstimate(text, factor);
  }

  /**
   * Total token cost of a list of chat messages, including per-message
   * overhead (~4 tokens per message for role/separators) and the role
   * tokens themselves. Mirrors the OpenAI cookbook formula:
   *
   *   tokens = Σ (count(content) + count(role) + 4) + 3
   *
   * The trailing `+3` accounts for the assistant priming; we include it
   * so the total matches what the API actually bills.
   *
   * @example
   * ```ts
   * const msgs = [
   *   { role: 'system', content: 'You are helpful.' },
   *   { role: 'user', content: 'Hi!' },
   * ];
   * tokenizer.countMessages(msgs); // ~14
   * ```
   */
  countMessages(messages: ReadonlyArray<LLMMessage>): number {
    let total = 0;
    for (const m of messages) {
      const content = typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content
              .filter((b): b is { type: 'text'; text: string } =>
                typeof b === 'object' && b !== null && 'type' in b && (b as { type?: string }).type === 'text' && 'text' in b)
              .map((b) => b.text)
              .join('')
          : '';
      total += this.count(content);
      total += this.count(m.role);
      total += PER_MESSAGE_OVERHEAD;
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          total += this.count(tc.function.name);
          total += this.count(tc.function.arguments);
        }
      }
    }
    // Assistant priming overhead (every Chat Completions call).
    total += 3;
    return total;
  }

  /**
   * Clear the LRU cache. Useful in tests or after a long-running
   * session whose working set has drifted far from the cached entries.
   */
  clearCache(): void {
    this.cache.clear();
  }

  /** Current cache entry count. */
  get cacheSize(): number {
    return this.cache.size;
  }

  /** Cache hits since last clear. */
  get cacheHits(): number {
    return this.cache.hitCount;
  }

  /** Cache misses since last clear. */
  get cacheMisses(): number {
    return this.cache.missCount;
  }
}

/**
 * Process-wide singleton tokenizer. Shared across the SANIX process so
 * the LRU cache hits as often as possible (every module that needs a
 * token count should call `tokenizer.count(...)` rather than
 * constructing its own instance).
 *
 * Constructed lazily on first access via {@link getTokenizer} to keep
 * import-time cost down — `gpt-tokenizer` carries a non-trivial BPE
 * table that we don't want to load if no caller actually needs exact
 * counts.
 */
let _singleton: ExactTokenizer | null = null;

/**
 * Get the process-wide {@link ExactTokenizer} singleton, constructing
 * it on first call.
 *
 * @example
 * ```ts
 * import { tokenizer } from '@sanix/optimizer';
 * const t = tokenizer.count('hello');
 * ```
 */
export function getTokenizer(): ExactTokenizer {
  if (_singleton === null) _singleton = new ExactTokenizer();
  return _singleton;
}

/**
 * Replace the process-wide tokenizer singleton. Primarily for tests
 * that want to inject a mock; production callers should rely on the
 * default singleton + `setDefaultProvider` instead.
 *
 * After calling this, the exported {@link tokenizer} proxy will start
 * dispatching to the new instance.
 *
 * @example
 * ```ts
 * const mock = new ExactTokenizer(100);
 * setTokenizer(mock);
 * ```
 */
export function setTokenizer(t: ExactTokenizer): void {
  _singleton = t;
}

/**
 * The shared {@link ExactTokenizer} singleton. Equivalent to
 * `getTokenizer()` but usable as a plain import for ergonomics:
 *
 *   import { tokenizer } from '@sanix/optimizer';
 *   const n = tokenizer.count(text);
 *
 * This is a thin Proxy that forwards every property access to the
 * current singleton (so {@link setTokenizer} swaps take effect
 * immediately). The proxy is read-only — assignment to any property
 * is silently ignored.
 */
export const tokenizer: ExactTokenizer = new Proxy(
  {} as ExactTokenizer,
  {
    get(_target, prop: string | symbol): unknown {
      const inst = getTokenizer();
      const value = (inst as unknown as Record<string | symbol, unknown>)[prop];
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(inst)
        : value;
    },
    set(): boolean {
      // Read-only proxy. Use `setTokenizer` to replace the singleton.
      return false;
    },
  },
);
