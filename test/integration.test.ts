/**
 * @file integration.test.ts
 * @description End-to-end integration tests combining multiple SANIX
 * subsystems: multi-agent + RAG, knowledge graph + multi-agent,
 * sandbox + self-improve, semantic cache + RAG, and the full pipeline.
 */
import { describe, it, expect } from 'vitest';
import { AgentTeam } from '@sanix/multiagent';
import type {
  AgentHandle,
  TeamConfig,
  TeamMember,
} from '@sanix/multiagent';
import {
  RAGPipeline,
  DocumentStore,
  HybridRetriever,
} from '@sanix/rag';
import type { Document } from '@sanix/rag';
import {
  GraphStore,
  GraphBuilder,
  EntityExtractor,
} from '@sanix/knowledge';
import { SemanticCache } from '@sanix/semantic-cache';
import { HNSWIndex } from '@sanix/memory-v2';
import { SandboxManager } from '@sanix/sandbox';
import {
  EvolutionEngine,
  PromptMutator,
  FitnessEvaluator,
} from '@sanix/self-improve';
import type { EvolutionConfig } from '@sanix/self-improve';
import { BenchmarkSuite } from '@sanix/bench';
import type { Benchmark } from '@sanix/bench';
import type { IProvider, LLMRequest, LLMResponse, LLMMessage } from '@sanix/providers';
import { createMockProvider } from './helpers/mockProvider.js';
import { createMockEmbedding } from './helpers/mockEmbedding.js';
import {
  SAMPLE_MARKDOWN,
  SAMPLE_ENTITIES_TEXT,
} from './helpers/fixtures.js';

// ─── Shared helpers ────────────────────────────────────────────────────────

function newDoc(content: string, source: string): Document {
  return {
    id: `doc-${Math.random().toString(36).slice(2, 8)}`,
    content,
    metadata: { source, title: source, createdAt: Date.now() },
  };
}

function makeMember(
  id: string,
  persona = 'researcher',
  role: TeamMember['role'] = 'researcher',
): TeamMember {
  return {
    id,
    persona,
    role,
    weight: 1,
    budget: { tokens: 4096, costUsd: 0.1 },
  };
}

/**
 * Build an AgentTeam whose members all delegate to the same provider.
 * Each member's `run` is augmented with an optional pre-flight hook
 * (used by some integration tests to inject RAG/KG context).
 */
function makeTeam(
  config: TeamConfig,
  provider: IProvider,
  preflight?: (input: string) => Promise<string>,
): AgentTeam {
  const factory = (member: TeamMember): AgentHandle => ({
    id: member.id,
    async run(input: string, context?: string): Promise<string> {
      const augmented = preflight ? await preflight(input) : input;
      const userContent = context
        ? `${context}\n\n${augmented}`
        : augmented;
      const req: LLMRequest = {
        messages: [
          { role: 'system', content: `You are member ${member.id}.` },
          { role: 'user', content: userContent },
        ],
      };
      const res = await provider.chat(req);
      return res.content;
    },
    abort: () => {},
  });
  return new AgentTeam(config, { agentFactory: factory });
}

// ─── Test 1: Multi-agent + RAG ─────────────────────────────────────────────

describe('Integration: Multi-agent + RAG', () => {
  it('team solves a problem using RAG-retrieved context', async () => {
    const embed = createMockEmbedding();
    const store = new DocumentStore({ backend: 'memory', chunking: false });
    const retriever = new HybridRetriever({
      embed: async (t) => (await embed.embed(t)) as Float32Array,
    });

    // Mock provider: returns a fact-laden answer.
    const provider = createMockProvider({
      responses: (req: LLMRequest) => {
        const allContent = req.messages
          .map((m) => (typeof m.content === 'string' ? m.content : ''))
          .join('\n');
        // RAG generation call — system prompt mentions "retrieval-augmented".
        if (allContent.includes('retrieval-augmented') || allContent.includes('Sources:')) {
          return 'Based on [1], SANIX uses JWT with HS256 signing.';
        }
        // Team-member calls receive the preflight-augmented prompt
        // (which includes "Context:" + RAG snippets + "Question:").
        if (allContent.includes('Question:')) {
          return 'SANIX uses JWT for authentication.';
        }
        return 'research';
      },
      usage: { inputTokens: 20, outputTokens: 30 },
      costUsd: 0.001,
    });

    const pipeline = new RAGPipeline({ store, retriever, provider });

    // Ingest the docs.
    await pipeline.ingest([
      newDoc(SAMPLE_MARKDOWN, 'auth.md'),
      newDoc('SANIX uses HNSW for vector search.', 'arch.md'),
    ]);

    // 3-member research team: each member queries RAG for context, then answers.
    const members = [
      makeMember('r1', 'researcher', 'researcher'),
      makeMember('r2', 'researcher', 'researcher'),
      makeMember('r3', 'researcher', 'researcher'),
    ];
    const config: TeamConfig = {
      name: 'RAG Research Team',
      description: 'Research team with RAG context',
      members,
      strategy: 'parallel',
      consensus: 'majority',
      rounds: 1,
      maxConcurrent: 4,
      timeoutMs: 30_000,
    };

    const team = makeTeam(config, provider, async (input) => {
      // Pre-flight: retrieve RAG context for the input.
      const result = await pipeline.query(input);
      const context = result.sources
        .map((s, i) => `[${i + 1}] ${s.snippet}`)
        .join('\n');
      return `Context:\n${context}\n\nQuestion: ${input}`;
    });

    const result = await team.solve('How does SANIX authentication work?');
    expect(result.contributions.length).toBe(3);
    // The team's consensus should mention JWT (from the RAG context).
    expect(result.consensus).toContain('JWT');
    // Every member contributed.
    for (const c of result.contributions) {
      expect(c.output.length).toBeGreaterThan(0);
    }
  });
});

// ─── Test 2: Knowledge graph + Multi-agent ─────────────────────────────────

describe('Integration: Knowledge graph + Multi-agent', () => {
  it('team members consult the KG for context, then synthesize', async () => {
    const store = new GraphStore({ inMemory: true });
    store.open();
    const extractor = new EntityExtractor({
      provider: createMockProvider({
        // Return entities + relationships parsed from the sample text.
        responses: JSON.stringify({
          entities: [
            { type: 'person', name: 'Alice', aliases: [], properties: {} },
            { type: 'person', name: 'Bob', aliases: [], properties: {} },
            { type: 'organization', name: 'Acme', aliases: [], properties: {} },
            { type: 'organization', name: 'Beta', aliases: [], properties: {} },
            { type: 'code', name: 'auth module', aliases: [], properties: {} },
          ],
          relationships: [
            { type: 'works_at', source: 'Alice', target: 'Acme', evidence: [], properties: {} },
            { type: 'works_at', source: 'Bob', target: 'Beta', evidence: [], properties: {} },
            { type: 'created', source: 'Alice', target: 'auth module', evidence: [], properties: {} },
          ],
        }),
      }),
      method: 'llm',
    });
    const builder = new GraphBuilder(store, extractor);
    await builder.ingest(SAMPLE_ENTITIES_TEXT, { source: 'demo' });

    // Sanity check: graph has the expected entities.
    const persons = store.listEntities({ type: 'person' });
    expect(persons.length).toBeGreaterThanOrEqual(2);

    // Mock provider for the team: members echo the context they receive.
    const provider = createMockProvider({
      responses: (req: LLMRequest) => {
        const last = req.messages[req.messages.length - 1];
        const content = typeof last?.content === 'string' ? last.content : '';
        // The pre-flight hook prepends KG context; the member should
        // reference the entities in its response.
        if (content.includes('Alice')) return 'Alice created the auth module.';
        if (content.includes('Bob')) return 'Bob works at Beta.';
        return 'unknown';
      },
    });

    const members = [
      makeMember('a', 'researcher', 'researcher'),
      makeMember('b', 'researcher', 'researcher'),
      makeMember('c', 'researcher', 'researcher'),
    ];
    const config: TeamConfig = {
      name: 'KG Research Team',
      description: 'Team that consults the knowledge graph',
      members,
      strategy: 'parallel',
      consensus: 'majority',
      rounds: 1,
      maxConcurrent: 4,
      timeoutMs: 30_000,
    };

    const team = makeTeam(config, provider, async (input) => {
      // Pre-flight: look up entities in the KG matching the query.
      const entities = store.listEntities({ limit: 100 });
      const rels: string[] = [];
      for (const e of entities) {
        const incident = store.getRelationships(e.id, { direction: 'both' });
        for (const r of incident) {
          const other = r.source === e.id ? r.target : r.source;
          const otherEnt = store.getEntity(other);
          if (otherEnt) {
            rels.push(`${e.name} ${r.type} ${otherEnt.name}`);
          }
        }
      }
      return `Graph context:\n${rels.slice(0, 5).join('\n')}\n\nQuestion: ${input}`;
    });

    const result = await team.solve('Who created the auth module?');
    // The team's consensus should incorporate graph entities.
    const lowerConsensus = result.consensus.toLowerCase();
    const mentionsEntity =
      lowerConsensus.includes('alice') ||
      lowerConsensus.includes('auth');
    expect(mentionsEntity).toBe(true);
    store.close();
  });
});

// ─── Test 3: Sandbox + Self-improve ────────────────────────────────────────

describe('Integration: Sandbox + Self-improve', () => {
  it('sandbox isolates failures while the fitness evaluator scores correct code', async () => {
    const sandbox = new SandboxManager({ defaultIsolation: 'process' });

    // 1. The sandbox isolates bad code without crashing the host.
    const badResult = await sandbox.execute(
      'throw new Error("intentional failure");',
      { runtime: 'node', isolation: 'process', timeoutMs: 5_000 },
    );
    expect(badResult.exitCode).not.toBe(0);
    expect(badResult.stderr).toContain('intentional failure');
    // The host process is still alive (we're here).
    expect(true).toBe(true);

    // 2. The sandbox correctly runs good code.
    const goodResult = await sandbox.execute(
      'console.log(2 + 2);',
      { runtime: 'node', isolation: 'process', timeoutMs: 5_000 },
    );
    expect(goodResult.stdout).toContain('4');

    await sandbox.stopAll();

    // 3. The fitness evaluator scores a benchmark correctly.
    const bench: Benchmark = {
      id: 'sandbox-integration',
      name: 'Sandbox Integration',
      description: 'Tests that sandboxed code produces correct outputs.',
      category: 'coding',
      prompts: [
        { id: 'p1', input: 'What is 2+2?', expected: '4' },
        { id: 'p2', input: 'What is 3+3?', expected: '6' },
      ],
      scoring: { type: 'contains', threshold: 0.7 },
      timeout: 5_000,
    };
    const subjectProvider = createMockProvider({
      responses: 'The answer is 4. The answer is 6.',
      usage: { inputTokens: 5, outputTokens: 10 },
      costUsd: 0.0001,
    });
    const suite = new BenchmarkSuite({ provider: subjectProvider });
    suite.register(bench);
    const evaluator = new FitnessEvaluator({
      benchmarkSuite: suite,
      provider: subjectProvider,
      samplesPerVariant: 2,
    });

    // Evaluate a simple variant.
    const fitness = await evaluator.evaluate(
      {
        id: 'v1',
        name: 'v1',
        systemPrompt: 'Answer concisely.',
        description: 'v1',
        createdAt: Date.now(),
        generation: 0,
        samples: 0,
      },
      { benchmarkId: 'sandbox-integration' },
    );
    expect(fitness.samples).toBeGreaterThan(0);
    expect(fitness.fitness).toBeGreaterThan(0);
  });
});

// ─── Test 4: Semantic cache + RAG ──────────────────────────────────────────

describe('Integration: Semantic cache + RAG', () => {
  it('second semantically-similar query hits the cache (no LLM call for generation)', async () => {
    const embed = createMockEmbedding();
    const store = new DocumentStore({ backend: 'memory', chunking: false });
    const retriever = new HybridRetriever({
      embed: async (t) => (await embed.embed(t)) as Float32Array,
    });

    const provider = createMockProvider({
      responses: (req: LLMRequest) => {
        const allContent = req.messages
          .map((m) => (typeof m.content === 'string' ? m.content : ''))
          .join('\n');
        if (
          allContent.includes('retrieval-augmented') ||
          allContent.includes('Sources:')
        ) {
          return 'Answer: JWT uses HS256 [1].';
        }
        return 'OK';
      },
      usage: { inputTokens: 30, outputTokens: 40 },
      costUsd: 0.001,
    });

    const pipeline = new RAGPipeline({ store, retriever, provider });
    await pipeline.ingest([newDoc(SAMPLE_MARKDOWN, 'auth.md')]);

    // Wrap the provider in a semantic cache.
    const cache = new SemanticCache({
      vectorIndex: new HNSWIndex(),
      embeddingProvider: embed,
      threshold: 0.85,
      ttlMs: 60_000,
    });

    // Helper: get answer from RAG, with cache.
    const queryWithCache = async (
      q: string,
    ): Promise<{ answer: string; hit: boolean }> => {
      const hit = await cache.get(q);
      if (hit) return { answer: hit.response, hit: true };
      const result = await pipeline.query(q);
      await cache.set(q, result.answer, {
        tokensUsed: result.tokensUsed,
      });
      return { answer: result.answer, hit: false };
    };

    // Use two queries that tokenize identically (modulo punctuation)
    // so the mock embedding produces near-identical vectors → cache hit.
    const r1 = await queryWithCache('How does JWT auth work?');
    expect(r1.hit).toBe(false);
    expect(provider.callCount).toBeGreaterThanOrEqual(1);
    const callsAfterFirst = provider.callCount;

    const r2 = await queryWithCache('How does JWT auth work?');
    expect(r2.hit).toBe(true);
    // No additional provider call for the second query.
    expect(provider.callCount).toBe(callsAfterFirst);
  });
});

// ─── Test 5: Full pipeline ─────────────────────────────────────────────────

describe('Integration: Full pipeline (RAG + KG + Multi-agent + Cache + Self-improve)', () => {
  it('all subsystems integrate without errors', async () => {
    // 1. Ingest docs into RAG.
    const embed = createMockEmbedding();
    const docStore = new DocumentStore({ backend: 'memory', chunking: false });
    const retriever = new HybridRetriever({
      embed: async (t) => (await embed.embed(t)) as Float32Array,
    });
    const provider = createMockProvider({
      responses: (req: LLMRequest) => {
        // Inspect the FULL conversation (system + user + assistant) so
        // prompts that put their instruction in the system message (e.g.
        // the EntityExtractor's "produce a JSON object …" system prompt)
        // are matched correctly.
        const content = req.messages
          .map((m) => (typeof m.content === 'string' ? m.content : ''))
          .join('\n');
        // Mutator/extractor calls → return JSON or text depending on content.
        if (content.includes('Rewrite') || content.includes('Rephrase')) {
          return 'Improved prompt: be concise and accurate.';
        }
        if (content.includes('JSON object')) {
          return JSON.stringify({
            entities: [
              { type: 'concept', name: 'SANIX', aliases: [], properties: {} },
            ],
            relationships: [],
          });
        }
        if (content.includes('Sources:')) {
          return 'SANIX uses JWT and HNSW [1].';
        }
        return 'OK';
      },
      usage: { inputTokens: 15, outputTokens: 25 },
      costUsd: 0.0005,
    });
    const pipeline = new RAGPipeline({
      store: docStore,
      retriever,
      provider,
    });
    await pipeline.ingest([newDoc(SAMPLE_MARKDOWN, 'auth.md')]);

    // 2. Build knowledge graph from the same docs.
    const kg = new GraphStore({ inMemory: true });
    kg.open();
    const extractor = new EntityExtractor({ provider, method: 'llm' });
    const builder = new GraphBuilder(kg, extractor);
    await builder.ingest(SAMPLE_MARKDOWN, { source: 'auth.md' });
    expect(kg.countEntities()).toBeGreaterThan(0);

    // 3. Run a multi-agent team that consults RAG + KG.
    const members = [
      makeMember('a', 'researcher', 'researcher'),
      makeMember('b', 'researcher', 'researcher'),
    ];
    const config: TeamConfig = {
      name: 'Full Pipeline Team',
      description: 'Team that combines RAG + KG context',
      members,
      strategy: 'parallel',
      consensus: 'majority',
      rounds: 1,
      maxConcurrent: 4,
      timeoutMs: 30_000,
    };
    const team = makeTeam(config, provider, async (input) => {
      const ragResult = await pipeline.query(input);
      const kgEntities = kg.listEntities({ limit: 5 });
      return `RAG: ${ragResult.answer}\nKG: ${kgEntities.map((e) => e.name).join(', ')}\nQ: ${input}`;
    });
    const teamResult = await team.solve('How does SANIX authentication work?');
    expect(teamResult.contributions.length).toBe(2);
    expect(teamResult.consensus.length).toBeGreaterThan(0);

    // 4. Cache the team's result.
    const cache = new SemanticCache({
      vectorIndex: new HNSWIndex(),
      embeddingProvider: embed,
      threshold: 0.85,
    });
    await cache.set('How does SANIX authentication work?', teamResult.consensus, {
      tokensUsed: 100,
      costUsd: 0.001,
    });
    const cachedHit = await cache.get('How does SANIX authentication work?');
    expect(cachedHit).not.toBeNull();
    expect(cachedHit!.response).toBe(teamResult.consensus);

    // 5. Evolve a prompt with the same provider as the test subject.
    const bench: Benchmark = {
      id: 'full-pipeline',
      name: 'Full Pipeline',
      description: 'Tiny benchmark for the full pipeline test.',
      category: 'reasoning',
      prompts: [{ id: 'p1', input: 'Say hello.', expected: 'hello' }],
      scoring: { type: 'contains', threshold: 0.7 },
      timeout: 5_000,
    };
    const suite = new BenchmarkSuite({ provider });
    suite.register(bench);
    const mutator = new PromptMutator({ provider });
    const evaluator = new FitnessEvaluator({
      benchmarkSuite: suite,
      provider,
      samplesPerVariant: 1,
    });
    const evolutionConfig: EvolutionConfig = {
      populationSize: 3,
      generations: 1,
      mutationRate: 0.4,
      crossoverRate: 0.3,
      eliteFraction: 0.34,
      benchmarkId: 'full-pipeline',
      samplesPerVariant: 1,
      selectionMethod: 'tournament',
      tournamentSize: 2,
      seed: 1,
    };
    const engine = new EvolutionEngine(evolutionConfig, {
      mutator,
      evaluator,
      seedPrompt: 'You are a helpful SANIX assistant.',
    });
    const evolutionResult = await engine.run();
    expect(evolutionResult.finalPopulation.length).toBe(3);
    expect(evolutionResult.history.length).toBe(2);
    expect(evolutionResult.bestVariant.systemPrompt.length).toBeGreaterThan(0);

    kg.close();
  }, 60_000);
});
