/**
 * @file PromptMinifier.ts
 * @description Lossless-where-possible minification: collapse whitespace,
 * strip comments (slash-slash and slash-star-star-slash and HTML comments),
 * and replace a curated list of common phrases with shorter equivalents.
 * The output preserves the original meaning for the LLM while shrinking
 * the token count.
 *
 * @packageDocumentation
 */

/** Common long phrases → shorter equivalents (case-insensitive match). */
const COMMON_PHRASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bin order to\b/gi, 'to'],
  [/\bfor the purpose of\b/gi, 'for'],
  [/\bdue to the fact that\b/gi, 'because'],
  [/\bin the event that\b/gi, 'if'],
  [/\bat this point in time\b/gi, 'now'],
  [/\bin the near future\b/gi, 'soon'],
  [/\bwith regard to\b/gi, 'about'],
  [/\bwith reference to\b/gi, 're'],
  [/\bin spite of the fact that\b/gi, 'although'],
  [/\ba large number of\b/gi, 'many'],
  [/\ba majority of\b/gi, 'most'],
  [/\bit should be noted that\b/gi, 'note:'],
  [/\bplease be advised that\b/gi, 'note:'],
  [/\bas a matter of fact\b/gi, 'actually'],
  [/\bin the process of\b/gi, 'while'],
  [/\bmake use of\b/gi, 'use'],
  [/\btake into consideration\b/gi, 'consider'],
  [/\bprior to\b/gi, 'before'],
  [/\bsubsequent to\b/gi, 'after'],
  [/\butilize\b/gi, 'use'],
  [/\butilization\b/gi, 'use'],
  [/\bfacilitate\b/gi, 'help'],
  [/\bindividuals\b/gi, 'people'],
  [/\bapproximately\b/gi, '~'],
  [/\btherefore\b/gi, 'so'],
  [/\bhowever\b/gi, 'but'],
  [/\badditionally\b/gi, 'also'],
  [/\bfurthermore\b/gi, 'also'],
  [/\bnevertheless\b/gi, 'still'],
];

/**
 * Result of {@link PromptMinifier.minify}.
 */
export interface MinifyResult {
  /** The minified text. */
  output: string;
  /** Original character count. */
  originalChars: number;
  /** Minified character count. */
  minifiedChars: number;
  /** Tokens saved (approx — assumes 4 chars/token). */
  tokensSaved: number;
}

/**
 * Strip code-block and inline comments from a text prompt while preserving
 * fenced code blocks (```...```) verbatim.
 */
function stripComments(text: string): string {
  // Pull fenced code blocks out.
  const blocks: string[] = [];
  let working = text.replace(/```[\s\S]*?```/g, (m) => {
    blocks.push(m);
    return `\u0000BLK${blocks.length - 1}\u0000`;
  });
  // /* */ block comments.
  working = working.replace(/\/\*[\s\S]*?\*\//g, '');
  // // line comments (but not inside URLs like http://).
  working = working.replace(/(^|[^:])\/\/.*$/gm, '$1');
  // HTML comments.
  working = working.replace(/<!--[\s\S]*?-->/g, '');
  // Restore code blocks.
  working = working.replace(/\u0000BLK(\d+)\u0000/g, (_m, idx: string) => blocks[Number(idx)] ?? '');
  return working;
}

/**
 * Minify a prompt: strip comments, collapse whitespace, replace common
 * verbose phrases with shorter equivalents.
 *
 * @example
 * ```ts
 * const r = PromptMinifier.minify(longText);
 * r.tokensSaved; // approx tokens saved
 * ```
 */
export const PromptMinifier = {
  /**
   * @param text The input prompt.
   * @param opts.skipComments If true, do not strip comments. Default false.
   * @param opts.skipPhrases If true, do not replace common phrases. Default false.
   */
  minify(
    text: string,
    opts: { skipComments?: boolean; skipPhrases?: boolean } = {},
  ): MinifyResult {
    const originalChars = text.length;
    if (!originalChars) {
      return { output: '', originalChars: 0, minifiedChars: 0, tokensSaved: 0 };
    }
    let out = opts.skipComments ? text : stripComments(text);
    if (!opts.skipPhrases) {
      for (const [re, rep] of COMMON_PHRASES) out = out.replace(re, rep);
    }
    // Collapse runs of whitespace to a single space, preserve newlines
    // (but cap at 2 consecutive newlines).
    out = out.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    const minifiedChars = out.length;
    const tokensSaved = Math.max(0, Math.ceil((originalChars - minifiedChars) / 4));
    return { output: out, originalChars, minifiedChars, tokensSaved };
  },
};
