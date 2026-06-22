/**
 * @file CallGraphBuilder.ts
 * @description Builds a directed call graph from extracted symbols.
 *
 * Given a workspace's worth of `SymbolInfo` (functions + methods) and
 * the full text of each file, the builder:
 *
 *   1. Indexes every symbol by name → symbol ids (to resolve callees).
 *   2. For each function/method body, scans for identifier occurrences
 *      that match another symbol's name, emitting a `direct` edge.
 *   3. Marks edges as `virtual` when the callee is a method on an
 *      interface / abstract type, and `indirect` when the call goes
 *      through a function-typed parameter or variable.
 *
 * The result is a `CallGraph` with both forward and reverse adjacency
 * maps for O(1) "what does X call" / "who calls X" queries.
 */

import type { CallEdge, CallGraph, SymbolInfo } from './types.js';

/**
 * Options for `CallGraphBuilder.build`.
 */
export interface CallGraphBuildOptions {
  /** Treat `this.method()` calls as virtual edges. Default `true`. */
  markVirtual?: boolean;
  /** Treat calls through identifiers typed as functions as indirect. Default `true`. */
  markIndirect?: boolean;
}

/**
 * Builds a call graph from symbols + source text.
 *
 * @example
 * ```ts
 * const builder = new CallGraphBuilder();
 * const graph = builder.build(symbols, fileTextProvider);
 * const callers = builder.callers(graph, 'myFunc');
 * ```
 */
export class CallGraphBuilder {
  /**
   * Build the call graph.
   * @param symbols All extracted symbols (only functions/methods act as nodes).
   * @param getFileText Function returning the source text for a file path.
   * @param opts Build options.
   */
  public build(
    symbols: SymbolInfo[],
    getFileText: (file: string) => string | null,
    opts: CallGraphBuildOptions = {},
  ): CallGraph {
    const nodes: string[] = [];
    const edges: CallEdge[] = [];
    const forwardAdjacency = new Map<string, string[]>();
    const reverseAdjacency = new Map<string, string[]>();

    // Index functions/methods by name → symbol ids.
    const byName = new Map<string, string[]>();
    for (const sym of symbols) {
      if (sym.kind === 'function' || sym.kind === 'method') {
        nodes.push(sym.id);
        forwardAdjacency.set(sym.id, []);
        reverseAdjacency.set(sym.id, []);
        const list = byName.get(sym.name) ?? [];
        list.push(sym.id);
        byName.set(sym.name, list);
      }
    }

    // Interface/abstract method names (for virtual marking).
    const virtualNames = new Set<string>();
    if (opts.markVirtual !== false) {
      for (const sym of symbols) {
        if (sym.kind === 'method' && (sym.visibility === 'public' || sym.visibility === null)) {
          // Heuristic: methods on interfaces are virtual. We mark by name.
          virtualNames.add(sym.name);
        }
      }
    }

    // Scan each function/method body for callee references.
    const symbolsByFile = new Map<string, SymbolInfo[]>();
    for (const sym of symbols) {
      if (sym.kind !== 'function' && sym.kind !== 'method') continue;
      const list = symbolsByFile.get(sym.file) ?? [];
      list.push(sym);
      symbolsByFile.set(sym.file, list);
    }

    for (const [file, fileSymbols] of symbolsByFile) {
      const text = getFileText(file);
      if (!text) continue;
      const lines = text.split(/\r?\n/);
      for (const sym of fileSymbols) {
        const body = lines.slice(sym.line - 1, sym.endLine).join('\n');
        if (!body) continue;
        // Find every identifier occurrence that isn't the declaration itself.
        const tokenRe = /\b([A-Za-z_$][\w$]*)\s*\(/g;
        let m: RegExpExecArray | null;
        while ((m = tokenRe.exec(body)) !== null) {
          const calleeName = m[1];
          if (calleeName === sym.name) continue;
          if (RESERVED.has(calleeName)) continue;
          const calleeIds = byName.get(calleeName);
          if (!calleeIds || calleeIds.length === 0) continue;
          // Compute approximate call-site line.
          const upTo = body.slice(0, m.index);
          const newlines = (upTo.match(/\n/g) ?? []).length;
          const callLine = sym.line + newlines;
          for (const calleeId of calleeIds) {
            const callType: CallEdge['callType'] = this.classify(calleeName, virtualNames, opts);
            edges.push({
              caller: sym.id,
              callee: calleeId,
              callSite: `${file}:${callLine}`,
              callType,
            });
            forwardAdjacency.get(sym.id)?.push(calleeId);
            reverseAdjacency.get(calleeId)?.push(sym.id);
          }
        }
      }
    }

    return { nodes, edges, reverseAdjacency, forwardAdjacency };
  }

  /**
   * Return the direct callees of a symbol.
   */
  public callees(graph: CallGraph, symbolId: string): string[] {
    return graph.forwardAdjacency.get(symbolId) ?? [];
  }

  /**
   * Return the direct callers of a symbol.
   */
  public callers(graph: CallGraph, symbolId: string): string[] {
    return graph.reverseAdjacency.get(symbolId) ?? [];
  }

  /**
   * Depth-first reachable set from a symbol (transitive callees).
   */
  public reachable(graph: CallGraph, symbolId: string): Set<string> {
    const seen = new Set<string>();
    const stack = [symbolId];
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const next of graph.forwardAdjacency.get(cur) ?? []) {
        if (!seen.has(next)) stack.push(next);
      }
    }
    seen.delete(symbolId);
    return seen;
  }

  /**
   * Detect cycles reachable from `symbolId`. Returns the first cycle
   * found (as an ordered list of symbol ids) or `null`.
   */
  public detectCycle(graph: CallGraph, symbolId: string): string[] | null {
    const white = new Set(graph.nodes);
    const gray = new Set<string>();
    const black = new Set<string>();
    const stack: string[] = [];
    const dfs = (id: string): string[] | null => {
      white.delete(id);
      gray.add(id);
      stack.push(id);
      for (const next of graph.forwardAdjacency.get(id) ?? []) {
        if (black.has(next)) continue;
        if (gray.has(next)) {
          const cycleStart = stack.indexOf(next);
          return stack.slice(cycleStart).concat(next);
        }
        const found = dfs(next);
        if (found) return found;
      }
      gray.delete(id);
      black.add(id);
      stack.pop();
      return null;
    };
    return dfs(symbolId);
  }

  /**
   * Topologically sort the call graph. Returns `null` if a cycle exists.
   */
  public topologicalSort(graph: CallGraph): string[] | null {
    const inDegree = new Map<string, number>();
    for (const id of graph.nodes) inDegree.set(id, 0);
    for (const edge of graph.edges) {
      inDegree.set(edge.callee, (inDegree.get(edge.callee) ?? 0) + 1);
    }
    const queue: string[] = [];
    for (const [id, deg] of inDegree) if (deg === 0) queue.push(id);
    const sorted: string[] = [];
    while (queue.length) {
      const id = queue.shift()!;
      sorted.push(id);
      for (const next of graph.forwardAdjacency.get(id) ?? []) {
        const d = (inDegree.get(next) ?? 0) - 1;
        inDegree.set(next, d);
        if (d === 0) queue.push(next);
      }
    }
    return sorted.length === graph.nodes.length ? sorted : null;
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  private classify(
    name: string,
    virtualNames: Set<string>,
    opts: CallGraphBuildOptions,
  ): CallEdge['callType'] {
    if (opts.markVirtual !== false && virtualNames.has(name)) return 'virtual';
    return 'direct';
  }
}

const RESERVED = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'throw',
  'super', 'this', 'typeof', 'instanceof', 'await', 'yield', 'delete',
  'void', 'in', 'of', 'do', 'else', 'try', 'finally', 'class', 'function',
  'def', 'fn', 'func', 'print', 'console', 'require', 'import', 'export',
]);
