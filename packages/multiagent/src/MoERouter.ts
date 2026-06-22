/**
 * @file MoERouter.ts
 * @description Mixture-of-Experts router. Given a query and a set of
 * expert specialties, ranks the experts by relevance and returns the
 * top-K.
 *
 * Three routing methods are supported (in priority order):
 *   1. **LLM-based** (if `routerProvider` is set) — ask the LLM which
 *      domains are most relevant to the query, then match against
 *      specialties.
 *   2. **Embedding-based** (if `embed` is set) — embed the query and
 *      each domain, cosine-similarity rank.
 *   3. **Keyword matching** (default) — score by overlap between query
 *      tokens and specialty domains.
 *
 * @packageDocumentation
 */

import type { IProvider, LLMMessage, LLMRequest } from '@sanix/providers';
import type { MoESpecialty } from './types.js';

/** Options for {@link MoERouter.constructor}. */
export interface MoERouterOptions {
  /**
   * LLM provider for LLM-based routing. If set, the router asks the LLM
   * to rank domains by relevance; otherwise falls back to embedding or
   * keyword matching.
   */
  routerProvider?: IProvider;
  /**
   * Embedding function for embedding-based routing. If set (and no
   * `routerProvider`), the router embeds the query and each domain,
   * then cosine-similarity ranks them.
   */
  embed?: (text: string) => Promise<number[]>;
  /** Number of experts to return (default 1; 3 for collaborative MoE). */
  topK?: number;
}

/** A routing result — a member id and its relevance score (0..1). */
export interface RoutingResult {
  /** Member id. */
  memberId: string;
  /** Relevance score (0..1, normalized so the top expert scores 1). */
  score: number;
}

/**
 * Routes a query to the most relevant expert(s).
 *
 * @example
 * ```ts
 * const router = new MoERouter(
 *   [
 *     { memberId: 'coder', domains: ['code', 'typescript', 'debugging'], weight: 1 },
 *     { memberId: 'writer', domains: ['writing', 'docs', 'creative'], weight: 1 },
 *   ],
 *   { topK: 1 },
 * );
 * const experts = await router.route('How do I fix this TypeScript error?');
 * console.log(experts[0]?.memberId); // 'coder'
 * ```
 */
export class MoERouter {
  private readonly specialties: MoESpecialty[];
  private readonly routerProvider?: IProvider;
  private readonly embed?: (text: string) => Promise<number[]>;
  private readonly topK: number;

  /**
   * @param specialties - The expert specialties (one per expert member).
   * @param opts        - Optional routerProvider / embed / topK.
   */
  constructor(specialties: MoESpecialty[], opts: MoERouterOptions = {}) {
    if (specialties.length === 0) {
      throw new Error('MoERouter requires at least one specialty');
    }
    this.specialties = specialties;
    this.routerProvider = opts.routerProvider;
    this.embed = opts.embed;
    this.topK = opts.topK ?? 1;
  }

  /**
   * Route a query to the top-K experts.
   *
   * @param query - The query / problem to route.
   * @returns Ranked list of `{ memberId, score }`, length ≤ topK.
   */
  async route(query: string): Promise<RoutingResult[]> {
    let scores: Array<{ memberId: string; raw: number }>;
    if (this.routerProvider) {
      scores = await this.routeViaLLM(query);
    } else if (this.embed) {
      scores = await this.routeViaEmbeddings(query);
    } else {
      scores = this.routeViaKeywords(query);
    }

    // Apply specialty weights.
    const weighted = scores.map((s) => {
      const spec = this.specialties.find((sp) => sp.memberId === s.memberId);
      const weight = spec?.weight ?? 1;
      return { memberId: s.memberId, raw: s.raw * weight };
    });

    // Sort descending, take top-K, normalize to 0..1.
    weighted.sort((a, b) => b.raw - a.raw);
    const top = weighted.slice(0, this.topK);
    if (top.length === 0) return [];
    const max = top[0]!.raw;
    const minRaw = top[top.length - 1]!.raw;
    return top.map((t) => ({
      memberId: t.memberId,
      score: max > 0 ? (t.raw - (minRaw < 0 ? minRaw : 0)) / (max - (minRaw < 0 ? minRaw : 0) || 1) : 0,
    }));
  }

  // ─── Routing methods ────────────────────────────────────────────────────

  /**
   * LLM-based routing: ask the LLM to rank domains by relevance to the
   * query, then map ranked domains back to experts.
   */
  private async routeViaLLM(query: string): Promise<Array<{ memberId: string; raw: number }>> {
    const allDomains = this.uniqueDomains();
    const messages: LLMMessage[] = [
      {
        role: 'system',
        content:
          'You are a Mixture-of-Experts router. Given a query, rank the available expert domains by relevance. ' +
          'Respond with a JSON object mapping each domain to a relevance score from 0.0 to 1.0. ' +
          'Example: {"code": 0.9, "writing": 0.1}',
      },
      {
        role: 'user',
        content: `Query: ${query}\n\nAvailable domains: ${allDomains.join(', ')}\n\nReturn JSON only.`,
      },
    ];
    const req: LLMRequest = {
      messages,
      maxTokens: 256,
      temperature: 0,
      taskType: 'fast_lookup',
    };
    try {
      const res = await this.routerProvider!.chat(req);
      const parsed = parseDomainScores(res.content, allDomains);
      return this.specialties.map((sp) => {
        const score = sp.domains.reduce((s, d) => s + (parsed[d] ?? 0), 0) / Math.max(1, sp.domains.length);
        return { memberId: sp.memberId, raw: score };
      });
    } catch {
      // LLM failed — fall back to keyword matching.
      return this.routeViaKeywords(query);
    }
  }

  /**
   * Embedding-based routing: embed the query and each domain, cosine-
   * similarity rank.
   */
  private async routeViaEmbeddings(
    query: string,
  ): Promise<Array<{ memberId: string; raw: number }>> {
    try {
      const queryVec = await this.embed!(query);
      const results: Array<{ memberId: string; raw: number }> = [];
      for (const sp of this.specialties) {
        let bestSim = 0;
        for (const domain of sp.domains) {
          const domainVec = await this.embed!(domain);
          const sim = cosineSim(queryVec, domainVec);
          if (sim > bestSim) bestSim = sim;
        }
        results.push({ memberId: sp.memberId, raw: bestSim });
      }
      return results;
    } catch {
      return this.routeViaKeywords(query);
    }
  }

  /**
   * Keyword matching (default): score by overlap between query tokens
   * and specialty domains. Each domain that appears as a token in the
   * query contributes 1 / num_domains to that expert's score.
   */
  private routeViaKeywords(query: string): Array<{ memberId: string; raw: number }> {
    const queryTokens = new Set(tokenize(query));
    const results: Array<{ memberId: string; raw: number }> = [];
    for (const sp of this.specialties) {
      let hits = 0;
      for (const domain of sp.domains) {
        const domainTokens = tokenize(domain);
        for (const dt of domainTokens) {
          if (queryTokens.has(dt)) {
            hits++;
            break; // count each domain at most once
          }
        }
      }
      const score = sp.domains.length > 0 ? hits / sp.domains.length : 0;
      results.push({ memberId: sp.memberId, raw: score });
    }
    return results;
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  /**
   * The deduplicated set of all domains across all specialties.
   */
  private uniqueDomains(): string[] {
    const set = new Set<string>();
    for (const sp of this.specialties) {
      for (const d of sp.domains) set.add(d);
    }
    return [...set];
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Parse the LLM's domain-score response. Accepts either a JSON object
 * or a markdown-fenced JSON block. Unknown domains are ignored; missing
 * domains default to 0.
 */
function parseDomainScores(
  text: string,
  knownDomains: string[],
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const d of knownDomains) result[d] = 0;

  const jsonText = extractJson(text);
  if (!jsonText) return result;
  try {
    const raw = JSON.parse(jsonText) as unknown;
    if (typeof raw !== 'object' || raw === null) return result;
    const obj = raw as Record<string, unknown>;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'number' && k in result) {
        result[k] = clamp01(v);
      } else if (typeof v === 'string') {
        const n = Number(v);
        if (Number.isFinite(n) && k in result) result[k] = clamp01(n);
      }
    }
  } catch {
    // ignore — return defaults
  }
  return result;
}

/**
 * Extract the first JSON object from a string (handles ```json fences).
 */
function extractJson(text: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced && fenced[1]) return fenced[1].trim();
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Tokenize a string into lowercase alphanumeric words.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/**
 * Cosine similarity between two equal-length numeric vectors.
 */
function cosineSim(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Clamp a number to the 0..1 range. */
function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
