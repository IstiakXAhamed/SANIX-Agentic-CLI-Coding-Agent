/**
 * @file QueryHistory.ts
 * @description In-memory query history with LRU eviction.
 *
 * Every NL→SQL run is recorded as a `HistoryEntry` so the user can
 * revisit / rerun / share past queries. The store is intentionally
 * in-memory (the SANIX memory tier handles persistence); callers can
 * serialise via `toJSON()` / `fromJSON()` for cross-session retention.
 */

import { nanoid } from 'nanoid';
import type { HistoryEntry, SQLDialect } from './types.js';

/**
 * Query history store.
 *
 * @example
 * ```ts
 * const h = new QueryHistory(100);
 * const id = h.record({ question: 'top 5 customers', sql: 'SELECT ...', params: [], success: true, dialect: 'postgres' });
 * const entry = h.get(id);
 * ```
 */
export class QueryHistory {
  private readonly entries = new Map<string, HistoryEntry>();
  private readonly order: string[] = [];

  /**
   * @param maxSize Max entries to keep (LRU eviction). Default `100`.
   */
  constructor(private readonly maxSize: number = 100) {}

  /**
   * Record a query run.
   */
  public record(entry: Omit<HistoryEntry, 'id' | 'timestamp'>): string {
    const id = nanoid(12);
    const full: HistoryEntry = { ...entry, id, timestamp: new Date().toISOString() };
    this.entries.set(id, full);
    this.order.push(id);
    this.evict();
    return id;
  }

  /**
   * Update an existing entry (e.g. after execution).
   */
  public update(id: string, patch: Partial<HistoryEntry>): void {
    const existing = this.entries.get(id);
    if (!existing) return;
    this.entries.set(id, { ...existing, ...patch });
  }

  /**
   * Get a single entry.
   */
  public get(id: string): HistoryEntry | undefined {
    return this.entries.get(id);
  }

  /**
   * List entries (newest first).
   */
  public list(limit?: number): HistoryEntry[] {
    const all = [...this.order].reverse().map((id) => this.entries.get(id)!).filter(Boolean);
    return limit ? all.slice(0, limit) : all;
  }

  /**
   * Search history by question / SQL substring.
   */
  public search(query: string, limit?: number): HistoryEntry[] {
    const lower = query.toLowerCase();
    const all = this.list().filter(
      (e) => e.question.toLowerCase().includes(lower) || e.sql.toLowerCase().includes(lower),
    );
    return limit ? all.slice(0, limit) : all;
  }

  /**
   * Filter by dialect.
   */
  public byDialect(dialect: SQLDialect, limit?: number): HistoryEntry[] {
    const all = this.list().filter((e) => e.dialect === dialect);
    return limit ? all.slice(0, limit) : all;
  }

  /**
   * Filter by success.
   */
  public successful(limit?: number): HistoryEntry[] {
    const all = this.list().filter((e) => e.success);
    return limit ? all.slice(0, limit) : all;
  }

  /**
   * Remove an entry.
   */
  public remove(id: string): boolean {
    if (!this.entries.delete(id)) return false;
    const idx = this.order.indexOf(id);
    if (idx >= 0) this.order.splice(idx, 1);
    return true;
  }

  /**
   * Clear all history.
   */
  public clear(): void {
    this.entries.clear();
    this.order.length = 0;
  }

  /**
   * Number of entries.
   */
  public size(): number {
    return this.entries.size;
  }

  /**
   * Serialise to JSON.
   */
  public toJSON(): HistoryEntry[] {
    return this.list();
  }

  /**
   * Restore from JSON.
   */
  public fromJSON(entries: HistoryEntry[]): void {
    this.clear();
    for (const e of entries) {
      this.entries.set(e.id, e);
      this.order.push(e.id);
    }
    this.evict();
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  private evict(): void {
    while (this.order.length > this.maxSize) {
      const oldest = this.order.shift()!;
      this.entries.delete(oldest);
    }
  }
}
