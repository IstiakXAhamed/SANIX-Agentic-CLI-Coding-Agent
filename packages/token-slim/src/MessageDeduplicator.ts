/**
 * @file MessageDeduplicator.ts
 * @description Remove semantically duplicate messages from a conversation
 * history. Two messages are considered duplicates if their Jaccard token
 * similarity exceeds a configurable threshold (default 0.85). The earlier
 * occurrence is kept; later duplicates are dropped.
 *
 * This is a fast, dependency-free approximation of true semantic dedup
 * (which would require embeddings) — Jaccard over lowercased word tokens
 * catches near-verbatim repeats, the most common kind of duplicate in
 * agent loops (re-asking, re-stating, tool echo).
 *
 * @packageDocumentation
 */

import type { SlimMessage } from './types.js';

/** Tokenize a string into a Set of lowercase word tokens. */
function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (w.length > 1) out.add(w);
  }
  return out;
}

/** Jaccard similarity between two token sets. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Deduplicate a message list.
 *
 * @example
 * ```ts
 * const dedup = new MessageDeduplicator({ threshold: 0.85 });
 * const slim = dedup.dedupe(messages);
 * slim.droppedCount; // # duplicates removed
 * ```
 */
export class MessageDeduplicator {
  /** Similarity above this = duplicate. */
  readonly threshold: number;
  /** If true, only dedup within the same role. Default false. */
  readonly sameRoleOnly: boolean;

  constructor(opts: { threshold?: number; sameRoleOnly?: boolean } = {}) {
    this.threshold = opts.threshold ?? 0.85;
    this.sameRoleOnly = opts.sameRoleOnly ?? false;
  }

  /**
   * Run dedup on a message list. Returns a new array; the input is not
   * mutated. Messages are kept in original order; later duplicates are
   * dropped.
   *
   * @param messages The input messages.
   * @returns The deduplicated messages + stats.
   */
  dedupe(messages: readonly SlimMessage[]): {
    kept: SlimMessage[];
    dropped: SlimMessage[];
    droppedCount: number;
  } {
    const kept: SlimMessage[] = [];
    const dropped: SlimMessage[] = [];
    const fingerprints: Array<{ role: SlimMessage['role']; tokens: Set<string> }> = [];
    for (const msg of messages) {
      const tokens = tokenize(msg.content);
      let isDup = false;
      for (const fp of fingerprints) {
        if (this.sameRoleOnly && fp.role !== msg.role) continue;
        if (jaccard(fp.tokens, tokens) >= this.threshold) {
          isDup = true;
          break;
        }
      }
      if (isDup) {
        dropped.push(msg);
      } else {
        kept.push(msg);
        fingerprints.push({ role: msg.role, tokens });
      }
    }
    return { kept, dropped, droppedCount: dropped.length };
  }
}
