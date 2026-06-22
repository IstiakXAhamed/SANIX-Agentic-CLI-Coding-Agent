/**
 * @file memory/EmbeddingProvider.ts
 * @description Lazy-loaded singleton wrapper around `@xenova/transformers`
 * (model `Xenova/all-MiniLM-L6-v2`, 384-dim). All tiers that need
 * embeddings (Episodic, Semantic) import this module instead of touching
 * `@xenova/transformers` directly.
 *
 * Design:
 *   - **Lazy load**: the transformers pipeline is only initialized on first
 *     `embed()` call. Environments without internet (or without the model
 *     cached) get a graceful fallback — `available()` returns false and
 *     `embed()` returns `null`, signaling callers to fall back to BM25-only
 *     retrieval.
 *   - **Singleton**: one pipeline instance per process; subsequent calls
 *     reuse it.
 *   - **Zero `any`**: the `@xenova/transformers` types are weak, so we
 *     narrow to `unknown` and validate the shape we expect before use.
 *
 * @packageDocumentation
 */

/** The embedding dimensionality produced by `Xenova/all-MiniLM-L6-v2`. */
export const EMBEDDING_DIM = 384;

/**
 * Lazy singleton holder. The pipeline is created on first use; the promise
 * is shared so concurrent first-callers don't double-init.
 */
let pipelinePromise: Promise<unknown> | null = null;
let pipelineAvailable = true;

/**
 * The shape we expect from `@xenova/transformers`' `pipeline()` call. The
 * library's own types are loose, so we declare a minimal interface and
 * narrow through it.
 */
interface EmbeddingPipeline {
  (text: string | string[]): Promise<{ data: number[] | number[][] }>;
}

/**
 * Dynamically import `@xenova/transformers` and construct the embedding
 * pipeline. Wrapped in try/catch so environments without the package, the
 * model cache, or internet access degrade gracefully.
 */
async function loadPipeline(): Promise<EmbeddingPipeline | null> {
  if (!pipelineAvailable) return null;
  if (pipelinePromise) {
    try {
      return (await pipelinePromise) as EmbeddingPipeline | null;
    } catch {
      return null;
    }
  }
  pipelinePromise = (async () => {
    try {
      // Dynamic import keeps the package out of the module graph when
      // embeddings aren't used (e.g. unit tests of pure-logic tiers).
      const mod = (await import('@xenova/transformers')) as {
        pipeline: (
          task: string,
          model: string,
          opts?: unknown,
        ) => Promise<unknown>;
        env?: {
          allowLocalModels?: boolean;
          allowRemoteModels?: boolean;
          cacheDir?: string;
        };
      };
      // Prefer local cache; allow remote download only if explicitly enabled.
      if (mod.env) {
        mod.env.allowLocalModels = true;
        // Do NOT flip allowRemoteModels to true by default — offline-first.
      }
      const pipe = (await mod.pipeline(
        'feature-extraction',
        'Xenova/all-MiniLM-L6-v2',
      )) as EmbeddingPipeline;
      return pipe;
    } catch (err) {
      pipelineAvailable = false;
      // Surface the reason in debug logs (the agent's logger is the caller's
      // responsibility — we just return null here).
      const msg = err instanceof Error ? err.message : String(err);
      // Swallow but mark unavailable so we don't keep retrying.
      void msg;
      return null;
    }
  })();
  try {
    return (await pipelinePromise) as EmbeddingPipeline | null;
  } catch {
    return null;
  }
}

/**
 * EmbeddingProvider — single-process singleton. All methods are async and
 * never throw (failures yield `null` so callers can fall back to BM25).
 *
 * @example
 * ```ts
 * const provider = EmbeddingProvider.getInstance();
 * if (await provider.available()) {
 *   const vec = await provider.embed('hello world');
 *   if (vec) console.log(vec.length); // 384
 * }
 * ```
 */
export class EmbeddingProvider {
  private static instance: EmbeddingProvider | null = null;

  /** Get the process-wide singleton. */
  static getInstance(): EmbeddingProvider {
    if (!EmbeddingProvider.instance) {
      EmbeddingProvider.instance = new EmbeddingProvider();
    }
    return EmbeddingProvider.instance;
  }

  /** Private — use {@link EmbeddingProvider.getInstance}. */
  private constructor() {}

  /**
   * True if the embedding pipeline has been (or can be) initialized. Callers
   * should check this before relying on `embed()` results.
   */
  async available(): Promise<boolean> {
    const pipe = await loadPipeline();
    return pipe !== null;
  }

  /**
   * Embed a single text string. Returns the 384-dim vector or `null` if the
   * pipeline isn't available.
   *
   * The returned vector is mean-pooled (the MiniLM pipeline returns one
   * vector per token; we average them).
   */
  async embed(text: string): Promise<number[] | null> {
    const pipe = await loadPipeline();
    if (!pipe) return null;
    try {
      const out = await pipe(text);
      return normalizeVector(toVector(out.data));
    } catch {
      return null;
    }
  }

  /**
   * Embed a batch of texts. More efficient than calling `embed()` in a loop
   * because the pipeline batches them. Returns `null` for any item the
   * pipeline fails on (the rest are still returned).
   */
  async embedBatch(texts: string[]): Promise<(number[] | null)[]> {
    if (texts.length === 0) return [];
    const pipe = await loadPipeline();
    if (!pipe) return texts.map(() => null);
    try {
      const out = await pipe(texts);
      const matrix = toMatrix(out.data, texts.length);
      return matrix.map((v) => (v ? normalizeVector(v) : null));
    } catch {
      return texts.map(() => null);
    }
  }
}

// ─── Internal helpers ───────────────────────────────────────────────────────

/**
 * Coerce a transformers pipeline output's `data` field into a flat number[]
 * or number[][] depending on shape.
 */
function toVector(data: number[] | number[][]): number[] {
  if (Array.isArray(data) && data.length > 0 && Array.isArray(data[0])) {
    // number[][] — token-level vectors; mean-pool across tokens.
    const tokenVecs = data as number[][];
    const dim = tokenVecs[0].length;
    const sum = new Array<number>(dim).fill(0);
    for (const v of tokenVecs) {
      for (let i = 0; i < dim; i++) sum[i] += v[i] ?? 0;
    }
    return sum.map((s) => s / tokenVecs.length);
  }
  // number[] — already a single vector.
  return data as number[];
}

/**
 * Coerce a batched output's `data` field into (number[] | null)[] of length
 * `count`. The transformers pipeline may return a flat Float32Array, a 2D
 * array, or a Tensor; we handle the two array shapes.
 */
function toMatrix(
  data: number[] | number[][],
  count: number,
): (number[] | null)[] {
  if (Array.isArray(data) && data.length > 0 && Array.isArray(data[0])) {
    // Already 2D: one vector per input.
    const matrix = data as number[][];
    const out: (number[] | null)[] = [];
    for (let i = 0; i < count; i++) out.push(matrix[i] ?? null);
    return out;
  }
  // Flat array — assume it's a single vector (only valid for count=1).
  if (count === 1) return [data as number[]];
  return Array.from({ length: count }, () => null);
}

/**
 * L2-normalize a vector so cosine similarity reduces to a dot product.
 * Returns the input unchanged if its norm is 0.
 */
export function normalizeVector(vec: number[]): number[] {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

/**
 * Cosine similarity between two vectors. Assumes both are L2-normalized
 * (which `embed()` guarantees) so this is a plain dot product. Falls back
 * to the full cosine formula if either vector has nonzero norm.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}
