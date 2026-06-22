/**
 * @file Breadcrumbs.ts
 * @description A fixed-capacity (default 50) ring buffer of breadcrumbs.
 * Breadcrumbs are lightweight events captured before an error to provide
 * context — they're attached to the next {@link ErrorEvent} emitted.
 *
 * @packageDocumentation
 */

import type { Breadcrumb, Severity } from './types.js';

/** Options for {@link Breadcrumbs}. */
export interface BreadcrumbsOptions {
  /** Max breadcrumbs to retain. Default 50. */
  maxSize?: number;
}

/**
 * A ring buffer of breadcrumbs.
 *
 * @example
 * ```ts
 * const bc = new Breadcrumbs();
 * bc.add('http', 'GET /api/users', 'info');
 * bc.snapshot(); // last ≤50 breadcrumbs
 * ```
 */
export class Breadcrumbs {
  private readonly maxSize: number;
  private readonly buffer: Breadcrumb[] = [];
  private head = 0;

  constructor(opts: BreadcrumbsOptions = {}) {
    this.maxSize = opts.maxSize ?? 50;
  }

  /**
   * Add a breadcrumb.
   *
   * @param category Category (e.g. `http`, `tool`).
   * @param message Human-readable message.
   * @param level Severity. Default `info`.
   * @param data Optional structured data.
   */
  add(category: string, message: string, level: Severity = 'info', data?: Record<string, unknown>): void {
    const entry: Breadcrumb = {
      timestamp: Date.now(),
      level,
      category,
      message,
      data,
    };
    if (this.buffer.length < this.maxSize) {
      this.buffer.push(entry);
    } else {
      this.buffer[this.head] = entry;
      this.head = (this.head + 1) % this.maxSize;
    }
  }

  /**
   * Return the breadcrumbs in chronological order (oldest first).
   */
  snapshot(): Breadcrumb[] {
    if (this.buffer.length < this.maxSize) return [...this.buffer];
    return [...this.buffer.slice(this.head), ...this.buffer.slice(0, this.head)];
  }

  /** Clear all breadcrumbs. */
  clear(): void {
    this.buffer.length = 0;
    this.head = 0;
  }

  /** Current breadcrumb count (≤ `maxSize`). */
  get size(): number {
    return this.buffer.length;
  }
}
