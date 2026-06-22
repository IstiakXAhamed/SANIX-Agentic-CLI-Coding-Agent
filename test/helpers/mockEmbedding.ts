/**
 * @file mockEmbedding.ts
 * @description Deterministic mock embedding provider for testing.
 *
 * Produces L2-normalized vectors whose values are derived from a stable
 * hash of the input text. Two pieces of text with overlapping tokens
 * (after lowercasing + word-splitting) will produce vectors with high
 * cosine similarity — so the same sentence, or near-duplicates, get
 * near-identical embeddings. Wholly unrelated sentences get vectors
 * with low cosine similarity.
 */
import type { EmbeddingProvider } from '@sanix/semantic-cache';

/**
 * Build a deterministic mock embedding function. Each call returns a
 * fresh `Float32Array` of `dims` dimensions, L2-normalized.
 *
 * Algorithm:
 *   1. Lowercase + tokenize the text on non-alphanumeric.
 *   2. For each token, hash it (FNV-1a variant) into a dimension index
 *      and add a token-specific weight to that dimension.
 *   3. L2-normalize the resulting vector.
 *
 * The result: texts with overlapping token sets produce vectors with
 * high cosine similarity (similar tokens land in similar buckets).
 *
 * @param dims - Vector dimensionality. Default 384 (matches Xenova MiniLM).
 */
export function createMockEmbedding(
  dims = 384,
): EmbeddingProvider & {
  embed(text: string): Promise<Float32Array>;
} {
  const cache = new Map<string, Float32Array>();

  const hash = (s: string): number => {
    // FNV-1a 32-bit, returns a positive integer.
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  };

  const embed = async (text: string): Promise<Float32Array> => {
    const cached = cache.get(text);
    if (cached) return new Float32Array(cached);

    const vec = new Float32Array(dims);
    const tokens = text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 0);

    if (tokens.length === 0) {
      // Return a zero vector (cached for determinism).
      const zero = new Float32Array(dims);
      cache.set(text, zero);
      return new Float32Array(zero);
    }

    for (const tok of tokens) {
      const h = hash(tok);
      const idx = h % dims;
      // Use a second hash for the weight so dimensions decorrelate.
      const w = ((hash(tok + '_w') % 1000) / 1000) * 0.5 + 0.5;
      vec[idx] += w;
    }

    // L2-normalize.
    let norm = 0;
    for (let i = 0; i < dims; i++) norm += vec[i]! * vec[i]!;
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < dims; i++) vec[i] = vec[i]! / norm;
    }

    cache.set(text, vec);
    return new Float32Array(vec);
  };

  return { embed };
}
