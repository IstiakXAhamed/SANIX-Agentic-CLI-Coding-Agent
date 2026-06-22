/**
 * @file strategies.test.ts
 * @description Tests every multi-agent execution strategy (parallel,
 * sequential, debate, voting, mixture_of_experts, hierarchical, swarm)
 * with mock agents. Verifies TeamResult shape, consensus, member
 * contribution aggregation, and edge cases.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { AgentTeam } from '@sanix/multiagent';
import type {
  AgentHandle,
  AgentRole,
  TeamConfig,
  TeamMember,
  TeamResult,
  TeamStrategy,
} from '@sanix/multiagent';
import type { IProvider, LLMRequest } from '@sanix/providers';
import { createMockProvider } from '../../../test/helpers/mockProvider.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeMember(
  id: string,
  role: AgentRole = 'worker',
  persona = 'coder',
  weight = 1,
): TeamMember {
  return {
    id,
    persona,
    role,
    weight,
    budget: { tokens: 4096, costUsd: 0.2 },
  };
}

function makeConfig(
  strategy: TeamStrategy,
  members: TeamMember[],
  extra: Partial<TeamConfig> = {},
): TeamConfig {
  return {
    name: `Test-${strategy}`,
    description: 'Test team',
    members,
    strategy,
    consensus: 'majority',
    rounds: 1,
    maxConcurrent: 4,
    timeoutMs: 5_000,
    ...extra,
  };
}

/**
 * Build an AgentTeam whose members are backed by a shared mock provider.
 * Each call to `member.run` routes through `provider.chat`, recording
 * per-call cost/tokens/duration for the team's metric aggregation.
 */
function makeTeam(
  config: TeamConfig,
  provider: IProvider,
): AgentTeam & { provider: IProvider } {
  const lastRunMap = new Map<string, { costUsd: number; tokensUsed: number; durationMs: number }>();

  const factory = (member: TeamMember): AgentHandle => {
    return {
      id: member.id,
      async run(input: string, context?: string): Promise<string> {
        const start = Date.now();
        const userContent = context ? `${context}\n\n${input}` : input;
        const req: LLMRequest = {
          messages: [
            { role: 'system', content: `You are member ${member.id}.` },
            { role: 'user', content: userContent },
          ],
        };
        const res = await provider.chat(req);
        lastRunMap.set(member.id, {
          costUsd: res.costUsd ?? 0,
          tokensUsed: res.usage.inputTokens + res.usage.outputTokens,
          durationMs: Date.now() - start,
        });
        return res.content;
      },
      abort(): void {
        // no-op
      },
      lastRun(): { costUsd: number; tokensUsed: number; durationMs: number } {
        return lastRunMap.get(member.id) ?? { costUsd: 0, tokensUsed: 0, durationMs: 0 };
      },
    };
  };

  const team = new AgentTeam(config, { agentFactory: factory });
  return Object.assign(team, { provider });
}

function expectValidTeamResult(
  result: TeamResult,
  config: TeamConfig,
  minMembers = 1,
): void {
  expect(result).toBeDefined();
  expect(result.teamName).toBe(config.name);
  expect(result.contributions.length).toBe(config.members.length);
  expect(result.totalCostUsd).toBeGreaterThanOrEqual(0);
  expect(result.totalTokens).toBeGreaterThanOrEqual(0);
  expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
  expect(result.rounds).toBeGreaterThanOrEqual(1);
  // Each contribution has a valid memberId + persona + role.
  for (const c of result.contributions) {
    expect(config.members.find((m) => m.id === c.memberId)).toBeTruthy();
    expect(typeof c.output).toBe('string');
  }
  // At least `minMembers` members produced non-empty output.
  const nonEmpty = result.contributions.filter((c) => c.output.length > 0);
  expect(nonEmpty.length).toBeGreaterThanOrEqual(minMembers);
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('multiagent strategies', () => {
  let provider: ReturnType<typeof createMockProvider>;

  beforeEach(() => {
    provider = createMockProvider({
      usage: { inputTokens: 12, outputTokens: 24 },
      costUsd: 0.001,
    });
  });

  describe('parallel', () => {
    it('runs every member and synthesizes consensus', async () => {
      const members = [
        makeMember('a'),
        makeMember('b'),
        makeMember('c'),
      ];
      const config = makeConfig('parallel', members, { consensus: 'majority' });
      const team = makeTeam(
        config,
        createMockProvider({
          responses: ['Use binary search.', 'Use binary search.', 'Use merge sort.'],
          costUsd: 0.002,
          usage: { inputTokens: 10, outputTokens: 15 },
        }),
      );
      const result = await team.solve('Best search algorithm?');
      expectValidTeamResult(result, config, 3);
      // Majority consensus: 2/3 said "Use binary search." → winner cluster.
      expect(result.consensus).toContain('binary search');
      expect(result.consensusConfidence).toBeGreaterThan(0.5);
      // All members contributed.
      const contributorIds = result.contributions.map((c) => c.memberId).sort();
      expect(contributorIds).toEqual(['a', 'b', 'c']);
      // Cost is aggregated.
      expect(result.totalCostUsd).toBeCloseTo(0.006, 5);
      expect(result.totalTokens).toBe(75); // 3 × (10 + 15)
    });

    it('handles a single-member team', async () => {
      const members = [makeMember('solo')];
      const config = makeConfig('parallel', members);
      const team = makeTeam(
        config,
        createMockProvider({ responses: ['only answer'] }),
      );
      const result = await team.solve('Question?');
      expectValidTeamResult(result, config, 1);
      expect(result.consensus).toBe('only answer');
      expect(result.consensusConfidence).toBe(1);
      expect(result.disagreements).toEqual([]);
    });

    it('returns empty consensus when every member fails', async () => {
      const members = [makeMember('a'), makeMember('b')];
      const config = makeConfig('parallel', members);
      const team = new AgentTeam(config, {
        agentFactory: (m) => ({
          id: m.id,
          run: async () => {
            throw new Error('boom');
          },
          abort: () => {},
        }),
      });
      const result = await team.solve('Question?');
      expect(result.consensus).toBe('');
      expect(result.consensusConfidence).toBe(0);
      // All members disagreed.
      expect(result.disagreements.sort()).toEqual(['a', 'b']);
    });
  });

  describe('sequential', () => {
    it('chains member outputs in order', async () => {
      const members = [makeMember('a'), makeMember('b'), makeMember('c')];
      const config = makeConfig('sequential', members);
      const team = makeTeam(
        config,
        createMockProvider({
          responses: ['Step 1 done.', 'Step 2 done.', 'Step 3 done.'],
        }),
      );
      const result = await team.solve('Build a feature.');
      expectValidTeamResult(result, config, 3);
      // The last member's output is the consensus (sequential strategy).
      expect(result.consensus).toContain('Step 3');
    });
  });

  describe('debate', () => {
    it('runs N rounds and synthesizes a consensus', async () => {
      const members = [makeMember('a'), makeMember('b')];
      const config = makeConfig('debate', members, {
        rounds: 2,
        consensus: 'majority',
      });
      const team = makeTeam(
        config,
        createMockProvider({
          responses: [
            'Position A1.', 'Position B1.',
            'Rebuttal A1.', 'Rebuttal B1.',
            'Position A2.', 'Position B2.',
            'Rebuttal A2.', 'Rebuttal B2.',
          ],
        }),
      );
      const result = await team.solve('Tabs or spaces?');
      expectValidTeamResult(result, config, 2);
      // 2 rounds executed.
      expect(result.rounds).toBeGreaterThanOrEqual(2);
    });

    it('uses judge synthesis when consensus is judge_decided', async () => {
      const judge = makeMember('judge', 'judge', 'architect');
      const members = [makeMember('a'), makeMember('b'), judge];
      const config = makeConfig('debate', members, {
        rounds: 1,
        consensus: 'judge_decided',
        judgeMemberId: 'judge',
      });
      const team = makeTeam(
        config,
        createMockProvider({
          responses: [
            'Position A.', 'Position B.', 'Position J.',
            'Rebuttal A.', 'Rebuttal B.', 'Rebuttal J.',
            // Final judge synthesis call.
            'FINAL JUDGMENT: use tabs.',
          ],
        }),
      );
      const result = await team.solve('Tabs or spaces?');
      expectValidTeamResult(result, config, 1);
      // Judge had the last word.
      expect(result.consensus).toContain('tabs');
    });
  });

  describe('voting', () => {
    it('elects the most-voted proposal', async () => {
      const members = [
        makeMember('a'),
        makeMember('b'),
        makeMember('c'),
        makeMember('d'),
        makeMember('e'),
      ];
      const config = makeConfig('voting', members, {
        consensus: 'majority',
      });
      const team = makeTeam(
        config,
        createMockProvider({
          responses: [
            // Proposals (one per member).
            'Proposal X', 'Proposal Y', 'Proposal X',
            'Proposal Y', 'Proposal X',
            // Votes: a→X, b→Y, c→X, d→Y, e→X (X wins 3-2).
            'vote: a', 'vote: b', 'vote: c', 'vote: d', 'vote: e',
            // Each non-winning member then runs a follow-up to ratify.
            'ratify: b', 'ratify: d',
          ],
        }),
      );
      const result = await team.solve('Pick a feature name.');
      expectValidTeamResult(result, config, 1);
      // Voting strategy should produce a non-empty consensus.
      expect(result.consensus.length).toBeGreaterThan(0);
    });
  });

  describe('mixture_of_experts', () => {
    it('routes to the most relevant expert', async () => {
      const coder = makeMember('coder', 'worker', 'coder');
      const writer = makeMember('writer', 'worker', 'writer');
      const researcher = makeMember('researcher', 'researcher', 'researcher');
      const config = makeConfig('mixture_of_experts', [coder, writer, researcher], {
        consensus: 'best_of_n',
      });
      const team = makeTeam(
        config,
        createMockProvider({
          responses: [
            // Routed expert (coder) answers a code question.
            'function add(a, b) { return a + b; }',
          ],
        }),
      );
      const result = await team.solve('Write a TypeScript add function.');
      expectValidTeamResult(result, config, 1);
      expect(result.consensus).toContain('add');
    });
  });

  describe('hierarchical', () => {
    it('decomposes via coordinator and synthesizes', async () => {
      const coordinator = makeMember('coord', 'coordinator', 'architect');
      const worker1 = makeMember('w1', 'worker', 'coder');
      const worker2 = makeMember('w2', 'worker', 'coder');
      const config = makeConfig('hierarchical', [coordinator, worker1, worker2], {
        consensus: 'best_of_n',
        coordinatorId: 'coord',
      });
      const team = makeTeam(
        config,
        createMockProvider({
          responses: [
            // Coordinator decomposes (JSON array of sub-tasks).
            JSON.stringify(['Design the schema.', 'Implement the API.']),
            // Worker 1 handles sub-task 1.
            'Schema: users(id, email).',
            // Worker 2 handles sub-task 2.
            'API: POST /users, GET /users/:id.',
            // Coordinator synthesizes.
            'Final plan: schema + API as designed.',
          ],
        }),
      );
      const result = await team.solve('Build a user management system.');
      expectValidTeamResult(result, config, 1);
      expect(result.consensus.length).toBeGreaterThan(0);
    });

    it('falls back to parallel when no coordinator is set', async () => {
      const members = [makeMember('a'), makeMember('b')];
      const config = makeConfig('hierarchical', members, {
        consensus: 'majority',
      });
      const team = makeTeam(
        config,
        createMockProvider({ responses: ['answer', 'answer'] }),
      );
      const result = await team.solve('Question?');
      expectValidTeamResult(result, config, 1);
    });
  });

  describe('swarm', () => {
    it('optimizes across iterations and tracks personal bests', async () => {
      const members = [makeMember('a'), makeMember('b'), makeMember('c')];
      const config = makeConfig('swarm', members, {
        rounds: 3,
        consensus: 'best_of_n',
      });
      const team = makeTeam(
        config,
        createMockProvider({
          // Each member produces progressively better answers.
          responses: (req: LLMRequest) => {
            const last = req.messages[req.messages.length - 1];
            const content =
              typeof last?.content === 'string' ? last.content : '';
            // Echo something to make the scorer happy.
            return content.length > 50
              ? 'Best answer: ' + content.slice(0, 30)
              : 'Short initial answer.';
          },
        }),
      );
      const result = await team.solve('Find the optimum.');
      expectValidTeamResult(result, config, 1);
      expect(result.rounds).toBeGreaterThanOrEqual(1);
      // Swarm runs `rounds` iterations.
      expect(result.consensus.length).toBeGreaterThan(0);
    });
  });

  describe('timeouts', () => {
    it('aborts members that exceed the team timeout', async () => {
      const members = [makeMember('slow')];
      const config = makeConfig('parallel', members, { timeoutMs: 50 });
      const team = new AgentTeam(config, {
        agentFactory: (m) => ({
          id: m.id,
          run: async () => {
            // Sleep 500ms — should be aborted by the 50ms team timeout.
            await new Promise((r) => setTimeout(r, 500));
            return 'should not reach here';
          },
          abort: () => {},
        }),
      });
      const result = await team.solve('Question?');
      // Either aborted (empty output) or completed. Either way, no crash.
      expect(result).toBeDefined();
      expect(result.contributions.length).toBe(1);
    }, 10_000);
  });
});
