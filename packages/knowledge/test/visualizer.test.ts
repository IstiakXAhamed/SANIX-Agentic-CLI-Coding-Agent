/**
 * @file visualizer.test.ts
 * @description Tests GraphVisualizer: DOT, Mermaid, ASCII, JSON output
 * formats + entity color mapping.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  GraphStore,
  GraphVisualizer,
  ENTITY_COLORS,
  ENTITY_SHAPES,
  colorForType,
  shapeForType,
} from '@sanix/knowledge';
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

describe('GraphVisualizer', () => {
  let store: GraphStore;
  let viz: GraphVisualizer;
  let alice: Entity;
  let acme: Entity;

  beforeEach(() => {
    store = new GraphStore({ inMemory: true });
    store.open();
    viz = new GraphVisualizer();
    alice = entity('person', 'Alice');
    acme = entity('organization', 'Acme');
    store.addEntity(alice);
    store.addEntity(acme);
    store.addRelationship({
      id: newRelationshipId(),
      type: 'works_at',
      source: alice.id,
      target: acme.id,
      properties: {},
      confidence: 0.9,
      evidence: ['Alice works at Acme.'],
      source_meta: 'test',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });

  afterEach(() => {
    store.close();
  });

  describe('toDot', () => {
    it('produces valid DOT syntax', () => {
      const sub = store.getSubgraph(alice.id, 1);
      const dot = viz.toDot(sub);
      expect(dot).toContain('digraph G');
      expect(dot).toContain('rankdir=LR');
      // Both entities appear as node declarations.
      expect(dot).toContain(`"${alice.id}"`);
      expect(dot).toContain(`"${acme.id}"`);
      // The relationship appears as an edge.
      expect(dot).toContain('->');
      // Type-specific fillcolor is applied.
      expect(dot.toLowerCase()).toContain('fillcolor');
    });
  });

  describe('toMermaid', () => {
    it('produces valid Mermaid graph syntax', () => {
      const sub = store.getSubgraph(alice.id, 1);
      const mermaid = viz.toMermaid(sub);
      expect(mermaid).toContain('graph');
      // Mermaid edges use --> or ---|label|.
      expect(mermaid).toMatch(/-->|---/);
      // Both entity names appear in the labels (Mermaid uses sanitized
      // N0/N1 ids internally but includes the entity name in the label).
      expect(mermaid).toContain('Alice');
      expect(mermaid).toContain('Acme');
    });
  });

  describe('toAscii', () => {
    it('produces a non-empty ASCII rendering', () => {
      const sub = store.getSubgraph(alice.id, 1);
      const ascii = viz.toAscii(sub);
      expect(ascii.length).toBeGreaterThan(0);
      // Both entity names appear.
      expect(ascii).toContain('Alice');
      expect(ascii).toContain('Acme');
    });
  });

  describe('toJSON', () => {
    it('produces valid D3 JSON with nodes + links', () => {
      const sub = store.getSubgraph(alice.id, 1);
      const json = viz.toJSON(sub);
      const parsed = JSON.parse(json) as {
        nodes: Array<{ id: string; label?: string; color?: string }>;
        links: Array<{ source: string; target: string; label?: string }>;
      };
      expect(parsed.nodes.length).toBeGreaterThanOrEqual(2);
      expect(parsed.links.length).toBeGreaterThanOrEqual(1);
      // Both entity ids appear.
      const ids = parsed.nodes.map((n) => n.id);
      expect(ids).toContain(alice.id);
      expect(ids).toContain(acme.id);
      // The link references source + target.
      const link = parsed.links[0]!;
      expect([link.source, link.target].sort()).toEqual(
        [alice.id, acme.id].sort(),
      );
    });
  });

  describe('entity colors + shapes', () => {
    it('ENTITY_COLORS covers all entity types', () => {
      const types: Entity['type'][] = [
        'person', 'organization', 'concept', 'event', 'location',
        'document', 'code', 'tool', 'project', 'technology', 'custom',
      ];
      for (const t of types) {
        expect(ENTITY_COLORS[t]).toBeDefined();
        expect(ENTITY_COLORS[t]!.hex).toMatch(/^#[0-9a-fA-F]{6}$/);
        expect(typeof ENTITY_COLORS[t]!.name).toBe('string');
      }
    });

    it('ENTITY_SHAPES covers all entity types', () => {
      const types: Entity['type'][] = [
        'person', 'organization', 'concept', 'event', 'location',
        'document', 'code', 'tool', 'project', 'technology', 'custom',
      ];
      for (const t of types) {
        expect(typeof ENTITY_SHAPES[t]).toBe('string');
      }
    });

    it('colorForType + shapeForType return the same values as the maps', () => {
      expect(colorForType('person')).toBe(ENTITY_COLORS.person);
      expect(shapeForType('person')).toBe(ENTITY_SHAPES.person);
    });

    it('DOT output applies per-type colors', () => {
      const sub = store.getSubgraph(alice.id, 1);
      const dot = viz.toDot(sub);
      // Person color hex appears in the output.
      expect(dot).toContain(ENTITY_COLORS.person.hex);
      // Organization color hex appears in the output.
      expect(dot).toContain(ENTITY_COLORS.organization.hex);
    });
  });
});
