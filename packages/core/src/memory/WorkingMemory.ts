/**
 * @file memory/WorkingMemory.ts
 * @description Tier-1 memory: the in-session sliding window. Holds the last
 * N messages (default 40 per config.memory.workingWindow) with importance
 * scoring so high-signal turns survive the eviction.
 *
 * Importance scoring heuristic (spec §3):
 *   - tool calls:        +1
 *   - errors:            +2
 *   - user messages:     +3
 *   - sub-agent reports: +2
 *
 * Older turns that fall outside the window are NOT deleted immediately —
 * they're moved to a `summarizedTail` string (a stub: actual summarization
 * requires an LLM call, deferred to when the agent has a provider). This
 * keeps the working tier cheap to operate without a provider.
 *
 * @packageDocumentation
 */

import { nanoid } from 'nanoid';
import type { LLMMessage } from '@sanix/providers';
import type {
  IMemoryTier,
  MemoryItem,
  RecallQuery,
  ScoredMemoryItem,
} from './types.js';

/**
 * Coerce a message's content (string or ContentBlock[]) into a plain-text
 * string suitable for storage in working memory. Image blocks are skipped
 * (they're too large to store as text and would inflate recall scores
 * artificially).
 */
function toText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as { type?: string; text?: string };
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push(b.text);
    }
  }
  return parts.join('');
}

/** Working-memory-specific item shape (extends MemoryItem with role/turn). */
export interface WorkingMemoryItem extends MemoryItem {
  tier: 'working';
  type: 'message' | 'action' | 'observation';
  /** The original LLM message (for replay into the prompt). */
  message: LLMMessage;
  /** Monotonic turn index within the session. */
  turnIndex: number;
}

/**
 * Options for {@link WorkingMemory.constructor}.
 */
export interface WorkingMemoryOptions {
  /** Max messages to retain in the active window. */
  windowSize?: number;
  /** When true, evicted turns are appended to a `summarizedTail` string. */
  keepSummarizedTail?: boolean;
}

/**
 * Tier-1 working memory — sliding window with importance scoring.
 *
 * @example
 * ```ts
 * const wm = new WorkingMemory({ windowSize: 40 });
 * await wm.addUserMessage('Refactor the auth module');
 * await wm.addAssistantMessage({ role: 'assistant', content: 'OK' });
 * const hits = await wm.recall({ query: 'auth' });
 * ```
 */
export class WorkingMemory implements IMemoryTier {
  readonly tier = 'working' as const;

  private readonly windowSize: number;
  private readonly keepSummarizedTail: boolean;
  private readonly items: WorkingMemoryItem[] = [];
  private turnCounter = 0;
  /** Stub tail of evicted turns (actual summarization deferred to LLM). */
  summarizedTail = '';

  constructor(opts: WorkingMemoryOptions = {}) {
    this.windowSize = opts.windowSize ?? 40;
    this.keepSummarizedTail = opts.keepSummarizedTail ?? true;
  }

  /**
   * Add a raw LLM message to the window. Importance is auto-scored from the
   * message's role and content.
   *
   * @param message - The LLM message to add.
   * @param type - Sub-type (default derived from role).
   */
  async addMessage(
    message: LLMMessage,
    type?: 'message' | 'action' | 'observation',
  ): Promise<WorkingMemoryItem> {
    const itemType: WorkingMemoryItem['type'] =
      type ?? (message.role === 'assistant' && message.tool_calls
        ? 'action'
        : message.role === 'tool'
          ? 'observation'
          : 'message');

    const item: WorkingMemoryItem = {
      id: nanoid(),
      tier: 'working',
      type: itemType,
      content: toText(message.content),
      metadata: {
        role: message.role,
        toolCallCount: message.tool_calls?.length ?? 0,
      },
      createdAt: new Date().toISOString(),
      importance: this.scoreImportance(message),
      message,
      turnIndex: this.turnCounter++,
    };

    this.items.push(item);
    this.evictIfNeeded();
    return item;
  }

  /** Convenience wrapper for adding a user message. */
  async addUserMessage(content: string): Promise<WorkingMemoryItem> {
    return this.addMessage({ role: 'user', content });
  }

  /** Convenience wrapper for adding an assistant message. */
  async addAssistantMessage(message: LLMMessage): Promise<WorkingMemoryItem> {
    if (message.role !== 'assistant') {
      throw new Error(`addAssistantMessage called with role=${message.role}`);
    }
    return this.addMessage(message);
  }

  /**
   * Mark a turn as an error (bumps importance by +2 per spec). Called by the
   * Executor when a tool call fails so the failed turn survives eviction.
   */
  markError(itemId: string): boolean {
    const item = this.items.find((i) => i.id === itemId);
    if (!item) return false;
    item.importance = Math.min(1, item.importance + 0.2);
    (item.metadata as Record<string, unknown>).isError = true;
    return true;
  }

  /**
   * Store a generic MemoryItem (used by the MemoryRouter). The item must
   * have `tier === 'working'` and a `message` field on the metadata, or it
   * will be wrapped as an observation.
   */
  async store(item: MemoryItem): Promise<void> {
    if (item.tier !== 'working') return;
    const wmi: WorkingMemoryItem = {
      ...item,
      tier: 'working',
      type: (item.type === 'message' || item.type === 'action' || item.type === 'observation'
        ? item.type
        : 'observation'),
      message: (item.metadata as { message?: LLMMessage }).message ?? {
        role: 'assistant',
        content: item.content,
      },
      turnIndex: this.turnCounter++,
    };
    this.items.push(wmi);
    this.evictIfNeeded();
  }

  /**
   * Recall items matching the query. Working memory uses keyword matching
   * (no embeddings — it's the in-session tier and small enough to scan).
   */
  async recall(query: RecallQuery): Promise<ScoredMemoryItem[]> {
    const limit = query.limit ?? 20;
    const q = query.query.toLowerCase();
    const terms = q.split(/\s+/).filter((t) => t.length > 0);

    const scored = this.items.map((item) => {
      const text = item.content.toLowerCase();
      let termHits = 0;
      for (const t of terms) {
        if (text.includes(t)) termHits++;
      }
      const termScore = terms.length > 0 ? termHits / terms.length : 0.5;
      const importance = item.importance;
      const recency = 1 - (this.turnCounter - item.turnIndex) / Math.max(1, this.turnCounter);
      // Blend: 50% relevance, 30% importance, 20% recency.
      const score = 0.5 * termScore + 0.3 * importance + 0.2 * recency;
      return {
        item,
        score,
        tier: 'working' as const,
        explanation: `term=${termScore.toFixed(2)} imp=${importance.toFixed(2)} rec=${recency.toFixed(2)}`,
      };
    });

    return scored
      .filter((s) => s.score >= (query.minRelevance ?? 0))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Return the current window as raw LLM messages (for prompt assembly).
   * Order is preserved by turnIndex.
   */
  toMessages(): LLMMessage[] {
    return [...this.items]
      .sort((a, b) => a.turnIndex - b.turnIndex)
      .map((i) => i.message);
  }

  /** Number of items currently in the window. */
  get length(): number {
    return this.items.length;
  }

  /** All items in turn order (for inspection / audit). */
  all(): WorkingMemoryItem[] {
    return [...this.items].sort((a, b) => a.turnIndex - b.turnIndex);
  }

  /** Clear the window (and the summarized tail). */
  clear(): void {
    this.items.length = 0;
    this.summarizedTail = '';
    this.turnCounter = 0;
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  /**
   * Importance score 0..1 per the spec heuristic. User messages get +3,
   * errors +2, tool calls +1. Normalized to a 0..1 range.
   *
   * @example
   * ```ts
   * scoreImportance({ role: 'user', content: 'hi' });     // 0.6 (user +3 / 5)
   * scoreImportance({ role: 'assistant', content: 'ok' }); // 0.0
   * ```
   */
  private scoreImportance(message: LLMMessage): number {
    let raw = 0;
    if (message.role === 'user') raw += 3;
    if (message.role === 'tool') raw += 1;
    if (message.tool_calls && message.tool_calls.length > 0) raw += 1;
    // Errors: heuristically detect via content (real errors get a +2 bump
    // via markError() at the executor level; this is a content-based fallback).
    const looksLikeError = /error|fail|exception|traceback/i.test(toText(message.content));
    if (looksLikeError) raw += 2;
    // Normalize to 0..1 (5 is the practical max: user +3 + error +2).
    return Math.min(1, raw / 5);
  }

  /**
   * Evict the lowest-importance item if the window is over capacity. The
   * evicted item's content is appended to `summarizedTail` (a stub: actual
   * summarization requires an LLM call).
   */
  private evictIfNeeded(): void {
    while (this.items.length > this.windowSize) {
      // Find lowest-importance item, biased toward older turnIndex.
      let evictIdx = 0;
      let evictScore = Number.POSITIVE_INFINITY;
      for (let i = 0; i < this.items.length; i++) {
        const item = this.items[i]!;
        // Penalize older turns slightly so ties break toward eviction.
        const score = item.importance - 0.01 * (this.turnCounter - item.turnIndex);
        if (score < evictScore) {
          evictScore = score;
          evictIdx = i;
        }
      }
      const [evicted] = this.items.splice(evictIdx, 1);
      if (evicted && this.keepSummarizedTail) {
        const note = `[${evicted.message.role}] ${evicted.content.slice(0, 120)}`;
        this.summarizedTail = this.summarizedTail
          ? `${this.summarizedTail}\n${note}`
          : note;
      }
    }
  }
}
