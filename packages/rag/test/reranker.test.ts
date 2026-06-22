/**
 * @file reranker.test.ts
 * @description Tests each reranker method (cross_encoder, llm, none).
 * Verifies reranking changes order when relevant docs are lower-ranked
 * by initial retrieval.
 */
import { describe, it, expect } from 'vitest';
import { Reranker } from '@sanix/rag';
import type { ScoredDoc, Document } from '@sanix/rag';
import { createMockProvider } from '../../../test/helpers/mockProvider.js';

function doc(id: string, content: string, source = id): Document {
  return {
    id,
    content,
    metadata: { source, title: id, createdAt: Date.now() },
  };
}

function scored(doc_: Document, score: number, method: ScoredDoc['method'] = 'hybrid'): ScoredDoc {
  return { doc: doc_, score, method, components: {} };
}

describe('Reranker', () => {
  describe('method: none', () => {
    it('passes through unchanged', async () => {
      const r = new Reranker({ method: 'none' });
      const input = [
        scored(doc('a', 'first'), 0.9),
        scored(doc('b', 'second'), 0.5),
      ];
      const out = await r.rerank('q', input);
      expect(out.map((s) => s.doc.id)).toEqual(['a', 'b']);
      // Scores preserved.
      expect(out[0]!.score).toBe(0.9);
      // Method unchanged.
      expect(out[0]!.method).toBe('hybrid');
    });

    it('respects topK', async () => {
      const r = new Reranker({ method: 'none' });
      const input = [
        scored(doc('a', 'a'), 0.9),
        scored(doc('b', 'b'), 0.5),
        scored(doc('c', 'c'), 0.3),
      ];
      const out = await r.rerank('q', input, { topK: 2 });
      expect(out).toHaveLength(2);
    });

    it('returns [] for empty input', async () => {
      const r = new Reranker({ method: 'none' });
      expect(await r.rerank('q', [])).toEqual([]);
    });
  });

  describe('method: cross_encoder', () => {
    it('re-scores docs by LLM ratings and re-orders', async () => {
      // Initial order: doc with low relevance on top, high on bottom.
      // Cross-encoder ratings (one per doc, comma-separated): 3, 9.
      // After rerank, the high-relevance doc should bubble up.
      const provider = createMockProvider({
        responses: ['3, 9'],
      });
      const r = new Reranker({ method: 'cross_encoder', provider });
      const input = [
        scored(doc('irrelevant', 'weather today'), 0.9),
        scored(doc('relevant', 'JWT tokens signed with HS256'), 0.3),
      ];
      const out = await r.rerank('JWT signing', input);
      expect(out[0]!.doc.id).toBe('relevant');
      expect(out[0]!.method).toBe('cross_encoder');
      // Score is the rating / 10.
      expect(out[0]!.score).toBeCloseTo(0.9, 5);
    });

    it('falls back to none when no provider is configured', async () => {
      const r = new Reranker({ method: 'cross_encoder' });
      const input = [scored(doc('a', 'a'), 0.5)];
      const out = await r.rerank('q', input);
      // Method stays 'hybrid' (passthrough = no reranking applied).
      expect(out[0]!.method).toBe('hybrid');
    });
  });

  describe('method: llm', () => {
    it('re-orders docs by LLM-provided index list', async () => {
      // Initial order: [a, b, c]. LLM says: 3,1,2 (most-relevant-first).
      const provider = createMockProvider({
        responses: ['3, 1, 2'],
      });
      const r = new Reranker({ method: 'llm', provider });
      const input = [
        scored(doc('a', 'apple'), 0.9),
        scored(doc('b', 'banana'), 0.5),
        scored(doc('c', 'cherry'), 0.3),
      ];
      const out = await r.rerank('cherry', input);
      expect(out[0]!.doc.id).toBe('c');
      expect(out[1]!.doc.id).toBe('a');
      expect(out[2]!.doc.id).toBe('b');
      expect(out[0]!.method).toBe('llm');
    });

    it('appends missing docs (the top hit is the LLM-selected one)', async () => {
      // LLM only mentions doc 2 — doc 1 and doc 3 should follow.
      const provider = createMockProvider({
        responses: ['2'],
      });
      const r = new Reranker({ method: 'llm', provider });
      const input = [
        scored(doc('a', 'apple'), 0.9),
        scored(doc('b', 'banana'), 0.5),
        scored(doc('c', 'cherry'), 0.3),
      ];
      const out = await r.rerank('banana', input);
      // The LLM-selected doc (b) is at the top.
      expect(out[0]!.doc.id).toBe('b');
      // The remaining slots are filled with the other docs.
      expect(out.length).toBe(3);
      // Method is set to 'llm'.
      expect(out[0]!.method).toBe('llm');
    });
  });

  describe('method: mono_t5', () => {
    it('falls back to passthrough when the mono-t5 CLI is missing', async () => {
      // The mono-t5 binary is not installed in this environment.
      const r = new Reranker({ method: 'mono_t5' });
      const input = [
        scored(doc('a', 'apple'), 0.9),
        scored(doc('b', 'banana'), 0.5),
      ];
      const out = await r.rerank('apple', input);
      // Falls back to passthrough ordering (method stays 'hybrid').
      expect(out.map((s) => s.doc.id)).toEqual(['a', 'b']);
      expect(out[0]!.method).toBe('hybrid');
    });
  });
});
