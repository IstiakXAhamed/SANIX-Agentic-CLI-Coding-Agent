/**
 * @file multi_turn/conversation.ts
 * @description 5 multi-turn conversations testing the model's ability to
 * maintain state (topic, entity references, prior decisions) across
 * turns. Each prompt is a `LLMMessage[]` with 4-6 turns.
 *
 * @packageDocumentation
 */

import type { Benchmark, BenchmarkPrompt } from '../../types.js';
import type { LLMMessage } from '@sanix/providers';

/**
 * Helper: build a multi-turn conversation prompt.
 */
function conv(
  id: string,
  messages: LLMMessage[],
  expected: string,
): BenchmarkPrompt {
  return { id, input: messages, expected };
}

/**
 * 5 multi-turn conversation prompts.
 */
export const multiTurnConversation: Benchmark = {
  id: 'multi-turn-conversation',
  name: 'Multi-Turn Conversation',
  description:
    '5 multi-turn conversations testing state retention (topic, entity references, prior decisions).',
  category: 'multi_turn',
  scoring: { type: 'contains' },
  timeout: 120_000,
  prompts: [
    conv('m1', [
      { role: 'user', content: 'I\'m planning a trip to Japan. I want to visit Tokyo, Kyoto, and Osaka.' },
      { role: 'assistant', content: 'Sounds great! Tokyo, Kyoto, and Osaka are the classic golden route.' },
      { role: 'user', content: 'I have 7 days total. How many days should I spend in each city?' },
      { role: 'assistant', content: 'I\'d suggest 3 days Tokyo, 2 days Kyoto, 2 days Osaka.' },
      { role: 'user', content: 'Which of the three cities did I say I want to spend the most time in? Answer with just the city name.' },
    ], 'Tokyo'),
    conv('m2', [
      { role: 'user', content: 'I\'m a vegetarian.' },
      { role: 'assistant', content: 'Noted — vegetarian.' },
      { role: 'user', content: 'Suggest a dinner idea.' },
      { role: 'assistant', content: 'How about a chickpea curry with basmati rice?' },
      { role: 'user', content: 'Given my dietary restriction, can you suggest a protein source for breakfast? Answer with just the food name.' },
    ], 'tofu'),
    conv('m3', [
      { role: 'user', content: 'Let\'s roleplay. You are a helpful pirate captain named Captain Salty.' },
      { role: 'assistant', content: 'Arrr! Captain Salty at yer service, matey!' },
      { role: 'user', content: 'What\'s the weather like today?' },
      { role: 'assistant', content: 'Arrr, the seas be calm and the sun be shinin\', matey!' },
      { role: 'user', content: 'What is your name? Answer with just the name.' },
    ], 'Salty'),
    conv('m4', [
      { role: 'user', content: 'I just finished reading "The Prag Programmer".' },
      { role: 'assistant', content: 'A classic! What did you think of it?' },
      { role: 'user', content: 'Loved it. Suggest a similar book.' },
      { role: 'assistant', content: 'You might enjoy "Clean Code" by Robert C. Martin.' },
      { role: 'user', content: 'What book did I just finish reading? Answer with just the title.' },
    ], 'Pragmatic Programmer'),
    conv('m5', [
      { role: 'user', content: 'Set a reminder: call mom tomorrow at 5pm.' },
      { role: 'assistant', content: 'Reminder set: call mom tomorrow at 5pm.' },
      { role: 'user', content: 'Also set a reminder: buy groceries on Saturday.' },
      { role: 'assistant', content: 'Reminder set: buy groceries on Saturday.' },
      { role: 'user', content: 'What time is the call-mom reminder for? Answer with just the time.' },
    ], '5pm'),
  ],
};
