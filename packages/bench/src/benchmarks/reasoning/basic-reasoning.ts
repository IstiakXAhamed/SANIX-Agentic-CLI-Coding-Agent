/**
 * @file reasoning/basic-reasoning.ts
 * @description 10 prompts testing basic logical reasoning (syllogisms,
 * comparisons, conditional logic, simple arithmetic reasoning).
 *
 * @packageDocumentation
 */

import type { Benchmark } from '../../types.js';

/**
 * 10 basic logical-reasoning prompts. Each prompt has a single correct
 * answer; scoring is `contains` (case-insensitive substring match).
 */
export const basicReasoning: Benchmark = {
  id: 'basic-reasoning',
  name: 'Basic Reasoning',
  description:
    '10 prompts testing syllogisms, transitive comparisons, conditional logic, and simple arithmetic reasoning.',
  category: 'reasoning',
  scoring: { type: 'contains' },
  timeout: 60_000,
  prompts: [
    {
      id: 'r1',
      input: 'If A is greater than B, and B is greater than C, is A greater than C? Answer yes or no and explain in one sentence.',
      expected: 'yes',
    },
    {
      id: 'r2',
      input: 'All cats are mammals. Whiskers is a cat. Is Whiskers a mammal? Answer yes or no and explain.',
      expected: 'yes',
    },
    {
      id: 'r3',
      input: 'If it rains, the ground gets wet. The ground is not wet. Did it rain? Answer yes or no and explain.',
      expected: 'no',
    },
    {
      id: 'r4',
      input: 'What is 17 + 25? Just answer with the number.',
      expected: '42',
    },
    {
      id: 'r5',
      input: 'A train travels 60 km in 1.5 hours. What is its average speed in km/h? Just give the number.',
      expected: '40',
    },
    {
      id: 'r6',
      input: 'If all Bloops are Razzies and all Razzies are Lazzies, are all Bloops definitely Lazzies? Answer yes or no.',
      expected: 'yes',
    },
    {
      id: 'r7',
      input: 'Mary is older than Tom. Tom is older than Bob. Who is the youngest? Answer with just the name.',
      expected: 'Bob',
    },
    {
      id: 'r8',
      input: 'If the day after tomorrow is Wednesday, what day is it today? Answer with just the day name.',
      expected: 'Monday',
    },
    {
      id: 'r9',
      input: 'I have 3 apples. I eat 1 and give 1 to a friend. How many do I have left? Just give the number.',
      expected: '1',
    },
    {
      id: 'r10',
      input: 'A is the father of B. B is the sister of C. How is A related to C? Answer with one word.',
      expected: 'father',
    },
  ],
};
