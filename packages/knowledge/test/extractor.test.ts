/**
 * @file extractor.test.ts
 * @description Tests EntityExtractor: regex, LLM (mock), hybrid, alias
 * resolution.
 */
import { describe, it, expect } from 'vitest';
import { EntityExtractor } from '@sanix/knowledge';
import { createMockProvider } from '../../../test/helpers/mockProvider.js';
import { SAMPLE_ENTITIES_TEXT } from '../../../test/helpers/fixtures.js';

const ENTITY_JSON = JSON.stringify({
  entities: [
    {
      type: 'person',
      name: 'Alice',
      aliases: ['Al'],
      description: 'A developer.',
      properties: {},
    },
    {
      type: 'person',
      name: 'Bob',
      aliases: [],
      description: 'A reviewer.',
      properties: {},
    },
    {
      type: 'organization',
      name: 'Acme',
      aliases: [],
      description: 'A company.',
      properties: {},
    },
    {
      type: 'organization',
      name: 'Beta',
      aliases: [],
      description: 'A partner company.',
      properties: {},
    },
    {
      type: 'code',
      name: 'auth module',
      aliases: [],
      description: 'The authentication module.',
      properties: {},
    },
  ],
  relationships: [
    {
      type: 'works_at',
      source: 'Alice',
      target: 'Acme',
      evidence: ['Alice works at Acme.'],
      properties: {},
    },
    {
      type: 'works_at',
      source: 'Bob',
      target: 'Beta',
      evidence: ['Bob works at Beta.'],
      properties: {},
    },
    {
      type: 'created',
      source: 'Alice',
      target: 'auth module',
      evidence: ['Alice created the auth module.'],
      properties: {},
    },
  ],
});

describe('EntityExtractor', () => {
  describe('regex extraction', () => {
    const extractor = new EntityExtractor({ method: 'regex' });

    it('extracts emails as persons', async () => {
      const result = await extractor.extract(
        'Contact alice@acme.com or bob@beta.io.',
        { source: 'test' },
      );
      const emails = result.entities.filter((e) =>
        'email' in (e.properties ?? {}),
      );
      expect(emails.length).toBeGreaterThanOrEqual(2);
    });

    it('extracts URLs as documents', async () => {
      const result = await extractor.extract(
        'Visit https://example.com or http://sanix.dev/docs.',
        { source: 'test' },
      );
      const urls = result.entities.filter(
        (e) => e.type === 'document' && 'url' in (e.properties ?? {}),
      );
      expect(urls.length).toBeGreaterThanOrEqual(2);
    });

    it('extracts dates as events', async () => {
      const result = await extractor.extract(
        'Shipped on 2024-05-12 and 2024-06-01.',
        { source: 'test' },
      );
      const dates = result.entities.filter((e) => e.type === 'event');
      expect(dates.length).toBeGreaterThanOrEqual(2);
    });

    it('extracts CamelCase identifiers as code', async () => {
      // The regex `[A-Z][a-z]+(?:[A-Z][a-z]+)+` matches identifiers
      // where the first segment is one uppercase + one-or-more lowercase
      // letters, followed by one or more additional CamelCase segments.
      // "GraphBuilder" matches; "HNSWIndex" does not (first segment is "H"
      // alone, no lowercase follow).
      const result = await extractor.extract(
        'We use GraphBuilder and HttpRequestParser for storage.',
        { source: 'test' },
      );
      const names = result.entities.map((e) => e.name);
      expect(names).toContain('GraphBuilder');
      expect(names).toContain('HttpRequestParser');
    });

    it('returns empty result for empty input', async () => {
      const result = await extractor.extract('', { source: 'test' });
      expect(result.entities).toEqual([]);
      expect(result.relationships).toEqual([]);
      expect(result.unresolved).toEqual([]);
    });
  });

  describe('LLM extraction', () => {
    it('parses a JSON response and returns entities + relationships', async () => {
      const provider = createMockProvider({ responses: [ENTITY_JSON] });
      const extractor = new EntityExtractor({ provider, method: 'llm' });
      const result = await extractor.extract(SAMPLE_ENTITIES_TEXT, {
        source: 'test',
      });
      expect(result.entities.length).toBe(5);
      expect(result.relationships.length).toBe(3);
      // All relationship endpoints should resolve to known entities.
      expect(result.unresolved).toEqual([]);
      // Spot-check a few entities.
      const alice = result.entities.find((e) => e.name === 'Alice');
      expect(alice).toBeDefined();
      expect(alice!.type).toBe('person');
      expect(alice!.aliases).toContain('Al');
    });

    it('returns empty result on malformed JSON', async () => {
      const provider = createMockProvider({ responses: ['not json'] });
      const extractor = new EntityExtractor({ provider, method: 'llm' });
      const result = await extractor.extract('Some text.', { source: 'test' });
      expect(result.entities).toEqual([]);
      expect(result.relationships).toEqual([]);
    });

    it('caches results by text hash', async () => {
      const provider = createMockProvider({ responses: [ENTITY_JSON] });
      const extractor = new EntityExtractor({ provider, method: 'llm' });
      await extractor.extract(SAMPLE_ENTITIES_TEXT, { source: 'test' });
      await extractor.extract(SAMPLE_ENTITIES_TEXT, { source: 'test' });
      // Second call should hit the cache (no extra provider call).
      expect(provider.callCount).toBe(1);
    });

    it('falls back to regex when no provider is configured', async () => {
      const extractor = new EntityExtractor({ method: 'llm' });
      const result = await extractor.extract(
        'Email alice@acme.com and visit https://example.com.',
        { source: 'test' },
      );
      // Regex fallback → at least the email + URL are extracted.
      expect(result.entities.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('hybrid extraction', () => {
    it('merges LLM + regex results', async () => {
      const provider = createMockProvider({ responses: [ENTITY_JSON] });
      const extractor = new EntityExtractor({ provider, method: 'hybrid' });
      const result = await extractor.extract(
        SAMPLE_ENTITIES_TEXT + ' Visit https://example.com.',
        { source: 'test' },
      );
      // LLM entities + regex URL entity.
      expect(result.entities.length).toBeGreaterThanOrEqual(5);
      // The URL (regex-only) should be present.
      const urls = result.entities.filter(
        (e) => e.type === 'document' && 'url' in (e.properties ?? {}),
      );
      expect(urls.length).toBeGreaterThanOrEqual(1);
      // LLM-derived relationships are preserved.
      expect(result.relationships.length).toBe(3);
    });
  });

  describe('alias resolution', () => {
    it('extracts aliases from the LLM response', async () => {
      const provider = createMockProvider({ responses: [ENTITY_JSON] });
      const extractor = new EntityExtractor({ provider, method: 'llm' });
      const result = await extractor.extract(SAMPLE_ENTITIES_TEXT, {
        source: 'test',
      });
      const alice = result.entities.find((e) => e.name === 'Alice');
      expect(alice!.aliases).toContain('Al');
    });

    it('treats every relationship endpoint as resolved when it matches an alias', async () => {
      const json = JSON.stringify({
        entities: [
          { type: 'person', name: 'Alice', aliases: ['Al'], properties: {} },
          { type: 'organization', name: 'Acme', aliases: [], properties: {} },
        ],
        relationships: [
          {
            type: 'works_at',
            source: 'Al',
            target: 'Acme',
            evidence: [],
            properties: {},
          },
        ],
      });
      const provider = createMockProvider({ responses: [json] });
      const extractor = new EntityExtractor({ provider, method: 'llm' });
      const result = await extractor.extract(
        'Al works at Acme.',
        { source: 'test' },
      );
      // 'Al' is an alias of Alice → resolved.
      expect(result.unresolved).toEqual([]);
    });
  });

  describe('clearCache', () => {
    it('clears the LLM cache so the next call hits the provider', async () => {
      const provider = createMockProvider({ responses: [ENTITY_JSON] });
      const extractor = new EntityExtractor({ provider, method: 'llm' });
      await extractor.extract(SAMPLE_ENTITIES_TEXT, { source: 'test' });
      expect(provider.callCount).toBe(1);
      extractor.clearCache();
      await extractor.extract(SAMPLE_ENTITIES_TEXT, { source: 'test' });
      expect(provider.callCount).toBe(2);
    });
  });
});
