/**
 * @file cost/CostTracker.ts
 * @description Per-call cost accounting + aggregate summaries for SANIX.
 *
 * Every LLM call (and optionally tool call) is recorded as a
 * {@link CostEntry}; the tracker then produces a {@link CostSummary} for
 * the CLI (`sanix costs`) and the TUI's StatusBar. Entries are persisted
 * append-only to `~/.sanix/costs.jsonl` so concurrent agent processes can
 * safely write without coordination (each `record()` → `persist()` cycle
 * appends exactly one JSON line).
 *
 * Pricing is hardcoded per {@link PRICING} (per 1M tokens). Cache-aware
 * pricing is applied:
 *   - Cache-read tokens (Anthropic) are billed at ~10% of input price.
 *   - Cache-write tokens (Anthropic) are billed at ~125% of input price.
 *   - Cached tokens (OpenAI) are billed at ~50% of input price.
 *
 * `savedFromCachingUsd` estimates the savings from cache reads vs paying
 * full input price, so users can see how much the prompt cache is worth.
 *
 * @packageDocumentation
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { TokenUsage } from '@sanix/providers';

/**
 * A single cost entry — one per LLM call (or tool call). Append-only;
 * once written to the JSONL log, entries are never mutated.
 */
export interface CostEntry {
  /** Unix ms timestamp of the call. */
  timestamp: number;
  /** Provider alias (e.g. 'claude-sonnet-4', 'gpt-4o'). */
  providerId: string;
  /** Concrete model id that served the call. */
  model: string;
  /** Input (prompt) tokens billed at full input price. */
  inputTokens: number;
  /** Output (completion) tokens billed at full output price. */
  outputTokens: number;
  /** Anthropic: tokens written to the prompt cache (billed ~125%). */
  cacheCreationTokens?: number;
  /** Anthropic: tokens read from the prompt cache (billed ~10%). */
  cacheReadTokens?: number;
  /** OpenAI: tokens served from the cached prefix (billed ~50%). */
  cachedTokens?: number;
  /** Computed cost in USD for this call. */
  costUsd: number;
  /** Optional task id (for grouping by plan task). */
  taskId?: string;
  /** Optional session id (for grouping by agent session). */
  sessionId?: string;
}

/**
 * Aggregate cost summary, computed by {@link CostTracker.summarize}.
 * `byProvider` and `bySession` break the totals down per-group for the
 * CLI's `sanix costs` table.
 */
export interface CostSummary {
  /** Total cost in USD across all matching entries. */
  totalCostUsd: number;
  /** Total input tokens (excluding cache reads). */
  totalInputTokens: number;
  /** Total output tokens. */
  totalOutputTokens: number;
  /** Total Anthropic cache-read tokens. */
  totalCacheReadTokens: number;
  /** Total Anthropic cache-write tokens. */
  totalCacheCreationTokens: number;
  /**
   * Estimated USD savings from prompt caching — what the matching entries
   * *would have cost* if all cache-read tokens were billed at full input
   * price, minus what they actually cost.
   */
  savedFromCachingUsd: number;
  /** Per-provider breakdown. */
  byProvider: Record<string, { costUsd: number; calls: number; tokens: number }>;
  /** Per-session breakdown. */
  bySession: Record<string, { costUsd: number; calls: number }>;
}

/**
 * Per-provider per-1M-token pricing. All values in USD per 1,000,000 tokens.
 *
 * Convention:
 *   - `input`  — full input price.
 *   - `output` — full output price.
 *   - `cacheRead` — Anthropic: billed at ~10% of input (the cache-hit rate).
 *   - `cacheWrite` — Anthropic: billed at ~125% of input (the cache-write premium).
 *   - `cachedTokens` for OpenAI is implicit: OpenAI charges ~50% of input
 *     for cached tokens. We model this directly in {@link computeCost}.
 *
 * Local providers (Ollama, LM Studio) have all-zero pricing.
 *
 * Sources: public pricing pages as of 2025-Q2 (blended approximations).
 */
export interface ProviderPricing {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /** USD per 1M Anthropic cache-read tokens (defaults to 0.10 × input). */
  cacheRead?: number;
  /** USD per 1M Anthropic cache-write tokens (defaults to 1.25 × input). */
  cacheWrite?: number;
}

/**
 * The master pricing table. Keys are the same stable model aliases used in
 * {@link PROVIDER_CAPABILITIES}. Entries exist for all 17 providers.
 */
export const PRICING: Record<string, ProviderPricing> = {
  // ── Anthropic Claude family ────────────────────────────────────────────
  'claude-opus-4': {
    input: 15,
    output: 75,
    cacheRead: 1.5,
    cacheWrite: 18.75,
  },
  'claude-sonnet-4': {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
  },
  'claude-haiku': {
    input: 0.25,
    output: 1.25,
    cacheRead: 0.025,
    cacheWrite: 0.3125,
  },

  // ── OpenAI family ──────────────────────────────────────────────────────
  // OpenAI cached tokens are billed at ~50% of input.
  'gpt-4o': { input: 2.5, output: 10 },
  'o1': { input: 15, output: 60 },
  'o3': { input: 10, output: 40 },
  'gpt-4.1': { input: 2, output: 8 },

  // ── Google Gemini family ───────────────────────────────────────────────
  'gemini-2.5-pro': { input: 1.25, output: 10, cacheRead: 0.3125 },
  'gemini-2.0-flash': { input: 0.1, output: 0.4, cacheRead: 0.025 },

  // ── Mistral family ─────────────────────────────────────────────────────
  'mistral-large': { input: 2, output: 6 },
  'codestral': { input: 0.2, output: 0.6 },

  // ── DeepSeek family ────────────────────────────────────────────────────
  'deepseek-v3': { input: 0.27, output: 1.1, cacheRead: 0.07 },
  'deepseek-r1': { input: 0.55, output: 2.19 },

  // ── Groq-hosted models ─────────────────────────────────────────────────
  'llama-3.3-70b': { input: 0.59, output: 0.79 },
  'qwen-2.5-72b': { input: 0.79, output: 0.79 },

  // ── Local providers (all zero — no cloud billing) ──────────────────────
  'ollama-default': { input: 0, output: 0 },
  'lmstudio-default': { input: 0, output: 0 },
};

/** Sentinel returned when a providerId is missing from {@link PRICING}. */
const UNKNOWN_PRICING: ProviderPricing = { input: 1, output: 2 };

/**
 * OpenAI cached-token discount rate: cached tokens are billed at 50% of
 * the input price. (Anthropic uses its own `cacheRead` rate which is
 * typically 10% of input.)
 */
const OPENAI_CACHE_DISCOUNT = 0.5;

/** One million, used to convert per-1M-token prices to per-token. */
const PER_MILLION = 1_000_000;

/**
 * Look up the pricing for a given provider id. Returns a safe default
 * (input $1, output $2 per 1M) when the id is unknown so callers never
 * crash on an unrecognized model — but the cost will be conservative.
 */
export function getPricing(providerId: string): ProviderPricing {
  return PRICING[providerId] ?? UNKNOWN_PRICING;
}

/**
 * Compute the USD cost of a single LLM call from its usage + provider id.
 *
 * Pricing rules:
 *   - Input tokens (full price) — minus cache-read/cached tokens, which
 *     are billed at their own (discounted) rates.
 *   - Output tokens — full output price.
 *   - Anthropic cache-creation tokens — billed at the `cacheWrite` rate
 *     (~125% of input).
 *
 * @example
 * ```ts
 * const cost = computeCost('claude-sonnet-4', {
 *   inputTokens: 10000,
 *   outputTokens: 500,
 *   cacheReadTokens: 8000,
 *   cacheCreationTokens: 1000,
 * });
 * ```
 */
export function computeCost(providerId: string, usage: TokenUsage): number {
  const p = getPricing(providerId);
  const cacheReadRate = p.cacheRead ?? p.input * 0.1;
  const cacheWriteRate = p.cacheWrite ?? p.input * 1.25;

  // Anthropic splits input into: cache-write (premium) + cache-read (discount) + fresh (full).
  // OpenAI exposes a separate `cachedTokens` (50% of input) and the rest of the
  // prompt is billed at full input price.
  const cacheCreation = usage.cacheCreationTokens ?? 0;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cached = usage.cachedTokens ?? 0;
  // Fresh input = total input minus the cached/cache-read/cache-write portions.
  // We clamp at 0 in case providers double-count.
  const freshInput = Math.max(0, usage.inputTokens - cacheRead - cacheCreation - cached);

  const inputCost = (freshInput / PER_MILLION) * p.input;
  const outputCost = (usage.outputTokens / PER_MILLION) * p.output;
  const cacheWriteCost = (cacheCreation / PER_MILLION) * cacheWriteRate;
  const cacheReadCost = (cacheRead / PER_MILLION) * cacheReadRate;
  // OpenAI cached tokens are billed at 50% of input.
  const cachedCost = (cached / PER_MILLION) * p.input * OPENAI_CACHE_DISCOUNT;

  return round6(inputCost + outputCost + cacheWriteCost + cacheReadCost + cachedCost);
}

/**
 * Round to 6 decimal places (micro-USD precision). Avoids floating-point
 * noise like 0.0000000001 in the persisted JSONL.
 */
function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

/**
 * Resolve the persistence path. Defaults to `~/.sanix/costs.jsonl`; can be
 * overridden (e.g. for tests or per-project cost logs).
 */
function defaultPersistencePath(): string {
  return path.join(os.homedir(), '.sanix', 'costs.jsonl');
}

/**
 * Options for {@link CostTracker.summarize}.
 */
export interface SummarizeOptions {
  /** Only include entries at-or-after this Unix-ms timestamp. */
  since?: number;
  /** Only include entries with a matching `sessionId`. */
  sessionId?: string;
}

/**
 * Append-only cost tracker. Thread-safe across concurrent agent processes
 * (each `persist()` call appends exactly one line; there is no read-modify-
 * write cycle on the file).
 *
 * @example
 * ```ts
 * const tracker = new CostTracker();
 * await tracker.load();
 * tracker.record({
 *   timestamp: Date.now(),
 *   providerId: 'claude-sonnet-4',
 *   model: 'claude-sonnet-4-20250514',
 *   inputTokens: 1024,
 *   outputTokens: 256,
 *   costUsd: computeCost('claude-sonnet-4', { inputTokens: 1024, outputTokens: 256 }),
 *   sessionId: 'sess-abc',
 * });
 * await tracker.persist();
 * console.log(tracker.formatSummary(tracker.summarize()));
 * ```
 */
export class CostTracker {
  /** In-memory entry buffer. */
  private entries: CostEntry[] = [];
  /** Path to the JSONL persistence file. */
  private readonly persistencePath: string;
  /** True after {@link load} has been called (avoids re-loading on every persist). */
  private loaded: boolean = false;
  /** Index of the next entry to persist (entries before this are already on disk). */
  private nextPersistIndex: number = 0;

  /**
   * @param persistencePath Override the default `~/.sanix/costs.jsonl` path
   *                        (mainly for tests).
   */
  constructor(persistencePath: string = defaultPersistencePath()) {
    this.persistencePath = persistencePath;
  }

  /**
   * Record a single cost entry. The entry is pushed to the in-memory
   * buffer; call {@link persist} to flush it to disk.
   */
  record(entry: CostEntry): void {
    this.entries.push(entry);
  }

  /**
   * Summarize recorded entries, optionally filtered by `since` timestamp
   * and/or `sessionId`. Returns aggregate totals + per-provider and
   * per-session breakdowns.
   */
  summarize(opts: SummarizeOptions = {}): CostSummary {
    const since = opts.since ?? 0;
    const sessionId = opts.sessionId;
    const summary: CostSummary = {
      totalCostUsd: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      savedFromCachingUsd: 0,
      byProvider: {},
      bySession: {},
    };

    for (const e of this.entries) {
      if (e.timestamp < since) continue;
      if (sessionId !== undefined && e.sessionId !== sessionId) continue;

      summary.totalCostUsd = round6(summary.totalCostUsd + e.costUsd);
      summary.totalInputTokens += e.inputTokens;
      summary.totalOutputTokens += e.outputTokens;
      summary.totalCacheReadTokens += e.cacheReadTokens ?? 0;
      summary.totalCacheCreationTokens += e.cacheCreationTokens ?? 0;

      // Savings: cache-read tokens would have cost `cacheReadRate` (or
      // `input × 0.1`); without caching they'd cost `input` full price.
      // We compute the difference (full input − cache-read rate) × tokens.
      const p = getPricing(e.providerId);
      const cacheReadRate = p.cacheRead ?? p.input * 0.1;
      const cachedDiscount = OPENAI_CACHE_DISCOUNT;
      const cacheReadSavings =
        (e.cacheReadTokens ?? 0) / PER_MILLION * (p.input - cacheReadRate);
      const cachedSavings =
        (e.cachedTokens ?? 0) / PER_MILLION * (p.input - p.input * cachedDiscount);
      summary.savedFromCachingUsd = round6(
        summary.savedFromCachingUsd + cacheReadSavings + cachedSavings,
      );

      // Per-provider breakdown.
      const prov = summary.byProvider[e.providerId] ?? { costUsd: 0, calls: 0, tokens: 0 };
      prov.costUsd = round6(prov.costUsd + e.costUsd);
      prov.calls += 1;
      prov.tokens += e.inputTokens + e.outputTokens;
      summary.byProvider[e.providerId] = prov;

      // Per-session breakdown.
      if (e.sessionId) {
        const sess = summary.bySession[e.sessionId] ?? { costUsd: 0, calls: 0 };
        sess.costUsd = round6(sess.costUsd + e.costUsd);
        sess.calls += 1;
        summary.bySession[e.sessionId] = sess;
      }
    }

    return summary;
  }

  /**
   * Persist any not-yet-persisted entries to the JSONL file. Append-only:
   * each call writes a single line per new entry. Safe for concurrent
   * agent processes (no read-modify-write cycle).
   *
   * Errors are swallowed and re-thrown as a typed Error so callers can
   * decide whether to fail the agent run or just log.
   */
  async persist(): Promise<void> {
    if (this.nextPersistIndex >= this.entries.length) return; // nothing new
    const dir = path.dirname(this.persistencePath);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (err) {
      throw new Error(
        `CostTracker: failed to create ${dir}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    const lines: string[] = [];
    for (let i = this.nextPersistIndex; i < this.entries.length; i++) {
      lines.push(JSON.stringify(this.entries[i]));
    }
    const payload = lines.join('\n') + (lines.length > 0 ? '\n' : '');
    try {
      await fs.appendFile(this.persistencePath, payload, 'utf8');
      this.nextPersistIndex = this.entries.length;
    } catch (err) {
      throw new Error(
        `CostTracker: failed to append to ${this.persistencePath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Load historical entries from the JSONL file into the in-memory buffer.
   * Safe to call multiple times — only the first call actually reads the
   * file (subsequent calls are no-ops). Call {@link reset} first to force
   * a re-read.
   */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    let text: string;
    try {
      text = await fs.readFile(this.persistencePath, 'utf8');
    } catch (err) {
      // Missing file is fine — nothing to load.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      throw new Error(
        `CostTracker: failed to read ${this.persistencePath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    const lines = text.split('\n').filter((l) => l.length > 0);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as CostEntry;
        this.entries.push(entry);
      } catch {
        // Skip malformed lines (partial writes from a crashed process).
      }
    }
    this.nextPersistIndex = this.entries.length;
  }

  /**
   * Clear all in-memory entries and reset the loaded flag. Does NOT delete
   * the on-disk file — call this when you want a fresh in-memory view
   * (e.g. before re-loading).
   */
  reset(): void {
    this.entries = [];
    this.nextPersistIndex = 0;
    this.loaded = false;
  }

  /** Current in-memory entry count. */
  get size(): number {
    return this.entries.length;
  }

  /**
   * Format a {@link CostSummary} as a human-readable string for the CLI
   * (`sanix costs` command).
   */
  formatSummary(summary: CostSummary): string {
    const lines: string[] = [];
    lines.push('── SANIX Cost Summary ──────────────────────────────────');
    lines.push(`  Total cost:           $${summary.totalCostUsd.toFixed(6)}`);
    lines.push(`  Saved from caching:   $${summary.savedFromCachingUsd.toFixed(6)}`);
    lines.push(
      `  Input tokens:         ${summary.totalInputTokens.toLocaleString()}`,
    );
    lines.push(
      `  Output tokens:        ${summary.totalOutputTokens.toLocaleString()}`,
    );
    lines.push(
      `  Cache-read tokens:    ${summary.totalCacheReadTokens.toLocaleString()}`,
    );
    lines.push(
      `  Cache-write tokens:   ${summary.totalCacheCreationTokens.toLocaleString()}`,
    );

    const providerEntries = Object.entries(summary.byProvider).sort(
      (a, b) => b[1].costUsd - a[1].costUsd,
    );
    if (providerEntries.length > 0) {
      lines.push('');
      lines.push('── By Provider ────────────────────────────────────────');
      lines.push('  provider                calls       tokens         cost');
      for (const [id, stats] of providerEntries) {
        lines.push(
          `  ${id.padEnd(22)} ${String(stats.calls).padStart(6)}  ${stats.tokens
            .toString()
            .padStart(12)}  $${stats.costUsd.toFixed(6)}`,
        );
      }
    }

    const sessionEntries = Object.entries(summary.bySession).sort(
      (a, b) => b[1].costUsd - a[1].costUsd,
    );
    if (sessionEntries.length > 0) {
      lines.push('');
      lines.push('── By Session ─────────────────────────────────────────');
      lines.push('  session                          calls         cost');
      for (const [id, stats] of sessionEntries) {
        lines.push(
          `  ${id.padEnd(30)} ${String(stats.calls).padStart(6)}  $${stats.costUsd.toFixed(
            6,
          )}`,
        );
      }
    }

    lines.push('───────────────────────────────────────────────────────');
    return lines.join('\n');
  }
}
