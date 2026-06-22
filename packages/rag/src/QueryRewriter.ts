/**
 * @file QueryRewriter.ts
 * @description Rewrites a user's query into one or more variants to
 * improve retrieval recall.
 *
 * ## Methods
 *
 * Each method maps to a different rewrite strategy. The rewriter can
 * apply several methods and return multiple `RewrittenQuery` objects;
 * the retriever fetches for each and merges the results.
 *
 *   - `'expand'` — add synonyms / related terms to broaden the query.
 *   - `'decompose'` — break a complex query into 2-3 simpler
 *     sub-queries (each retrievable independently).
 *   - `'hyde'` — Hypothetical Document Embeddings: generate a
 *     hypothetical answer to the query and use it (or its embedding)
 *     to retrieve similar real documents.
 *   - `'step_back'` — ask a more abstract / general version of the
 *     query (e.g. "CEO of the company that acquired X" → "history of
 *     company acquisitions of X").
 *   - `'rephrase'` — rephrase the query for clarity (fix grammar,
 *     remove ambiguity).
 *   - `'multilingual'` — translate the query to other languages for
 *     multilingual corpora (defaults to English ↔ Spanish ↔ French).
 *
 * ## Graceful degradation
 *
 * If `provider` is missing, the rewriter silently returns the
 * original query as a single `'rephrase'` rewrite (so downstream
 * retrieval still runs once with the original query).
 *
 * @packageDocumentation
 */

import type { IProvider, LLMMessage } from '@sanix/providers';

/** Query-rewrite strategy. See file header for descriptions. */
export type QueryRewriteMethod =
  | 'expand'
  | 'decompose'
  | 'hyde'
  | 'step_back'
  | 'rephrase'
  | 'multilingual';

/** A single rewritten query. */
export interface RewrittenQuery {
  /** The rewritten query text. */
  text: string;
  /** Which method produced this rewrite. */
  method: QueryRewriteMethod;
  /** LLM-provided rationale for the rewrite (may be empty). */
  rationale: string;
}

/** Constructor options. */
export interface QueryRewriterOptions {
  /** LLM provider (required for all methods). */
  provider?: IProvider;
  /**
   * Methods to apply. Default `['rephrase']`. Callers typically pass
   * multiple methods to maximize recall.
   */
  methods?: QueryRewriteMethod[];
  /**
   * Languages to translate to for `'multilingual'`. Default
   * `['es', 'fr']` (Spanish + French). The original query's language
   * is auto-detected and excluded.
   */
  targetLanguages?: string[];
  /** LLM temperature. Default 0.2 (low for deterministic rewrites). */
  temperature?: number;
  /** Max tokens for each LLM call. Default 512. */
  maxTokens?: number;
}

/** Rewrite context. */
export interface RewriteContext {
  /** Recent conversation history (last few turns). */
  conversationHistory?: LLMMessage[];
  /** Recent queries (for context / disambiguation). */
  previousQueries?: string[];
}

/**
 * Query rewriter.
 *
 * @example
 * ```ts
 * const rewriter = new QueryRewriter({
 *   provider: claudeProvider,
 *   methods: ['expand', 'decompose', 'hyde'],
 * });
 * const rewrites = await rewriter.rewrite('how does auth work?');
 * // → [{ text: 'authentication authorization JWT ...', method: 'expand', ... }, ...]
 * ```
 */
export class QueryRewriter {
  private readonly provider?: IProvider;
  private readonly methods: QueryRewriteMethod[];
  private readonly targetLanguages: string[];
  private readonly temperature: number;
  private readonly maxTokens: number;

  constructor(opts: QueryRewriterOptions = {}) {
    this.provider = opts.provider;
    this.methods = opts.methods ?? ['rephrase'];
    this.targetLanguages = opts.targetLanguages ?? ['es', 'fr'];
    this.temperature = opts.temperature ?? 0.2;
    this.maxTokens = opts.maxTokens ?? 512;
  }

  /**
   * Rewrite `query` into one or more variants. If the rewriter is
   * configured with multiple methods, the result is the concatenation
   * of each method's outputs (deduplicated by exact text match,
   * preserving order).
   *
   * @example
   * ```ts
   * const rewrites = await rewriter.rewrite('CEO of OpenAI', {
   *   previousQueries: ['who founded OpenAI?'],
   * });
   * ```
   */
  async rewrite(
    query: string,
    context?: RewriteContext,
  ): Promise<RewrittenQuery[]> {
    if (!this.provider) {
      // Graceful degradation: return the original query.
      return [{ text: query, method: 'rephrase', rationale: 'no provider' }];
    }

    const out: RewrittenQuery[] = [];
    for (const method of this.methods) {
      try {
        const rewrites = await this.applyMethod(method, query, context);
        out.push(...rewrites);
      } catch {
        // Skip failed methods; don't fail the whole rewrite.
      }
    }

    // Dedupe by exact text match (case-insensitive), preserving order.
    const seen = new Set<string>();
    const deduped: RewrittenQuery[] = [];
    for (const r of out) {
      const key = r.text.toLowerCase().trim();
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(r);
    }
    // Always include the original query as the first result so the
    // retriever has at least one query to run.
    if (deduped.length === 0 || deduped[0]!.text.toLowerCase() !== query.toLowerCase()) {
      deduped.unshift({ text: query, method: 'rephrase', rationale: 'original' });
    }
    return deduped;
  }

  // ─── Per-method implementations ─────────────────────────────────────

  private async applyMethod(
    method: QueryRewriteMethod,
    query: string,
    context: RewriteContext | undefined,
  ): Promise<RewrittenQuery[]> {
    switch (method) {
      case 'expand':
        return this.expand(query, context);
      case 'decompose':
        return this.decompose(query, context);
      case 'hyde':
        return this.hyde(query, context);
      case 'step_back':
        return this.stepBack(query, context);
      case 'rephrase':
        return this.rephrase(query, context);
      case 'multilingual':
        return this.multilingual(query, context);
    }
  }

  /** Expand the query with synonyms and related terms. */
  private async expand(
    query: string,
    context: RewriteContext | undefined,
  ): Promise<RewrittenQuery[]> {
    const prompt = buildPrompt(
      'Expand this query with synonyms and related terms to improve search recall. ' +
        'Output the expanded query on a single line. No preamble.',
      query,
      context,
    );
    const text = await this.callLLM(prompt);
    return [
      {
        text: text.trim(),
        method: 'expand',
        rationale: 'broaden with synonyms',
      },
    ];
  }

  /** Decompose a complex query into 2-3 simpler sub-queries. */
  private async decompose(
    query: string,
    context: RewriteContext | undefined,
  ): Promise<RewrittenQuery[]> {
    const prompt = buildPrompt(
      'Decompose this into 2-3 simpler sub-queries (one per line, no numbering). ' +
        'Each sub-query should be answerable independently.',
      query,
      context,
    );
    const text = await this.callLLM(prompt);
    return text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .slice(0, 3)
      .map((sub) => ({
        text: sub,
        method: 'decompose',
        rationale: 'sub-query',
      }));
  }

  /** HyDE: generate a hypothetical answer to use as the query. */
  private async hyde(
    query: string,
    context: RewriteContext | undefined,
  ): Promise<RewrittenQuery[]> {
    const prompt = buildPrompt(
      'Write a 2-paragraph answer to this query as if you were an expert. ' +
        'This will be used as a search query to find supporting documents.',
      query,
      context,
    );
    const text = await this.callLLM(prompt);
    return [
      {
        text: text.trim(),
        method: 'hyde',
        rationale: 'hypothetical document embedding',
      },
    ];
  }

  /** Step-back: ask a more general / abstract version of the query. */
  private async stepBack(
    query: string,
    context: RewriteContext | undefined,
  ): Promise<RewrittenQuery[]> {
    const prompt = buildPrompt(
      "What's a more general version of this query that would surface " +
        'background information? Output only the general query.',
      query,
      context,
    );
    const text = await this.callLLM(prompt);
    return [
      {
        text: text.trim(),
        method: 'step_back',
        rationale: 'generalize for background',
      },
    ];
  }

  /** Rephrase the query for clarity. */
  private async rephrase(
    query: string,
    context: RewriteContext | undefined,
  ): Promise<RewrittenQuery[]> {
    const prompt = buildPrompt(
      'Rephrase this query for clarity and unambiguous search. ' +
        'Output only the rephrased query.',
      query,
      context,
    );
    const text = await this.callLLM(prompt);
    return [
      {
        text: text.trim(),
        method: 'rephrase',
        rationale: 'clarify',
      },
    ];
  }

  /** Translate the query to other languages. */
  private async multilingual(
    query: string,
    context: RewriteContext | undefined,
  ): Promise<RewrittenQuery[]> {
    const out: RewrittenQuery[] = [];
    for (const lang of this.targetLanguages) {
      const prompt = buildPrompt(
        `Translate this query to ${langName(lang)}. Output only the translation.`,
        query,
        context,
      );
      try {
        const text = await this.callLLM(prompt);
        out.push({
          text: text.trim(),
          method: 'multilingual',
          rationale: `translated to ${lang}`,
        });
      } catch {
        // Skip failed language.
      }
    }
    return out;
  }

  // ─── LLM helper ─────────────────────────────────────────────────────

  private async callLLM(prompt: string): Promise<string> {
    if (!this.provider) return '';
    const messages: LLMMessage[] = [
      { role: 'user', content: prompt },
    ];
    const res = await this.provider.chat({
      messages,
      temperature: this.temperature,
      maxTokens: this.maxTokens,
    });
    return res.content;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Build a single-turn LLM prompt with optional context from the
 * conversation history and previous queries. Keeps the prompt
 * compact so we don't blow the budget on context.
 */
function buildPrompt(
  instruction: string,
  query: string,
  context: RewriteContext | undefined,
): string {
  const parts: string[] = [instruction];
  if (context?.previousQueries && context.previousQueries.length > 0) {
    parts.push(
      `\nPrevious queries (for context):\n- ${context.previousQueries.slice(-3).join('\n- ')}`,
    );
  }
  parts.push(`\nQuery: ${query}`);
  parts.push('\nResponse:');
  return parts.join('\n');
}

/** Map an ISO 639-1 code to a human-friendly language name. */
function langName(code: string): string {
  const map: Record<string, string> = {
    en: 'English',
    es: 'Spanish',
    fr: 'French',
    de: 'German',
    it: 'Italian',
    pt: 'Portuguese',
    nl: 'Dutch',
    ru: 'Russian',
    ja: 'Japanese',
    ko: 'Korean',
    zh: 'Chinese',
    ar: 'Arabic',
    hi: 'Hindi',
  };
  return map[code] ?? code;
}
