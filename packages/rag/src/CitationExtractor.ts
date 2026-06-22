/**
 * @file CitationExtractor.ts
 * @description Parses `[1]`, `[2]`, etc. citations out of LLM output
 * and maps them back to the source documents that were passed to the
 * LLM as context.
 *
 * ## Citation format
 *
 * The RAG pipeline's system prompt instructs the LLM:
 *
 *   > "Use [1], [2] etc. to cite sources."
 *
 * Where `1`, `2`, … are the 1-based indices into the `sources` array
 * (in the order they were presented to the LLM). The extractor parses
 * those bracketed numbers and returns the source doc + the cited text
 * snippet for each.
 *
 * ## Snippet extraction
 *
 * For each citation, we find the **sentence** in the LLM output that
 * contains the citation marker and return it as the snippet. If the
 * citation appears multiple times, we return the first occurrence's
 * sentence. If no surrounding sentence can be identified, the snippet
 * is the citation marker itself.
 *
 * @packageDocumentation
 */

import type { Document } from './types.js';

/** A parsed citation. */
export interface Citation {
  /** 1-based citation number as it appears in the text. */
  citation: number;
  /** The source document id the citation refers to. */
  docId: string;
  /** The text snippet containing the citation. */
  text: string;
}

/**
 * Citation extractor.
 *
 * @example
 * ```ts
 * const extractor = new CitationExtractor();
 * const citations = extractor.extract(
 *   'JWT is stateless [1]. OAuth2 adds scopes [2].',
 *   [doc1, doc2],
 * );
 * // → [{ citation: 1, docId: 'd1', text: 'JWT is stateless [1].' }, ...]
 * ```
 */
export class CitationExtractor {
  /**
   * Extract citations from `text` and map them to source docs.
   *
   * @param text The LLM output containing `[n]` markers.
   * @param sources The source documents, in the order they were
   *   presented to the LLM (so index 0 ↔ `[1]`, index 1 ↔ `[2]`, …).
   * @returns Array of citations, deduplicated by `(citation, docId)`
   *   and sorted by citation number.
   *
   * @example
   * ```ts
   * const cites = extractor.extract('See [1] and [2].', [doc1, doc2]);
   * ```
   */
  extract(text: string, sources: Document[]): Citation[] {
    if (sources.length === 0) return [];
    const matches = this.findCitations(text);
    if (matches.length === 0) return [];

    const sentences = splitSentences(text);
    const out: Citation[] = [];
    const seen = new Set<string>();
    for (const m of matches) {
      const idx = m.number - 1;
      if (idx < 0 || idx >= sources.length) continue;
      const doc = sources[idx]!;
      const key = `${m.number}:${doc.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const snippet = findSentence(sentences, m.offset) ?? `[${m.number}]`;
      out.push({ citation: m.number, docId: doc.id, text: snippet.trim() });
    }
    out.sort((a, b) => a.citation - b.citation);
    return out;
  }

  /**
   * Find all `[n]` citation markers in `text`. Returns them in order
   * of appearance, each with the marker's 1-based number and the
   * character offset where the marker begins.
   */
  private findCitations(text: string): Array<{ number: number; offset: number }> {
    const re = /\[(\d{1,3})\]/g;
    const out: Array<{ number: number; offset: number }> = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const n = Number.parseInt(m[1]!, 10);
      if (n >= 1) out.push({ number: n, offset: m.index });
    }
    return out;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Split `text` into sentences. Handles common English sentence
 * boundaries; non-Latin scripts may not split well (we treat the
 * whole text as one sentence in that case, which is fine — the
 * snippet just ends up larger).
 */
function splitSentences(text: string): Array<{ text: string; start: number; end: number }> {
  const out: Array<{ text: string; start: number; end: number }> = [];
  const re = /(?<=[.!?])\s+(?=[A-Z0-9"'])/g;
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const end = m.index + m[0].length;
    out.push({ text: text.slice(cursor, end).trim(), start: cursor, end });
    cursor = end;
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  if (cursor < text.length) {
    out.push({ text: text.slice(cursor).trim(), start: cursor, end: text.length });
  }
  return out;
}

/**
 * Find the sentence that contains the character at `offset`. Returns
 * `undefined` if no sentence contains the offset (which shouldn't
 * happen but is handled defensively).
 */
function findSentence(
  sentences: Array<{ text: string; start: number; end: number }>,
  offset: number,
): string | undefined {
  for (const s of sentences) {
    if (offset >= s.start && offset < s.end) return s.text;
  }
  return undefined;
}
