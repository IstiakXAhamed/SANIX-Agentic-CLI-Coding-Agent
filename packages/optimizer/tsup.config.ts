import { defineConfig } from 'tsup';

/**
 * ESM build for @sanix/optimizer. Single entry — the barrel `src/index.ts`
 * re-exports every public symbol so downstream callers do one import:
 *
 *   import {
 *     tokenizer,
 *     SemanticChunker,
 *     AttentionSelector,
 *     DynamicBudgetReallocator,
 *     LazyContextExpander,
 *     MessageConsolidator,
 *     RACManager,
 *     ContextCompressor,
 *     ToolResultTruncator,
 *   } from '@sanix/optimizer';
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
  // Keep heavy native / runtime-only deps external — they're loaded via
  // dynamic import() inside SemanticChunker at runtime, so bundling them
  // would just bloat dist (1.7MB → 100KB).
  external: [
    '@xenova/transformers',
    '@lancedb/lancedb',
    'better-sqlite3',
    'gpt-tokenizer',
  ],
  noExternal: [],
});
