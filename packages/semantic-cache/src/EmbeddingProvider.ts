/**
 * @file EmbeddingProvider.ts
 * @description Adapts various embedding sources to the
 * `EmbeddingProvider` interface (`embed(text) → Float32Array | null`)
 * used by {@link SemanticCache}.
 *
 * ## Sources
 *
 *   - `'xenova'` — local `@xenova/transformers` pipeline (default).
 *     Lazy-loaded; the model (`Xenova/all-MiniLM-L6-v2`, 384-dim) is
 *     downloaded on first use and cached under `~/.cache/`.
 *   - `'openai'` — `text-embedding-3-small` via the OpenAI REST API.
 *     Requires `apiKey`. Returns 1536-dim vectors.
 *   - `'cohere'` — `embed-english-v3.0` via the Cohere REST API.
 *     Requires `apiKey`. Returns 1024-dim vectors.
 *   - `'custom'` — caller-supplied function. Useful for tests, for
 *     private in-house embedding models, or for already-initialized
 *     embedding pipelines (e.g. an Ollama embeddings endpoint).
 *
 * All adapters return `null` (never throw) on failure, so the cache
 * can degrade gracefully to "no vector arm" when embeddings are
 * unavailable.
 *
 * @packageDocumentation
 */

import type { EmbeddingProvider } from './types.js';

/** Embedding source identifier. */
export type EmbeddingSource = 'xenova' | 'openai' | 'cohere' | 'custom';

/** Factory options. */
export interface CreateEmbeddingProviderOptions {
  /** Source. */
  source: EmbeddingSource;
  /** API key (required for `'openai'` and `'cohere'`). */
  apiKey?: string;
  /** Model override (defaults to the source's standard model). */
  model?: string;
  /**
   * Custom embedding function (required for `'custom'`). Should
   * return `null` on failure rather than throwing.
   */
  customFn?: (text: string) => Promise<Float32Array | null>;
  /** Optional base URL override (for OpenAI-compatible endpoints). */
  baseUrl?: string;
}

/**
 * Create an {@link EmbeddingProvider} backed by the requested source.
 *
 * @example
 * ```ts
 * // Local Xenova (default, no API key needed):
 * const provider = createEmbeddingProvider({ source: 'xenova' });
 *
 * // OpenAI:
 * const provider = createEmbeddingProvider({
 *   source: 'openai', apiKey: process.env.OPENAI_API_KEY,
 * });
 *
 * // Custom (e.g. your own embedding microservice):
 * const provider = createEmbeddingProvider({
 *   source: 'custom',
 *   customFn: async (text) => await fetchEmbedding(text),
 * });
 * ```
 */
export function createEmbeddingProvider(
  opts: CreateEmbeddingProviderOptions,
): EmbeddingProvider {
  switch (opts.source) {
    case 'xenova':
      return new XenovaEmbeddingProvider(opts.model);
    case 'openai':
      return new OpenAIEmbeddingProvider(opts.apiKey, opts.model, opts.baseUrl);
    case 'cohere':
      return new CohereEmbeddingProvider(opts.apiKey, opts.model);
    case 'custom':
      if (!opts.customFn) {
        throw new Error(
          "createEmbeddingProvider: 'custom' source requires `customFn`",
        );
      }
      return new CustomEmbeddingProvider(opts.customFn);
  }
}

// ─── Adapters ────────────────────────────────────────────────────────────

/**
 * Xenova `@xenova/transformers` adapter. Lazy-loads the
 * `feature-extraction` pipeline on first `embed()` call.
 *
 * Returns 384-dim L2-normalized vectors (mean-pooled MiniLM output).
 */
class XenovaEmbeddingProvider implements EmbeddingProvider {
  private readonly model: string;
  private pipePromise: Promise<((texts: string[]) => Promise<{ data: number[] }>) | null> | null = null;

  constructor(model?: string) {
    this.model = model ?? 'Xenova/all-MiniLM-L6-v2';
  }

  async embed(text: string): Promise<Float32Array | null> {
    const pipe = await this.loadPipe();
    if (!pipe) return null;
    try {
      const out = await pipe([text]);
      const vec = out.data;
      const normalized = l2Normalize(vec);
      return new Float32Array(normalized);
    } catch {
      return null;
    }
  }

  private loadPipe(): Promise<((texts: string[]) => Promise<{ data: number[] }>) | null> {
    if (this.pipePromise) return this.pipePromise;
    this.pipePromise = (async () => {
      try {
        const mod = (await import('@xenova/transformers')) as {
          pipeline: (task: string, model: string) => Promise<unknown>;
        };
        const pipe = (await mod.pipeline('feature-extraction', this.model)) as unknown as (
          texts: string[],
        ) => Promise<{ data: number[] }>;
        return pipe;
      } catch {
        return null;
      }
    })();
    return this.pipePromise;
  }
}

/**
 * OpenAI `text-embedding-3-small` adapter. Uses the OpenAI REST API
 * directly (no SDK dependency). Returns 1536-dim L2-normalized
 * vectors.
 */
class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(apiKey?: string, model?: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.model = model ?? 'text-embedding-3-small';
    this.baseUrl = baseUrl ?? 'https://api.openai.com/v1';
  }

  async embed(text: string): Promise<Float32Array | null> {
    if (!this.apiKey) return null;
    try {
      const res = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.model, input: text }),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as {
        data?: Array<{ embedding?: number[] }>;
      };
      const vec = json.data?.[0]?.embedding;
      if (!vec) return null;
      return new Float32Array(l2Normalize(vec));
    } catch {
      return null;
    }
  }
}

/**
 * Cohere `embed-english-v3.0` adapter. Uses the Cohere REST API
 * directly. Returns 1024-dim L2-normalized vectors.
 */
class CohereEmbeddingProvider implements EmbeddingProvider {
  private readonly apiKey?: string;
  private readonly model: string;

  constructor(apiKey?: string, model?: string) {
    this.apiKey = apiKey;
    this.model = model ?? 'embed-english-v3.0';
  }

  async embed(text: string): Promise<Float32Array | null> {
    if (!this.apiKey) return null;
    try {
      const res = await fetch('https://api.cohere.ai/v1/embed', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          texts: [text],
          input_type: 'search_query',
        }),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as {
        embeddings?: number[][];
      };
      const vec = json.embeddings?.[0];
      if (!vec) return null;
      return new Float32Array(l2Normalize(vec));
    } catch {
      return null;
    }
  }
}

/**
 * Custom-function adapter. Wraps a caller-supplied async function.
 */
class CustomEmbeddingProvider implements EmbeddingProvider {
  private readonly fn: (text: string) => Promise<Float32Array | null>;

  constructor(fn: (text: string) => Promise<Float32Array | null>) {
    this.fn = fn;
  }

  async embed(text: string): Promise<Float32Array | null> {
    try {
      return await this.fn(text);
    } catch {
      return null;
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * L2-normalize a vector. Returns a plain `number[]` so callers can
 * construct a `Float32Array` (or any other typed array) from it.
 * Zero vectors are returned unchanged.
 */
function l2Normalize(vec: number[]): number[] {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}
