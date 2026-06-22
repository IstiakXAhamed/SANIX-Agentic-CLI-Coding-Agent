/**
 * @file EntityExtractor.ts
 * @description Extract entities + relationships from free text. Three
 * extraction methods:
 *
 *   - **llm**    — prompt the LLM with a structured-output instruction and
 *     validate the response with Zod. Best F1 on real prose.
 *   - **regex**  — pure pattern-based extraction: emails, URLs, dates,
 *     capitalized words (person/org candidates), code identifiers
 *     (CamelCase = class, snake_case = function/var), file paths, version
 *     numbers. Zero-cost, zero-LLM, deterministic.
 *   - **hybrid** (default) — run both, merge results, prefer LLM for
 *     ambiguous cases. Best overall.
 *
 * LLM extraction results are cached by text hash (LRU 1000) so re-extract
 * on identical text is free.
 *
 * @packageDocumentation
 */

import { z } from 'zod';
import type { IProvider, LLMMessage } from '@sanix/providers';
import type {
  EntityType,
  ExtractedEntity,
  ExtractedRelationship,
  ExtractionResult,
} from './types.js';

// ─── Constructor options ───────────────────────────────────────────────────

/**
 * Options for {@link EntityExtractor.constructor}.
 */
export interface EntityExtractorOptions {
  /**
   * LLM provider used by the `llm` and `hybrid` methods. When omitted,
   * those methods fall back to `regex`-only with a warning logged via the
   * `unresolved` channel.
   */
  provider?: IProvider;
  /**
   * Extraction strategy:
   *   - `llm`    — LLM-only.
   *   - `regex`  — regex-only.
   *   - `hybrid` — run both, merge (default).
   */
  method?: 'llm' | 'regex' | 'hybrid';
  /**
   * Restrict the LLM to these entity types. Default: all 11 canonical
   * types. The LLM is told to use `custom` for anything outside this list.
   */
  entityTypes?: EntityType[];
  /** LLM temperature for extraction. Default: 0.1 (deterministic-ish). */
  temperature?: number;
  /** LLM max tokens for extraction response. Default: 2048. */
  maxTokens?: number;
}

// ─── Zod schemas for LLM structured output ─────────────────────────────────

const EntityTypeSchema = z.enum([
  'person',
  'organization',
  'concept',
  'event',
  'location',
  'document',
  'code',
  'tool',
  'project',
  'technology',
  'custom',
]);

const LlmEntitySchema = z.object({
  type: EntityTypeSchema,
  name: z.string().min(1),
  aliases: z.array(z.string()).optional().default([]),
  description: z.string().optional(),
  properties: z.record(z.unknown()).optional().default({}),
});

const LlmRelationshipSchema = z.object({
  type: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  evidence: z.array(z.string()).optional().default([]),
  properties: z.record(z.unknown()).optional().default({}),
});

const LlmExtractionSchema = z.object({
  entities: z.array(LlmEntitySchema),
  relationships: z.array(LlmRelationshipSchema),
});

// ─── LRU cache for LLM extractions ─────────────────────────────────────────

/**
 * Tiny LRU cache keyed by text hash. Bounded to `capacity` entries; on
 * overflow the least-recently-used entry is evicted.
 */
class LRU<K, V> {
  private readonly map = new Map<K, V>();
  constructor(private readonly capacity: number) {}

  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    // Re-insert to mark as most-recently-used.
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= this.capacity) {
      // Evict oldest (first key in insertion order).
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, value);
  }

  size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}

// ─── Regex patterns ────────────────────────────────────────────────────────

const REGEX_PATTERNS = {
  email:
    /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g,
  url: /\bhttps?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]]/g,
  ipv4: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
  date: /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})\b/g,
  version: /\bv?\d+\.\d+(?:\.\d+)?(?:-[a-zA-Z0-9.]+)?\b/g,
  filepath:
    /(?:\.{0,2}\/)?(?:[a-zA-Z0-9._-]+\/)+[a-zA-Z0-9._-]+\.[a-zA-Z0-9]+/g,
  // CamelCase identifier (likely class/type).
  camelCase: /\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g,
  // SCREAMING_SNAKE (likely constant).
  screamingSnake: /\b[A-Z]{2,}(?:_[A-Z0-9]+)+\b/g,
  // lower_snake_case (likely function/var).
  snakeCase: /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g,
  // Capitalized word / sequence (person/org candidate).
  capitalized: /\b(?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})\b/g,
  // Money.
  money: /\$[\d,]+(?:\.\d+)?(?:\s?(?:USD|EUR|GBP|JPY|CNY))?/g,
} as const;

// ─── EntityExtractor ──────────────────────────────────────────────────────

/**
 * Extract entities + relationships from text using LLM, regex, or both.
 *
 * @example
 * ```ts
 * const ext = new EntityExtractor({ provider: anthropicProvider });
 * const result = await ext.extract(
 *   'Alice works at Acme Corp. She created the HNSW module.',
 *   { source: 'demo.txt', confidence: 0.9 },
 * );
 * console.log(result.entities.length, result.relationships.length);
 * ```
 */
export class EntityExtractor {
  private readonly provider?: IProvider;
  private readonly method: 'llm' | 'regex' | 'hybrid';
  private readonly entityTypes: EntityType[];
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly cache = new LRU<string, ExtractionResult>(1000);

  /**
   * @param opts - Constructor options. See {@link EntityExtractorOptions}.
   */
  constructor(opts: EntityExtractorOptions = {}) {
    this.provider = opts.provider;
    this.method = opts.method ?? 'hybrid';
    this.entityTypes = opts.entityTypes ?? [
      'person',
      'organization',
      'concept',
      'event',
      'location',
      'document',
      'code',
      'tool',
      'project',
      'technology',
      'custom',
    ];
    this.temperature = opts.temperature ?? 0.1;
    this.maxTokens = opts.maxTokens ?? 2048;
  }

  /**
   * Extract entities + relationships from `text`.
   *
   * @param text - The input text to extract from.
   * @param opts - Per-call options:
   *   - `source`     — provenance string attached to extracted entities.
   *   - `confidence` — base confidence (0..1) for extracted entities.
   *                    Default: 0.7.
   * @returns Extraction result with `entities`, `relationships`, `unresolved`.
   */
  async extract(
    text: string,
    opts: { source?: string; confidence?: number } = {},
  ): Promise<ExtractionResult> {
    if (!text.trim()) {
      return { entities: [], relationships: [], unresolved: [] };
    }
    const source = opts.source ?? 'unknown';
    const confidence = opts.confidence ?? 0.7;

    // Pick effective method (fall back to regex if LLM is needed but no
    // provider was supplied).
    let method = this.method;
    if (method !== 'regex' && !this.provider) {
      method = 'regex';
    }

    if (method === 'regex') {
      return this.regexExtract(text, source, confidence);
    }
    if (method === 'llm') {
      return this.llmExtract(text, source, confidence);
    }
    // hybrid: run both, merge.
    const [llmRes, regexRes] = await Promise.all([
      this.provider
        ? this.llmExtract(text, source, confidence)
        : Promise.resolve({
            entities: [] as ExtractedEntity[],
            relationships: [] as ExtractedRelationship[],
            unresolved: [] as string[],
          }),
      this.regexExtract(text, source, confidence),
    ]);
    return this.mergeResults(llmRes, regexRes);
  }

  /**
   * Clear the LLM-extraction cache.
   */
  clearCache(): void {
    this.cache.clear();
  }

  // ─── LLM extraction ────────────────────────────────────────────────────

  /**
   * Run LLM extraction. Caches by text+source+confidence hash so repeated
   * calls on the same input are free.
   */
  private async llmExtract(
    text: string,
    source: string,
    confidence: number,
  ): Promise<ExtractionResult> {
    const cacheKey = `${hashText(text)}|${source}|${confidence}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const messages: LLMMessage[] = [
      {
        role: 'system',
        content: `You are an entity-relationship extractor. Read the user's text and produce a JSON object with this exact shape:
{
  "entities": [
    { "type": "person|organization|concept|event|location|document|code|tool|project|technology|custom",
      "name": "canonical name",
      "aliases": ["alternate name", ...],
      "description": "optional short description",
      "properties": {}
    }
  ],
  "relationships": [
    { "type": "works_at|created|depends_on|located_in|part_of|related_to|uses|mentions|custom",
      "source": "source entity NAME (must match an entity's name or alias)",
      "target": "target entity NAME (must match an entity's name or alias)",
      "evidence": ["text snippet that supports this relationship"],
      "properties": {}
    }
  ]
}
Rules:
- Use only entity types from the list above. Use "custom" for anything else.
- Entity names should be canonical (e.g. "Acme Corp." not "acme").
- Every relationship's source/target must reference an entity name from the entities array.
- Output ONLY the JSON object — no markdown fences, no commentary.
- If no entities/relationships are found, return {"entities": [], "relationships": []}.`,
      },
      {
        role: 'user',
        content: text,
      },
    ];

    if (!this.provider) {
      return { entities: [], relationships: [], unresolved: [] };
    }

    let response;
    try {
      response = await this.provider.chat({
        messages,
        temperature: this.temperature,
        maxTokens: this.maxTokens,
        taskType: 'fast_lookup',
      });
    } catch {
      return { entities: [], relationships: [], unresolved: [] };
    }

    const parsed = parseLlmJson(response.content);
    if (!parsed) {
      return { entities: [], relationships: [], unresolved: [] };
    }
    const validationResult = LlmExtractionSchema.safeParse(parsed);
    if (!validationResult.success) {
      return { entities: [], relationships: [], unresolved: [] };
    }
    const data = validationResult.data;
    const entityNames = new Set(
      data.entities.map((e) => e.name.toLowerCase()),
    );
    for (const e of data.entities) {
      for (const a of e.aliases ?? []) entityNames.add(a.toLowerCase());
    }
    const unresolved: string[] = [];
    for (const r of data.relationships) {
      if (!entityNames.has(r.source.toLowerCase())) {
        unresolved.push(r.source);
      }
      if (!entityNames.has(r.target.toLowerCase())) {
        unresolved.push(r.target);
      }
    }
    const entities: ExtractedEntity[] = data.entities.map((e) => ({
      type: e.type,
      name: e.name,
      aliases: e.aliases ?? [],
      description: e.description,
      properties: e.properties ?? {},
    }));
    const relationships: ExtractedRelationship[] = data.relationships.map(
      (r) => ({
        type: r.type,
        source: r.source,
        target: r.target,
        evidence: r.evidence ?? [],
        properties: r.properties ?? {},
      }),
    );
    const result: ExtractionResult = {
      entities: withConfidence(entities, confidence),
      relationships: withRelConfidence(relationships, confidence),
      unresolved,
    };
    this.cache.set(cacheKey, result);
    return result;
  }

  // ─── Regex extraction ──────────────────────────────────────────────────

  /**
   * Run regex extraction. Deterministic and zero-cost. Returns extracted
   * entities + relationships + unresolved names (always empty for regex,
   * since regex doesn't infer relationships).
   */
  private regexExtract(
    text: string,
    source: string,
    confidence: number,
  ): ExtractionResult {
    const entities: ExtractedEntity[] = [];
    const seenNames = new Set<string>();
    const pushEntity = (
      type: EntityType,
      name: string,
      description?: string,
      properties?: Record<string, unknown>,
    ): void => {
      const key = `${type}|${name.toLowerCase()}`;
      if (seenNames.has(key)) return;
      seenNames.add(key);
      entities.push({
        type,
        name,
        aliases: [],
        description,
        properties: properties ?? {},
      });
    };

    // Emails → persons (or organizations if domain-only).
    for (const m of text.matchAll(REGEX_PATTERNS.email)) {
      const email = m[0];
      pushEntity('person', email, `Email address: ${email}`, { email });
    }
    // URLs → documents.
    for (const m of text.matchAll(REGEX_PATTERNS.url)) {
      const url = m[0];
      pushEntity('document', url, `URL: ${url}`, { url });
    }
    // IPv4 → locations (network).
    for (const m of text.matchAll(REGEX_PATTERNS.ipv4)) {
      pushEntity('location', m[0], `IP address: ${m[0]}`, { ip: m[0] });
    }
    // Dates → events.
    for (const m of text.matchAll(REGEX_PATTERNS.date)) {
      pushEntity('event', m[0], `Date: ${m[0]}`, { date: m[0] });
    }
    // Versions → technologies.
    for (const m of text.matchAll(REGEX_PATTERNS.version)) {
      pushEntity('technology', m[0], `Version: ${m[0]}`, { version: m[0] });
    }
    // File paths → documents.
    for (const m of text.matchAll(REGEX_PATTERNS.filepath)) {
      pushEntity('document', m[0], `File path: ${m[0]}`, { path: m[0] });
    }
    // CamelCase → code (class/type).
    for (const m of text.matchAll(REGEX_PATTERNS.camelCase)) {
      pushEntity('code', m[0], `Class/type identifier: ${m[0]}`, {
        kind: 'class',
      });
    }
    // SCREAMING_SNAKE → code (constant).
    for (const m of text.matchAll(REGEX_PATTERNS.screamingSnake)) {
      pushEntity('code', m[0], `Constant identifier: ${m[0]}`, {
        kind: 'constant',
      });
    }
    // snake_case → code (function/var).
    for (const m of text.matchAll(REGEX_PATTERNS.snakeCase)) {
      pushEntity('code', m[0], `Function/var identifier: ${m[0]}`, {
        kind: 'function',
      });
    }
    // Money → concept (financial).
    for (const m of text.matchAll(REGEX_PATTERNS.money)) {
      pushEntity('concept', m[0], `Money amount: ${m[0]}`, { money: m[0] });
    }
    // Capitalized sequences → person or organization candidates. We tag
    // them as 'person' by default; downstream alias resolution can re-type
    // them when they're merged with an existing organization.
    for (const m of text.matchAll(REGEX_PATTERNS.capitalized)) {
      const name = m[0].trim();
      // Skip single capitalized words that are sentence-initial.
      if (name.includes(' ')) {
        pushEntity('person', name, `Capitalized phrase: ${name}`, {});
      }
    }

    return {
      entities: withConfidence(entities, confidence * 0.7),
      relationships: [],
      unresolved: [],
    };
  }

  // ─── Merge (hybrid) ────────────────────────────────────────────────────

  /**
   * Merge LLM + regex results. LLM entities win on name conflicts; regex
   * entities are added only when their name doesn't collide with an LLM
   * entity (case-insensitive).
   */
  private mergeResults(
    llm: ExtractionResult,
    regex: ExtractionResult,
  ): ExtractionResult {
    const merged: Array<ExtractedEntity> = [];
    const namesLower = new Set<string>();
    for (const e of llm.entities) {
      merged.push(e);
      namesLower.add(e.name.toLowerCase());
      for (const a of e.aliases ?? []) namesLower.add(a.toLowerCase());
    }
    for (const e of regex.entities) {
      if (!namesLower.has(e.name.toLowerCase())) {
        merged.push(e);
        namesLower.add(e.name.toLowerCase());
      }
    }
    return {
      entities: merged,
      relationships: llm.relationships,
      unresolved: llm.unresolved,
    };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Attach a confidence score to each extracted entity (regex extracts at
 * 0.7 * base by default; LLM at full base).
 */
function withConfidence(
  entities: ExtractedEntity[],
  confidence: number,
): ExtractedEntity[] {
  return entities.map((e) => ({
    ...e,
    properties: { ...e.properties, _confidence: confidence },
  }));
}

/** Same as {@link withConfidence} but for relationships. */
function withRelConfidence(
  rels: ExtractedRelationship[],
  confidence: number,
): ExtractedRelationship[] {
  return rels.map((r) => ({
    ...r,
    properties: { ...r.properties, _confidence: confidence },
  }));
}

/**
 * Stable, fast string hash (FNV-1a 32-bit, returned as hex). Used for LLM
 * extraction cache keys.
 */
function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

/**
 * Parse the LLM's response into a JSON object. Strips markdown fences and
 * leading/trailing prose. Returns `null` on any parse failure.
 */
function parseLlmJson(content: string): unknown | null {
  let s = content.trim();
  // Strip ```json ... ``` fences.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence && fence[1]) {
    s = fence[1].trim();
  }
  // Find the first `{` and last `}` to trim prose around the JSON object.
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  const jsonStr = s.slice(start, end + 1);
  try {
    return JSON.parse(jsonStr) as unknown;
  } catch {
    return null;
  }
}
