/**
 * @file templates.test.ts
 * @description Verifies the 6 built-in team templates are well-formed and
 * that `getTeamTemplate` returns null for unknown names.
 */
import { describe, it, expect } from 'vitest';
import {
  TEAM_TEMPLATES,
  getTeamTemplate,
  listTeamTemplates,
  CODE_REVIEW_TEAM,
  RESEARCH_TEAM,
  BUG_FIX_TEAM,
  BRAINSTORM_TEAM,
  MOE_TEAM,
  SWARM_TEAM,
} from '@sanix/multiagent';

const EXPECTED_NAMES = [
  'code-review-team',
  'research-team',
  'bug-fix-team',
  'brainstorm-team',
  'moe-team',
  'swarm-team',
];

describe('team templates', () => {
  it('exports exactly 6 templates', () => {
    expect(TEAM_TEMPLATES).toHaveLength(6);
  });

  it('listTeamTemplates returns the 6 known names', () => {
    const names = listTeamTemplates();
    expect(names.sort()).toEqual([...EXPECTED_NAMES].sort());
  });

  it('every template has members + strategy + consensus', () => {
    for (const t of TEAM_TEMPLATES) {
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.members.length).toBeGreaterThanOrEqual(1);
      expect(t.strategy).toBeTruthy();
      expect(t.consensus).toBeTruthy();
      expect(t.rounds).toBeGreaterThanOrEqual(1);
      expect(t.maxConcurrent).toBeGreaterThanOrEqual(1);
      expect(t.timeoutMs).toBeGreaterThan(0);
      // Every member has the required fields.
      for (const m of t.members) {
        expect(m.id.length).toBeGreaterThan(0);
        expect(m.persona.length).toBeGreaterThan(0);
        expect(m.role).toBeTruthy();
        expect(typeof m.weight).toBe('number');
        expect(m.budget.tokens).toBeGreaterThan(0);
        expect(m.budget.costUsd).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('each template uses a distinct strategy', () => {
    const strategies = new Set(TEAM_TEMPLATES.map((t) => t.strategy));
    // The 6 templates cover 6 distinct strategies.
    expect(strategies.size).toBe(6);
  });

  it('every member id is unique within its team', () => {
    for (const t of TEAM_TEMPLATES) {
      const ids = t.members.map((m) => m.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('getTeamTemplate returns the matching config', () => {
    expect(getTeamTemplate('code-review-team')).toBe(CODE_REVIEW_TEAM);
    expect(getTeamTemplate('research-team')).toBe(RESEARCH_TEAM);
    expect(getTeamTemplate('bug-fix-team')).toBe(BUG_FIX_TEAM);
    expect(getTeamTemplate('brainstorm-team')).toBe(BRAINSTORM_TEAM);
    expect(getTeamTemplate('moe-team')).toBe(MOE_TEAM);
    expect(getTeamTemplate('swarm-team')).toBe(SWARM_TEAM);
  });

  it('getTeamTemplate returns null for unknown names', () => {
    expect(getTeamTemplate('does-not-exist')).toBeNull();
    expect(getTeamTemplate('')).toBeNull();
    expect(getTeamTemplate('Code-Review-Team')).toBeNull(); // case-sensitive
  });

  it('templates that need a judge have a judgeMemberId', () => {
    for (const t of TEAM_TEMPLATES) {
      if (t.consensus === 'judge_decided') {
        expect(t.judgeMemberId).toBeTruthy();
        expect(
          t.members.find((m) => m.id === t.judgeMemberId),
        ).toBeTruthy();
      }
    }
  });

  it('templates that use hierarchical strategy have a coordinatorId', () => {
    for (const t of TEAM_TEMPLATES) {
      if (t.strategy === 'hierarchical') {
        expect(t.coordinatorId).toBeTruthy();
        expect(
          t.members.find((m) => m.id === t.coordinatorId),
        ).toBeTruthy();
      }
    }
  });

  it('moE-team has at least 3 expert members with distinct personas', () => {
    expect(MOE_TEAM.members.length).toBeGreaterThanOrEqual(3);
    const personas = new Set(MOE_TEAM.members.map((m) => m.persona));
    expect(personas.size).toBe(MOE_TEAM.members.length);
  });

  it('swarm-team has rounds ≥ 2 (PSO needs multiple iterations)', () => {
    expect(SWARM_TEAM.rounds).toBeGreaterThanOrEqual(2);
  });
});
