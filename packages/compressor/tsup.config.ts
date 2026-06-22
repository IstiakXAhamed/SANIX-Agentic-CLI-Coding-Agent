import { defineConfig } from 'tsup';

/**
 * @file tsup.config.ts
 * @description Build config for `@sanix/compressor`. Single entry — the
 * barrel `src/index.ts` re-exports every public symbol so downstream
 * callers do one import:
 *
 *   import {
 *     LLMPromptCompressor,
 *     SymbolCodeContext,
 *     ConversationStateTracker,
 *     PromptCacheManager,
 *     DiffContextUpdater,
 *   } from '@sanix/compressor';
 *
 * ESM-only output, with DTS bundles and clean build dir. Heavy / native
 * `@sanix/*` deps are kept external (they're loaded via dynamic
 * `import()` by the consumer where appropriate).
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  platform: 'node',
  treeshake: true,
  external: [
    '@sanix/optimizer',
    '@sanix/providers',
    '@sanix/config',
    '@sanix/core',
    'gpt-tokenizer',
    '@xenova/transformers',
    '@lancedb/lancedb',
    'better-sqlite3',
    'diff',
    'p-limit',
    'nanoid',
    'eventemitter3',
    'zod',
  ],
  noExternal: [],
});
