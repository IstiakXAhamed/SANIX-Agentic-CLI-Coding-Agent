/**
 * @file memory-v2/src/EpisodicExtractor.ts
 * @description Mines episodic memories (session records) for reusable
 * semantic facts, deduplicates them against existing facts, and emits
 * `ExtractedFact[]` ready for storage in the semantic tier.
 *
 * ## Algorithm
 *
 *   1. Take the session's goal + lessons learned + tool calls.
 *   2. If `llmCallback` is provided, prompt the LLM to extract factual
 *      statements in a structured JSON shape:
 *      `[{ "content": "...", "confidence": 0..1, "evidence": "..." }]`.
 *   3. If `llmCallback` is absent (or fails), fall back to heuristic
 *      regex-based extraction — recognize "X is Y", "Use Z for W",
 *      "Pattern P applies to T" patterns in lessons and goal text.
 *   4. Deduplicate the extracted facts against `existingFacts` (via
 *      {@link SemanticDeduplicator}) — duplicates are dropped.
 *   5. Return the surviving facts as `ExtractedFact[]`.
 *
 * The caller (typically {@link MemoryCompactor}) is responsible for
 * storing the facts in the semantic tier.
 *
 * @packageDocumentation
 */

import type { MemoryItem } from './types.js';
import {
  SemanticDeduplicator,
  type EmbedProvider,
} from './SemanticDeduplicator.js';

/** A session record passed to the extractor. */
export interface SessionRecord {
  /** Unique session id. */
  id: string;
  /** The session's goal. */
  goal: string;
  /** Lessons learned (free-text strings). */
  lessons: string[];
  /** Tool calls made during the session. */
  toolCalls: ReadonlyArray<{
    name: string;
    args?: unknown;
    success?: boolean;
  }>;
  /** True if the session ended successfully. */
  success: boolean;
  /** ISO timestamp the session started. */
  startedAt: string;
  /** ISO timestamp the session ended. */
  endedAt: string;
}

/** A single extracted fact ready for semantic storage. */
export interface ExtractedFact {
  /** The factual statement (e.g. "JWT auth uses 24h tokens"). */
  content: string;
  /** Confidence 0..1. */
  confidence: number;
  /** Source session id. */
  source: string;
  /** Evidence supporting the fact (e.g. "lesson", "tool_call:write_file"). */
  evidence: string;
}

/** Options for `extract()`. */
export interface ExtractOptions {
  /**
   * Optional LLM callback. Receives a prompt and returns the model's
   * text response. The response should be JSON-parseable into an
   * array of `{ content, confidence?, evidence? }` objects. If the
   * callback throws or returns unparseable output, the heuristic
   * extractor is used as a fallback.
   */
  llmCallback?: (prompt: string) => Promise<string>;
  /** Existing semantic facts to deduplicate against. */
  existingFacts?: ReadonlyArray<MemoryItem>;
  /** Optional embedding provider for similarity-based dedup. */
  embeddingProvider?: EmbedProvider;
  /** Cosine similarity threshold for "duplicate" facts. Default 0.92. */
  dedupThreshold?: number;
}

/** Constructor options. */
export interface EpisodicExtractorOptions {
  /** Override the default deduplicator. */
  deduplicator?: SemanticDeduplicator;
}

/**
 * Episodic → semantic fact extractor.
 *
 * @example
 * ```ts
 * const extractor = new EpisodicExtractor();
 * const facts = await extractor.extract(session, {
 *   llmCallback: (prompt) => provider.chat({ messages: [{role:'user', content: prompt}] }).then(r => r.content),
 *   existingFacts: await fetchAllSemanticFacts(),
 * });
 * for (const f of facts) {
 *   await memoryRouter.store({
 *     id: nanoid(),
 *     tier: 'semantic',
 *     type: 'fact',
 *     content: f.content,
 *     metadata: { confidence: f.confidence, source: f.source },
 *     createdAt: new Date().toISOString(),
 *     importance: f.confidence,
 *   });
 * }
 * ```
 */
export class EpisodicExtractor {
  private readonly deduplicator: SemanticDeduplicator;

  constructor(opts: EpisodicExtractorOptions = {}) {
    this.deduplicator = opts.deduplicator ?? new SemanticDeduplicator();
  }

  /**
   * Extract reusable facts from a session record.
   *
   * @param session - The session to mine.
   * @param opts    - Options (LLM callback, existing facts, ...).
   * @returns Array of extracted, deduplicated facts.
   *
   * @example
   * ```ts
   * const facts = await extractor.extract(session, { llmCallback });
   * console.log(`Extracted ${facts.length} new facts.`);
   * ```
   */
  async extract(
    session: SessionRecord,
    opts: ExtractOptions = {},
  ): Promise<ExtractedFact[]> {
    let facts: ExtractedFact[] = [];

    // Step 1: LLM-based extraction (if callback provided).
    if (opts.llmCallback) {
      try {
        const prompt = this.buildPrompt(session);
        const response = await opts.llmCallback(prompt);
        facts = this.parseLlmResponse(response, session.id);
      } catch {
        // Fall back to heuristic.
        facts = [];
      }
    }

    // Step 2: Heuristic extraction (always runs as a fallback / supplement).
    if (facts.length === 0) {
      facts = this.heuristicExtract(session);
    }

    if (facts.length === 0) return [];

    // Step 3: Deduplicate against existing facts.
    if (opts.existingFacts && opts.existingFacts.length > 0) {
      const candidateItems: MemoryItem[] = facts.map((f) => factToMemoryItem(f, session));
      const all = [...opts.existingFacts, ...candidateItems];
      const result = this.deduplicator.deduplicate(all, opts.dedupThreshold ?? 0.92);
      // Keep only items whose id starts with the candidate prefix
      // (i.e. were just extracted, not pre-existing).
      const kept = result.kept.filter((m) => m.metadata.__extracted === true);
      return kept.map((m) => memoryItemToFact(m, session.id));
    }

    return facts;
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  /**
   * Build the LLM extraction prompt. Asks the model to return a JSON
   * array of factual statements.
   */
  private buildPrompt(session: SessionRecord): string {
    const toolSummary = session.toolCalls
      .map((c) => `- ${c.name}${c.success === false ? ' (failed)' : ''}`)
      .join('\n');
    const lessonsText = session.lessons.map((l) => `- ${l}`).join('\n');
    return `You are a memory-extraction assistant. Read the following session record and extract reusable factual statements.

Session goal: ${session.goal}

Lessons learned:
${lessonsText || '(none)'}

Tool calls:
${toolSummary || '(none)'}

Extract facts in one of these forms:
- "X is Y" (definitions)
- "To do Z, use tool W" (procedural)
- "Pattern P applies to task T" (patterns)

Return ONLY a JSON array, no prose. Each element: { "content": "...", "confidence": 0..1, "evidence": "..." }

JSON:`;
  }

  /**
   * Parse the LLM's response into `ExtractedFact[]`. Tolerates markdown
   * fences, leading prose, and partial JSON. On any parse failure,
   * returns an empty array (the heuristic extractor will fill in).
   */
  private parseLlmResponse(response: string, sessionId: string): ExtractedFact[] {
    const jsonText = extractJsonArray(response);
    if (!jsonText) return [];
    try {
      const raw = JSON.parse(jsonText) as unknown;
      if (!Array.isArray(raw)) return [];
      const facts: ExtractedFact[] = [];
      for (const item of raw) {
        if (typeof item !== 'object' || item === null) continue;
        const obj = item as Record<string, unknown>;
        if (typeof obj.content !== 'string') continue;
        facts.push({
          content: obj.content,
          confidence: typeof obj.confidence === 'number'
            ? Math.max(0, Math.min(1, obj.confidence))
            : 0.6,
          source: sessionId,
          evidence: typeof obj.evidence === 'string' ? obj.evidence : 'llm',
        });
      }
      return facts;
    } catch {
      return [];
    }
  }

  /**
   * Heuristic extraction when no LLM is available. Scans lessons and
   * tool calls for the three target patterns:
   *   - "X is Y"
   *   - "Use Z for W" / "To do Z, use W"
   *   - "Pattern P applies to task T"
   *
   * Each lesson is also emitted as a low-confidence fact (lessons are
   * already fact-shaped by convention).
   */
  private heuristicExtract(session: SessionRecord): ExtractedFact[] {
    const facts: ExtractedFact[] = [];

    // Pass 1: lessons are treated as fact-shaped statements.
    for (const lesson of session.lessons) {
      const trimmed = lesson.trim();
      if (trimmed.length === 0) continue;
      // Pattern: "X is Y"
      const isMatch = /^(.+?)\s+is\s+(.+?)[.!?]?$/i.exec(trimmed);
      if (isMatch) {
        facts.push({
          content: `${isMatch[1]} is ${isMatch[2]}`.replace(/[.!?]?$/, ''),
          confidence: 0.7,
          source: session.id,
          evidence: 'lesson:is-pattern',
        });
        continue;
      }
      // Pattern: "Use Z for W" / "To do Z, use W"
      const useMatch = /^(?:use\s+(.+?)\s+for\s+(.+?)|to\s+(.+?),\s+use\s+(.+?))[.!?]?$/i.exec(trimmed);
      if (useMatch) {
        const tool = useMatch[1] ?? useMatch[4];
        const task = useMatch[2] ?? useMatch[3];
        if (tool && task) {
          facts.push({
            content: `To ${task}, use ${tool}`,
            confidence: 0.7,
            source: session.id,
            evidence: 'lesson:use-pattern',
          });
          continue;
        }
      }
      // Pattern: "Pattern P applies to task T"
      const patternMatch = /^pattern\s+(.+?)\s+applies\s+to\s+(?:task\s+)?(.+?)[.!?]?$/i.exec(trimmed);
      if (patternMatch) {
        facts.push({
          content: `Pattern ${patternMatch[1]} applies to task ${patternMatch[2]}`.replace(/[.!?]?$/, ''),
          confidence: 0.65,
          source: session.id,
          evidence: 'lesson:pattern-pattern',
        });
        continue;
      }
      // Fallback: emit the lesson verbatim at lower confidence.
      facts.push({
        content: trimmed,
        confidence: 0.5,
        source: session.id,
        evidence: 'lesson',
      });
    }

    // Pass 2: successful tool calls → "To do <goal>, use <tool>".
    if (session.success) {
      const successfulTools = new Set<string>();
      for (const c of session.toolCalls) {
        if (c.success !== false) successfulTools.add(c.name);
      }
      for (const tool of successfulTools) {
        facts.push({
          content: `To ${session.goal.toLowerCase().replace(/[.!?]?$/, '')}, use ${tool}`,
          confidence: 0.5,
          source: session.id,
          evidence: `tool_call:${tool}`,
        });
      }
    }

    return facts;
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────

/**
 * Extract the first JSON array from a model response. Strips ``` fences
 * and tolerates leading prose.
 */
function extractJsonArray(text: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced && fenced[1]) {
    const trimmed = fenced[1].trim();
    if (trimmed.startsWith('[')) return trimmed;
  }
  const start = text.indexOf('[');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Convert an `ExtractedFact` to a `MemoryItem` (with a marker for dedup). */
function factToMemoryItem(fact: ExtractedFact, session: SessionRecord): MemoryItem {
  return {
    id: `ext-${session.id}-${Math.random().toString(36).slice(2, 10)}`,
    tier: 'semantic',
    type: 'fact',
    content: fact.content,
    metadata: {
      confidence: fact.confidence,
      sessionId: session.id,
      source: fact.source,
      evidence: fact.evidence,
      __extracted: true,
    },
    createdAt: session.endedAt || new Date().toISOString(),
    importance: fact.confidence,
  };
}

/** Convert a `MemoryItem` back to an `ExtractedFact`. */
function memoryItemToFact(item: MemoryItem, defaultSource: string): ExtractedFact {
  return {
    content: item.content,
    confidence: typeof item.metadata.confidence === 'number' ? item.metadata.confidence : 0.6,
    source: typeof item.metadata.source === 'string' ? item.metadata.source : defaultSource,
    evidence: typeof item.metadata.evidence === 'string' ? item.metadata.evidence : 'unknown',
  };
}
