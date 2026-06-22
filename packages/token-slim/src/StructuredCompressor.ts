/**
 * @file StructuredCompressor.ts
 * @description Compress prose into structured formats (bulleted lists or
 * compact JSON) when the content is purely informational (e.g. system
 * prompts, docs). Far more aggressive than LLMLingua — we strip filler
 * sentences entirely and keep only the noun-phrase essence.
 *
 * @packageDocumentation
 */

/**
 * Output format for {@link StructuredCompressor.compress}.
 */
export type StructuredFormat = 'bullets' | 'json';

/**
 * Result of structured compression.
 */
export interface StructuredResult {
  /** The compressed output (markdown bullets or a JSON string). */
  output: string;
  /** Original character count. */
  originalChars: number;
  /** Compressed character count. */
  compressedChars: number;
  /** Compression ratio (compressed / original). */
  ratio: number;
}

/**
 * Sentence-splitting helper. Handles `.`, `!`, `?` followed by whitespace.
 */
function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Extract the "subject" of a sentence — the first noun-phrase-like run
 * (up to the first verb-ish word). Crude but effective for technical prose.
 */
function extractSubject(sentence: string): string {
  // Drop leading conjunctions / fillers.
  const cleaned = sentence.replace(/^(however|moreover|furthermore|additionally|also|then|so|but|and|or)\s+/i, '');
  // Take up to the first common verb.
  const verbSplit = cleaned.split(/\b(is|are|was|were|will|shall|should|must|can|may|does|do|did|has|have|had|to)\b/i);
  const head = (verbSplit[0] ?? cleaned).trim();
  // If still long, take first 8 words.
  const words = head.split(/\s+/).slice(0, 8).join(' ');
  return words.replace(/[:;,.]+$/, '');
}

/**
 * Compress prose into bullets or compact JSON.
 *
 * @example
 * ```ts
 * const r = StructuredCompressor.compress(longText, 'bullets');
 * r.output; // "- subject 1\n- subject 2"
 * r.ratio;  // 0.34
 * ```
 */
export const StructuredCompressor = {
  /**
   * Compress prose.
   *
   * @param text The input prose.
   * @param format `'bullets'` (default) or `'json'`.
   * @returns A {@link StructuredResult}.
   */
  compress(text: string, format: StructuredFormat = 'bullets'): StructuredResult {
    const originalChars = text.length;
    if (!originalChars) {
      return { output: '', originalChars: 0, compressedChars: 0, ratio: 0 };
    }
    const sentences = splitSentences(text);
    const subjects = sentences.map(extractSubject).filter((s) => s.length > 1);

    let output: string;
    if (format === 'json') {
      // Emit a compact JSON array of {s: subject} objects.
      output = JSON.stringify(subjects.map((s) => ({ s })));
    } else {
      output = subjects.map((s) => `- ${s}`).join('\n');
    }
    const compressedChars = output.length;
    return {
      output,
      originalChars,
      compressedChars,
      ratio: compressedChars / Math.max(1, originalChars),
    };
  },
};
