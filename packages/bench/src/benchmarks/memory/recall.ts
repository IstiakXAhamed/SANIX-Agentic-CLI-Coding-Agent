/**
 * @file memory/recall.ts
 * @description 5 prompts testing memory recall across turns. Each prompt
 * is a 2-turn conversation: the first turn establishes a fact, the
 * second turn asks the model to recall it (without restating it in the
 * prompt).
 *
 * Scoring is `contains` against the fact.
 *
 * @packageDocumentation
 */

import type { Benchmark } from '../../types.js';
import type { LLMMessage } from '@sanix/providers';

/**
 * Helper: build a 2-turn memory-recall prompt.
 */
function recall(
  id: string,
  messages: LLMMessage[],
  expected: string,
): { id: string; input: LLMMessage[]; expected: string } {
  return { id, input: messages, expected };
}

/**
 * 5 multi-turn memory-recall prompts. Each uses a `LLMMessage[]` input.
 */
export const memoryRecall: Benchmark = {
  id: 'memory-recall',
  name: 'Memory Recall',
  description:
    '5 multi-turn prompts testing the model\'s ability to recall facts established in earlier turns.',
  category: 'memory',
  scoring: { type: 'contains' },
  timeout: 90_000,
  prompts: [
    recall(
      'm1',
      [
        { role: 'user', content: 'My favorite color is teal.' },
        { role: 'assistant', content: 'Got it — your favorite color is teal.' },
        { role: 'user', content: 'What is my favorite color? Answer with just the color name.' },
      ],
      'teal',
    ),
    recall(
      'm2',
      [
        { role: 'user', content: 'I was born on March 14, 1990.' },
        { role: 'assistant', content: 'Noted — March 14, 1990.' },
        { role: 'user', content: 'What is my birth month? Answer with just the month name.' },
      ],
      'March',
    ),
    recall(
      'm3',
      [
        { role: 'user', content: 'I have two pets: a dog named Rex and a cat named Whiskers.' },
        { role: 'assistant', content: 'Cute! Rex the dog and Whiskers the cat.' },
        { role: 'user', content: 'What is my cat\'s name? Answer with just the name.' },
      ],
      'Whiskers',
    ),
    recall(
      'm4',
      [
        { role: 'user', content: 'The passcode is 4729.' },
        { role: 'assistant', content: 'Saved the passcode 4729.' },
        { role: 'user', content: 'What is the passcode? Answer with just the four digits.' },
      ],
      '4729',
    ),
    recall(
      'm5',
      [
        { role: 'user', content: 'I work at a company called Acme Corp in the engineering department.' },
        { role: 'assistant', content: 'Got it — Acme Corp, engineering.' },
        { role: 'user', content: 'Which department do I work in? Answer with just the department name.' },
      ],
      'engineering',
    ),
  ],
};
