/**
 * @file smoke.test.ts
 * @description Basic smoke tests verifying all packages can be imported
 * and that each exports expected public symbols.
 */
import { describe, it, expect } from 'vitest';

describe('smoke: packages can be imported', () => {
  it('@sanix/multiagent exports AgentTeam + ConsensusEngine', async () => {
    const mod = await import('@sanix/multiagent');
    expect(mod.AgentTeam).toBeDefined();
    expect(mod.ConsensusEngine).toBeDefined();
    expect(mod.QualityScorer).toBeDefined();
    expect(mod.MoERouter).toBeDefined();
    expect(mod.TeamCoordinator).toBeDefined();
    expect(typeof mod.getStrategy).toBe('function');
    expect(Array.isArray(mod.TEAM_TEMPLATES)).toBe(true);
    expect(mod.TEAM_TEMPLATES.length).toBe(6);
  });

  it('@sanix/multiagent/strategies exports all 7 strategies', async () => {
    const mod = await import('@sanix/multiagent/strategies');
    expect(mod.ParallelStrategy).toBeDefined();
    expect(mod.SequentialStrategy).toBeDefined();
    expect(mod.DebateStrategy).toBeDefined();
    expect(mod.VotingStrategy).toBeDefined();
    expect(mod.MoEStrategy).toBeDefined();
    expect(mod.HierarchicalStrategy).toBeDefined();
    expect(mod.SwarmStrategy).toBeDefined();
    expect(typeof mod.getStrategy).toBe('function');
  });

  it('@sanix/multiagent/templates exports all 6 templates', async () => {
    const mod = await import('@sanix/multiagent/templates');
    expect(mod.CODE_REVIEW_TEAM).toBeDefined();
    expect(mod.RESEARCH_TEAM).toBeDefined();
    expect(mod.BUG_FIX_TEAM).toBeDefined();
    expect(mod.BRAINSTORM_TEAM).toBeDefined();
    expect(mod.MOE_TEAM).toBeDefined();
    expect(mod.SWARM_TEAM).toBeDefined();
    expect(typeof mod.getTeamTemplate).toBe('function');
    expect(typeof mod.listTeamTemplates).toBe('function');
  });

  it('@sanix/rag exports RAGPipeline + HybridRetriever + Reranker', async () => {
    const mod = await import('@sanix/rag');
    expect(mod.RAGPipeline).toBeDefined();
    expect(mod.DocumentStore).toBeDefined();
    expect(mod.HybridRetriever).toBeDefined();
    expect(mod.Reranker).toBeDefined();
    expect(mod.QueryRewriter).toBeDefined();
    expect(mod.MultiHopRetriever).toBeDefined();
    expect(mod.BM25Index).toBeDefined();
    expect(mod.KeywordIndex).toBeDefined();
    expect(mod.CitationExtractor).toBeDefined();
    expect(typeof mod.DEFAULT_RAG_SYSTEM_PROMPT).toBe('string');
  });

  it('@sanix/semantic-cache exports SemanticCache + CachedProviderRouter', async () => {
    const mod = await import('@sanix/semantic-cache');
    expect(mod.SemanticCache).toBeDefined();
    expect(mod.CachedProviderRouter).toBeDefined();
    expect(mod.CacheMetadataStore).toBeDefined();
    expect(typeof mod.createEmbeddingProvider).toBe('function');
  });

  it('@sanix/knowledge exports GraphStore + GraphBuilder + DSL + Visualizer', async () => {
    const mod = await import('@sanix/knowledge');
    expect(mod.GraphStore).toBeDefined();
    expect(mod.GraphBuilder).toBeDefined();
    expect(mod.EntityExtractor).toBeDefined();
    expect(mod.GraphQueryDSL).toBeDefined();
    expect(mod.GraphVisualizer).toBeDefined();
    expect(mod.KnowledgeIndex).toBeDefined();
    expect(mod.KnowledgeManager).toBeDefined();
    expect(typeof mod.ENTITY_COLORS).toBe('object');
    expect(mod.DSLParseError).toBeDefined();
    expect(typeof mod.newEntityId).toBe('function');
  });

  it('@sanix/sandbox exports SandboxManager + REPLManager + runtimes', async () => {
    const mod = await import('@sanix/sandbox');
    expect(mod.SandboxManager).toBeDefined();
    expect(mod.REPLManager).toBeDefined();
    expect(mod.ArtifactManager).toBeDefined();
    expect(mod.SandboxExecuteTool).toBeDefined();
    expect(mod.NodeRuntime).toBeDefined();
    expect(mod.PythonRuntime).toBeDefined();
    expect(mod.BashRuntime).toBeDefined();
    expect(mod.ProcessIsolation).toBeDefined();
    expect(typeof mod.getRuntimeAdapter).toBe('function');
    expect(typeof mod.getIsolationBackend).toBe('function');
  });

  it('@sanix/self-improve exports EvolutionEngine + ABTester + Mutator', async () => {
    const mod = await import('@sanix/self-improve');
    expect(mod.EvolutionEngine).toBeDefined();
    expect(mod.ABTester).toBeDefined();
    expect(mod.PromptMutator).toBeDefined();
    expect(mod.FitnessEvaluator).toBeDefined();
    expect(mod.Selection).toBeDefined();
    expect(mod.PromptRegistry).toBeDefined();
    expect(mod.MetaLearner).toBeDefined();
    expect(mod.SelfImprovementManager).toBeDefined();
    expect(Array.isArray(mod.ALL_MUTATION_TYPES)).toBe(true);
    expect(mod.DEFAULT_EVOLUTION_CONFIG).toBeDefined();
  });

  it('@sanix/providers exports IProvider contract + ProviderRouter', async () => {
    const mod = await import('@sanix/providers');
    expect(mod.ProviderRouter).toBeDefined();
    expect(mod.CircuitBreaker).toBeDefined();
    expect(mod.ProviderError).toBeDefined();
    expect(mod.RateLimitError).toBeDefined();
    expect(typeof mod.PROVIDER_CAPABILITIES).toBe('object');
  });

  it('@sanix/memory-v2 exports HNSWIndex', async () => {
    const mod = await import('@sanix/memory-v2');
    expect(mod.HNSWIndex).toBeDefined();
    expect(mod.ForgettingCurve).toBeDefined();
    expect(mod.SalienceScorer).toBeDefined();
    expect(mod.SemanticDeduplicator).toBeDefined();
    expect(mod.TierManager).toBeDefined();
  });

  it('@sanix/bench exports BenchmarkSuite + reporters', async () => {
    const mod = await import('@sanix/bench');
    expect(mod.BenchmarkSuite).toBeDefined();
    expect(typeof mod.formatReport).toBe('function');
    expect(typeof mod.formatJSON).toBe('function');
    expect(typeof mod.formatMarkdown).toBe('function');
    expect(Array.isArray(mod.BUILTIN_BENCHMARKS)).toBe(true);
  });
});

describe('smoke: type shapes', () => {
  it('TeamConfig has the expected required fields', async () => {
    const { RESEARCH_TEAM } = await import('@sanix/multiagent');
    expect(RESEARCH_TEAM.name).toBeTruthy();
    expect(RESEARCH_TEAM.strategy).toBeTruthy();
    expect(RESEARCH_TEAM.consensus).toBeTruthy();
    expect(Array.isArray(RESEARCH_TEAM.members)).toBe(true);
    expect(RESEARCH_TEAM.members.length).toBeGreaterThan(0);
  });

  it('DEFAULT_RAG_SYSTEM_PROMPT mentions sources / citations', async () => {
    const { DEFAULT_RAG_SYSTEM_PROMPT } = await import('@sanix/rag');
    expect(DEFAULT_RAG_SYSTEM_PROMPT.length).toBeGreaterThan(20);
    expect(DEFAULT_RAG_SYSTEM_PROMPT.toLowerCase()).toMatch(/source|cit/);
  });

  it('DEFAULT_EVOLUTION_CONFIG has the expected defaults', async () => {
    const { DEFAULT_EVOLUTION_CONFIG } = await import('@sanix/self-improve');
    expect(DEFAULT_EVOLUTION_CONFIG.populationSize).toBeGreaterThan(0);
    expect(DEFAULT_EVOLUTION_CONFIG.generations).toBeGreaterThan(0);
    expect(DEFAULT_EVOLUTION_CONFIG.mutationRate).toBeGreaterThan(0);
    expect(DEFAULT_EVOLUTION_CONFIG.crossoverRate).toBeGreaterThanOrEqual(0);
  });
});
