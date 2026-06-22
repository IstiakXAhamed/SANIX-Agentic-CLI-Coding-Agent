/**
 * @file LLMPromptCompressor.ts
 * @description LLMlingua-style prompt compression for SANIX.
 *
 * The compressor uses a *small* LLM (e.g. Haiku / Llama 3.1 8B) to strip
 * low-information tokens from a prompt before the main LLM call. The
 * algorithm mirrors the LLMlingua paper (Microsoft, 2023) in simplified
 * form:
 *
 *   1. **Partition** the prompt into "essential" sections (system
 *      instructions, current user query, the active plan) and
 *      "compressible" sections (file context, tool descriptions,
 *      retrieved memories, older conversation history).
 *   2. **Chunk** each compressible section into LLM-sized pieces.
 *   3. **Compress** each chunk by asking the small LLM: "Compress this
 *      while preserving key information. Output only the compressed
 *      version." with a target compression ratio (default 0.5).
 *   4. **Validate**: if the compressed chunk is > 95% of the original
 *      (i.e. barely any savings), keep the original — the compression
 *      cost wasn't worth it.
 *   5. **Concatenate** essential + compressed sections back together.
 *
 * The compressor maintains an LRU cache on chunk *content* so repeated
 * chunks (extremely common in agent loops where the same file context
 * appears across iterations) are not recompressed. Chunks are compressed
 * concurrently with `p-limit` (default concurrency 3) so multi-MB
 * prompts finish in seconds rather than minutes.
 *
 * ## Graceful degradation
 *
 * When no `compressorProvider` is configured, every method returns its
 * input unchanged with `skipped: true` (and a `reason`). This makes the
 * feature safe to wire in unconditionally — production callers that
 * don't want prompt compression simply never pass a provider.
 *
 * @packageDocumentation
 */

import type { IProvider, LLMMessage, LLMRequest, MessageContent } from '@sanix/providers';
import type { BuiltContext } from '@sanix/optimizer';
import { tokenizer as optimizerTokenizer } from '@sanix/optimizer';

// ─── Tiny in-file LRU (kept dependency-free; reused from optimizer's) ──────

/**
 * A bounded LRU cache. Uses `Map`'s insertion-order preservation for
 * eviction: on every hit the entry is moved to the MRU end; when full,
 * the first (LRU) key is dropped.
 *
 * Kept deliberately small so the compressor doesn't pull in any extra
 * runtime deps beyond `@sanix/optimizer` + `@sanix/providers`.
 */
class LruCache<K, V> {
  private readonly store: Map<K, V> = new Map();
  private readonly capacity: number;
  private hits = 0;
  private misses = 0;

  /**
   * @param capacity - Maximum entries. Must be >= 1.
   */
  constructor(capacity: number) {
    if (capacity < 1) {
      throw new Error(`LruCache capacity must be >= 1 (got ${capacity})`);
    }
    this.capacity = capacity;
  }

  /** Look up `key`. On hit, the entry is moved to MRU. */
  get(key: K): V | undefined {
    const v = this.store.get(key);
    if (v === undefined) {
      this.misses++;
      return undefined;
    }
    this.store.delete(key);
    this.store.set(key, v);
    this.hits++;
    return v;
  }

  /** Insert `value` under `key`. Evicts the LRU entry when at capacity. */
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

// ─── p-limit (lazy, optional) ──────────────────────────────────────────────

/**
 * The minimal surface we use from `p-limit`. Declared locally so this
 * file type-checks even if the dep is missing at runtime — the dynamic
 * `import()` is wrapped in try/catch and falls back to a serial run.
 */
type PLimitFn = (concurrency: number) => <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * Lazily-loaded p-limit factory. `null` once we've tried + failed.
 */
let pLimitModule: PLimitFn | null | undefined = undefined;
let pLimitLoadAttempted = false;

/**
 * Load `p-limit` if available; otherwise return `null`. The result is
 * cached so subsequent calls are O(1). When the dep is unavailable the
 * compressor runs chunks serially (still correct, just slower).
 */
async function loadPLimit(): Promise<PLimitFn | null> {
  if (pLimitLoadAttempted) return pLimitModule ?? null;
  pLimitLoadAttempted = true;
  try {
    const mod = (await import('p-limit')) as unknown as { default: PLimitFn } | PLimitFn;
    // p-limit v6 ESM shape: `default` is the factory function.
    const fn = typeof mod === 'function' ? mod : (mod as { default: PLimitFn }).default;
    if (typeof fn === 'function') {
      pLimitModule = fn;
      return fn;
    }
    pLimitModule = null;
    return null;
  } catch {
    pLimitModule = null;
    return null;
  }
}

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Result of a single {@link LLMPromptCompressor.compress} call. Carries
 * both the original and compressed text, per-stage token counts, the
 * effective compression ratio, and a `skipped` flag (true when the
 * compressor declined to compress — e.g. no provider configured, or
 * the compressed output wasn't smaller than the original).
 */
export interface CompressionResult {
  /** The original prompt text. */
  original: string;
  /** The compressed prompt text (identical to `original` when `skipped`). */
  compressed: string;
  /** Token count of the original prompt. */
  originalTokens: number;
  /** Token count of the compressed prompt. */
  compressedTokens: number;
  /** Effective ratio `compressedTokens / originalTokens` (1.0 when skipped). */
  ratio: number;
  /** Number of chunks actually sent to the small LLM (0 when skipped). */
  chunksProcessed: number;
  /** True when compression was declined (no provider, no savings, etc.). */
  skipped: boolean;
  /** Human-readable reason when `skipped` is true. */
  reason?: string;
}

/**
 * Constructor options for {@link LLMPromptCompressor}.
 */
export interface LLMPromptCompressorOptions {
  /**
   * The small LLM provider used to compress chunks (e.g. an Haiku or
   * Llama 3.1 8B adapter). When omitted, every method degrades
   * gracefully — it returns its input unchanged with `skipped: true`.
   */
  compressorProvider?: IProvider;
  /**
   * Default target compression ratio (compressed / original). The
   * small LLM is told to aim for this ratio per chunk. Default 0.5
   * (halve the size).
   */
  targetRatio?: number;
  /**
   * Minimum tokens a chunk must have before it's worth compressing.
   * Smaller chunks are passed through unchanged — the LLM call cost
   * would dominate. Default 64.
   */
  minChunkTokens?: number;
  /**
   * Maximum number of chunks to compress in a single `compress()` call.
   * Further chunks are passed through unchanged. Guards against
   * runaway costs on huge prompts. Default 64.
   */
  maxChunks?: number;
  /**
   * Max concurrency for chunk compression. Default 3. Set to 1 for
   * serial execution (e.g. when running against a small local model
   * that can't handle parallel requests).
   */
  concurrency?: number;
  /**
   * Approximate chunk size (in tokens) the small LLM compresses in one
   * shot. The LLMlingua paper recommends ~512-token chunks for best
   * quality. Default 512.
   */
  chunkTokens?: number;
  /**
   * Skip-compression threshold: if the compressed chunk is greater than
   * this fraction of the original, keep the original. Default 0.95
   * (i.e. require at least 5% savings).
   */
  skipThreshold?: number;
  /**
   * LRU cache capacity (number of chunk entries). Default 1000. Each
   * entry is keyed on the chunk's text content so repeated chunks (very
   * common in agent loops) are O(1).
   */
  cacheCapacity?: number;
}

/**
 * Per-call options for {@link LLMPromptCompressor.compress}.
 */
export interface CompressOptions {
  /**
   * Override the constructor's {@link LLMPromptCompressorOptions.targetRatio}
   * for this call only.
   */
  ratio?: number;
  /**
   * Section headers (matched case-insensitively as substrings of the
   * `## Section` header line) whose bodies should be preserved verbatim
   * rather than compressed. The section is included as-is in the
   * output. Useful for keeping the system prompt, plan, or current
   * user query intact.
   *
   * Default: `['system', 'plan', 'user']` — these are essential.
   */
  preserveSections?: string[];
}

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * Default values for {@link LLMPromptCompressorOptions}.
 */
const DEFAULTS = {
  targetRatio: 0.5,
  minChunkTokens: 64,
  maxChunks: 64,
  concurrency: 3,
  chunkTokens: 512,
  skipThreshold: 0.95,
  cacheCapacity: 1000,
} as const;

/**
 * The default `preserveSections` list. Sections whose headers contain
 * any of these substrings (case-insensitive) are passed through
 * verbatim — they're considered "essential" (cannot be compressed
 * without losing instructions the model needs verbatim).
 */
const DEFAULT_PRESERVE_SECTIONS: ReadonlyArray<string> = ['system', 'plan', 'user', 'instructions', 'goal'];

/**
 * Marker lines the compressor uses to delimit sections + chunks when
 * prompting the small LLM. The opening line of every prompt sent to
 * the small LLM looks like:
 *
 *   Compress the following text to ~50% of its length while preserving
 *   all key information (function names, types, identifiers, numbers,
 *   decisions, error messages). Output ONLY the compressed text — no
 *   commentary, no markdown fences.
 *
 *   --- BEGIN TEXT ---
 *   <chunk>
 *   --- END TEXT ---
 */
const SMALL_LLM_SYSTEM_PROMPT = `You are a prompt-compression assistant. Compress the user-supplied text to the requested ratio of its original length while preserving all key information — identifiers, function names, types, numbers, decisions, error messages, and code snippets MUST be preserved verbatim. Remove filler words, redundant phrasing, and low-information prose. Output ONLY the compressed text. Do not add commentary, headers, or markdown fences.`;

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Coerce message content (string or ContentBlock[]) to plain text.
 * Image / file blocks are dropped (they can't be LLM-compressed).
 */
function toText(content: MessageContent): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as { type?: string; text?: string };
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push(b.text);
    }
  }
  return parts.join('');
}

/**
 * A parsed section of the prompt. The compressor splits the input on
 * markdown-style `## Section` headers; each section is classified as
 * "essential" (preserve verbatim) or "compressible" (chunk + compress).
 */
interface PromptSection {
  /** The header line (e.g. `## File Context`) or `''` for the preamble. */
  header: string;
  /** The section's body text (excluding the header line). */
  body: string;
  /** True if this section should be preserved verbatim. */
  essential: boolean;
}

/**
 * Split a prompt into {@link PromptSection}s on `## Section` headers.
 * Lines that aren't part of any `## ` header go into the preamble
 * section (header `''`). Sections with no `## ` header at all collapse
 * into a single section (the whole prompt becomes one compressible
 * chunk unless it matches an essential keyword).
 *
 * @param prompt - The full prompt text.
 * @param preserveSections - Lowercase substrings; section headers
 *   containing any of these are marked `essential`.
 */
function partitionPrompt(
  prompt: string,
  preserveSections: ReadonlyArray<string>,
): PromptSection[] {
  const lines = prompt.split('\n');
  const sections: PromptSection[] = [];
  let current: PromptSection = { header: '', body: '', essential: false };
  for (const line of lines) {
    const headerMatch = /^##\s+(.*)$/u.exec(line);
    if (headerMatch && headerMatch[1] !== undefined) {
      // Flush the previous section.
      if (current.body.length > 0 || current.header.length > 0) {
        sections.push(current);
      }
      const headerText = headerMatch[1].trim();
      const essential = preserveSections.some((s) =>
        headerText.toLowerCase().includes(s.toLowerCase()),
      );
      current = { header: `## ${headerText}`, body: '', essential };
    } else {
      current.body += (current.body.length > 0 ? '\n' : '') + line;
    }
  }
  // Flush the last section.
  if (current.body.length > 0 || current.header.length > 0) {
    sections.push(current);
  }
  // Edge case: empty prompt → return one empty compressible section so
  // downstream code can call .body without checking length.
  if (sections.length === 0) {
    return [{ header: '', body: '', essential: false }];
  }
  // If no `## ` headers were found, the whole prompt is one section.
  // Mark it essential only if it contains an essential keyword in the
  // first non-empty line; otherwise compressible.
  if (sections.length === 1 && sections[0]!.header === '') {
    const firstLine = sections[0]!.body.split('\n').find((l) => l.trim().length > 0) ?? '';
    const essential = preserveSections.some((s) =>
      firstLine.toLowerCase().includes(s.toLowerCase()),
    );
    sections[0]!.essential = essential;
  }
  return sections;
}

/**
 * A compressible chunk extracted from a section body. The compressor
 * splits large sections on paragraph boundaries (blank-line separated)
 * to keep each chunk under {@link LLMPromptCompressorOptions.chunkTokens}
 * tokens. Small bodies become a single chunk.
 */
interface Chunk {
  /** The chunk's text (without trailing newline). */
  text: string;
  /** Token count for `text`. */
  tokens: number;
}

/**
 * Split a section body into chunks of at most `maxTokens` tokens on
 * paragraph boundaries. A single paragraph longer than `maxTokens` is
 * split mid-paragraph on sentence boundaries as a last resort.
 */
function chunkSection(body: string, maxTokens: number): Chunk[] {
  const trimmed = body.trim();
  if (trimmed.length === 0) return [];
  const paragraphs = trimmed.split(/\n\s*\n/u);
  const chunks: Chunk[] = [];
  let current = '';
  let currentTokens = 0;
  for (const para of paragraphs) {
    const paraTokens = optimizerTokenizer.count(para);
    // If the paragraph alone exceeds the budget, flush current then
    // split it on sentence boundaries.
    if (paraTokens > maxTokens) {
      if (current.length > 0) {
        chunks.push({ text: current, tokens: currentTokens });
        current = '';
        currentTokens = 0;
      }
      const sentences = para.split(/(?<=[.!?])\s+/u);
      for (const sentence of sentences) {
        const sTokens = optimizerTokenizer.count(sentence);
        if (currentTokens + sTokens > maxTokens && current.length > 0) {
          chunks.push({ text: current, tokens: currentTokens });
          current = '';
          currentTokens = 0;
        }
        current += (current.length > 0 ? ' ' : '') + sentence;
        currentTokens += sTokens;
      }
      continue;
    }
    if (currentTokens + paraTokens > maxTokens && current.length > 0) {
      chunks.push({ text: current, tokens: currentTokens });
      current = '';
      currentTokens = 0;
    }
    current += (current.length > 0 ? '\n\n' : '') + para;
    currentTokens += paraTokens;
  }
  if (current.length > 0) {
    chunks.push({ text: current, tokens: currentTokens });
  }
  return chunks;
}

// ─── LLMPromptCompressor ────────────────────────────────────────────────────

/**
 * LLMlingua-style LLM prompt compressor.
 *
 * Uses a small LLM to strip low-information tokens from a prompt's
 * compressible sections before the main LLM call. Essential sections
 * (system instructions, plan, current user query) are preserved
 * verbatim. The compressor caches chunk results (LRU, 1000 entries) so
 * repeated chunks across agent iterations are O(1).
 *
 * @example
 * ```ts
 * import { LLMPromptCompressor } from '@sanix/compressor';
 * import { OllamaAdapter } from '@sanix/providers';
 *
 * const compressor = new LLMPromptCompressor({
 *   compressorProvider: new OllamaAdapter({ model: 'llama3.1:8b' }),
 *   targetRatio: 0.5,
 * });
 *
 * const result = await compressor.compress(longPrompt);
 * if (!result.skipped) {
 *   console.log(`Compressed ${result.originalTokens} → ${result.compressedTokens} tokens`);
 * }
 * ```
 */
export class LLMPromptCompressor {
  private readonly provider: IProvider | undefined;
  private readonly targetRatio: number;
  private readonly minChunkTokens: number;
  private readonly maxChunks: number;
  private readonly concurrency: number;
  private readonly chunkTokens: number;
  private readonly skipThreshold: number;
  private readonly cache: LruCache<string, string>;

  /**
   * @param opts - Constructor options. See {@link LLMPromptCompressorOptions}.
   */
  constructor(opts: LLMPromptCompressorOptions = {}) {
    this.provider = opts.compressorProvider;
    this.targetRatio = opts.targetRatio ?? DEFAULTS.targetRatio;
    this.minChunkTokens = opts.minChunkTokens ?? DEFAULTS.minChunkTokens;
    this.maxChunks = opts.maxChunks ?? DEFAULTS.maxChunks;
    this.concurrency = opts.concurrency ?? DEFAULTS.concurrency;
    this.chunkTokens = opts.chunkTokens ?? DEFAULTS.chunkTokens;
    this.skipThreshold = opts.skipThreshold ?? DEFAULTS.skipThreshold;
    this.cache = new LruCache<string, string>(opts.cacheCapacity ?? DEFAULTS.cacheCapacity);
  }

  /**
   * Compress a single prompt string. Splits the prompt into essential
   * + compressible sections, chunks each compressible section, asks
   * the small LLM to compress each chunk, then concatenates the
   * results.
   *
   * @param prompt - The prompt text to compress.
   * @param opts - Per-call options (ratio override, section preservation).
   * @returns A {@link CompressionResult} with both original + compressed
   *   text and per-stage token counts.
   *
   * @example
   * ```ts
   * const result = await compressor.compress(prompt, { ratio: 0.4 });
   * const final = result.skipped ? result.original : result.compressed;
   * ```
   */
  async compress(
    prompt: string,
    opts: CompressOptions = {},
  ): Promise<CompressionResult> {
    const originalTokens = optimizerTokenizer.count(prompt);

    // Graceful degradation: no provider → return input unchanged.
    if (!this.provider) {
      return {
        original: prompt,
        compressed: prompt,
        originalTokens,
        compressedTokens: originalTokens,
        ratio: 1,
        chunksProcessed: 0,
        skipped: true,
        reason: 'No compressorProvider configured.',
      };
    }

    // Trivially short prompts aren't worth compressing.
    if (originalTokens < this.minChunkTokens) {
      return {
        original: prompt,
        compressed: prompt,
        originalTokens,
        compressedTokens: originalTokens,
        ratio: 1,
        chunksProcessed: 0,
        skipped: true,
        reason: `Prompt below minChunkTokens (${originalTokens} < ${this.minChunkTokens}).`,
      };
    }

    const ratio = opts.ratio ?? this.targetRatio;
    const preserveSections = opts.preserveSections ?? DEFAULT_PRESERVE_SECTIONS;

    // Partition into essential + compressible sections.
    const sections = partitionPrompt(prompt, preserveSections);

    // Collect compressible chunks across all compressible sections.
    // Track which section each chunk belongs to so we can stitch the
    // result back together.
    interface ChunkRef {
      sectionIndex: number;
      chunkIndex: number;
      chunk: Chunk;
    }
    const chunkRefs: ChunkRef[] = [];
    const sectionChunks: Chunk[][] = sections.map((s, i) => {
      if (s.essential || s.body.trim().length === 0) return [];
      const chunks = chunkSection(s.body, this.chunkTokens).filter(
        (c) => c.tokens >= this.minChunkTokens,
      );
      chunks.forEach((chunk, ci) => chunkRefs.push({ sectionIndex: i, chunkIndex: ci, chunk }));
      return chunks;
    });

    // Honor the maxChunks cap: only compress the first N chunks; pass
    // the rest through unchanged.
    const toCompress = chunkRefs.slice(0, this.maxChunks);
    const overflow = chunkRefs.slice(this.maxChunks);

    // Compress concurrently.
    const compressedMap = new Map<string, string>();
    let chunksProcessed = 0;
    const pLimitFn = await loadPLimit();
    const limit = pLimitFn ? pLimitFn(Math.max(1, this.concurrency)) : null;

    const compressOne = async (ref: ChunkRef): Promise<void> => {
      const cacheKey = `${ratio}\u0000${ref.chunk.text}`;
      const cached = this.cache.get(cacheKey);
      if (cached !== undefined) {
        compressedMap.set(`${ref.sectionIndex}:${ref.chunkIndex}`, cached);
        return;
      }
      const compressed = await this.compressChunkViaLLM(ref.chunk.text, ratio);
      if (compressed !== null) {
        chunksProcessed++;
        // Validate: keep the original if the compressed version isn't
        // smaller than the skip threshold.
        const origTokens = ref.chunk.tokens;
        const compTokens = optimizerTokenizer.count(compressed);
        if (compTokens / Math.max(1, origTokens) > this.skipThreshold) {
          compressedMap.set(`${ref.sectionIndex}:${ref.chunkIndex}`, ref.chunk.text);
          this.cache.set(cacheKey, ref.chunk.text);
        } else {
          compressedMap.set(`${ref.sectionIndex}:${ref.chunkIndex}`, compressed);
          this.cache.set(cacheKey, compressed);
        }
      } else {
        // LLM call failed → pass through the original chunk.
        compressedMap.set(`${ref.sectionIndex}:${ref.chunkIndex}`, ref.chunk.text);
      }
    };

    if (limit) {
      await Promise.all(toCompress.map((ref) => limit(() => compressOne(ref))));
    } else {
      for (const ref of toCompress) {
        await compressOne(ref);
      }
    }
    // Pass-through overflow chunks (they weren't compressed).
    for (const ref of overflow) {
      compressedMap.set(`${ref.sectionIndex}:${ref.chunkIndex}`, ref.chunk.text);
    }

    // Stitch the result back together.
    const parts: string[] = [];
    for (let i = 0; i < sections.length; i++) {
      const s = sections[i]!;
      if (s.header) parts.push(s.header);
      if (s.essential || s.body.trim().length === 0) {
        if (s.body) parts.push(s.body);
        continue;
      }
      const chunks = sectionChunks[i] ?? [];
      if (chunks.length === 0) {
        if (s.body) parts.push(s.body);
        continue;
      }
      const rebuilt = chunks
        .map((_, ci) => compressedMap.get(`${i}:${ci}`) ?? '')
        .filter((t) => t.length > 0)
        .join('\n\n');
      if (rebuilt) parts.push(rebuilt);
    }
    const compressed = parts.join('\n\n');
    const compressedTokens = optimizerTokenizer.count(compressed);

    // If we somehow ended up *larger* than the original (e.g. the LLM
    // added commentary despite instructions), bail and return the
    // original.
    if (compressedTokens >= originalTokens) {
      return {
        original: prompt,
        compressed: prompt,
        originalTokens,
        compressedTokens: originalTokens,
        ratio: 1,
        chunksProcessed,
        skipped: true,
        reason: 'Compressed output not smaller than original.',
      };
    }

    return {
      original: prompt,
      compressed,
      originalTokens,
      compressedTokens,
      ratio: compressedTokens / Math.max(1, originalTokens),
      chunksProcessed,
      skipped: false,
    };
  }

  /**
   * Compress a list of chat messages. Each message's text content is
   * compressed independently (so essential role framing is preserved).
   * Image / file blocks are passed through unchanged (they can't be
   * LLM-compressed).
   *
   * The first message (typically the system prompt) and the last
   * message (typically the current user query) are preserved verbatim
   * — they're the most essential. Middle messages are compressed.
   *
   * @param messages - The chat messages to compress.
   * @param opts - Per-call options (same as {@link compress}).
   * @returns A new message array. Each element is either the original
   *   message (preserved) or a shallow copy with compressed text
   *   content.
   *
   * @example
   * ```ts
   * const compressed = await compressor.compressMessages(messages);
   * await provider.chat({ messages: compressed });
   * ```
   */
  async compressMessages(
    messages: ReadonlyArray<LLMMessage>,
    opts: CompressOptions = {},
  ): Promise<LLMMessage[]> {
    if (!this.provider || messages.length <= 2) {
      // Nothing to compress (no provider, or only the essential pair).
      return [...messages];
    }
    // Preserve the first + last messages verbatim.
    const middle = messages.slice(1, -1);
    const result: LLMMessage[] = [messages[0]!];
    for (const m of middle) {
      const text = toText(m.content);
      if (text.trim().length === 0) {
        result.push(m);
        continue;
      }
      const compressed = await this.compress(text, opts);
      result.push({
        ...m,
        content: compressed.skipped ? m.content : compressed.compressed,
      });
    }
    result.push(messages[messages.length - 1]!);
    return result;
  }

  /**
   * Compress a built context. The `system`, `plan`, and `history`
   * fields are preserved (essential). The `memory` and `context`
   * fields are compressed via {@link compress}. The returned object
   * is a shallow copy with the compressed fields replaced.
   *
   * This is the entry point the {@link ContextBuilder} calls when a
   * compressor is wired in — it's invoked as the final step before
   * the built context is handed to the provider adapter.
   *
   * @param ctx - The built context to compress.
   * @param opts - Per-call options (same as {@link compress}).
   * @returns A new {@link BuiltContext} with `memory` and `context`
   *   possibly compressed. If compression was skipped, the input is
   *   returned unchanged (referentially).
   *
   * @example
   * ```ts
   * const compressed = await compressor.compressContext(built);
   * const prompt = builder.assemblePrompt(compressed);
   * await provider.chat(prompt.request);
   * ```
   */
  async compressContext(
    ctx: BuiltContext,
    opts: CompressOptions = {},
  ): Promise<BuiltContext> {
    if (!this.provider) return ctx;

    const memoryResult = ctx.memory
      ? await this.compress(ctx.memory, opts)
      : null;
    const contextResult = ctx.context
      ? await this.compress(ctx.context, opts)
      : null;

    // If both were skipped, return the original (no copy).
    const memorySkipped = !memoryResult || memoryResult.skipped;
    const contextSkipped = !contextResult || contextResult.skipped;
    if (memorySkipped && contextSkipped) return ctx;

    return {
      ...ctx,
      memory: memoryResult && !memoryResult.skipped ? memoryResult.compressed : ctx.memory,
      context: contextResult && !contextResult.skipped ? contextResult.compressed : ctx.context,
    };
  }

  /**
   * Send a single chunk to the small LLM and return the compressed
   * text. Returns `null` on any error (the caller falls back to the
   * original chunk).
   *
   * @param chunk - The chunk text to compress.
   * @param ratio - Target compression ratio (0..1).
   */
  private async compressChunkViaLLM(
    chunk: string,
    ratio: number,
  ): Promise<string | null> {
    if (!this.provider) return null;
    const pct = Math.round(ratio * 100);
    const userPrompt = `Compress the following text to ~${pct}% of its original length while preserving all key information (identifiers, function names, types, numbers, decisions, error messages, code snippets). Output ONLY the compressed text — no commentary, no markdown fences, no preamble.

--- BEGIN TEXT ---
${chunk}
--- END TEXT ---`;
    const request: LLMRequest = {
      messages: [
        { role: 'system', content: SMALL_LLM_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      maxTokens: Math.max(64, Math.ceil(optimizerTokenizer.count(chunk) * ratio) + 32),
      temperature: 0,
      taskType: 'fast_lookup',
    };
    try {
      const response = await this.provider.chat(request);
      const text = response.content.trim();
      // Strip accidental markdown fences.
      const fenced = /```(?:\w+)?\s*([\s\S]*?)```/u.exec(text);
      if (fenced && fenced[1] !== undefined) return fenced[1].trim();
      return text;
    } catch {
      return null;
    }
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
