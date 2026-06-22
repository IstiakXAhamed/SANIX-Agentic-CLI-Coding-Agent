/**
 * @file dsl.test.ts
 * @description Tests the GraphQueryDSL: MATCH + RETURN, WHERE, variable-
 * length paths, ORDER BY + LIMIT, and parse errors.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GraphStore, GraphQueryDSL, DSLParseError } from '@sanix/knowledge';
import type { Entity } from '@sanix/knowledge';
import { newEntityId, newRelationshipId } from '@sanix/knowledge';

function entity(type: Entity['type'], name: string): Entity {
  const now = Date.now();
  return {
    id: newEntityId(),
    type,
    name,
    aliases: [],
    properties: {},
    source: 'test',
    confidence: 0.9,
    createdAt: now,
    updatedAt: now,
  };
}

function rel(type: string, source: string, target: string) {
  const now = Date.now();
  return {
    id: newRelationshipId(),
    type,
    source,
    target,
    properties: {},
    confidence: 0.9,
    evidence: [],
    source_meta: 'test',
    createdAt: now,
    updatedAt: now,
  };
}

describe('GraphQueryDSL', () => {
  let store: GraphStore;
  let dsl: GraphQueryDSL;
  let alice: Entity;
  let bob: Entity;
  let acme: Entity;
  let beta: Entity;

  beforeEach(() => {
    store = new GraphStore({ inMemory: true });
    store.open();
    dsl = new GraphQueryDSL();

    alice = entity('person', 'Alice');
    bob = entity('person', 'Bob');
    acme = entity('organization', 'Acme');
    beta = entity('organization', 'Beta');
    store.addEntity(alice);
    store.addEntity(bob);
    store.addEntity(acme);
    store.addEntity(beta);
    store.addRelationship(rel('works_at', alice.id, acme.id));
    store.addRelationship(rel('works_at', bob.id, beta.id));
    store.addRelationship(rel('partnered_with', acme.id, beta.id));
    store.addRelationship(rel('knows', alice.id, bob.id));
  });

  afterEach(() => {
    store.close();
  });

  describe('simple MATCH + RETURN', () => {
    it('matches all entities of a given type', async () => {
      const parsed = dsl.parse('MATCH (n:person) RETURN n');
      const result = await dsl.execute(parsed, store);
      expect(result.matched.length).toBe(2); // Alice + Bob
      // All matched items should be person-typed nodes.
      for (const m of result.matched) {
        if ('entity' in m) {
          expect(m.entity.type).toBe('person');
        }
      }
    });

    it('matches all entities when no type filter is supplied', async () => {
      const parsed = dsl.parse('MATCH (n) RETURN n');
      const result = await dsl.execute(parsed, store);
      expect(result.matched.length).toBe(4);
    });
  });

  describe('MATCH with relationship + WHERE', () => {
    it('matches (n:person)-[:works_at]->(o:organization) and filters by name', async () => {
      const q = `MATCH (n:person)-[:works_at]->(o:organization) WHERE o.name = 'Acme' RETURN n`;
      const parsed = dsl.parse(q);
      const result = await dsl.execute(parsed, store);
      // Only Alice works_at Acme.
      const matchedNames = result.matched.map((m) =>
        'entity' in m ? m.entity.name : '',
      );
      expect(matchedNames).toContain('Alice');
      expect(matchedNames).not.toContain('Bob');
    });

    it('WHERE != excludes matching rows', async () => {
      const q = `MATCH (n:person) WHERE n.name != 'Alice' RETURN n`;
      const result = await dsl.execute(dsl.parse(q), store);
      const names = result.matched.map((m) =>
        'entity' in m ? m.entity.name : '',
      );
      expect(names).not.toContain('Alice');
      expect(names).toContain('Bob');
    });

    it('WHERE contains-like via != matches entities not equal to value', async () => {
      // The DSL only supports =, !=, <, <=, >, >=. Verify != works.
      const q = `MATCH (n:organization) WHERE n.name != 'Beta' RETURN n`;
      const result = await dsl.execute(dsl.parse(q), store);
      const names = result.matched.map((m) =>
        'entity' in m ? m.entity.name : '',
      );
      expect(names).toContain('Acme');
      expect(names).not.toContain('Beta');
    });
  });

  describe('variable-length paths', () => {
    it('matches *1..2 hops between Alice and Beta', async () => {
      // alice -[:knows]-> bob -[:works_at]-> Beta   (2 hops, mixed types)
      // alice -[:works_at]-> Acme -[:partnered_with]-> Beta   (2 hops)
      // Use an untyped edge so any relationship type qualifies.
      const q = `MATCH (n:person)-[*1..2]->(m:organization) RETURN m`;
      const result = await dsl.execute(dsl.parse(q), store);
      // Beta is reachable from Alice in 2 hops (multiple paths).
      const names = result.matched.map((m) =>
        'entity' in m ? m.entity.name : '',
      );
      expect(names).toContain('Beta');
    });

    it('matches *1..1 single-hop with type filter', async () => {
      const q = `MATCH (n:person)-[:works_at*1..1]->(o:organization) RETURN o`;
      const result = await dsl.execute(dsl.parse(q), store);
      // Both Acme and Beta should be reachable in exactly 1 hop of :works_at.
      const names = result.matched.map((m) =>
        'entity' in m ? m.entity.name : '',
      );
      expect(names).toContain('Acme');
      expect(names).toContain('Beta');
    });
  });

  describe('ORDER BY + LIMIT', () => {
    it('orders by name ascending', async () => {
      const q = `MATCH (n:person) RETURN n ORDER BY n.name ASC`;
      const result = await dsl.execute(dsl.parse(q), store);
      const names = result.matched.map((m) =>
        'entity' in m ? m.entity.name : '',
      );
      expect(names).toEqual(['Alice', 'Bob']);
    });

    it('orders by name descending', async () => {
      const q = `MATCH (n:person) RETURN n ORDER BY n.name DESC`;
      const result = await dsl.execute(dsl.parse(q), store);
      const names = result.matched.map((m) =>
        'entity' in m ? m.entity.name : '',
      );
      expect(names).toEqual(['Bob', 'Alice']);
    });

    it('limits results', async () => {
      const q = `MATCH (n) RETURN n LIMIT 2`;
      const result = await dsl.execute(dsl.parse(q), store);
      expect(result.matched.length).toBeLessThanOrEqual(2);
    });

    it('combines ORDER BY + LIMIT', async () => {
      const q = `MATCH (n:person) RETURN n ORDER BY n.name ASC LIMIT 1`;
      const result = await dsl.execute(dsl.parse(q), store);
      expect(result.matched.length).toBe(1);
      const name = (result.matched[0] as { entity: Entity }).entity.name;
      expect(name).toBe('Alice');
    });
  });

  describe('parse errors', () => {
    it('throws DSLParseError on invalid syntax', () => {
      expect(() => dsl.parse('MATCH (n:person RETURN n')).toThrow(DSLParseError);
    });

    it('throws on missing RETURN', () => {
      expect(() => dsl.parse('MATCH (n:person)')).toThrow(DSLParseError);
    });

    it('throws on unterminated string literal', () => {
      expect(() =>
        dsl.parse(`MATCH (n) WHERE n.name = 'unterminated RETURN n`),
      ).toThrow(DSLParseError);
    });

    it('DSLParseError carries line/column/token info', () => {
      try {
        dsl.parse('MATCH (n:person RETURN n');
        fail('Expected DSLParseError');
      } catch (err) {
        expect(err).toBeInstanceOf(DSLParseError);
        const e = err as DSLParseError;
        expect(e.line).toBeGreaterThanOrEqual(1);
        expect(e.column).toBeGreaterThanOrEqual(1);
        expect(typeof e.token).toBe('string');
        expect(e.message).toContain('DSL parse error');
      }
    });
  });
});
