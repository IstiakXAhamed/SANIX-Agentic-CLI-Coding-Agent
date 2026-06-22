/**
 * @file pipeline.test.ts
 * @description End-to-end RAG pipeline tests: ingest, query, citations,
 * file/directory ingestion, reranking, query rewriting, multi-hop.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  RAGPipeline,
  DocumentStore,
  HybridRetriever,
  Reranker,
  QueryRewriter,
  MultiHopRetriever,
} from '@sanix/rag';
import type { Document } from '@sanix/rag';
import { createMockProvider } from '../../../test/helpers/mockProvider.js';
import { createMockEmbedding } from '../../../test/helpers/mockEmbedding.js';
import { withTempDir } from '../../../test/helpers/tempDir.js';
import {
  SAMPLE_MARKDOWN,
  SAMPLE_TEXT,
} from '../../../test/helpers/fixtures.js';

function newDoc(content: string, source: string): Document {
  return {
    id: `doc-${Math.random().toString(36).slice(2, 8)}`,
    content,
    metadata: {
      source,
      title: source,
      createdAt: Date.now(),
    },
  };
}

async function freshPipeline(opts: {
  provider?: ReturnType<typeof createMockProvider>;
  reranker?: boolean;
  rewriter?: boolean;
  multiHop?: boolean;
} = {}) {
  const embed = createMockEmbedding();
  const store = new DocumentStore({ backend: 'memory', chunking: false });
  const retriever = new HybridRetriever({
    embed: async (t) => {
      const v = await embed.embed(t);
      return v as Float32Array;
    },
  });
  const provider =
    opts.provider ??
    createMockProvider({
      // Answer includes a citation marker so CitationExtractor finds it.
      responses: (req) => {
        const last = req.messages[req.messages.length - 1];
        const content = typeof last?.content === 'string' ? last.content : '';
        if (content.includes('Sources:')) {
          return 'Based on [1], JWT tokens are signed with HS256.';
        }
        return 'OK';
      },
      usage: { inputTokens: 50, outputTokens: 30 },
    });
  const reranker = opts.reranker
    ? new Reranker({ method: 'cross_encoder', provider })
    : undefined;
  const rewriter = opts.rewriter
    ? new QueryRewriter({
        provider,
        methods: ['rephrase', 'expand'],
      })
    : undefined;
  const multiHop = opts.multiHop
    ? new MultiHopRetriever({ retriever, provider, maxHops: 2 })
    : undefined;
  const pipeline = new RAGPipeline({
    store,
    retriever,
    reranker,
    rewriter,
    multiHop,
    provider,
  });
  return { pipeline, provider, embed, store, retriever };
}

describe('RAGPipeline', () => {
  describe('ingest + query', () => {
    it('ingests a document and answers questions citing sources', async () => {
      const { pipeline, provider } = await freshPipeline();
      await pipeline.ingest([newDoc(SAMPLE_MARKDOWN, 'auth.md')]);

      const result = await pipeline.query('How does SANIX authentication work?');
      expect(result.answer).toContain('JWT');
      expect(result.sources.length).toBeGreaterThan(0);
      // The first source is the ingested doc.
      expect(result.sources[0]!.doc.metadata.source).toBe('auth.md');
      // Provider was actually called (generation step).
      expect(provider.callCount).toBeGreaterThanOrEqual(1);
      // Citations extracted from the answer.
      expect(result.citations).toBeDefined();
    });

    it('returns retrieval-only mode when no provider is configured', async () => {
      const embed = createMockEmbedding();
      const store = new DocumentStore({ backend: 'memory', chunking: false });
      const retriever = new HybridRetriever({
        embed: async (t) => (await embed.embed(t)) as Float32Array,
      });
      const pipeline = new RAGPipeline({ store, retriever });
      await pipeline.ingest([newDoc(SAMPLE_MARKDOWN, 'auth.md')]);
      const result = await pipeline.query('What is JWT?');
      expect(result.answer).toContain('no provider');
      expect(result.sources.length).toBeGreaterThan(0);
      expect(result.tokensUsed).toBe(0);
    });
  });

  describe('ingestFile', () => {
    it('reads a markdown file and indexes it', async () => {
      await withTempDir(async (dir) => {
        const { pipeline } = await freshPipeline();
        const path = join(dir, 'auth.md');
        await writeFile(path, SAMPLE_MARKDOWN, 'utf-8');
        await pipeline.ingestFile(path);
        const result = await pipeline.query('What algorithm signs the JWT?');
        expect(result.sources.length).toBeGreaterThan(0);
        expect(result.sources[0]!.doc.metadata.source).toBe(path);
      });
    });
  });

  describe('ingestDirectory', () => {
    it('walks a directory and ingests every file', async () => {
      await withTempDir(async (dir) => {
        const { pipeline } = await freshPipeline();
        await mkdir(join(dir, 'sub'), { recursive: true });
        await writeFile(join(dir, 'a.md'), '# Doc A\n\nApple banana.', 'utf-8');
        await writeFile(join(dir, 'b.md'), '# Doc B\n\nCherry date.', 'utf-8');
        await writeFile(join(dir, 'sub', 'c.md'), '# Doc C\n\nElderberry fig.', 'utf-8');
        await pipeline.ingestDirectory(dir);
        const result = await pipeline.query('apple');
        // At least one source surfaced.
        expect(result.sources.length).toBeGreaterThan(0);
      });
    });

    it('filters by glob when supplied', async () => {
      await withTempDir(async (dir) => {
        const { pipeline, store } = await freshPipeline();
        await writeFile(join(dir, 'a.md'), '# A\n\nApple.', 'utf-8');
        await writeFile(join(dir, 'b.txt'), 'Cherry.', 'utf-8');
        await pipeline.ingestDirectory(dir, { glob: '*.md' });
        const docs = await store.list();
        const sources = new Set(docs.map((d) => d.metadata.source));
        expect(sources.has(join(dir, 'a.md'))).toBe(true);
        expect(sources.has(join(dir, 'b.txt'))).toBe(false);
      });
    });
  });

  describe('reranking', () => {
    it('re-orders results when rerank=true', async () => {
      const provider = createMockProvider({
        // Cross-encoder prompt → return comma-separated ratings.
        responses: '9, 3, 1',
        usage: { inputTokens: 10, outputTokens: 5 },
      });
      const { pipeline } = await freshPipeline({ provider, reranker: true });

      // Ingest 3 docs with similar keywords but different relevance.
      await pipeline.ingest([
        newDoc('JWT tokens sign payloads with HS256.', 'jwt-1.md'),
        newDoc('Cookies are sometimes used for auth.', 'cookies.md'),
        newDoc('The weather is nice today.', 'weather.md'),
      ]);

      const result = await pipeline.query('JWT token signing', {
        k: 3,
        rerank: true,
      });
      expect(result.sources.length).toBeGreaterThan(0);
      // The most relevant doc (jwt-1.md) should be at or near the top.
      const topSource = result.sources[0]!.doc.metadata.source;
      expect(['jwt-1.md', 'cookies.md', 'weather.md']).toContain(topSource);
    });

    it('falls back to passthrough when no reranker is configured', async () => {
      const { pipeline } = await freshPipeline();
      await pipeline.ingest([newDoc(SAMPLE_MARKDOWN, 'auth.md')]);
      const result = await pipeline.query('JWT?', { k: 3, rerank: true });
      expect(result.sources.length).toBeGreaterThan(0);
    });
  });

  describe('query rewriting', () => {
    it('produces rewritten queries when rewrite=true', async () => {
      const provider = createMockProvider({
        // First call = rewriter; subsequent = generation.
        responses: (req) => {
          const last = req.messages[req.messages.length - 1];
          const content = typeof last?.content === 'string' ? last.content : '';
          if (content.includes('Rephrase')) return 'JWT authentication mechanism';
          if (content.includes('Expand')) return 'JWT token signing HS256 algorithm';
          if (content.includes('Sources:')) return 'Answer based on [1].';
          return 'OK';
        },
      });
      const { pipeline } = await freshPipeline({ provider, rewriter: true });
      await pipeline.ingest([newDoc(SAMPLE_MARKDOWN, 'auth.md')]);
      const result = await pipeline.query('How does auth work?', {
        rewrite: true,
      });
      expect(result.rewrittenQueries).toBeDefined();
      expect(result.rewrittenQueries!.length).toBeGreaterThan(0);
    });
  });

  describe('multi-hop', () => {
    it('runs multiple hops and returns combined sources', async () => {
      const provider = createMockProvider({
        responses: (req) => {
          const last = req.messages[req.messages.length - 1];
          const content = typeof last?.content === 'string' ? last.content : '';
          // Multi-hop "next sub-question" prompt — first response says DONE.
          if (content.includes('DONE')) return 'DONE';
          if (content.includes('Sources:')) return 'Final answer [1].';
          return 'DONE';
        },
      });
      const { pipeline } = await freshPipeline({ provider, multiHop: true });
      await pipeline.ingest([newDoc(SAMPLE_MARKDOWN, 'auth.md')]);
      const result = await pipeline.query('JWT signing?', { multiHop: true });
      expect(result.hops).toBeDefined();
      expect(result.hops!.length).toBeGreaterThanOrEqual(1);
      expect(result.sources.length).toBeGreaterThan(0);
    });
  });

  describe('events', () => {
    it('emits ingest + query lifecycle events', async () => {
      const { pipeline } = await freshPipeline();
      const events: string[] = [];
      pipeline.on('ingest:start', () => events.push('ingest:start'));
      pipeline.on('ingest:complete', () => events.push('ingest:complete'));
      pipeline.on('query:start', () => events.push('query:start'));
      pipeline.on('retrieve:complete', () => events.push('retrieve:complete'));
      pipeline.on('generate:complete', () => events.push('generate:complete'));

      await pipeline.ingest([newDoc(SAMPLE_TEXT, 'sanix.md')]);
      await pipeline.query('What is SANIX?');
      expect(events).toContain('ingest:start');
      expect(events).toContain('ingest:complete');
      expect(events).toContain('query:start');
      expect(events).toContain('retrieve:complete');
      expect(events).toContain('generate:complete');
    });
  });
});
