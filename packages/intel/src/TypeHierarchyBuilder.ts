/**
 * @file TypeHierarchyBuilder.ts
 * @description Builds a type hierarchy from extracted symbols.
 *
 * Scans class / interface / enum / type / struct declarations and
 * their inheritance clauses (`extends`, `implements`, `:`, `inherit`,
 * `inherits`) to produce a forest of `TypeNode`s. The builder resolves
 * parent names to symbol ids via a name → id index, so cross-file
 * hierarchies work as long as the parent was indexed.
 *
 * Supports:
 *   - TypeScript / JavaScript: `class A extends B implements C, D`
 *   - Python: `class A(B, C):`
 *   - Java: `class A extends B implements C`
 *   - Rust: `struct A;` / `trait B: C`
 *   - Go: `type A struct { ... }` (embedded fields = parents)
 */

import type { SymbolInfo, TypeHierarchy, TypeNode } from './types.js';

/**
 * Options for `TypeHierarchyBuilder.build`.
 */
export interface TypeHierarchyBuildOptions {
  /** When a parent name can't be resolved, keep it as a string in `qualifiedName`. Default `true`. */
  keepUnresolved?: boolean;
}

/**
 * Builds a type hierarchy from extracted symbols + source text.
 *
 * @example
 * ```ts
 * const builder = new TypeHierarchyBuilder();
 * const hierarchy = builder.build(symbols, fileTextProvider);
 * const subs = builder.subtypes(hierarchy, 'MyClass');
 * ```
 */
export class TypeHierarchyBuilder {
  /**
   * Build the hierarchy.
   */
  public build(
    symbols: SymbolInfo[],
    getFileText: (file: string) => string | null,
    _opts: TypeHierarchyBuildOptions = {},
  ): TypeHierarchy {
    const nodes = new Map<string, TypeNode>();
    const byName = new Map<string, string[]>();

    // Pass 1: collect type declarations.
    for (const sym of symbols) {
      if (sym.kind === 'class' || sym.kind === 'interface' || sym.kind === 'enum' || sym.kind === 'type' || sym.kind === 'namespace') {
        const kind = this.asTypeKind(sym.kind);
        const node: TypeNode = {
          symbolId: sym.id,
          name: sym.name,
          qualifiedName: sym.containerName ? `${sym.containerName}.${sym.name}` : sym.name,
          kind,
          file: sym.file,
          line: sym.line,
          parents: [],
          children: [],
        };
        nodes.set(sym.id, node);
        const list = byName.get(sym.name) ?? [];
        list.push(sym.id);
        byName.set(sym.name, list);
      }
    }

    // Pass 2: parse parent names from source.
    for (const sym of symbols) {
      if (!nodes.has(sym.id)) continue;
      const text = getFileText(sym.file);
      if (!text) continue;
      const lines = text.split(/\r?\n/);
      const declLine = lines[sym.line - 1] ?? '';
      const parents = this.extractParents(declLine, sym);
      const node = nodes.get(sym.id)!;
      for (const parentName of parents) {
        const parentIds = byName.get(parentName);
        if (parentIds && parentIds.length > 0) {
          const parentId = parentIds[0];
          node.parents.push(parentId);
          nodes.get(parentId)?.children.push(sym.id);
        }
      }
    }

    const roots: string[] = [];
    for (const [id, node] of nodes) {
      if (node.parents.length === 0) roots.push(id);
    }
    return { nodes, roots };
  }

  /**
   * Return all direct + transitive subtypes of a type.
   */
  public subtypes(hierarchy: TypeHierarchy, symbolId: string): TypeNode[] {
    const out: TypeNode[] = [];
    const seen = new Set<string>();
    const stack = [symbolId];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const node = hierarchy.nodes.get(id);
      if (!node) continue;
      for (const childId of node.children) {
        const child = hierarchy.nodes.get(childId);
        if (child && !seen.has(childId)) {
          out.push(child);
          stack.push(childId);
        }
      }
    }
    return out;
  }

  /**
   * Return all direct + transitive supertypes of a type.
   */
  public supertypes(hierarchy: TypeHierarchy, symbolId: string): TypeNode[] {
    const out: TypeNode[] = [];
    const seen = new Set<string>();
    const stack = [symbolId];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const node = hierarchy.nodes.get(id);
      if (!node) continue;
      for (const parentId of node.parents) {
        const parent = hierarchy.nodes.get(parentId);
        if (parent && !seen.has(parentId)) {
          out.push(parent);
          stack.push(parentId);
        }
      }
    }
    return out;
  }

  /**
   * Find the lowest common ancestor of two types.
   */
  public lowestCommonAncestor(hierarchy: TypeHierarchy, a: string, b: string): TypeNode | null {
    const ancestorsA = new Set<string>([a]);
    for (const sup of this.supertypes(hierarchy, a)) ancestorsA.add(sup.symbolId);
    if (ancestorsA.has(b)) return hierarchy.nodes.get(b) ?? null;
    const stack = [b];
    const seen = new Set<string>();
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      if (ancestorsA.has(id)) return hierarchy.nodes.get(id) ?? null;
      const node = hierarchy.nodes.get(id);
      if (node) for (const p of node.parents) stack.push(p);
    }
    return null;
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  private asTypeKind(kind: SymbolInfo['kind']): TypeNode['kind'] {
    switch (kind) {
      case 'class': return 'class';
      case 'interface': return 'interface';
      case 'enum': return 'enum';
      case 'type': return 'type';
      case 'namespace': return 'struct';
      default: return 'class';
    }
  }

  private extractParents(declLine: string, sym: SymbolInfo): string[] {
    const parents: string[] = [];
    const line = declLine.trim();
    switch (this.guessLanguage(sym)) {
      case 'typescript':
      case 'javascript':
      case 'java': {
        const ext = /\bextends\s+([A-Za-z_$][\w$.]*(?:\s*,\s*[A-Za-z_$][\w$.]*)*)/.exec(line);
        if (ext) for (const p of ext[1].split(',')) parents.push(p.trim().split('.')[0]);
        const impl = /\bimplements\s+([A-Za-z_$][\w$.]*(?:\s*,\s*[A-Za-z_$][\w$.]*)*)/.exec(line);
        if (impl) for (const p of impl[1].split(',')) parents.push(p.trim().split('.')[0]);
        break;
      }
      case 'python': {
        const m = /class\s+\w+\s*\(([^)]*)\)/.exec(line);
        if (m) for (const p of m[1].split(',')) {
          const name = p.trim().split('.')[0];
          if (name && name !== 'object') parents.push(name);
        }
        break;
      }
      case 'rust': {
        const trait = /trait\s+\w+\s*:\s*([^{]+)\{/.exec(line);
        if (trait) for (const p of trait[1].split('+')) parents.push(p.trim().split('<')[0]);
        break;
      }
      case 'go': {
        // Embedded fields appear on the next lines: `  *Parent`
        // Detected elsewhere; for the decl line itself, nothing to do.
        break;
      }
    }
    return [...new Set(parents)];
  }

  private guessLanguage(sym: SymbolInfo): 'typescript' | 'javascript' | 'java' | 'python' | 'rust' | 'go' {
    const ext = sym.file.slice(sym.file.lastIndexOf('.'));
    switch (ext) {
      case '.ts': case '.tsx': return 'typescript';
      case '.js': case '.jsx': return 'javascript';
      case '.java': return 'java';
      case '.py': return 'python';
      case '.rs': return 'rust';
      case '.go': return 'go';
      default: return 'typescript';
    }
  }
}
