/**
 * @file memory/ProceduralMemory.ts
 * @description Tier-4 memory: learned prompt templates and tool-usage
 * patterns, stored as a JSON file at `~/.sanix/memory/procedural.json`.
 *
 * Per spec §3:
 *   - Named prompt templates learned from successful past runs.
 *   - Stores tool usage patterns, preferred approaches per task type.
 *   - Auto-extracted from sessions with high success scores.
 *
 * This is the simplest tier (no embeddings, no SQL — just JSON). Recall is
 * by exact task-type match plus keyword fallback.
 *
 * @packageDocumentation
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { nanoid } from 'nanoid';
import type {
  IMemoryTier,
  MemoryItem,
  RecallQuery,
  ScoredMemoryItem,
} from './types.js';

/**
 * A learned procedural pattern — either a prompt template or a tool-usage
 * pattern, indexed by task type.
 */
export interface ProceduralPattern {
  /** Unique id (nanoid). */
  id: string;
  /** Pattern name (human-readable). */
  name: string;
  /** Task type this pattern applies to. */
  taskType: string;
  /** The template / pattern content (text, may include placeholders). */
  template: string;
  /** Tools used in this pattern (for tool_pattern type). */
  tools: string[];
  /** Confidence score 0..1 (higher = more proven). */
  confidence: number;
  /** Number of successful runs that contributed to this pattern. */
  successCount: number;
  /** ISO timestamp the pattern was created. */
  createdAt: string;
  /** ISO timestamp the pattern was last updated. */
  updatedAt: string;
  /** Optional tags. */
  tags: string[];
}

/**
 * On-disk JSON shape.
 */
interface ProceduralStore {
  /** Schema version for forward migration. */
  version: number;
  /** All patterns. */
  patterns: ProceduralPattern[];
}

/**
 * Options for {@link ProceduralMemory.constructor}.
 */
export interface ProceduralMemoryOptions {
  /** JSON path (may use `~`). Default: `~/.sanix/memory/procedural.json`. */
  filePath?: string;
}

/**
 * Tier-4 procedural memory — JSON-backed prompt-template + tool-pattern store.
 *
 * @example
 * ```ts
 * const pm = new ProceduralMemory();
 * await pm.store({
 *   id: nanoid(),
 *   name: 'refactor-extract-function',
 *   taskType: 'code_edit',
 *   template: 'Identify the block, extract to a named function, update call sites.',
 *   tools: ['read_file', 'edit_file', 'run_tests'],
 *   confidence: 0.8,
 *   successCount: 3,
 *   createdAt: new Date().toISOString(),
 *   updatedAt: new Date().toISOString(),
 *   tags: ['refactor'],
 * });
 * const hits = await pm.recall({ query: 'refactor a function', type: 'tool_pattern' });
 * ```
 */
export class ProceduralMemory implements IMemoryTier {
  readonly tier = 'procedural' as const;

  private readonly filePath: string;
  private storeData: ProceduralStore | null = null;

  constructor(opts: ProceduralMemoryOptions = {}) {
    this.filePath = resolveHome(opts.filePath ?? '~/.sanix/memory/procedural.json');
  }

  /**
   * Store a pattern. If a pattern with the same `name` + `taskType` exists,
   * it is merged (successCount incremented, confidence averaged, template
   * replaced with the newer one).
   */
  async storePattern(pattern: ProceduralPattern): Promise<void> {
    const s = this.load();
    const existingIdx = s.patterns.findIndex(
      (p) => p.name === pattern.name && p.taskType === pattern.taskType,
    );
    if (existingIdx >= 0) {
      const existing = s.patterns[existingIdx]!;
      const merged: ProceduralPattern = {
        ...existing,
        template: pattern.template,
        tools: Array.from(new Set([...existing.tools, ...pattern.tools])),
        confidence: (existing.confidence * existing.successCount +
          pattern.confidence * pattern.successCount) /
          Math.max(1, existing.successCount + pattern.successCount),
        successCount: existing.successCount + pattern.successCount,
        updatedAt: new Date().toISOString(),
        tags: Array.from(new Set([...existing.tags, ...pattern.tags])),
      };
      s.patterns[existingIdx] = merged;
    } else {
      s.patterns.push(pattern);
    }
    this.persist(s);
  }

  /**
   * Store a MemoryItem (used by the MemoryRouter). The item must have
   * `tier === 'procedural'` and pattern fields in metadata.
   */
  async store(item: MemoryItem): Promise<void> {
    if (item.tier !== 'procedural') return;
    const m = item.metadata;
    await this.storePattern({
      id: item.id,
      name: (m.name as string) ?? `pattern-${item.id}`,
      taskType: (m.taskType as string) ?? 'general',
      template: item.content,
      tools: (m.tools as string[]) ?? [],
      confidence: typeof m.confidence === 'number' ? m.confidence : 0.5,
      successCount: typeof m.successCount === 'number' ? m.successCount : 1,
      createdAt: item.createdAt,
      updatedAt: new Date().toISOString(),
      tags: (m.tags as string[]) ?? [],
    });
  }

  /**
   * Recall patterns for a task type. Falls back to keyword search if no
   * exact taskType match is found.
   *
   * @param query - Recall query; `query.metadata?.taskType` is the primary key.
   */
  async recall(query: RecallQuery): Promise<ScoredMemoryItem[]> {
    const s = this.load();
    const limit = query.limit ?? 5;
    const q = query.query.toLowerCase();
    const terms = q.split(/\s+/).filter((t) => t.length > 0);

    const taskType =
      (query.type as string | undefined) ??
      (query as RecallQuery & { taskType?: string }).taskType;

    const scored: ScoredMemoryItem[] = s.patterns.map((p) => {
      let score = 0;
      // Task-type exact match: +0.5.
      if (taskType && p.taskType === taskType) score += 0.5;
      // Keyword overlap on template + name + tags: up to 0.3.
      const text = `${p.name} ${p.template} ${p.tags.join(' ')}`.toLowerCase();
      const hits = terms.filter((t) => text.includes(t)).length;
      score += terms.length > 0 ? 0.3 * (hits / terms.length) : 0;
      // Confidence: up to 0.2.
      score += 0.2 * p.confidence;
      return {
        item: patternToMemoryItem(p),
        score,
        tier: 'procedural',
        explanation: `taskType=${p.taskType === taskType ? 'match' : 'no'} conf=${p.confidence.toFixed(2)}`,
      };
    });

    return scored
      .filter((s) => s.score >= (query.minRelevance ?? 0))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Recall patterns by exact task type. Convenience wrapper around
   * `recall({ query, taskType })` for callers that don't want the full
   * RecallQuery shape.
   *
   * @example
   * ```ts
   * const patterns = pm.recallForTaskType('code_edit');
   * ```
   */
  recallForTaskType(taskType: string): ProceduralPattern[] {
    const s = this.load();
    return s.patterns
      .filter((p) => p.taskType === taskType)
      .sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Extract patterns from a successful session (heuristic). Called by the
   * MemoryCompressor when a session ends with success=true.
   *
   * Heuristic: if the session was successful, extract a pattern named
   * `<taskType>-extracted-<short-id>` whose template is the goal summary
   * and whose tools are the union of all tools used in the session.
   *
   * @example
   * ```ts
   * await pm.extractFromSession({
   *   success: true,
   *   goal: 'Refactor the auth module',
   *   taskType: 'code_edit',
   *   toolsUsed: ['read_file', 'edit_file', 'run_tests'],
   * });
   * ```
   */
  async extractFromSession(session: {
    success: boolean;
    goal: string;
    taskType: string;
    toolsUsed: string[];
  }): Promise<ProceduralPattern | null> {
    if (!session.success) return null;
    if (session.toolsUsed.length === 0) return null;
    const now = new Date().toISOString();
    const pattern: ProceduralPattern = {
      id: nanoid(),
      name: `${session.taskType}-extracted-${nanoid(6)}`,
      taskType: session.taskType,
      template: session.goal,
      tools: session.toolsUsed,
      confidence: 0.5,
      successCount: 1,
      createdAt: now,
      updatedAt: now,
      tags: ['auto-extracted'],
    };
    await this.storePattern(pattern);
    return pattern;
  }

  /**
   * Delete a pattern by id. Returns true if removed.
   */
  delete(id: string): boolean {
    const s = this.load();
    const before = s.patterns.length;
    s.patterns = s.patterns.filter((p) => p.id !== id);
    if (s.patterns.length !== before) {
      this.persist(s);
      return true;
    }
    return false;
  }

  /**
   * List all patterns (optionally filtered by taskType).
   */
  list(taskType?: string): ProceduralPattern[] {
    const s = this.load();
    if (taskType) return s.patterns.filter((p) => p.taskType === taskType);
    return s.patterns;
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  /** Load (and cache) the JSON store, creating it if missing. */
  private load(): ProceduralStore {
    if (this.storeData) return this.storeData;
    if (!existsSync(this.filePath)) {
      this.storeData = { version: 1, patterns: [] };
      return this.storeData;
    }
    try {
      const text = readFileSync(this.filePath, 'utf-8');
      const raw = JSON.parse(text) as unknown;
      // Validate minimally; bad files yield an empty store.
      if (
        typeof raw === 'object' &&
        raw !== null &&
        Array.isArray((raw as ProceduralStore).patterns)
      ) {
        this.storeData = raw as ProceduralStore;
      } else {
        this.storeData = { version: 1, patterns: [] };
      }
    } catch {
      this.storeData = { version: 1, patterns: [] };
    }
    return this.storeData;
  }

  /** Persist the store to disk (creating parent dirs as needed). */
  private persist(s: ProceduralStore): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(s, null, 2), 'utf-8');
    this.storeData = s;
  }
}

// ─── Internal helpers ───────────────────────────────────────────────────────

function resolveHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

function patternToMemoryItem(p: ProceduralPattern): MemoryItem {
  return {
    id: p.id,
    tier: 'procedural',
    type: 'prompt_template',
    content: p.template,
    metadata: {
      name: p.name,
      taskType: p.taskType,
      tools: p.tools,
      confidence: p.confidence,
      successCount: p.successCount,
      tags: p.tags,
    },
    createdAt: p.createdAt,
    importance: p.confidence,
  };
}
