/**
 * @file graph.test.ts
 * @description Tests GraphStore CRUD + traversal: entities, relationships,
 * getNeighbors, getSubgraph, shortestPath, mergeEntities.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  GraphStore,
  GraphBuilder,
  newEntityId,
  newRelationshipId,
} from '@sanix/knowledge';
import { EntityExtractor } from '@sanix/knowledge';
import type { Entity, Relationship } from '@sanix/knowledge';
import { createMockProvider } from '../../../test/helpers/mockProvider.js';

function person(name: string, aliases: string[] = []): Entity {
  const now = Date.now();
  return {
    id: newEntityId(),
    type: 'person',
    name,
    aliases,
    properties: {},
    source: 'test',
    confidence: 0.9,
    createdAt: now,
    updatedAt: now,
  };
}

function org(name: string): Entity {
  const now = Date.now();
  return {
    id: newEntityId(),
    type: 'organization',
    name,
    aliases: [],
    properties: {},
    source: 'test',
    confidence: 0.9,
    createdAt: now,
    updatedAt: now,
  };
}

function rel(
  type: string,
  source: string,
  target: string,
  evidence: string[] = [],
): Relationship {
  const now = Date.now();
  return {
    id: newRelationshipId(),
    type,
    source,
    target,
    properties: {},
    confidence: 0.9,
    evidence,
    source_meta: 'test',
    createdAt: now,
    updatedAt: now,
  };
}

describe('GraphStore', () => {
  let store: GraphStore;

  beforeEach(() => {
    store = new GraphStore({ inMemory: true });
    store.open();
  });

  afterEach(() => {
    store.close();
  });

  describe('entity CRUD', () => {
    it('addEntity + getEntity round-trips', () => {
      const alice = person('Alice');
      store.addEntity(alice);
      const got = store.getEntity(alice.id);
      expect(got).toBeDefined();
      expect(got!.name).toBe('Alice');
      expect(got!.type).toBe('person');
      expect(got!.aliases).toEqual([]);
    });

    it('getEntity returns undefined for unknown ids', () => {
      expect(store.getEntity('does-not-exist')).toBeUndefined();
    });

    it('getEntityByName finds by case-insensitive name', () => {
      const alice = person('Alice');
      store.addEntity(alice);
      expect(store.getEntityByName('alice')).toBeDefined();
      expect(store.getEntityByName('ALICE')).toBeDefined();
      expect(store.getEntityByName('bob')).toBeUndefined();
    });

    it('updateEntity patches fields and bumps updatedAt', () => {
      const alice = person('Alice');
      store.addEntity(alice);
      const original = store.getEntity(alice.id)!;
      // Pause to ensure updatedAt differs.
      const updated = store.updateEntity(alice.id, {
        description: 'A software engineer.',
        aliases: ['Al'],
      });
      expect(updated).toBeDefined();
      expect(updated!.description).toBe('A software engineer.');
      expect(updated!.aliases).toContain('Al');
      expect(updated!.updatedAt).toBeGreaterThanOrEqual(original.updatedAt);
    });

    it('updateEntity returns undefined for unknown id', () => {
      expect(store.updateEntity('nope', { description: 'x' })).toBeUndefined();
    });

    it('deleteEntity removes the entity', () => {
      const alice = person('Alice');
      store.addEntity(alice);
      expect(store.deleteEntity(alice.id)).toBe(true);
      expect(store.getEntity(alice.id)).toBeUndefined();
    });

    it('deleteEntity returns false for unknown id', () => {
      expect(store.deleteEntity('nope')).toBe(false);
    });

    it('listEntities filters by type', () => {
      store.addEntity(person('Alice'));
      store.addEntity(org('Acme'));
      store.addEntity(org('Beta'));
      const orgs = store.listEntities({ type: 'organization' });
      expect(orgs).toHaveLength(2);
      const persons = store.listEntities({ type: 'person' });
      expect(persons).toHaveLength(1);
    });
  });

  describe('relationship CRUD', () => {
    it('addRelationship + getRelationships (out direction)', () => {
      const alice = person('Alice');
      const acme = org('Acme');
      store.addEntity(alice);
      store.addEntity(acme);
      store.addRelationship(rel('works_at', alice.id, acme.id, ['Alice works at Acme.']));

      const out = store.getRelationships(alice.id, { direction: 'out' });
      expect(out).toHaveLength(1);
      expect(out[0]!.type).toBe('works_at');
      expect(out[0]!.source).toBe(alice.id);
      expect(out[0]!.target).toBe(acme.id);

      const inc = store.getRelationships(acme.id, { direction: 'in' });
      expect(inc).toHaveLength(1);
      expect(inc[0]!.type).toBe('works_at');

      const both = store.getRelationships(alice.id, { direction: 'both' });
      expect(both).toHaveLength(1);
    });

    it('filters relationships by type', () => {
      const alice = person('Alice');
      const acme = org('Acme');
      store.addEntity(alice);
      store.addEntity(acme);
      store.addRelationship(rel('works_at', alice.id, acme.id));
      store.addRelationship(rel('created', alice.id, acme.id));
      const filtered = store.getRelationships(alice.id, {
        direction: 'out',
        type: 'works_at',
      });
      expect(filtered).toHaveLength(1);
      expect(filtered[0]!.type).toBe('works_at');
    });

    it('deleteRelationship removes a relationship', () => {
      const alice = person('Alice');
      const acme = org('Acme');
      store.addEntity(alice);
      store.addEntity(acme);
      const r = rel('works_at', alice.id, acme.id);
      store.addRelationship(r);
      expect(store.deleteRelationship(r.id)).toBe(true);
      expect(store.getRelationships(alice.id, { direction: 'out' })).toHaveLength(0);
    });

    it('cascades relationship deletion when an entity is deleted', () => {
      const alice = person('Alice');
      const acme = org('Acme');
      store.addEntity(alice);
      store.addEntity(acme);
      store.addRelationship(rel('works_at', alice.id, acme.id));
      store.deleteEntity(alice.id);
      // The relationship should be gone (FK cascade).
      expect(store.getRelationships(acme.id, { direction: 'in' })).toHaveLength(0);
    });
  });

  describe('graph traversal', () => {
    function buildGraph(): { alice: Entity; bob: Entity; acme: Entity; beta: Entity } {
      const alice = person('Alice');
      const bob = person('Bob');
      const acme = org('Acme');
      const beta = org('Beta');
      store.addEntity(alice);
      store.addEntity(bob);
      store.addEntity(acme);
      store.addEntity(beta);
      store.addRelationship(rel('works_at', alice.id, acme.id));
      store.addRelationship(rel('works_at', bob.id, beta.id));
      store.addRelationship(rel('partnered_with', acme.id, beta.id));
      store.addRelationship(rel('knows', alice.id, bob.id));
      return { alice, bob, acme, beta };
    }

    it('getNeighbors returns BFS distances', () => {
      const { alice, bob, acme, beta } = buildGraph();
      const neighbors = store.getNeighbors(alice.id, 2);
      // alice=0, bob=1 (knows), acme=1 (works_at), beta=2 (acme partnered_with)
      expect(neighbors.get(alice.id)).toBe(0);
      expect(neighbors.get(bob.id)).toBe(1);
      expect(neighbors.get(acme.id)).toBe(1);
      expect(neighbors.get(beta.id)).toBe(2);
    });

    it('getNeighbors with depth=0 returns only the root', () => {
      const { alice } = buildGraph();
      const neighbors = store.getNeighbors(alice.id, 0);
      expect(neighbors.size).toBe(1);
      expect(neighbors.get(alice.id)).toBe(0);
    });

    it('getSubgraph returns nodes + edges within depth', () => {
      const { alice } = buildGraph();
      const sub = store.getSubgraph(alice.id, 1);
      expect(sub.rootEntityId).toBe(alice.id);
      expect(sub.depth).toBe(1);
      // Root + 2 direct neighbors (bob, acme).
      expect(sub.nodes.length).toBeGreaterThanOrEqual(3);
      // Edges among the subgraph.
      expect(sub.edges.length).toBeGreaterThanOrEqual(2);
    });

    it('shortestPath finds the minimum-hop path', () => {
      const { alice, beta } = buildGraph();
      // alice → bob → ? no. alice → acme → beta is the shortest.
      // Also alice → bob, but bob→beta is 1 hop via works_at, so
      // alice→bob→beta = 2 hops, same as alice→acme→beta.
      const path = store.shortestPath(alice.id, beta.id);
      expect(path).toBeDefined();
      expect(path![0]).toBe(alice.id);
      expect(path![path!.length - 1]).toBe(beta.id);
      expect(path!.length).toBeLessThanOrEqual(3);
    });

    it('shortestPath returns undefined when no path exists', () => {
      const alice = person('Alice');
      const bob = person('Bob');
      store.addEntity(alice);
      store.addEntity(bob);
      // No relationship between them.
      expect(store.shortestPath(alice.id, bob.id)).toBeUndefined();
    });

    it('shortestPath returns [start] when start === end', () => {
      const { alice } = buildGraph();
      const path = store.shortestPath(alice.id, alice.id);
      expect(path).toEqual([alice.id]);
    });
  });

  describe('mergeEntities (via GraphBuilder)', () => {
    it('merges aliases + properties when entities are merged', async () => {
      const extractor = new EntityExtractor({
        provider: createMockProvider({ responses: '[]' }),
        method: 'regex',
      });
      const builder = new GraphBuilder(store, extractor);

      const alice = person('Alice', ['Al']);
      const aliceSmith = person('Alice Smith', ['Ali']);
      store.addEntity(alice);
      store.addEntity(aliceSmith);
      const acme = org('Acme');
      store.addEntity(acme);

      // alice works_at acme; aliceSmith created acme.
      store.addRelationship(rel('works_at', alice.id, acme.id));
      store.addRelationship(rel('created', aliceSmith.id, acme.id));

      // Merge aliceSmith INTO alice.
      await builder.mergeEntities(alice.id, aliceSmith.id);

      // aliceSmith should be gone.
      expect(store.getEntity(aliceSmith.id)).toBeUndefined();
      // alice should have absorbed aliceSmith's name as an alias.
      const merged = store.getEntity(alice.id)!;
      expect(merged.aliases).toContain('Alice Smith');
      // Alice's original aliases are preserved.
      expect(merged.aliases).toContain('Al');
      // Alice's properties accumulate the `sources` array.
      expect(Array.isArray(merged.properties['sources'])).toBe(true);
    });

    it('is a no-op when target === source', async () => {
      const extractor = new EntityExtractor({ method: 'regex' });
      const builder = new GraphBuilder(store, extractor);
      const alice = person('Alice');
      store.addEntity(alice);
      await builder.mergeEntities(alice.id, alice.id);
      expect(store.getEntity(alice.id)).toBeDefined();
    });

    it('is a no-op when either entity is missing', async () => {
      const extractor = new EntityExtractor({ method: 'regex' });
      const builder = new GraphBuilder(store, extractor);
      const alice = person('Alice');
      store.addEntity(alice);
      // Bob was never added — merge should be a no-op.
      await builder.mergeEntities(alice.id, 'does-not-exist');
      expect(store.getEntity(alice.id)).toBeDefined();
    });
  });

  describe('aggregations', () => {
    it('countByType groups entities', () => {
      store.addEntity(person('Alice'));
      store.addEntity(person('Bob'));
      store.addEntity(org('Acme'));
      const counts = store.countByType();
      expect(counts.person).toBe(2);
      expect(counts.organization).toBe(1);
    });

    it('mostConnected returns top-N by degree', () => {
      const alice = person('Alice');
      const acme = org('Acme');
      const beta = org('Beta');
      store.addEntity(alice);
      store.addEntity(acme);
      store.addEntity(beta);
      store.addRelationship(rel('works_at', alice.id, acme.id));
      store.addRelationship(rel('works_at', alice.id, beta.id));
      const top = store.mostConnected(1);
      expect(top.length).toBe(1);
      // Alice has degree 2 (out), acme/beta each have degree 1.
      expect(top[0]!.entity.id).toBe(alice.id);
    });

    it('countEntities + countRelationships', () => {
      expect(store.countEntities()).toBe(0);
      store.addEntity(person('Alice'));
      store.addEntity(org('Acme'));
      expect(store.countEntities()).toBe(2);
      const a = store.listEntities()[0]!;
      const b = store.listEntities()[1]!;
      store.addRelationship(rel('works_at', a.id, b.id));
      expect(store.countRelationships()).toBe(1);
    });

    it('clusterByConnectedComponents groups disconnected subgraphs', () => {
      const a1 = person('A1');
      const a2 = person('A2');
      const b1 = person('B1');
      store.addEntity(a1);
      store.addEntity(a2);
      store.addEntity(b1);
      store.addRelationship(rel('knows', a1.id, a2.id));
      // b1 is isolated.
      const components = store.clusterByConnectedComponents();
      expect(components.length).toBe(2);
    });
  });
});
