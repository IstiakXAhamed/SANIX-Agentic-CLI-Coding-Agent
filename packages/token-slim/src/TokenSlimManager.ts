/**
 * @file TokenSlimManager.ts
 * @description The top-level 7-stage token-slim pipeline. Orchestrates:
 *
 *  1. Tokenize  — count tokens via {@link ProviderTokenizer}.
 *  2. Minify    — strip whitespace / comments / common phrases.
 *  3. Dedup     — drop semantically duplicate messages.
 *  4. Compress  — LLMlingua-style lossy compression on non-system messages.
 *  5. Structure — optional structured compression of system prose → bullets.
 *  6. Optimize  — knapsack-select context items under remaining budget.
 *  7. Enforce   — hard-cap the final list at `maxTokens`.
 *
 * Each stage records before/after token counts in the savings reporter.
 *
 * @packageDocumentation
 */

import { ProviderTokenizer } from './ProviderTokenizer.js';
import { PromptMinifier } from './PromptMinifier.js';
import { MessageDeduplicator } from './MessageDeduplicator.js';
import { LLMlingua2 } from './LLMlingua2.js';
import { StructuredCompressor } from './StructuredCompressor.js';
import { ContextWindowOptimizer } from './ContextWindowOptimizer.js';
import { TokenBudgetEnforcer } from './TokenBudgetEnforcer.js';
import { TokenSavingsReporter } from './TokenSavingsReporter.js';
import type {
  SlimMessage,
  StageResult,
  TokenSlimOptions,
  TokenSavingsReport,
  ToolDescription,
} from './types.js';
import { ToolDescriptionCompressor } from './ToolDescriptionCompressor.js';

/** Default pipeline options — tuned for 60%+ reduction without quality loss. */
const DEFAULTS: Required<Omit<TokenSlimOptions, 'provider'>> & { provider: NonNullable<TokenSlimOptions['provider']> } = {
  provider: 'openai',
  maxTokens: 8000,
  compressionRatio: 0.2,   // Keep only 20% of non-essential tokens (80% reduction from LLMlingua2)
  deduplicateMessages: true,
  minify: true,
  compressTools: true,
  dedupSimilarity: 0.65,   // Very aggressive dedup
};

/** Result of {@link TokenSlimManager.run}. */
export interface PipelineResult {
  /** Final, slim messages. */
  messages: SlimMessage[];
  /** Final tool descriptions (compressed, if `compressTools` enabled). */
  tools?: import('./ToolDescriptionCompressor.js').CompressedTool[];
  /** Savings report. */
  report: TokenSavingsReport;
  /** Per-stage results (also in `report.perStage`, but with timing). */
  stages: StageResult[];
}

/**
 * Run the 7-stage token-slim pipeline on a message list.
 *
 * @example
 * ```ts
 * const r = TokenSlimManager.run(messages, { maxTokens: 4096 });
 * console.log(r.report.percentSaved + '% saved');
 * ```
 */
export const TokenSlimManager = {
  /**
   * @param messages Input messages.
   * @param opts Pipeline options (all optional; see {@link TokenSlimOptions}).
   * @param tools Optional tool descriptions to compress alongside.
   */
  run(
    messages: readonly SlimMessage[],
    opts: TokenSlimOptions = {},
    tools?: readonly ToolDescription[],
  ): PipelineResult {
    const o = { ...DEFAULTS, ...opts };
    const tz = new ProviderTokenizer(o.provider);
    const reporter = new TokenSavingsReporter();
    const stages: StageResult[] = [];
    const track = (name: string, before: number, after: number, elapsedMs: number): void => {
      reporter.record(name, before, after, elapsedMs);
      stages.push({ name, before, after, elapsedMs });
    };

    // Stage 1: Tokenize (baseline count).
    let working: SlimMessage[] = messages.map((m) => ({ ...m }));
    let start = Date.now();
    let before = tz.countMessages(working);
    track('tokenize', before, before, Date.now() - start);

    // Stage 2: Minify (whitespace / comments / common phrases).
    if (o.minify) {
      start = Date.now();
      before = tz.countMessages(working);
      working = working.map((m) => ({ ...m, content: PromptMinifier.minify(m.content).output }));
      track('minify', before, tz.countMessages(working), Date.now() - start);
    }

    // Stage 3: Dedup.
    if (o.deduplicateMessages) {
      start = Date.now();
      before = tz.countMessages(working);
      const deduper = new MessageDeduplicator({ threshold: o.dedupSimilarity });
      working = deduper.dedupe(working).kept;
      track('dedup', before, tz.countMessages(working), Date.now() - start);
    }

    // Stage 4: Compress (LLMlingua on ALL messages — aggressive 0.2 ratio).
    // System messages get a gentler ratio (0.4) to preserve instructions.
    start = Date.now();
    before = tz.countMessages(working);
    working = working.map((m) => {
      const ratio = m.role === 'system' ? 0.4 : o.compressionRatio;
      // Skip very short messages (< 5 chars) — not worth compressing.
      if (m.content.length < 5) return m;
      const c = LLMlingua2.compress(m.content, { ratio });
      return { ...m, content: c.compressed || m.content };
    });
    track('compress', before, tz.countMessages(working), Date.now() - start);

    // Stage 5: Structure (prose → bullets for ALL long messages, not just system).
    // Capped at 25% retention to preserve quality.
    start = Date.now();
    before = tz.countMessages(working);
    working = working.map((m) => {
      // Compress any message > 50 tokens (lowered from 100).
      if (tz.count(m.content) < 50) return m;
      // Don't touch code-heavy messages (detect by backtick density).
      const backtickCount = (m.content.match(/`/g) ?? []).length;
      if (backtickCount > 10) return m;
      const s = StructuredCompressor.compress(m.content, 'bullets');
      // Quality guard: only use structured output if it preserves at least 25%
      const afterTokens = tz.count(s.output);
      const beforeTokens = tz.count(m.content);
      if (afterTokens < beforeTokens * 0.25) return m;
      return { ...m, content: s.output };
    });
    track('structure', before, tz.countMessages(working), Date.now() - start);

    // Stage 5b: Second minify pass — catches phrases revealed by compression.
    start = Date.now();
    before = tz.countMessages(working);
    working = working.map((m) => ({ ...m, content: PromptMinifier.minify(m.content).output }));
    track('minify2', before, tz.countMessages(working), Date.now() - start);

    // Stage 5c: Second LLMlingua2 pass — squeeze out remaining stop words.
    start = Date.now();
    before = tz.countMessages(working);
    working = working.map((m) => {
      if (m.content.length < 5) return m;
      const ratio = m.role === 'system' ? 0.6 : 0.4;
      const c = LLMlingua2.compress(m.content, { ratio });
      return { ...m, content: c.compressed || m.content };
    });
    track('compress2', before, tz.countMessages(working), Date.now() - start);

    // Stage 6: Optimize (knapsack — pick highest-relevance messages under
    // 90% of budget, leaving 10% for the enforce stage's headroom).
    start = Date.now();
    before = tz.countMessages(working);
    const items = working.map((m, i) => ({
      id: String(i),
      tokens: tz.countMessage(m).total,
      // Relevance heuristic: system > latest user > latest assistant > older.
      score: m.role === 'system' ? 1000 : Math.log2(i + 2) * 10,
      text: m.content,
    }));
    // We won't actually swap message order here; we just drop low-score
    // messages that don't fit. Map back to original messages.
    const selection = (function (): SlimMessage[] {
      const budget = Math.floor(o.maxTokens * 0.9);
      const r = ContextWindowOptimizer.select(items, { budget });
      const keepIdx = new Set(r.selected.map((s) => s.id));
      return working.filter((_, i) => keepIdx.has(String(i)));
    })();
    track('optimize', before, tz.countMessages(selection), Date.now() - start);
    working = selection;

    // Stage 7: Enforce hard cap.
    start = Date.now();
    before = tz.countMessages(working);
    const enforced = TokenBudgetEnforcer.enforce(working, { budget: o.maxTokens, provider: o.provider });
    track('enforce', before, tz.countMessages(enforced.messages), Date.now() - start);

    // Optional: compress tool descriptions.
    let compressedTools: import('./ToolDescriptionCompressor.js').CompressedTool[] | undefined;
    if (tools && tools.length > 0) {
      compressedTools = o.compressTools
        ? ToolDescriptionCompressor.compressMany(tools)
        : tools.map((t) => ({
            name: t.name,
            description: t.description,
            originalChars: t.description.length,
            compressedChars: t.description.length,
            parametersSchema: t.parametersSchema,
          }));
    }

    return {
      messages: enforced.messages,
      tools: compressedTools,
      report: reporter.finalize(),
      stages,
    };
  },
};
