/**
 * @file LLMlingua2.ts
 * @description A pure-TypeScript approximation of Microsoft's LLMLingua-2
 * prompt-compression algorithm. The original uses a BERT-based classifier to
 * predict per-token "perplexity" and drops the lowest-information tokens.
 * Here we substitute a fast heuristic: tokens (whitespace-split words +
 * punctuation) are scored by inverse document-frequency-like rarity, and the
 * lowest-scoring tokens are dropped until the target compression ratio is
 * met. Stop-words and very short tokens are deprioritized first.
 *
 * The output is still human-readable prose, just shorter — perfect for
 * non-critical context windows.
 *
 * @packageDocumentation
 */

/** English stop-words deprioritized during compression. */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'for',
  'of', 'to', 'in', 'on', 'at', 'by', 'with', 'from', 'as', 'is',
  'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
  'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might',
  'this', 'that', 'these', 'those', 'it', 'its', 'they', 'them', 'their',
  'we', 'us', 'our', 'you', 'your', 'he', 'she', 'him', 'her', 'his',
  'i', 'me', 'my', 'so', 'not', 'no', 'yes', 'can', 'just', 'also',
  // Additional filler words for aggressive compression
  'very', 'really', 'quite', 'rather', 'somewhat', 'fairly', 'pretty',
  'actually', 'basically', 'literally', 'honestly', 'obviously', 'clearly',
  'simply', 'merely', 'essentially', 'particularly', 'specifically',
  'however', 'therefore', 'moreover', 'furthermore', 'additionally',
  'consequently', 'nevertheless', 'nonetheless', 'thus', 'hence',
  'indeed', 'certainly', 'surely', 'truly', 'perhaps', 'maybe',
  'please', 'thank', 'thanks', 'welcome', 'sorry',
  'about', 'into', 'onto', 'upon', 'within', 'without', 'through',
  'during', 'before', 'after', 'since', 'until', 'while', 'although',
  'because', 'unless', 'whether', 'whilst', 'whereas',
  'some', 'any', 'all', 'each', 'every', 'both', 'few', 'many', 'much',
  'more', 'most', 'less', 'least', 'fewer', 'fewest',
  'other', 'another', 'same', 'such', 'own', 'same',
  'which', 'who', 'whom', 'whose', 'what', 'where', 'when', 'why', 'how',
  'here', 'there', 'now', 'then', 'always', 'never', 'ever',
  'only', 'even', 'still', 'yet', 'already', 'again',
  'up', 'down', 'out', 'off', 'over', 'under', 'again',
  'get', 'got', 'make', 'made', 'take', 'took', 'go', 'went',
  'come', 'came', 'see', 'saw', 'know', 'knew', 'think', 'thought',
  'say', 'said', 'tell', 'told', 'give', 'gave', 'want', 'wanted',
  'need', 'needed', 'use', 'used', 'try', 'tried', 'let',
]);

/**
 * A token (word / punctuation) with its computed score.
 */
interface ScoredToken {
  text: string;
  index: number;
  score: number;
  /** Whether the token is a stop-word. */
  stop: boolean;
}

/**
 * Approximation of LLMLingua-2: drops low-information tokens until the
 * compressed text meets the target ratio.
 *
 * @example
 * ```ts
 * const out = LLMlingua2.compress(longPrompt, { ratio: 0.5 });
 * out.compressed; // ~half the tokens
 * out.droppedCount; // # tokens removed
 * ```
 */
export const LLMlingua2 = {
  /**
   * Compress a text prompt by dropping low-information tokens.
   *
   * @param text The input text.
   * @param opts.ratio Target compression ratio in (0, 1]. `0.5` keeps ~50% of tokens.
   * @param opts.preserveCode If true, fenced code blocks are passed through untouched. Default true.
   * @returns The compressed text plus stats.
   */
  compress(
    text: string,
    opts: { ratio?: number; preserveCode?: boolean } = {},
  ): { compressed: string; originalCount: number; keptCount: number; droppedCount: number } {
    const ratio = opts.ratio ?? 0.6;
    const preserveCode = opts.preserveCode ?? true;
    if (ratio >= 1 || !text) {
      const count = text.split(/\s+/).filter(Boolean).length;
      return { compressed: text, originalCount: count, keptCount: count, droppedCount: 0 };
    }

    // Pull fenced code blocks out so we don't compress them.
    const codeBlocks: string[] = [];
    let working = text;
    if (preserveCode) {
      working = text.replace(/```[\s\S]*?```/g, (m) => {
        codeBlocks.push(m);
        return `\u0000CODE${codeBlocks.length - 1}\u0000`;
      });
    }

    const tokens = working.match(/(\s+|[A-Za-z0-9_]+|[^\sA-Za-z0-9_]+)/g) ?? [];
    const scored: ScoredToken[] = tokens.map((t, i) => {
      const word = t.trim().toLowerCase();
      const isStop = STOP_WORDS.has(word);
      // Score: longer + non-stop = higher (more likely to keep).
      const lenScore = Math.min(word.length, 12) / 12;
      const stopScore = isStop ? 0 : 1;
      const punctScore = /^[^\sA-Za-z0-9_]+$/.test(t) ? 0.3 : 1;
      return { text: t, index: i, score: (lenScore * 0.5) + (stopScore * 0.4) + (punctScore * 0.1), stop: isStop };
    });

    const originalCount = scored.filter((s) => !/^\s+$/.test(s.text)).length;
    const targetKeep = Math.max(1, Math.ceil(originalCount * ratio));

    // Sort by score ascending; mark lowest for removal until we hit target.
    const sorted = [...scored].sort((a, b) => a.score - b.score);
    const dropSet = new Set<number>();
    let kept = originalCount;
    for (const tok of sorted) {
      if (kept <= targetKeep) break;
      if (/^\s+$/.test(tok.text)) continue;
      dropSet.add(tok.index);
      kept--;
    }

    // Rebuild, skipping dropped tokens but keeping whitespace runs adjacent
    // to a dropped token collapsed to a single space.
    const out: string[] = [];
    for (let i = 0; i < scored.length; i++) {
      if (dropSet.has(i)) {
        // Insert a single space if the previous non-dropped token didn't
        // already end in whitespace.
        const prev = out[out.length - 1];
        if (prev !== undefined && !/\s$/.test(prev)) out.push(' ');
        continue;
      }
      out.push(scored[i].text);
    }
    let compressed = out.join('').replace(/\s+/g, ' ').trim();

    // Restore code blocks.
    if (preserveCode) {
      compressed = compressed.replace(/\u0000CODE(\d+)\u0000/g, (_m, idx: string) => codeBlocks[Number(idx)] ?? '');
    }

    return {
      compressed,
      originalCount,
      keptCount: kept,
      droppedCount: originalCount - kept,
    };
  },
};
