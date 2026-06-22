/**
 * @file GraphVisualizer.ts
 * @description Generates visual representations of (sub)graphs in four
 * formats:
 *
 *   - **DOT**    — Graphviz DOT format (loadable by `dot -Tpng`).
 *   - **Mermaid** — Mermaid.js graph syntax (renders in GitHub/Markdown).
 *   - **ASCII**  — simple boxes-and-arrows representation (terminal output).
 *   - **JSON**   — D3.js force-directed graph format (`{ nodes: [...],
 *                  links: [...] }`).
 *
 * Entity types are color-coded consistently across formats (Person = blue,
 * Organization = green, Concept = purple, etc.).
 *
 * @packageDocumentation
 */

import type { EntityType, GraphEdge, GraphNode, Subgraph } from './types.js';

// ─── Color / shape mapping ─────────────────────────────────────────────────

/**
 * Color palette per entity type. Hex values chosen for reasonable contrast
 * on white backgrounds (DOT, D3) and mapped to friendly Tailwind-ish names
 * for Mermaid classDefs.
 */
export const ENTITY_COLORS: Record<EntityType, { hex: string; name: string }> =
  {
    person: { hex: '#3b82f6', name: 'blue' },
    organization: { hex: '#10b981', name: 'green' },
    concept: { hex: '#a855f7', name: 'purple' },
    event: { hex: '#f59e0b', name: 'amber' },
    location: { hex: '#ef4444', name: 'red' },
    document: { hex: '#6366f1', name: 'indigo' },
    code: { hex: '#14b8a6', name: 'teal' },
    tool: { hex: '#8b5cf6', name: 'violet' },
    project: { hex: '#ec4899', name: 'pink' },
    technology: { hex: '#0ea5e9', name: 'sky' },
    custom: { hex: '#64748b', name: 'slate' },
  };

/**
 * Shape per entity type for DOT output (Graphviz `shape` attribute).
 */
export const ENTITY_SHAPES: Record<EntityType, string> = {
  person: 'ellipse',
  organization: 'box',
  concept: 'diamond',
  event: 'hexagon',
  location: 'house',
  document: 'note',
  code: 'component',
  tool: 'folder',
  project: 'tab',
  technology: 'cylinder',
  custom: 'oval',
};

// ─── GraphVisualizer ──────────────────────────────────────────────────────

/**
 * Generates visual representations of (sub)graphs.
 *
 * @example
 * ```ts
 * const viz = new GraphVisualizer();
 * const sub = store.getSubgraph(aliceId, 2);
 * console.log(viz.toMermaid(sub));
 * fs.writeFileSync('graph.dot', viz.toDot(sub));
 * ```
 */
export class GraphVisualizer {
  /**
   * Generate Graphviz DOT output. Loadable by `dot -Tpng graph.dot -o graph.png`.
   *
   * @example
   * ```ts
   * const dot = viz.toDot(subgraph);
   * fs.writeFileSync('graph.dot', dot);
   * // shell: dot -Tpng graph.dot -o graph.png
   * ```
   */
  toDot(subgraph: Subgraph): string {
    const lines: string[] = [];
    lines.push('digraph G {');
    lines.push('  rankdir=LR;');
    lines.push('  node [fontname="Helvetica", fontsize=10];');
    lines.push('  edge [fontname="Helvetica", fontsize=9];');
    // Nodes.
    for (const n of subgraph.nodes) {
      const e = n.entity;
      const color = ENTITY_COLORS[e.type].hex;
      const shape = ENTITY_SHAPES[e.type];
      const label = escapeDotLabel(
        `${e.name}\\n(${e.type})`,
      );
      lines.push(
        `  "${e.id}" [label="${label}", shape=${shape}, style=filled, fillcolor="${color}", fontcolor="white"];`,
      );
    }
    // Edges.
    for (const edge of subgraph.edges) {
      const r = edge.relationship;
      const label = escapeDotLabel(r.type);
      lines.push(
        `  "${r.source}" -> "${r.target}" [label="${label}"];`,
      );
    }
    lines.push('}');
    return lines.join('\n');
  }

  /**
   * Generate Mermaid.js graph syntax. Renders inline in GitHub Markdown,
   * Notion, Obsidian, etc.
   *
   * @example
   * ```ts
   * const mmd = viz.toMermaid(subgraph);
   * // paste into a GitHub README:
   * // ```mermaid
   * // <mmd>
   * // ```
   * ```
   */
  toMermaid(subgraph: Subgraph): string {
    const lines: string[] = [];
    lines.push('graph LR');
    // Mermaid node ids must be alphanumeric; we sanitize by hashing.
    const idMap = new Map<string, string>();
    let i = 0;
    for (const n of subgraph.nodes) {
      const alias = `N${i++}`;
      idMap.set(n.entity.id, alias);
      const color = ENTITY_COLORS[n.entity.type].name;
      const label = `${n.entity.name} (${n.entity.type})`;
      // Mermaid supports `N1[Label]:::className` for styling.
      lines.push(`  ${alias}["${escapeMermaidLabel(label)}"]:::${color}`);
    }
    // Class definitions for each color used.
    const usedColors = new Set<string>();
    for (const n of subgraph.nodes) {
      usedColors.add(ENTITY_COLORS[n.entity.type].name);
    }
    for (const colorName of usedColors) {
      const hex = Object.values(ENTITY_COLORS).find(
        (c) => c.name === colorName,
      )?.hex;
      if (hex) {
        lines.push(`  classDef ${colorName} fill:${hex},color:#fff;`);
      }
    }
    // Edges.
    for (const edge of subgraph.edges) {
      const r = edge.relationship;
      const src = idMap.get(r.source);
      const tgt = idMap.get(r.target);
      if (!src || !tgt) continue;
      lines.push(`  ${src} -->|${escapeMermaidLabel(r.type)}| ${tgt}`);
    }
    return lines.join('\n');
  }

  /**
   * Generate an ASCII-art representation. Boxes for nodes, arrows for
   * edges. Suitable for terminal display.
   *
   * @example
   * ```ts
   * console.log(viz.toAscii(subgraph));
   * //   ┌─────────────┐
   * //   │ Alice       │ ──works_at──▶ ┌──────────┐
   * //   │ (person)    │               │ Acme     │
   * //   └─────────────┘               │ (org)    │
   * //                                 └──────────┘
   * ```
   */
  toAscii(subgraph: Subgraph): string {
    if (subgraph.nodes.length === 0) return '(empty subgraph)';
    const lines: string[] = [];
    // Node boxes.
    const boxes = subgraph.nodes.map((n) => makeAsciiBox(n));
    const maxBoxWidth = Math.max(...boxes.map((b) => b.width));
    // Lay boxes out in a single column, left-aligned.
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i]!;
      for (const line of b.lines) {
        lines.push(line.padEnd(maxBoxWidth));
      }
      if (i < boxes.length - 1) lines.push('');
    }
    // Edges section.
    if (subgraph.edges.length > 0) {
      lines.push('');
      lines.push('Relationships:');
      for (const edge of subgraph.edges) {
        const srcName = edge.sourceEntity.name;
        const tgtName = edge.targetEntity.name;
        lines.push(
          `  ${srcName} ──${edge.relationship.type}──▶ ${tgtName}`,
        );
      }
    }
    return lines.join('\n');
  }

  /**
   * Generate a D3.js force-directed graph JSON. Two arrays: `nodes` (with
   * `id`, `name`, `type`, `color`, and any entity metadata) and `links`
   * (with `source`, `target`, `type`, `confidence`).
   *
   * @example
   * ```ts
   * const json = viz.toJSON(subgraph);
   * fs.writeFileSync('graph.json', json);
   * // in a D3 app:
   * // const { nodes, links } = JSON.parse(json);
   * // const sim = d3.forceSimulation(nodes).force('link', d3.forceLink(links).id(d => d.id));
   * ```
   */
  toJSON(subgraph: Subgraph): string {
    const nodes = subgraph.nodes.map((n) => {
      const e = n.entity;
      const color = ENTITY_COLORS[e.type].hex;
      return {
        id: e.id,
        name: e.name,
        type: e.type,
        color,
        degree: n.degree,
        confidence: e.confidence,
        description: e.description ?? null,
        source: e.source,
        aliases: e.aliases,
      };
    });
    const links = subgraph.edges.map((edge) => ({
      id: edge.relationship.id,
      source: edge.relationship.source,
      target: edge.relationship.target,
      type: edge.relationship.type,
      confidence: edge.relationship.confidence,
      evidence: edge.relationship.evidence,
    }));
    return JSON.stringify({ nodes, links }, null, 2);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Escape a label for use in a DOT double-quoted string. Backslash and
 * double-quote are escaped; newlines become `\\n` (DOT's line break).
 */
function escapeDotLabel(label: string): string {
  return label
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

/**
 * Escape a label for use in Mermaid node/edge text. Mermaid is sensitive
 * to brackets, pipes, and quotes.
 */
function escapeMermaidLabel(label: string): string {
  return label.replace(/[\[\]#"|]/g, (c) => `#${c.charCodeAt(0)};`);
}

/**
 * Build an ASCII box around an entity's name + type. Returns the box
 * lines + total width.
 */
function makeAsciiBox(node: GraphNode): { lines: string[]; width: number } {
  const e = node.entity;
  const title = e.name;
  const subtitle = `(${e.type})`;
  const inner = Math.max(title.length, subtitle.length);
  const width = inner + 4; // 2 chars padding each side
  const top = '┌' + '─'.repeat(inner + 2) + '┐';
  const titleLine = '│ ' + title.padEnd(inner) + ' │';
  const subLine = '│ ' + subtitle.padEnd(inner) + ' │';
  const bottom = '└' + '─'.repeat(inner + 2) + '┘';
  return { lines: [top, titleLine, subLine, bottom], width };
}

/**
 * Convenience: pick a color for an entity type. Exported so callers can
 * render custom UIs with the same palette.
 *
 * @example
 * ```ts
 * const { hex } = colorForType('person'); // '#3b82f6'
 * ```
 */
export function colorForType(type: EntityType): { hex: string; name: string } {
  return ENTITY_COLORS[type] ?? ENTITY_COLORS.custom;
}

/**
 * Convenience: pick a DOT shape for an entity type.
 *
 * @example
 * ```ts
 * const shape = shapeForType('concept'); // 'diamond'
 * ```
 */
export function shapeForType(type: EntityType): string {
  return ENTITY_SHAPES[type] ?? ENTITY_SHAPES.custom;
}

/**
 * Strip an edge of its surrounding GraphEdge wrapper, returning just the
 * relationship. Useful for callers that want to iterate edges uniformly.
 *
 * @example
 * ```ts
 * const rels = subgraph.edges.map(edgeToRelationship);
 * ```
 */
export function edgeToRelationship(edge: GraphEdge): import('./types.js').Relationship {
  return edge.relationship;
}

/**
 * Strip a node of its surrounding GraphNode wrapper, returning just the
 * entity.
 *
 * @example
 * ```ts
 * const ents = subgraph.nodes.map(nodeToEntity);
 * ```
 */
export function nodeToEntity(node: GraphNode): import('./types.js').Entity {
  return node.entity;
}
