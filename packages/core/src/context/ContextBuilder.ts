/**
 * @file context/ContextBuilder.ts
 * @description Assembles the final prompt array handed to the LLM. Uses
 * {@link TokenBudget} to allocate the model's context window across the 6
 * tiers (system / memory / plan / history / context / output) and emits a
 * `BuiltPrompt` ready for `IProvider.chat()`.
 *
 * The builder also emits prompt-cache hints: the system prompt is flagged
 * as cacheable (Anthropic prompt cache, OpenAI cached prefixes) so repeated
 * iterations reuse the cached prefix. The {@link ContextBuilder.buildCacheOptimized}
 * method extends this with explicit per-section cache metadata so provider
 * adapters know exactly where to place `cache_control` breakpoints.
 *
 * ## Optimized builds (V3)
 *
 * When `@sanix/optimizer` is installed, {@link ContextBuilder.buildOptimized}
 * applies five advanced optimizations on top of the regular build:
 *
 *   1. **Attention-weighted memory selection** — picks the most relevant
 *      memories via cosine similarity + recency + importance, instead of
 *      the default recency-ranked selection.
 *   2. **Semantic file chunking** — splits large file contents into
 *      topic-coherent chunks and selects only the most relevant ones.
 *   3. **Message consolidation** — merges adjacent tool-call pairs,
 *      dedupes system reminders, summarizes old user messages.
 *   4. **Dynamic budget reallocation** — adjusts tier allocations based
 *      on observed usage patterns (EMA-smoothed).
 *   5. **Lazy context expansion** — when a tool error or LLM signal
 *      indicates insufficient context, loads adjacent file sections,
 *      recalls more memories, or pulls in older history.
 *
 * The optimized path is fully opt-in: callers that don't invoke
 * `buildOptimized` get the exact same behavior as before. The
 * `@sanix/optimizer` dep is loaded lazily via dynamic `import()`; if
 * it's missing, `buildOptimized` falls back to the regular
 * `buildContext` path.
 *
 * @packageDocumentation
 */

import type { LLMMessage, LLMRequest, ToolDef } from '@sanix/providers';
import type { SanixConfig } from '@sanix/config';
// Type-only imports for V4 compressor integration. The caller constructs
// `LLMPromptCompressor` / `ConversationStateTracker` instances and passes
// them in via the constructor opts or setters; these type-only imports are
// erased at compile time so there's no runtime cycle. The package is
// declared as a dep in core's package.json so it resolves at type-check
// time.
import type { LLMPromptCompressor, ConversationStateTracker } from '@sanix/compressor';
import type { AgentState, Plan } from '../agent/types.js';
import type { ScoredMemoryItem } from '../memory/types.js';
import {
  TokenBudget,
  type BudgetAllocation,
  type BuiltContext,
  estimateTokens,
} from './TokenBudget.js';

/**
 * The minimal surface we use from `@sanix/optimizer`. Declared locally
 * so this file type-checks even when the optimizer dep is absent (the
 * dynamic `import()` is wrapped in try/catch at runtime).
 */
interface OptimizerSurface {
  AttentionSelector: new () => {
    select: <T extends { id: string; content: string; tokens?: number; importance?: number; timestamp?: number; metadata?: Record<string, unknown> }>(
      query: string,
      items: ReadonlyArray<T>,
      budget: number,
      weights?: { alpha?: number; beta?: number; gamma?: number; delta?: number },
    ) => Promise<T[]>;
  };
  SemanticChunker: new () => {
    chunk: (text: string, opts?: { maxTokens?: number; overlap?: number; minChunkTokens?: number }) => Promise<Array<{ text: string; tokens: number; sentences: number; startOffset: number; endOffset: number }>>;
  };
  MessageConsolidator: new () => {
    consolidate: (messages: ReadonlyArray<LLMMessage>, opts?: { maxTokens?: number; summarizer?: (texts: string[]) => Promise<string>; windowSize?: number }) => Promise<LLMMessage[]>;
  };
  DynamicBudgetReallocator: new () => {
    observe: (usage: { system: number; memory: number; plan: number; history: number; context: number; output: number }) => void;
    reallocate: (base: BudgetAllocation) => BudgetAllocation;
    reset: () => void;
    readonly count: number;
  };
  LazyContextExpander: new () => {
    shouldExpand: (signal: { type: 'tool_error' | 'llm_ambiguous' | 'llm_request_info' | 'retry'; details: string; iteration?: number }, opts?: { maxExpansions?: number; cooldownMs?: number }) => boolean;
    expand: (current: BuiltContext, signal: { type: 'tool_error' | 'llm_ambiguous' | 'llm_request_info' | 'retry'; details: string; iteration?: number }, opts?: { loadAdjacentSections?: (s: { details: string }) => Promise<string>; recallMoreMemories?: (s: { details: string }) => Promise<string>; recallOlderHistory?: (s: { details: string }) => Promise<LLMMessage[]>; maxExpansions?: number }) => Promise<BuiltContext>;
    reset: () => void;
    get totalExpansions(): number;
  };
}

// ─── V4 compressor integration (lazy, optional) ──────────────────────────────
//
// Unlike the V3 optimizer integration (which dynamic-imports the
// optimizer so it can instantiate `AttentionSelector` etc. inside
// `buildOptimized`), the V4 compressor integration receives
// pre-constructed `LLMPromptCompressor` and `ConversationStateTracker`
// instances from the caller (typically the CLI bootstrap). The caller
// has already imported `@sanix/compressor` directly, so we don't need
// a dynamic-import shim — we just type the fields with type-only
// imports (erased at compile time) and call methods on the instances
// at runtime.
//
// If `@sanix/compressor` is not installed, the caller can't construct
// the instances to pass in, so `compressor` / `stateTracker` stay
// `null` and the V4 code paths in `buildOptimized` are skipped — the
// builder behaves exactly as before.

/**
 * Lazily-resolved `@sanix/optimizer` module. Cached after first load;
 * `null` if the package is not installed.
 */
let optimizerModule: OptimizerSurface | null | undefined = undefined;
let optimizerLoadAttempted = false;

/**
 * Dynamic-import the optimizer package. Returns `null` if unavailable.
 * The result is cached so subsequent calls are O(1).
 */
async function loadOptimizer(): Promise<OptimizerSurface | null> {
  if (optimizerLoadAttempted) return optimizerModule ?? null;
  optimizerLoadAttempted = true;
  try {
    const mod = (await import('@sanix/optimizer')) as Partial<OptimizerSurface>;
    if (
      mod?.AttentionSelector &&
      mod?.SemanticChunker &&
      mod?.MessageConsolidator &&
      mod?.DynamicBudgetReallocator &&
      mod?.LazyContextExpander
    ) {
      optimizerModule = mod as OptimizerSurface;
      return optimizerModule;
    }
    optimizerModule = null;
    return null;
  } catch {
    optimizerModule = null;
    return null;
  }
}

/**
 * An expansion signal passed to {@link ContextBuilder.buildOptimized} when
 * the agent detects it needs more context. Mirrors `ExpansionSignal` from
 * `@sanix/optimizer` (re-declared locally to avoid a type-only import
 * from the optional dep).
 */
export interface OptimizedExpansionSignal {
  /** The kind of signal. */
  type: 'tool_error' | 'llm_ambiguous' | 'llm_request_info' | 'retry';
  /** Free-text details (e.g. the tool error message). */
  details: string;
  /** Iteration the signal originated from. */
  iteration?: number;
}

/**
 * Callbacks the optimized builder can invoke when expanding context.
 * Each is optional; absent callbacks simply skip that expansion
 * strategy.
 */
export interface OptimizedExpansionCallbacks {
  /** Load adjacent file sections (for tool-error signals referencing files). */
  loadAdjacentSections?: (signal: OptimizedExpansionSignal) => Promise<string>;
  /** Recall more memories (broader query). */
  recallMoreMemories?: (signal: OptimizedExpansionSignal) => Promise<string>;
  /** Recall older history messages. */
  recallOlderHistory?: (signal: OptimizedExpansionSignal) => Promise<LLMMessage[]>;
}

/**
 * Options for {@link ContextBuilder.buildOptimized}.
 */
export interface OptimizedBuildOptions {
  /**
   * The query used for attention-weighted selection (memory + file
   * chunks). Defaults to `state.currentTask?.title ?? state.goal`.
   */
  query?: string;
  /**
   * Attention-weight overrides for memory selection.
   */
  memoryWeights?: { alpha?: number; beta?: number; gamma?: number; delta?: number };
  /**
   * Max tokens per file chunk when semantic-chunking file contents.
   * Default 512.
   */
  fileChunkMaxTokens?: number;
  /**
   * Optional summarizer for the MessageConsolidator's old-user-message
   * summarization strategy. When absent, old user messages are
   * truncated (not summarized).
   */
  summarizer?: (texts: string[]) => Promise<string>;
  /**
   * Whether to apply dynamic budget reallocation. Default true. Set to
   * false to keep the base allocation unchanged (useful when the
   * reallocator hasn't observed enough samples yet).
   */
  reallocateBudget?: boolean;
  /**
   * Optional expansion signal. When provided AND the LazyContextExpander
   * decides expansion is warranted, the builder will invoke the
   * callbacks in {@link expansionCallbacks} to expand the context.
   */
  expansionSignal?: OptimizedExpansionSignal;
  /**
   * Callbacks for lazy context expansion. Only used when
   * {@link expansionSignal} is set.
   */
  expansionCallbacks?: OptimizedExpansionCallbacks;
  /**
   * Maximum number of expansions per session. Default 5.
   */
  maxExpansions?: number;
  /**
   * V4: Target compression ratio override for the final
   * `compressor.compressContext(built)` step. Only takes effect when
   * a compressor is wired on the builder. Falls back to the
   * compressor's constructor `targetRatio` when omitted.
   */
  compressionRatio?: number;
  /**
   * V4: Section-header substrings whose bodies should be preserved
   * verbatim by the compressor (e.g. `['system', 'plan']`). Only
   * takes effect when a compressor is wired. Falls back to the
   * compressor's default `preserveSections` when omitted.
   */
  compressionPreserveSections?: string[];
}

/**
 * The final assembled prompt + tool definitions ready for `IProvider.chat()`.
 */
export interface BuiltPrompt {
  /** The full message array (system + memory + plan + history + context). */
  messages: LLMMessage[];
  /** The LLMRequest to hand to the provider (messages + tools + settings). */
  request: LLMRequest;
  /** Per-tier token accounting (for the TUI ContextMeter). */
  tokens: BudgetAllocation;
  /** The built context sections (for debugging / TUI display). */
  sections: BuiltContext;
}

/**
 * Stability ranking for context sections. Lower number = more stable =
 * higher priority for a prompt-cache breakpoint. The order mirrors the
 * frequency with which each section changes between agent iterations:
 *
 *   system  (0)  — changes essentially never within a session
 *   memory  (1)  — changes only when new memories are recalled
 *   plan    (2)  — changes only on replan (every few iterations)
 *   history (3)  — grows every iteration (assistant + tool results)
 *   context (4)  — changes as files are loaded/edited
 *
 * Anthropic caps cache breakpoints at 4 per request; in practice the top
 * 3 (system / memory / plan) are the highest-value cache targets because
 * they persist across many iterations, while history / context change so
 * often that caching them yields little benefit.
 */
export type ContextSectionName = 'system' | 'memory' | 'plan' | 'history' | 'context';

/** Per-section cache metadata emitted by {@link ContextBuilder.buildCacheOptimized}. */
export interface CacheSectionMetadata {
  /** Which section this entry describes. */
  section: ContextSectionName;
  /** Whether this section should receive a `cache_control` breakpoint. */
  cacheable: boolean;
  /** Stability priority (0 = most stable = highest cache priority). */
  priority: number;
  /** Estimated token count for this section. */
  estimatedTokens: number;
  /** True if the section is non-empty (empty sections are skipped). */
  present: boolean;
}

/**
 * Result of {@link ContextBuilder.buildCacheOptimized}. Extends
 * {@link BuiltContext} with per-section cache metadata so the provider
 * adapter (Anthropic / OpenAI) knows exactly where to place
 * `cache_control` breakpoints.
 */
export interface CacheOptimizedContext extends BuiltContext {
  /** Per-section cache metadata (one entry per section, in stability order). */
  cacheSections: CacheSectionMetadata[];
  /** Ordered list of sections that should receive cache breakpoints. */
  cacheableSections: CacheSectionMetadata[];
}

/**
 * Options for {@link ContextBuilder.build}.
 */
export interface ContextBuilderOptions {
  /** Total token budget for the model's context window. */
  totalBudget: number;
  /** Tool definitions to expose to the model. */
  tools?: ToolDef[];
  /** Max output tokens (defaults to the output tier allocation). */
  maxOutputTokens?: number;
  /** Temperature override (defaults to provider default). */
  temperature?: number;
  /** Task type hint for the router. */
  taskType?: LLMRequest['taskType'];
}

/**
 * Stability ranking (lower = more stable). Used by
 * {@link ContextBuilder.buildCacheOptimized} to decide which sections
 * receive cache breakpoints.
 */
const SECTION_STABILITY: Record<ContextSectionName, number> = {
  system: 0,
  memory: 1,
  plan: 2,
  history: 3,
  context: 4,
};

/**
 * Sections that are eligible for caching by default. History and file
 * context change every iteration (or near it), so caching them provides
 * little benefit and burns breakpoints that could be used on more stable
 * sections.
 */
const DEFAULT_CACHEABLE_SECTIONS: ReadonlySet<ContextSectionName> = new Set([
  'system',
  'memory',
  'plan',
]);

/**
 * Assembles LLM prompts from agent state + budget.
 *
 * @example
 * ```ts
 * const builder = new ContextBuilder(config);
 * const built = await builder.build(state, {
 *   totalBudget: 100_000,
 *   tools: registry.enabledToolsAsDefs(),
 * });
 * const response = await provider.chat(built.request);
 * ```
 */
export class ContextBuilder {
  private readonly budget: TokenBudget;
  private readonly config: SanixConfig;
  /**
   * Per-instance dynamic budget reallocator. Shared across
   * {@link buildOptimized} calls so the EMA accumulates across
   * iterations. The AgentLoop accesses this via
   * {@link getReallocator} to call `observe()` after each iteration.
   * Lazily initialized on the first `buildOptimized` / `initOptimizer`
   * call (only when `@sanix/optimizer` is installed).
   */
  private reallocator: {
    observe: (usage: { system: number; memory: number; plan: number; history: number; context: number; output: number }) => void;
    reallocate: (base: BudgetAllocation) => BudgetAllocation;
    reset: () => void;
    readonly count: number;
  } | null = null;
  /**
   * Per-instance lazy context expander. Shared across
   * {@link buildOptimized} calls so expansion state (count, cooldown,
   * tried-strategies) persists across iterations. Lazily initialized
   * on the first `buildOptimized` / `initOptimizer` call.
   */
  private expander: {
    shouldExpand: (signal: OptimizedExpansionSignal, opts?: { maxExpansions?: number; cooldownMs?: number }) => boolean;
    expand: (current: BuiltContext, signal: OptimizedExpansionSignal, opts?: { loadAdjacentSections?: (s: OptimizedExpansionSignal) => Promise<string>; recallMoreMemories?: (s: OptimizedExpansionSignal) => Promise<string>; recallOlderHistory?: (s: OptimizedExpansionSignal) => Promise<LLMMessage[]>; maxExpansions?: number }) => Promise<BuiltContext>;
    reset: () => void;
    get totalExpansions(): number;
  } | null = null;
  /**
   * Optional V4 LLM prompt compressor. When set, {@link buildOptimized}
   * invokes `compressor.compressContext(built)` as the final step
   * before returning. Opt-in — `undefined` by default. Set via the
   * constructor opts or {@link setCompressor}.
   */
  private compressor: LLMPromptCompressor | null = null;
  /**
   * Optional V4 conversation state tracker. When set, {@link buildOptimized}
   * injects `stateTracker.summarize()` as a top-level context section
   * (prepended to the memory section so it appears before memory items
   * in the rendered prompt). Opt-in — `undefined` by default. Set via
   * the constructor opts or {@link setStateTracker}.
   */
  private stateTracker: ConversationStateTracker | null = null;

  constructor(config: SanixConfig, opts: {
    /** Optional V4 LLM prompt compressor (see {@link buildOptimized}). */
    compressor?: LLMPromptCompressor;
    /** Optional V4 conversation state tracker (see {@link buildOptimized}). */
    stateTracker?: ConversationStateTracker;
  } = {}) {
    this.config = config;
    this.budget = new TokenBudget();
    // The reallocator + expander are lazily initialized on the first
    // `buildOptimized` / `initOptimizer` call (only when the optimizer
    // is installed). This keeps the constructor cheap and avoids a
    // hard dep on `@sanix/optimizer`.
    this.compressor = opts.compressor ?? null;
    this.stateTracker = opts.stateTracker ?? null;
  }

  /**
   * Wire a V4 LLM prompt compressor. When set, {@link buildOptimized}
   * invokes `compressor.compressContext(built)` as the final step.
   * Pass `null` to disable.
   */
  setCompressor(compressor: LLMPromptCompressor | null): void {
    this.compressor = compressor;
  }

  /**
   * Wire a V4 conversation state tracker. When set, {@link buildOptimized}
   * injects `stateTracker.summarize()` as a top-level context section.
   * Pass `null` to disable.
   */
  setStateTracker(stateTracker: ConversationStateTracker | null): void {
    this.stateTracker = stateTracker;
  }

  /**
   * Get the wired V4 LLM prompt compressor (or `null` when unset).
   */
  getCompressor(): LLMPromptCompressor | null {
    return this.compressor;
  }

  /**
   * Get the wired V4 conversation state tracker (or `null` when unset).
   */
  getStateTracker(): ConversationStateTracker | null {
    return this.stateTracker;
  }

  /**
   * Build the final prompt from agent state. The system prompt is the
   * cacheable prefix; everything else is appended as user/assistant turns
   * so the model sees a coherent conversation.
   *
   * @param state - The current agent state.
   * @param opts - Build options (budget, tools, temperature, ...).
   * @param memories - Pre-ranked memory items (from MemoryRouter.recall).
   */
  async build(
    state: AgentState,
    opts: ContextBuilderOptions,
    memories: ReadonlyArray<ScoredMemoryItem> = [],
  ): Promise<BuiltPrompt> {
    const allocation = this.budget.allocate(opts.totalBudget);
    const sections = await this.budget.buildContext(state, allocation, memories);

    // Assemble the message array.
    const messages: LLMMessage[] = [];

    // System prompt (cacheable).
    const systemParts: string[] = [];
    if (sections.system) systemParts.push(sections.system);
    if (sections.memory) systemParts.push(`# Relevant Memory\n${sections.memory}`);
    if (sections.plan) systemParts.push(`# Plan\n${sections.plan}`);
    if (sections.context) systemParts.push(`# Context\n${sections.context}`);
    if (systemParts.length > 0) {
      messages.push({
        role: 'system',
        content: systemParts.join('\n\n---\n\n'),
      });
    }

    // Conversation history (already pruned to fit).
    for (const m of sections.history) {
      messages.push(m);
    }

    // Ensure the last message is a user message (some providers require it).
    if (messages.length === 0 || messages[messages.length - 1]!.role !== 'user') {
      messages.push({
        role: 'user',
        content: state.currentTask
          ? `Continue with task: ${state.currentTask.title}`
          : 'Continue.',
      });
    }

    const maxOutputTokens = opts.maxOutputTokens ?? allocation.output;
    const request: LLMRequest = {
      messages,
      tools: opts.tools,
      maxTokens: maxOutputTokens,
      temperature: opts.temperature ?? this.config.providers.configs[this.config.providers.default]?.temperature ?? 0.1,
      taskType: opts.taskType,
      systemPrompt: sections.system,
    };

    return {
      messages,
      request,
      tokens: allocation,
      sections,
    };
  }

  /**
   * Re-build the prompt with a different budget (e.g. when the agent needs
   * to retry with a smaller context). Reuses the same state + memories.
   */
  async rebuildWithBudget(
    state: AgentState,
    opts: ContextBuilderOptions,
    memories: ReadonlyArray<ScoredMemoryItem>,
    newTotalBudget: number,
  ): Promise<BuiltPrompt> {
    return this.build(state, { ...opts, totalBudget: newTotalBudget }, memories);
  }

  /**
   * Build a cache-optimized context: assemble the normal 5 sections
   * (system / memory / plan / history / context) and emit per-section
   * cache metadata so the provider adapter knows where to place
   * `cache_control` breakpoints.
   *
   * Sections are ranked by stability (system > memory > plan > history >
   * context). The most-stable sections are marked `cacheable: true`; the
   * less-stable sections (history / context) are marked `cacheable: false`
   * because they change every iteration and would burn cache breakpoints
   * for little benefit.
   *
   * Anthropic caps cache breakpoints at 4 per request — this method
   * respects that cap by only flagging the top 3 stable sections
   * (system / memory / plan) as cacheable by default.
   *
   * @param state - The current agent state.
   * @param allocation - Per-tier budget (from `TokenBudget.allocate`).
   * @param memories - Pre-ranked scored memory items (optional).
   * @returns The built context + per-section cache metadata.
   */
  async buildCacheOptimized(
    state: AgentState,
    allocation: BudgetAllocation,
    memories: ReadonlyArray<ScoredMemoryItem> = [],
  ): Promise<CacheOptimizedContext> {
    const sections = await this.budget.buildContext(state, allocation, memories);

    // Compute per-section metadata in stability order.
    const sectionTexts: Record<ContextSectionName, string> = {
      system: sections.system,
      memory: sections.memory,
      plan: sections.plan,
      history: sections.history.map((m) => m.content).join('\n'),
      context: sections.context,
    };

    const cacheSections: CacheSectionMetadata[] = (
      Object.keys(SECTION_STABILITY) as ContextSectionName[]
    ).map((section) => {
      const text = sectionTexts[section];
      const present = text.length > 0;
      return {
        section,
        cacheable: present && DEFAULT_CACHEABLE_SECTIONS.has(section),
        priority: SECTION_STABILITY[section],
        estimatedTokens: present ? estimateTokens(text) : 0,
        present,
      };
    });

    // `cacheableSections` is the ordered list (by priority) of sections
    // the adapter should attempt to mark with cache_control breakpoints.
    const cacheableSections = cacheSections
      .filter((s) => s.cacheable)
      .sort((a, b) => a.priority - b.priority);

    return {
      ...sections,
      // If at least one stable section is cacheable, flag systemCacheable
      // (preserves backward compat with the BuiltContext.systemCacheable flag).
      systemCacheable: cacheableSections.some((s) => s.section === 'system'),
      cacheSections,
      cacheableSections,
    };
  }

  /**
   * Build an optimized context using the five V3 strategies (attention-
   * weighted memory selection, semantic file chunking, message
   * consolidation, dynamic budget reallocation, lazy context expansion).
   *
   * This is the recommended context-build path for V3+ agent loops. It
   * transparently falls back to the regular {@link TokenBudget.buildContext}
   * when `@sanix/optimizer` is not installed, so callers don't need to
   * feature-detect.
   *
   * **Side effects:** The first call lazily initializes the per-builder
   * {@link DynamicBudgetReallocator} and {@link LazyContextExpander}
   * instances (so their state persists across calls). Subsequent calls
   * reuse these instances.
   *
   * @param state - The current agent state.
   * @param allocation - Base per-tier budget (will be reallocated).
   * @param memories - Pre-ranked scored memory items.
   * @param opts - Optimized-build options (query, weights, summarizer, ...).
   * @returns The optimized built context.
   *
   * @example
   * ```ts
   * const builder = new ContextBuilder(config);
   * const alloc = budget.allocate(100_000);
   * const ctx = await builder.buildOptimized(state, alloc, memories, {
   *   query: state.currentTask?.title ?? state.goal,
   *   summarizer: async (texts) => llm.summarize(texts),
   * });
   * ```
   */
  async buildOptimized(
    state: AgentState,
    allocation: BudgetAllocation,
    memories: ReadonlyArray<ScoredMemoryItem> = [],
    opts: OptimizedBuildOptions = {},
  ): Promise<BuiltContext> {
    const optimizer = await loadOptimizer();
    if (!optimizer) {
      // Optimizer unavailable — fall back to the regular path.
      return this.budget.buildContext(state, allocation, memories);
    }

    // Lazy-init the per-builder reallocator + expander.
    if (!this.reallocator) {
      this.reallocator = new optimizer.DynamicBudgetReallocator();
    }
    if (!this.expander) {
      this.expander = new optimizer.LazyContextExpander() as unknown as NonNullable<typeof this.expander>;
    }
    const reallocator = this.reallocator;
    const expander = this.expander!;

    // Step 1: Dynamic budget reallocation (if enabled and we have
    // enough observations).
    const reallocate = opts.reallocateBudget ?? true;
    const adjustedAllocation: BudgetAllocation =
      reallocate && reallocator.count >= 2
        ? reallocator.reallocate(allocation)
        : allocation;

    // Step 2: Attention-weighted memory selection. Convert scored
    // memory items to ScoreableItem shape and pick the top N that
    // fit in the memory tier budget.
    const query = opts.query ?? state.currentTask?.title ?? state.goal;
    const selector = new optimizer.AttentionSelector();
    const memoryItems = memories.map((m) => ({
      id: m.item.id,
      content: m.item.content,
      tokens: estimateTokens(m.item.content),
      importance: m.item.importance,
      timestamp: new Date(m.item.createdAt).getTime(),
      metadata: { tier: m.tier, score: m.score, ...(m.item.metadata as Record<string, unknown>) },
    }));
    const pickedMemories = await selector.select(
      query,
      memoryItems,
      adjustedAllocation.memory,
      opts.memoryWeights,
    );
    const memoryText = pickedMemories
      .map((m) => {
        const tier = (m.metadata?.tier as string) ?? 'memory';
        return `[${tier}] ${m.content}`;
      })
      .join('\n');

    // Step 3: Semantic file chunking. For each file in state.fileContext,
    // chunk it semantically and select the chunks most relevant to the
    // query (via the same AttentionSelector).
    const chunker = new optimizer.SemanticChunker();
    const fileBlocks: string[] = [];
    let contextTokensUsed = 0;
    const fileEntries = Object.entries(state.fileContext);
    const perFileBudget = Math.floor(adjustedAllocation.context / Math.max(1, fileEntries.length));
    for (const [path, content] of fileEntries) {
      const header = `── ${path} ──`;
      const chunks = await chunker.chunk(content, {
        maxTokens: opts.fileChunkMaxTokens ?? 512,
      });
      if (chunks.length === 0) continue;
      // Score each chunk by query overlap (reuse the selector).
      const chunkItems = chunks.map((c, i) => ({
        id: `${path}#${i}`,
        content: c.text,
        tokens: c.tokens,
        importance: 0.5,
        metadata: { path, offset: c.startOffset },
      }));
      const pickedChunks = await selector.select(query, chunkItems, perFileBudget);
      if (pickedChunks.length === 0) continue;
      const body = pickedChunks.map((c) => c.content).join('\n...\n');
      const block = `${header}\n${body}`;
      const blockTokens = estimateTokens(block);
      if (contextTokensUsed + blockTokens > adjustedAllocation.context) break;
      fileBlocks.push(block);
      contextTokensUsed += blockTokens;
    }
    const contextText = fileBlocks.join('\n\n');

    // Step 4: System prompt + plan (reuse the regular compression).
    const system = await this.budget.compressSystem(
      state.systemPrompt,
      adjustedAllocation.system,
    );
    const plan = this.budget.formatPlan(state.plan, adjustedAllocation.plan);

    // Step 5: Message consolidation for history.
    const consolidator = new optimizer.MessageConsolidator();
    const history = await consolidator.consolidate(state.messages, {
      maxTokens: adjustedAllocation.history,
      summarizer: opts.summarizer,
    });

    let built: BuiltContext = {
      system,
      memory: memoryText,
      plan,
      history,
      context: contextText,
      tokens: adjustedAllocation,
      systemCacheable: true,
    };

    // Step 5.5: V4 conversation state injection. If a state tracker is
    // wired, prepend its `[STATE]` block to the memory section so it
    // appears as a top-level context section before memory items in
    // the rendered prompt. The system prompt stays untouched (preserving
    // its cacheability — state changes per iteration and would
    // invalidate the system cache).
    if (this.stateTracker) {
      try {
        const stateBlock = this.stateTracker.summarize();
        if (stateBlock.length > 0) {
          built = {
            ...built,
            memory: built.memory.length > 0
              ? `${stateBlock}\n\n${built.memory}`
              : stateBlock,
          };
        }
      } catch {
        // State-tracker failures must not break the build.
      }
    }

    // Step 6: Lazy context expansion (if a signal was provided).
    if (opts.expansionSignal && expander.shouldExpand(opts.expansionSignal, { maxExpansions: opts.maxExpansions })) {
      const callbacks = opts.expansionCallbacks ?? {};
      built = await expander.expand(built, opts.expansionSignal, {
        loadAdjacentSections: callbacks.loadAdjacentSections
          ? (s) => callbacks.loadAdjacentSections!(s)
          : undefined,
        recallMoreMemories: callbacks.recallMoreMemories
          ? (s) => callbacks.recallMoreMemories!(s)
          : undefined,
        recallOlderHistory: callbacks.recallOlderHistory
          ? (s) => callbacks.recallOlderHistory!(s)
          : undefined,
        maxExpansions: opts.maxExpansions,
      });
    }

    // Step 7: V4 LLM prompt compression. If a compressor is wired,
    // run `compressor.compressContext(built)` as the final step before
    // returning. The compressor gracefully degrades when no provider
    // is configured (returns the input unchanged with `skipped: true`),
    // so this is always safe to invoke.
    if (this.compressor) {
      try {
        const compressed = await this.compressor.compressContext(built, {
          ratio: opts.compressionRatio,
          preserveSections: opts.compressionPreserveSections,
        });
        built = compressed;
      } catch {
        // Compressor failures must not break the build — return the
        // uncompressed context.
      }
    }

    return built;
  }

  /**
   * Get the per-builder {@link DynamicBudgetReallocator} (if the
   * optimizer is installed and `buildOptimized` has been called at
   * least once). The AgentLoop uses this to call `observe()` after
   * each iteration.
   *
   * Returns `null` if the optimizer isn't installed or the reallocator
   * hasn't been initialized yet (call `buildOptimized` once first).
   */
  getReallocator(): {
    observe: (usage: { system: number; memory: number; plan: number; history: number; context: number; output: number }) => void;
    reallocate: (base: BudgetAllocation) => BudgetAllocation;
    reset: () => void;
    readonly count: number;
  } | null {
    return this.reallocator;
  }

  /**
   * Get the per-builder {@link LazyContextExpander} (if the optimizer
   * is installed and `buildOptimized` has been called at least once).
   * Callers can inspect `totalExpansions` for diagnostics.
   */
  getExpander(): {
    shouldExpand: (signal: OptimizedExpansionSignal, opts?: { maxExpansions?: number; cooldownMs?: number }) => boolean;
    expand: (current: BuiltContext, signal: OptimizedExpansionSignal, opts?: { loadAdjacentSections?: (s: OptimizedExpansionSignal) => Promise<string>; recallMoreMemories?: (s: OptimizedExpansionSignal) => Promise<string>; recallOlderHistory?: (s: OptimizedExpansionSignal) => Promise<LLMMessage[]>; maxExpansions?: number }) => Promise<BuiltContext>;
    reset: () => void;
    get totalExpansions(): number;
  } | null {
    return this.expander;
  }

  /**
   * Pre-initialize the optimizer-backed reallocator + expander. Call
   * this at agent startup (before the first `buildOptimized` call) to
   * ensure `getReallocator()` returns a non-null instance for the
   * AgentLoop's `observe()` calls.
   *
   * No-op if the optimizer is not installed.
   */
  async initOptimizer(): Promise<void> {
    const optimizer = await loadOptimizer();
    if (!optimizer) return;
    if (!this.reallocator) {
      this.reallocator = new optimizer.DynamicBudgetReallocator();
    }
    if (!this.expander) {
      this.expander = new optimizer.LazyContextExpander() as unknown as NonNullable<typeof this.expander>;
    }
  }

  /**
   * Get the underlying TokenBudget instance (for advanced callers that want
   * to call `allocate` or `compressSystem` directly).
   */
  getBudget(): TokenBudget {
    return this.budget;
  }
}

/**
 * Format a plan as a compact string for the system prompt's `# Plan`
 * section. Re-exported from TokenBudget for convenience.
 *
 * @example
 * ```ts
 * const text = formatPlanForPrompt(state.plan);
 * ```
 */
export function formatPlanForPrompt(plan: Plan): string {
  const budget = new TokenBudget();
  return budget.formatPlan(plan, Number.POSITIVE_INFINITY);
}
