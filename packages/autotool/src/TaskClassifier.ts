/**
 * @file TaskClassifier.ts
 * @description Classify a user prompt into one of 11 task categories using
 * keyword rules first (fast, deterministic) and an optional LLM fallback
 * for prompts that don't match any rule.
 *
 * The 11 categories and their keyword buckets:
 *   file    — read, write, edit, open, save, file, directory, path
 *   search  — search, find, grep, lookup, where, locate
 *   code    — function, class, refactor, implement, debug, compile, lint
 *   web     — fetch, http, url, website, scrape, browse
 *   shell   — run, exec, shell, bash, command, terminal
 *   memory  — remember, recall, forget, memory, note
 *   data    — parse, transform, csv, json, yaml, sql, database
 *   network — ping, dns, ip, port, socket, ssh
 *   math    — calculate, compute, sum, average, equation
 *   time    — schedule, time, date, cron, timer, now
 *   unknown — (fallback when no keywords match)
 *
 * @packageDocumentation
 */

import type { Classification, TaskCategory } from './types.js';

/** Keyword → category mapping. */
const RULES: ReadonlyArray<readonly [TaskCategory, readonly string[]]> = [
  ['file', ['read', 'write', 'edit', 'open', 'save', 'file', 'directory', 'path', 'mkdir', 'rm']],
  ['search', ['search', 'find', 'grep', 'lookup', 'where', 'locate', 'rg']],
  ['code', ['function', 'class', 'refactor', 'implement', 'debug', 'compile', 'lint', 'typescript', 'javascript', 'python']],
  ['web', ['fetch', 'http', 'url', 'website', 'scrape', 'browse', 'curl', 'request']],
  ['shell', ['run', 'exec', 'shell', 'bash', 'command', 'terminal', 'spawn']],
  ['memory', ['remember', 'recall', 'forget', 'memory', 'note', 'memo']],
  ['data', ['parse', 'transform', 'csv', 'json', 'yaml', 'sql', 'database', 'query']],
  ['network', ['ping', 'dns', 'ip', 'port', 'socket', 'ssh', 'tcp', 'udp']],
  ['math', ['calculate', 'compute', 'sum', 'average', 'equation', 'math', 'arithmetic']],
  ['time', ['schedule', 'time', 'date', 'cron', 'timer', 'now', 'timestamp']],
];

/**
 * The LLM fallback signature. Implementations should take a prompt and
 * return one of the 11 categories (or `unknown`).
 */
export type LLMFallback = (prompt: string) => Promise<TaskCategory>;

/**
 * Options for {@link TaskClassifier}.
 */
export interface TaskClassifierOptions {
  /** Optional LLM fallback for prompts that match no keyword rule. */
  llmFallback?: LLMFallback;
  /** Minimum confidence to skip the LLM fallback. Default 0.5. */
  minConfidence?: number;
}

/**
 * Classify a prompt into a task category.
 *
 * @example
 * ```ts
 * const c = new TaskClassifier();
 * const r = await c.classify('read package.json and find the deps');
 * r.category; // 'file' (first matched rule wins)
 * ```
 */
export class TaskClassifier {
  private readonly llmFallback?: LLMFallback;
  private readonly minConfidence: number;

  constructor(opts: TaskClassifierOptions = {}) {
    this.llmFallback = opts.llmFallback;
    this.minConfidence = opts.minConfidence ?? 0.5;
  }

  /**
   * Classify a prompt.
   *
   * @param prompt The user's prompt.
   * @returns The {@link Classification}.
   */
  async classify(prompt: string): Promise<Classification> {
    const lower = prompt.toLowerCase();
    const tokens = lower.match(/[a-z_]+/g) ?? [];
    const tokenSet = new Set(tokens);

    let bestCat: TaskCategory = 'unknown';
    let bestMatches: string[] = [];
    let bestScore = 0;

    for (const [cat, keywords] of RULES) {
      const matched = keywords.filter((k) => tokenSet.has(k));
      if (matched.length === 0) continue;
      const score = matched.length / Math.max(1, keywords.length);
      if (score > bestScore) {
        bestScore = score;
        bestCat = cat;
        bestMatches = matched;
      }
    }

    if (bestScore >= this.minConfidence) {
      return {
        category: bestCat,
        confidence: Math.min(1, bestScore + 0.2),
        matchedKeywords: bestMatches,
        usedFallback: false,
      };
    }

    // LLM fallback (if configured).
    if (this.llmFallback) {
      try {
        const cat = await this.llmFallback(prompt);
        return { category: cat, confidence: 0.4, matchedKeywords: bestMatches, usedFallback: true };
      } catch {
        // Fall through to keyword-based result.
      }
    }

    return {
      category: bestCat,
      confidence: bestScore,
      matchedKeywords: bestMatches,
      usedFallback: false,
    };
  }
}
