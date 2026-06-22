/**
 * @file PromptMutator.ts
 * @description Generates prompt variants via LLM-driven mutation strategies
 * (paraphrase / add_examples / add_constraints / simplify / expand / reorder
 * / tone_shift / persona_shift / random) and crossover (combines sections
 * from two parents).
 *
 * @packageDocumentation
 */

import { nanoid } from 'nanoid';
import type { IProvider } from '@sanix/providers';
import type { MutationType, PromptVariant } from './types.js';
import { ALL_MUTATION_TYPES } from './types.js';
import { chatWithRetry, type ChatOptions } from './llm.js';

/**
 * Per-mutation-type LLM instruction templates. The user prompt is appended
 * after the template.
 */
const MUTATION_TEMPLATES: Record<Exclude<MutationType, 'random'>, string> = {
  paraphrase:
    'Rewrite the following system prompt with different wording while preserving the intent. ' +
    'Keep it about the same length. Output ONLY the new prompt, no preamble.\n\n---\n',
  add_examples:
    'Add 1-2 concrete examples to the following system prompt to illustrate the desired behavior. ' +
    'Keep the rest of the prompt intact. Output ONLY the new prompt, no preamble.\n\n---\n',
  add_constraints:
    'Add 1-2 explicit constraints to the following system prompt to guide the model. ' +
    'Keep the rest of the prompt intact. Output ONLY the new prompt, no preamble.\n\n---\n',
  simplify:
    'Simplify the following system prompt, removing unnecessary words and redundancies. ' +
    'Preserve all key instructions. Output ONLY the new prompt, no preamble.\n\n---\n',
  expand:
    'Expand the following system prompt with more detail and context. Add specifics where useful. ' +
    'Output ONLY the new prompt, no preamble.\n\n---\n',
  reorder:
    'Reorder the sections of the following system prompt for clarity. Group related instructions. ' +
    'Do NOT add or remove content. Output ONLY the new prompt, no preamble.\n\n---\n',
  tone_shift:
    'Rewrite the following system prompt in a more formal, technical tone. ' +
    'Preserve the intent. Output ONLY the new prompt, no preamble.\n\n---\n',
  persona_shift:
    'Rewrite the following system prompt as if the AI were a domain expert — confident, ' +
    'precise, and citing best practices. Output ONLY the new prompt, no preamble.\n\n---\n',
};

/**
 * PromptMutator constructor options.
 */
export interface PromptMutatorOptions {
  /** The LLM provider used for mutations + crossover. */
  provider: IProvider;
  /** LLM call options (timeout, retries). */
  chatOpts?: ChatOptions;
  /** RNG for picking `random` mutation types. Optional. */
  rng?: () => MutationType;
}

/**
 * Generates prompt variants via LLM-driven mutation and crossover.
 *
 * @example
 * ```ts
 * const mutator = new PromptMutator({ provider });
 * const child = await mutator.mutate(parent, 'add_examples');
 * const cross = await mutator.crossover(parentA, parentB);
 * ```
 */
export class PromptMutator {
  private readonly provider: IProvider;
  private readonly chatOpts: ChatOptions;
  private readonly rng: () => MutationType;

  constructor(opts: PromptMutatorOptions) {
    this.provider = opts.provider;
    this.chatOpts = opts.chatOpts ?? { timeoutMs: 60_000, maxAttempts: 3 };
    this.rng = opts.rng ?? (() => ALL_MUTATION_TYPES[Math.floor(Math.random() * (ALL_MUTATION_TYPES.length - 1))]!);
  }

  /**
   * Mutate a variant using the given strategy (or `random`).
   */
  async mutate(variant: PromptVariant, type: MutationType = 'random'): Promise<PromptVariant> {
    const effectiveType: Exclude<MutationType, 'random'> =
      type === 'random' ? this.pickNonRandom() : type;
    const template = MUTATION_TEMPLATES[effectiveType];
    const userMsg = `${template}${variant.systemPrompt}`;
    const res = await chatWithRetry(this.provider, userMsg, this.chatOpts);
    const newPrompt = res.content.trim();
    return {
      id: nanoid(10),
      name: `${variant.name}#${effectiveType}`,
      systemPrompt: newPrompt,
      description: `${effectiveType} mutation of ${variant.name}`,
      createdAt: Date.now(),
      parent: variant.id,
      generation: variant.generation + 1,
      mutationType: effectiveType,
      samples: 0,
    };
  }

  /**
   * Crossover two parents: split each on blank lines, take alternating
   * sections, then ask the LLM to smooth the result.
   */
  async crossover(parentA: PromptVariant, parentB: PromptVariant): Promise<PromptVariant> {
    const sectionsA = parentA.systemPrompt.split(/\n\s*\n/).filter((s) => s.trim().length > 0);
    const sectionsB = parentB.systemPrompt.split(/\n\s*\n/).filter((s) => s.trim().length > 0);
    const maxLen = Math.max(sectionsA.length, sectionsB.length);
    const combined: string[] = [];
    for (let i = 0; i < maxLen; i++) {
      if (i < sectionsA.length) combined.push(sectionsA[i]!);
      if (i < sectionsB.length) combined.push(sectionsB[i]!);
    }
    const draft = combined.join('\n\n');
    const userMsg =
      'The following is a draft system prompt assembled from two parent prompts by alternating their sections. ' +
      'Smooth the transitions, remove redundancies, and produce a coherent final prompt. ' +
      'Output ONLY the new prompt, no preamble.\n\n---\n' + draft;
    const res = await chatWithRetry(this.provider, userMsg, this.chatOpts);
    return {
      id: nanoid(10),
      name: `${parentA.name}×${parentB.name}`,
      systemPrompt: res.content.trim(),
      description: `crossover of ${parentA.name} and ${parentB.name}`,
      createdAt: Date.now(),
      parent: parentA.id,
      generation: Math.max(parentA.generation, parentB.generation) + 1,
      mutationType: 'random',
      samples: 0,
    };
  }

  /**
   * Generate an initial population of `count` variants from a seed prompt.
   * The first variant is the seed itself (unchanged); the remaining are
   * mutations of the seed using randomly-picked strategies.
   */
  async generateInitialPopulation(seed: string, count: number): Promise<PromptVariant[]> {
    if (count <= 0) return [];
    const seedVariant: PromptVariant = {
      id: nanoid(10),
      name: 'seed',
      systemPrompt: seed,
      description: 'original seed prompt',
      createdAt: Date.now(),
      generation: 0,
      samples: 0,
    };
    if (count === 1) return [seedVariant];
    const mutations = await Promise.all(
      Array.from({ length: count - 1 }, () => this.mutate(seedVariant, 'random')),
    );
    return [seedVariant, ...mutations];
  }

  private pickNonRandom(): Exclude<MutationType, 'random'> {
    return this.rng() === 'random'
      ? ALL_MUTATION_TYPES[Math.floor(Math.random() * (ALL_MUTATION_TYPES.length - 1))]! as Exclude<MutationType, 'random'>
      : this.rng() as Exclude<MutationType, 'random'>;
  }
}
