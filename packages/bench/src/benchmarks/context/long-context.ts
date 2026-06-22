/**
 * @file context/long-context.ts
 * @description 3 prompts with large context windows (10K, 50K, 100K
 * tokens). Each prompt embeds a large filler text and a needle (a
 * specific phrase the model must recall). Scoring is `contains` against
 * the needle.
 *
 * @packageDocumentation
 */

import type { Benchmark, BenchmarkPrompt } from '../../types.js';

/**
 * Generate filler text of approximately `targetTokens` tokens (rough
 * estimate: 1 token ≈ 4 chars). The filler is repeating lorem-ipsum-
 * style prose; the needle is placed roughly in the middle.
 */
function longContextPrompt(
  targetTokens: number,
  needle: string,
  question: string,
): BenchmarkPrompt {
  const charsPerToken = 4;
  const totalChars = targetTokens * charsPerToken;
  const fillerUnit =
    'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ';
  const repetitions = Math.ceil(totalChars / fillerUnit.length);
  let filler = '';
  for (let i = 0; i < repetitions; i++) filler += fillerUnit;
  // Truncate to target.
  filler = filler.slice(0, totalChars);
  // Insert the needle roughly in the middle, on its own line.
  const mid = Math.floor(filler.length / 2);
  filler =
    filler.slice(0, mid) +
    `\n\n[NEEDLE] ${needle} [/NEEDLE]\n\n` +
    filler.slice(mid);
  return {
    id: `ctx-${targetTokens}`,
    input: `${filler}\n\n${question}`,
    expected: needle,
  };
}

/**
 * 3 long-context prompts (10K, 50K, 100K tokens). Useful for testing
 * providers' effective context windows and needle-in-a-haystack recall.
 */
export const longContext: Benchmark = {
  id: 'long-context',
  name: 'Long Context (needle-in-a-haystack)',
  description:
    '3 prompts with 10K / 50K / 100K token contexts. Each embeds a needle phrase the model must recall.',
  category: 'context',
  scoring: { type: 'contains' },
  timeout: 300_000,
  prompts: [
    longContextPrompt(
      10_000,
      'the magic number is 7381',
      'What is the magic number mentioned in the text above? Answer with just the four digits.',
    ),
    longContextPrompt(
      50_000,
      'the secret code is banana-split-42',
      'What is the secret code mentioned in the text above? Answer with the code phrase.',
    ),
    longContextPrompt(
      100_000,
      'the launch password is orion-rises-at-dawn',
      'What is the launch password mentioned in the text above? Answer with the password phrase.',
    ),
  ],
};
