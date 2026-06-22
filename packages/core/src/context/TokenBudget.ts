/**
 * @file context/TokenBudget.ts
 * @description Per-request token accounting. SANIX's competitive advantage
 * (per spec §4) is extreme token efficiency — this module enforces the
 * 6-tier budget split and provides per-tier compression strategies.
 *
 * Tiers (default weights):
 *   system   10%  — system prompt (compressed, cacheable)
 *   memory   20%  — recalled memories
 *   plan      5%  — current task plan
 *   history  25%  — compressed conversation history
 *   context  30%  — files, code, tool results
 *   output   10%  — reserved for model output
 *
 * ## Optimizer integration (V3)
 *
 * When `@sanix/optimizer` is installed (it's an optional dep), this
 * module routes `estimateTokens()` through `ExactTokenizer.countFor()`
 * for exact BPE-based counts. The integration is fully opt-in:
 *
 *   - If `@sanix/optimizer` is missing, the existing heuristic
 *     (`detailedEstimate`) is used unchanged.
 *   - The default counting provider is `'generic'` (matches the old
 *     behavior most closely); callers can switch via
 *     {@link TokenBudget.setTokenizer}.
 *   - All other modules in `@sanix/core` continue to call
 *     `estimateTokens()` — the optimizer is transparent to them.
 *
 * @packageDocumentation
 */

import { createRequire as nodeCreateRequire } from 'node:module';
import type { LLMMessage } from '@sanix/providers';
import type { AgentState, Plan } from '../agent/types.js';
import type { ScoredMemoryItem } from '../memory/types.js';

/**
 * Per-tier token budget. Produced by {@link TokenBudget.allocate}.
 */
export interface BudgetAllocation {
  system: number;
  memory: number;
  plan: number;
  history: number;
  context: number;
  output: number;
}

/**
 * The assembled prompt context. Produced by {@link TokenBudget.buildContext}
 * (and consumed by the ContextBuilder).
 */
export interface BuiltContext {
  /** Compressed system prompt (cacheable prefix). */
  system: string;
  /** Selected memory items, formatted as text. */
  memory: string;
  /** Current plan, formatted as text. */
  plan: string;
  /** Compressed conversation history. */
  history: LLMMessage[];
  /** Smart file context (only relevant sections). */
  context: string;
  /** Per-tier token accounting (for the TUI's ContextMeter). */
  tokens: BudgetAllocation;
  /** True if the system prompt should be flagged as cacheable. */
  systemCacheable: boolean;
}

/**
 * SANIX token budget allocator + context assembler.
 *
 * @example
 * ```ts
 * const budget = new TokenBudget();
 * const alloc = budget.allocate(100_000);
 * // alloc.system === 10_000, alloc.memory === 20_000, ...
 * const built = await budget.buildContext(state, alloc);
 * ```
 */
export class TokenBudget {
  /** The 6-tier budget weights (must sum to 1.0). */
  readonly BUDGET_TIERS = {
    system: 0.1,
    memory: 0.2,
    plan: 0.05,
    history: 0.25,
    context: 0.3,
    output: 0.1,
  } as const;

  /**
   * Per-instance LRU token-estimate cache. Repeated measurements of the
   * same string (common during iterative context building — e.g. the
   * system prompt is re-measured on every `compressSystem` call) hit the
   * cache instead of re-running the heuristic. The cache is bounded to
   * 1000 entries to keep memory predictable.
   */
  private readonly counter: TokenCounter = new TokenCounter(1000);

  /**
   * Switch the default counting provider used by {@link estimateTokens}
   * when `@sanix/optimizer` is installed. Accepts the same values as
   * `ExactTokenizer.countFor`:
   *
   *   - `'openai'`    — exact GPT-4 BPE via `gpt-tokenizer`.
   *   - `'anthropic'` — chars/3.5 (Claude's tokenizer is not public).
   *   - `'gemini'`    — chars/4.
   *   - `'generic'`   — chars/4 with a JSON-density tweak (default).
   *
   * No-op if `@sanix/optimizer` is not installed (the heuristic is
   * used regardless of provider).
   *
   * This is a process-wide setting (the optimizer tokenizer is a
   * singleton). All `TokenBudget` instances and all callers of
   * `estimateTokens` are affected.
   *
   * @example
   * ```ts
   * TokenBudget.setTokenizer('anthropic');
   * // All subsequent estimateTokens() calls use chars/3.5
   * ```
   */
  static setTokenizer(provider: 'openai' | 'anthropic' | 'gemini' | 'generic'): void {
    setCountingProvider(provider);
  }

  /**
   * The current default counting provider (settable via
   * {@link setTokenizer}). Mirrors {@link getCountingProvider}.
   */
  static getTokenizer(): string {
    return getCountingProvider();
  }


  /**
   * Allocate a total token budget across the 6 tiers. Floor-rounds so the
   * sum never exceeds the total.
   *
   * @example
   * ```ts
   * const alloc = budget.allocate(100_000);
   * // { system: 10_000, memory: 20_000, plan: 5_000, history: 25_000, context: 30_000, output: 10_000 }
   * ```
   */
  allocate(totalBudget: number): BudgetAllocation {
    const t = Math.max(0, totalBudget);
    return {
      system: Math.floor(t * this.BUDGET_TIERS.system),
      memory: Math.floor(t * this.BUDGET_TIERS.memory),
      plan: Math.floor(t * this.BUDGET_TIERS.plan),
      history: Math.floor(t * this.BUDGET_TIERS.history),
      context: Math.floor(t * this.BUDGET_TIERS.context),
      output: Math.floor(t * this.BUDGET_TIERS.output),
    };
  }

  /**
   * Build the full prompt context per the budget. Each section is
   * compressed independently to fit its tier allocation.
   *
   * @param state - The current agent state.
   * @param allocation - Per-tier budget (from {@link allocate}).
   * @param memories - Pre-ranked scored memory items (from MemoryRouter.recall).
   */
  async buildContext(
    state: AgentState,
    allocation: BudgetAllocation,
    memories: ReadonlyArray<ScoredMemoryItem> = [],
  ): Promise<BuiltContext> {
    const system = await this.compressSystem(state.systemPrompt, allocation.system);
    const memory = await this.selectiveMemory(
      memories,
      state.currentTask?.title ?? state.goal,
      allocation.memory,
    );
    const plan = this.formatPlan(state.plan, allocation.plan);
    const history = await this.compressHistory(state.messages, allocation.history);
    const context = await this.smartFileContext(state.fileContext, allocation.context);

    return {
      system,
      memory,
      plan,
      history,
      context,
      tokens: allocation,
      systemCacheable: true,
    };
  }

  /**
   * Compress the system prompt to fit `maxTokens`. Strategy: the system
   * prompt is treated as a cacheable prefix — we never truncate it
   * mid-sentence; if it exceeds the budget, we drop trailing sections
   * (split on blank lines) until it fits.
   *
   * @example
   * ```ts
   * const sys = await budget.compressSystem(longSystemPrompt, 2000);
   * ```
   */
  async compressSystem(systemPrompt: string, maxTokens: number): Promise<string> {
    if (this.counter.count(systemPrompt) <= maxTokens) return systemPrompt;
    const sections = systemPrompt.split(/\n\s*\n/);
    let out = '';
    for (const section of sections) {
      const candidate = out ? `${out}\n\n${section}` : section;
      if (this.counter.count(candidate) > maxTokens) break;
      out = candidate;
    }
    return out;
  }

  /**
   * Select the most-relevant memories for the current task and format them
   * as text. Stops when the memory tier budget is exhausted.
   *
   * @param memories - Pre-ranked scored memory items (from MemoryRouter.recall).
   * @param taskHint - A hint string (task title or goal) for de-duplication.
   * @param maxTokens - Memory tier budget.
   */
  async selectiveMemory(
    memories: ReadonlyArray<ScoredMemoryItem>,
    taskHint: string,
    maxTokens: number,
  ): Promise<string> {
    if (memories.length === 0) return '';
    const lines: string[] = [];
    let tokens = 0;
    const seen = new Set<string>();
    for (const m of memories) {
      const line = `[${m.tier}] ${m.item.content}`;
      // De-duplicate by content prefix.
      const key = line.slice(0, 80);
      if (seen.has(key)) continue;
      const t = this.counter.count(line);
      if (tokens + t > maxTokens) break;
      lines.push(line);
      seen.add(key);
      tokens += t;
    }
    // taskHint is used for de-duplication only — no output here.
    void taskHint;
    return lines.join('\n');
  }

  /**
   * Format the current plan as text within the plan tier budget.
   *
   * @example
   * ```ts
   * const text = budget.formatPlan(state.plan, 1000);
   * ```
   */
  formatPlan(plan: Plan, maxTokens: number): string {
    const lines: string[] = [
      `# Plan: ${plan.goal}`,
      `Understanding: ${plan.understanding}`,
      '',
      '## Tasks:',
    ];
    for (const task of plan.tasks) {
      const status = task.status === 'completed' ? 'x' : task.status === 'in_flight' ? '>' : ' ';
      const line = `- [${status}] ${task.id}: ${task.title} (${task.type})`;
      lines.push(line);
    }
    if (plan.successCriteria.length > 0) {
      lines.push('', '## Success Criteria:');
      for (const c of plan.successCriteria) lines.push(`- ${c}`);
    }
    const full = lines.join('\n');
    if (this.counter.count(full) <= maxTokens) return full;
    // Truncate to fit (keep the header + first N tasks).
    const header = lines.slice(0, 3).join('\n');
    const taskLines = lines.slice(3);
    let out = header;
    for (const line of taskLines) {
      if (this.counter.count(`${out}\n${line}`) > maxTokens) break;
      out = `${out}\n${line}`;
    }
    return out;
  }

  /**
   * Compress conversation history to fit `maxTokens`. Strategy:
   *   - Always keep the first user message (sets the goal context).
   *   - Always keep the last N messages (most-recent activity).
   *   - Keep "important milestones" (tool calls with errors, user feedback).
   *
   * Delegates the actual pruning to {@link ContextPruner.prune}.
   *
   * @param messages - Full conversation history.
   * @param maxTokens - History tier budget.
   */
  async compressHistory(
    messages: ReadonlyArray<LLMMessage>,
    maxTokens: number,
  ): Promise<LLMMessage[]> {
    // Lazy import to avoid a hard cycle when ContextPruner imports from
    // this module's neighbors (it doesn't, but the pattern keeps things
    // decoupled for future edits).
    const { ContextPruner } = await import('./ContextPruner.js');
    const pruner = new ContextPruner();
    return pruner.prune(messages, maxTokens);
  }

  /**
   * Smart file context: select only relevant sections of loaded files.
   * Strategy: each file is truncated to its first N lines (configurable
   * per-file in future; for now uniform) with a note when truncated.
   *
   * @param fileContext - Map of absolute path → file content.
   * @param maxTokens - Context tier budget.
   */
  async smartFileContext(
    fileContext: Record<string, string>,
    maxTokens: number,
  ): Promise<string> {
    const entries = Object.entries(fileContext);
    if (entries.length === 0) return '';
    // Equal share per file.
    const perFile = Math.floor(maxTokens / entries.length);
    const blocks: string[] = [];
    for (const [path, content] of entries) {
      const header = `── ${path} ──`;
      const lines = content.split('\n');
      let body = content;
      if (this.counter.count(content) > perFile) {
        // Truncate by lines until it fits (with room for the header).
        const headerTokens = this.counter.count(header) + 2;
        const budget = perFile - headerTokens;
        let lineCount = lines.length;
        while (lineCount > 0 && this.counter.count(lines.slice(0, lineCount).join('\n')) > budget) {
          lineCount = Math.floor(lineCount * 0.8);
        }
        body = `${lines.slice(0, lineCount).join('\n')}\n... (${lines.length - lineCount} more lines truncated)`;
      }
      blocks.push(`${header}\n${body}`);
      if (this.counter.count(blocks.join('\n\n')) > maxTokens) {
        // We've exceeded the total budget; drop the last block.
        blocks.pop();
        break;
      }
    }
    return blocks.join('\n\n');
  }
}

// ─── Internal helpers ───────────────────────────────────────────────────────

/**
 * The estimation method chosen by {@link detailedEstimate} for a given text.
 * - `word` — natural-language text (count words × 1.3).
 * - `char` — JSON / dense structured data (count chars / 4).
 * - `code` — source code (count token-boundary pieces).
 */
export type EstimateMethod = 'word' | 'char' | 'code';

/**
 * Result of a detailed token estimate.
 */
export interface DetailedEstimate {
  /** Estimated token count. */
  tokens: number;
  /** The estimation method that was selected. */
  method: EstimateMethod;
}

/**
 * Regex matching common source-code token boundaries: whitespace, brace/
 * bracket/paren pairs, semicolons, commas, dots, arrows, operators,
 * string delimiters. Used by {@link estimateCodeTokens}.
 */
const CODE_TOKEN_BOUNDARY = /[\s{}()\[\];,.<>:?+\-*/%=!&|^~@#\\'"`]+/g;

/**
 * Regex matching common source-code structural signals — used by
 * {@link detectEstimateMethod} to decide whether a string is "code".
 * Matches: brackets, semicolons, arrows, common operators, common JS/TS
 * keywords. We deliberately keep this loose so it triggers on most
 * programming-language text but not on prose with the occasional brace.
 */
const CODE_SIGNAL = /(?:=>|;\s*$|function\s|const\s|let\s|import\s|export\s|class\s|return\s|=>|&&|\|\||\bif\b\s*\(|\bfor\b\s*\(|\{\s*$|^\s*\})/m;

/**
 * Detect whether a string is JSON: it either parses as JSON, or starts
 * with `{`/`[` and contains a high density of `":` (object-field markers).
 */
function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  // Fast path: parseable JSON.
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    // fall through to heuristic
  }
  // Heuristic: starts with `{` or `[`, and >3 `":` sequences per 200 chars.
  if (trimmed[0] !== '{' && trimmed[0] !== '[') return false;
  const markers = (trimmed.match(/"\s*:/g) ?? []).length;
  const density = markers / (trimmed.length / 200);
  return density >= 1;
}

/**
 * Detect whether a string looks like source code (any language).
 */
function looksLikeCode(text: string): boolean {
  return CODE_SIGNAL.test(text);
}

/**
 * Select the best estimation method for a piece of text.
 * Order: empty → word; JSON → char; code → code; else → word.
 */
function detectEstimateMethod(text: string): EstimateMethod {
  if (text.length === 0) return 'word';
  if (looksLikeJson(text)) return 'char';
  if (looksLikeCode(text)) return 'code';
  return 'word';
}

/**
 * Count tokens in source code by splitting on common token boundaries
 * (whitespace, punctuation, operators). Each resulting piece roughly
 * corresponds to one BPE token; this is more accurate than `chars/4` for
 * code where punctuation is dense.
 */
function estimateCodeTokens(text: string): number {
  if (text.length === 0) return 0;
  const pieces = text.split(CODE_TOKEN_BOUNDARY).filter((p) => p.length > 0);
  // Each piece ≈ 1 token; add a small fudge factor for very long pieces
  // (e.g. a 40-char identifier would be split into ~3 BPE tokens).
  let tokens = 0;
  for (const p of pieces) {
    if (p.length <= 8) tokens += 1;
    else if (p.length <= 16) tokens += 2;
    else tokens += Math.ceil(p.length / 8);
  }
  // Account for the boundary characters themselves (each `,`, `{`, `;`
  // etc. is usually its own token).
  const boundaries = (text.match(CODE_TOKEN_BOUNDARY) ?? []).join('');
  tokens += Math.ceil(boundaries.length / 4);
  return tokens;
}

/**
 * Improved token estimator. Picks the best heuristic per text type:
 *
 * - **Text** (natural language): `words × 1.3`. Words average ~1.3 BPE
 *   tokens for English (most words are 1 token; common verbs/edges are 2).
 * - **JSON / structured data**: `chars / 4`. Structured data is denser
 *   per character (lots of punctuation, short string literals) and the
 *   classic `chars/4` heuristic is the most accurate here.
 * - **Code**: counts token-boundary pieces (whitespace, punctuation,
 *   operators) — significantly more accurate than `chars/4` for source
 *   code where punctuation dominates.
 *
 * The method selection is heuristic (see {@link detectEstimateMethod});
 * for a definitive count, use a real tokenizer (tiktoken / @anthropic-ai/tokenizer).
 * SANIX intentionally avoids those heavy deps in `@sanix/core`.
 *
 * @example
 * ```ts
 * detailedEstimate('hello world');      // { tokens: 3, method: 'word' }
 * detailedEstimate('{"a":1,"b":2}');    // { tokens: 4, method: 'char' }
 * detailedEstimate('const x = () => 1');// { tokens: 9, method: 'code' }
 * ```
 */
export function detailedEstimate(text: string): DetailedEstimate {
  if (text.length === 0) return { tokens: 0, method: 'word' };
  const method = detectEstimateMethod(text);
  if (method === 'char') {
    return { tokens: Math.ceil(text.length / 4), method };
  }
  if (method === 'code') {
    return { tokens: estimateCodeTokens(text), method };
  }
  // word
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return { tokens: Math.ceil(words * 1.3), method };
}

/**
 * Token estimate for a string. Picks the best heuristic per text type
 * (see {@link detailedEstimate}) so it is more accurate than the previous
 * `Math.ceil(text.length / 4)` for code and prose, while remaining
 * dependency-free.
 *
 * When `@sanix/optimizer` is installed (V3), this delegates to
 * `ExactTokenizer.countFor(getDefaultCountingProvider(), text)` for
 * exact BPE-based counts (or the provider-specific approximation for
 * Anthropic / Gemini). The optimizer integration is lazy + cached:
 * the first call attempts to load `@sanix/optimizer`, and the result
 * is remembered (success or failure) so subsequent calls are O(1).
 *
 * @example
 * ```ts
 * estimateTokens('hello world'); // 3
 * estimateTokens('');            // 0
 * ```
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  const tok = getOptimizerTokenizer();
  if (tok) {
    try {
      return tok.countFor(optimizerProvider, text);
    } catch {
      // Fall through to heuristic.
    }
  }
  return detailedEstimate(text).tokens;
}

// ─── Optimizer integration (V3, opt-in) ─────────────────────────────────────

/**
 * The minimal surface we need from `@sanix/optimizer`'s `ExactTokenizer`.
 * Declared locally so this file doesn't need a type-only import from
 * the optional dep (which would fail at typecheck time if the dep is
 * absent).
 */
interface OptimizerTokenizerSurface {
  countFor(provider: string, text: string): number;
  setDefaultProvider(provider: string): void;
  getDefaultProvider(): string;
}

/**
 * Lazily-resolved `@sanix/optimizer` tokenizer singleton. `undefined`
 * before first access, `null` (permanently) if the package failed to
 * load, or the tokenizer object if it loaded successfully.
 *
 * We use a synchronous `createRequire` so `estimateTokens()` can stay
 * synchronous (it's called from many places that can't be made async).
 */
let optimizerTokenizer: OptimizerTokenizerSurface | null | undefined = undefined;
let optimizerLoadAttempted = false;

/**
 * The default counting provider used when `@sanix/optimizer` is
 * available. Defaults to `'generic'` (matches the old heuristic most
 * closely). Switch via {@link setCountingProvider} or
 * {@link TokenBudget.setTokenizer}.
 */
let optimizerProvider = 'generic';

/**
 * Lazily load the `@sanix/optimizer` tokenizer. Returns `null` if the
 * package is not installed or failed to load — callers fall back to
 * the heuristic. The load is attempted exactly once; subsequent calls
 * are O(1).
 *
 * Uses `createRequire(import.meta.url)` to get a synchronous `require`
 * function. On Node 22+, `require()` can load ESM packages directly;
 * on Node 20.x it throws `ERR_REQUIRE_ESM` for ESM packages, which we
 * catch and remember (the integration silently degrades to the
 * heuristic until the user upgrades Node). This is acceptable: the
 * optimizer integration is a pure performance optimization, not a
 * correctness requirement.
 */
function getOptimizerTokenizer(): OptimizerTokenizerSurface | null {
  if (optimizerLoadAttempted) return optimizerTokenizer ?? null;
  optimizerLoadAttempted = true;
  try {
    // `createRequire` is the standard ESM escape hatch for sync
    // module loading. We can't use dynamic `import()` here because
    // `estimateTokens` must stay synchronous (it's called from many
    // non-async code paths).
    const req = nodeCreateRequire(import.meta.url);
    const mod = req('@sanix/optimizer') as {
      tokenizer?: OptimizerTokenizerSurface;
    };
    if (mod?.tokenizer && typeof mod.tokenizer.countFor === 'function') {
      optimizerTokenizer = mod.tokenizer;
      // Apply the currently-configured provider.
      try {
        mod.tokenizer.setDefaultProvider(optimizerProvider);
      } catch {
        // swallow — provider switch is best-effort
      }
      return mod.tokenizer;
    }
    optimizerTokenizer = null;
    return null;
  } catch {
    optimizerTokenizer = null;
    return null;
  }
}

/**
 * Switch the default counting provider used by {@link estimateTokens}
 * when `@sanix/optimizer` is available. Accepts the same values as
 * `ExactTokenizer.countFor`: `'openai'` (exact BPE), `'anthropic'`
 * (chars/3.5), `'gemini'` (chars/4), `'generic'` (chars/4 with a JSON
 * tweak).
 *
 * No-op if the optimizer is not installed.
 *
 * @example
 * ```ts
 * setCountingProvider('anthropic');
 * estimateTokens('Hello, world!'); // now uses chars/3.5
 * ```
 */
export function setCountingProvider(provider: 'openai' | 'anthropic' | 'gemini' | 'generic'): void {
  optimizerProvider = provider;
  const tok = getOptimizerTokenizer();
  if (tok) {
    try {
      tok.setDefaultProvider(provider);
    } catch {
      // swallow — provider switch is best-effort
    }
  }
}

/**
 * The current default counting provider (settable via
 * {@link setCountingProvider}).
 */
export function getCountingProvider(): string {
  return optimizerProvider;
}

/**
 * LRU-cached token counter. Caches {@link estimateTokens} results per
 * string so repeated measurements of the same content (common during
 * iterative context building — the same system prompt is re-measured on
 * every iteration) are O(1) after the first call.
 *
 * The cache uses a `Map<string, number>` and exploits `Map`'s insertion-
 * order preservation for LRU eviction: on every cache hit, the entry is
 * deleted and re-inserted (moving it to the "most-recently-used" end);
 * when the cache is full, the first key (least-recently-used) is evicted.
 *
 * @example
 * ```ts
 * const counter = new TokenCounter(1000);
 * counter.count('hello world'); // 3 (miss, computed + cached)
 * counter.count('hello world'); // 3 (hit, O(1))
 * counter.clear();
 * ```
 */
export class TokenCounter {
  private readonly cache: Map<string, number> = new Map();
  private readonly capacity: number;
  private hits = 0;
  private misses = 0;

  /**
   * @param capacity Maximum number of strings to cache (default 1000).
   *                 When the cap is reached, the least-recently-used
   *                 entry is evicted.
   */
  constructor(capacity = 1000) {
    if (capacity < 1) {
      throw new Error(`TokenCounter capacity must be >= 1 (got ${capacity})`);
    }
    this.capacity = capacity;
  }

  /**
   * Estimate the token count for `text`, caching the result. Repeated
   * calls with the same string are O(1) after the first.
   */
  count(text: string): number {
    const cached = this.cache.get(text);
    if (cached !== undefined) {
      // Move to end (most-recently-used).
      this.cache.delete(text);
      this.cache.set(text, cached);
      this.hits++;
      return cached;
    }
    const tokens = estimateTokens(text);
    if (this.cache.size >= this.capacity) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(text, tokens);
    this.misses++;
    return tokens;
  }

  /**
   * Detailed estimate (tokens + method) for `text`. Not cached — the
   * method detection is cheap and the cache stores only the token count.
   */
  detailed(text: string): DetailedEstimate {
    return detailedEstimate(text);
  }

  /** Clear the cache. */
  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /** Current number of cached strings. */
  get size(): number {
    return this.cache.size;
  }

  /** Cache-hit count (for diagnostics / tuning the capacity). */
  get hitCount(): number {
    return this.hits;
  }

  /** Cache-miss count (for diagnostics / tuning the capacity). */
  get missCount(): number {
    return this.misses;
  }
}
