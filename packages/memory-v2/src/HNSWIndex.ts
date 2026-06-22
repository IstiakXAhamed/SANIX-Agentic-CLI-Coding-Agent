/**
 * @file memory-v2/src/HNSWIndex.ts
 * @description Pure-TypeScript HNSW (Hierarchical Navigable Small World)
 * vector index for fast approximate nearest-neighbor (ANN) search.
 *
 * Replaces LanceDB for users who want zero native deps beyond
 * `better-sqlite3`. LanceDB ships a native Rust extension that isn't
 * always installable; this HNSW implementation is pure TS so it works
 * anywhere Node runs.
 *
 * ## Algorithm
 *
 * HNSW builds a layered proximity graph:
 *   - **Layer 0** contains every node (up to `M*2` connections per node).
 *   - **Layer L** (for L > 0) contains a random subset of nodes (the
 *     subset shrinks exponentially with L). Each node has at most `M`
 *     connections per non-zero layer.
 *   - The entry point lives at the highest layer. Search descends from
 *     the top layer to layer 0; at each layer it greedily moves toward
 *     the query until it can no longer improve, then drops one layer.
 *   - At layer 0, the search maintains a candidate set of size `ef`
 *     (>= `k`) to recover from local minima.
 *
 * Distance is **cosine distance** = `1 - cos(θ)`. Callers should
 * L2-normalize vectors before adding them; non-normalized vectors are
 * normalized internally on `add()` / `search()` so distance remains in
 * `[0, 2]` (0 = identical, 2 = opposite).
 *
 * ## Complexity
 *
 *   - `add()`:     O(M · efConstruction · log N) typical.
 *   - `search()`:  O(efSearch · log N) typical.
 *   - `remove()`:  O(M · L) (re-links neighbors).
 *
 * ## Persistence
 *
 * `serialize()` returns a self-contained `Buffer` (JSON of the graph +
 * node data) that `deserialize()` can read back. `save()` / `load()`
 * wrap this for file persistence.
 *
 * @packageDocumentation
 */

import { existsSync, mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** A single search hit. */
export interface SearchResult {
  /** The matched node's id. */
  id: string;
  /** Cosine distance to the query (0 = identical, 2 = opposite). */
  distance: number;
  /** Optional metadata attached at `add()` time. */
  metadata?: Record<string, unknown>;
}

/** Constructor options. */
export interface HNSWOptions {
  /** Max connections per node at layers > 0 (M). Default 16. */
  maxConnections?: number;
  /** Size of the dynamic candidate list during construction. Default 200. */
  efConstruction?: number;
  /** Size of the dynamic candidate list during search. Default 50. */
  efSearch?: number;
  /** Embedding dimensionality. Default 384. */
  dimensions?: number;
}

/** Internal node representation. */
interface HNSWNode {
  id: string;
  vector: Float32Array;
  metadata?: Record<string, unknown>;
  level: number;
}

/** Internal candidate for the search heaps. */
interface Candidate {
  id: string;
  dist: number;
}

/**
 * Pure-TypeScript HNSW vector index.
 *
 * @example
 * ```ts
 * const idx = new HNSWIndex({ maxConnections: 16, dimensions: 384 });
 * idx.add('a', normalize(vecA), { tier: 'semantic' });
 * idx.add('b', normalize(vecB));
 * const hits = idx.search(normalize(queryVec), 5);
 * for (const h of hits) console.log(h.id, h.distance);
 * await idx.save('~/.sanix/memory/hnsw.json');
 * ```
 */
export class HNSWIndex {
  private readonly M: number;
  private readonly efConstruction: number;
  private efSearch: number;
  readonly dimensions: number;

  /** All nodes by id. */
  private readonly nodes = new Map<string, HNSWNode>();
  /** graph[layer][id] = Set<neighborId>. */
  private readonly graph: Map<number, Map<string, Set<string>>> = new Map();
  /** Current entry point (highest-layer node). */
  private entryPointId: string | null = null;
  /** Current max layer index. */
  private maxLevel = -1;

  constructor(opts: HNSWOptions = {}) {
    this.M = opts.maxConnections ?? 16;
    this.efConstruction = opts.efConstruction ?? 200;
    this.efSearch = opts.efSearch ?? 50;
    this.dimensions = opts.dimensions ?? 384;
  }

  /**
   * Number of indexed nodes.
   *
   * @example
   * ```ts
   * console.log(`Index has ${idx.size()} nodes.`);
   * ```
   */
  size(): number {
    return this.nodes.size;
  }

  /**
   * Add a vector to the index. If `id` already exists, the existing node
   * is replaced (its connections are unlinked first).
   *
   * The vector is L2-normalized internally so callers don't have to.
   *
   * @example
   * ```ts
   * idx.add('doc-1', new Float32Array([0.1, 0.2, ...]), { url: 'https://...' });
   * ```
   */
  add(id: string, vector: Float32Array, metadata?: Record<string, unknown>): void {
    if (this.nodes.has(id)) {
      this.remove(id);
    }
    const normalized = l2Normalize(vector);
    const level = this.randomLevel();
    const node: HNSWNode = { id, vector: normalized, metadata, level };
    this.nodes.set(id, node);

    // Ensure layer maps exist up to `level`.
    for (let l = 0; l <= level; l++) {
      if (!this.graph.has(l)) this.graph.set(l, new Map());
      if (!this.graph.get(l)!.has(id)) this.graph.get(l)!.set(id, new Set());
    }

    // First node: become the entry point and bail.
    if (this.entryPointId === null) {
      this.entryPointId = id;
      this.maxLevel = level;
      return;
    }

    // Phase 1: greedy 1-NN descent from the top down to `level + 1`.
    let currEp = this.entryPointId;
    for (let l = this.maxLevel; l > level; l--) {
      currEp = this.greedySearchLayer(l, normalized, currEp);
    }

    // Phase 2: from min(level, maxLevel) down to 0, find efConstruction
    // nearest neighbors and bidirectionally link them.
    for (let l = Math.min(level, this.maxLevel); l >= 0; l--) {
      const candidates = this.searchLayer(l, normalized, currEp, this.efConstruction);
      const maxConn = l === 0 ? this.M * 2 : this.M;
      const neighbors = this.selectNeighbors(candidates, maxConn);

      const layerGraph = this.graph.get(l)!;
      const myConns = layerGraph.get(id)!;
      for (const n of neighbors) {
        myConns.add(n);
        const nConns = layerGraph.get(n);
        if (nConns) {
          nConns.add(id);
          // Prune neighbor's connections if over capacity.
          if (nConns.size > maxConn) {
            this.pruneConnections(l, n, maxConn);
          }
        }
      }

      // Promote the closest candidate as the entry point for the next
      // lower layer.
      if (candidates.length > 0) {
        currEp = candidates[0]!.id;
      }
    }

    // If this node's level exceeds the current max, it becomes the new
    // global entry point.
    if (level > this.maxLevel) {
      this.maxLevel = level;
      this.entryPointId = id;
    }
  }

  /**
   * Remove a node from the index. Bidirectionally unlinks it from its
   * neighbors at every layer it participates in. If the removed node was
   * the entry point, the highest-level remaining node is promoted.
   *
   * @returns `true` if the node existed and was removed.
   *
   * @example
   * ```ts
   * if (idx.remove('doc-1')) console.log('removed');
   * ```
   */
  remove(id: string): boolean {
    const node = this.nodes.get(id);
    if (!node) return false;

    // Unlink from neighbors at every layer.
    for (let l = 0; l <= node.level; l++) {
      const layerGraph = this.graph.get(l);
      if (!layerGraph) continue;
      const conns = layerGraph.get(id);
      if (conns) {
        for (const n of conns) {
          const nConns = layerGraph.get(n);
          if (nConns) nConns.delete(id);
        }
      }
      layerGraph.delete(id);
    }
    this.nodes.delete(id);

    // Re-pick the entry point if we just removed it.
    if (this.entryPointId === id) {
      let newEp: string | null = null;
      let newMaxLevel = -1;
      for (const [nid, n] of this.nodes) {
        if (n.level > newMaxLevel) {
          newMaxLevel = n.level;
          newEp = nid;
        }
      }
      this.entryPointId = newEp;
      this.maxLevel = newEp ? newMaxLevel : -1;
    }
    return true;
  }

  /**
   * Search for the `k` nearest neighbors of `query`.
   *
   * @param query - The query vector (will be L2-normalized internally).
   * @param k - Maximum number of results.
   * @param opts - Optional `{ ef }` to override `efSearch` for this call.
   *   Higher `ef` = more thorough (and slower) search.
   *
   * @example
   * ```ts
   * const hits = idx.search(queryVec, 10, { ef: 100 });
   * for (const h of hits) console.log(h.id, 1 - h.distance); // similarity
   * ```
   */
  search(
    query: Float32Array,
    k: number,
    opts?: { ef?: number },
  ): SearchResult[] {
    if (this.entryPointId === null || this.nodes.size === 0) return [];
    const normalized = l2Normalize(query);
    const ef = Math.max(opts?.ef ?? this.efSearch, k);

    // Phase 1: greedy descent from the top layer down to layer 1.
    let currEp = this.entryPointId;
    for (let l = this.maxLevel; l > 0; l--) {
      currEp = this.greedySearchLayer(l, normalized, currEp);
    }

    // Phase 2: ef-search at layer 0, then truncate to k.
    const candidates = this.searchLayer(0, normalized, currEp, ef);
    return candidates.slice(0, k).map((c) => ({
      id: c.id,
      distance: c.dist,
      metadata: this.nodes.get(c.id)?.metadata,
    }));
  }

  /**
   * Override the default `efSearch`. Higher = more recall, slower.
   */
  setEfSearch(ef: number): void {
    this.efSearch = ef;
  }

  // ─── Persistence ───────────────────────────────────────────────────────

  /**
   * Serialize the entire index (nodes + graph + entry point) to a Buffer.
   * The format is a JSON object: `{ v: 1, M, efC, efS, dims, nodes,
   * graph, entry, maxLevel }`. Vectors are stored as arrays of numbers.
   *
   * @example
   * ```ts
   * const buf = idx.serialize();
   * // ... later, in another process:
   * const idx2 = new HNSWIndex();
   * idx2.deserialize(buf);
   * ```
   */
  serialize(): Buffer {
    const nodesArr: Array<{
      id: string;
      vector: number[];
      metadata?: Record<string, unknown>;
      level: number;
    }> = [];
    for (const [id, n] of this.nodes) {
      nodesArr.push({
        id,
        vector: Array.from(n.vector),
        metadata: n.metadata,
        level: n.level,
      });
    }
    const graphObj: Record<string, Array<[string, string[]]>> = {};
    for (const [layer, layerMap] of this.graph) {
      graphObj[layer] = [];
      for (const [id, conns] of layerMap) {
        graphObj[layer].push([id, Array.from(conns)]);
      }
    }
    const payload = {
      v: 1,
      M: this.M,
      efC: this.efConstruction,
      efS: this.efSearch,
      dims: this.dimensions,
      nodes: nodesArr,
      graph: graphObj,
      entry: this.entryPointId,
      maxLevel: this.maxLevel,
    };
    return Buffer.from(JSON.stringify(payload), 'utf-8');
  }

  /**
   * Restore an index from a `serialize()`-d buffer. Replaces the current
   * contents of this index.
   *
   * @throws if the buffer is malformed.
   */
  deserialize(buf: Buffer): void {
    const raw = JSON.parse(buf.toString('utf-8')) as {
      v: number;
      M: number;
      efC: number;
      efS: number;
      dims: number;
      nodes: Array<{ id: string; vector: number[]; metadata?: Record<string, unknown>; level: number }>;
      graph: Record<string, Array<[string, string[]]>>;
      entry: string | null;
      maxLevel: number;
    };
    if (raw.v !== 1) {
      throw new Error(`HNSWIndex.deserialize: unsupported version ${raw.v}`);
    }
    // Clear current state.
    this.nodes.clear();
    this.graph.clear();
    (this as unknown as { M: number }).M = raw.M;
    (this as unknown as { efConstruction: number }).efConstruction = raw.efC;
    this.efSearch = raw.efS;
    (this as unknown as { dimensions: number }).dimensions = raw.dims;

    for (const n of raw.nodes) {
      this.nodes.set(n.id, {
        id: n.id,
        vector: new Float32Array(n.vector),
        metadata: n.metadata,
        level: n.level,
      });
    }
    for (const [layerStr, pairs] of Object.entries(raw.graph)) {
      const layer = Number(layerStr);
      const layerMap = new Map<string, Set<string>>();
      for (const [id, conns] of pairs) {
        layerMap.set(id, new Set(conns));
      }
      this.graph.set(layer, layerMap);
    }
    this.entryPointId = raw.entry;
    this.maxLevel = raw.maxLevel;
  }

  /**
   * Persist the index to a file at `path`. Parent directories are created
   * if missing. Uses `serialize()` under the hood.
   *
   * @example
   * ```ts
   * await idx.save('~/.sanix/memory/hnsw.json');
   * ```
   */
  async save(path: string): Promise<void> {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const buf = this.serialize();
    await writeFile(path, buf);
  }

  /**
   * Load the index from a file at `path`. Replaces the current contents.
   *
   * @throws if the file cannot be read or parsed.
   */
  async load(path: string): Promise<void> {
    const buf = await readFile(path);
    this.deserialize(buf);
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  /**
   * Greedy 1-NN search on a single layer. Walks the layer's graph from
   * `entryPoint`, hopping to any neighbor that's closer to `query`,
   * until no improvement is possible. Returns the id of the closest
   * node found.
   */
  private greedySearchLayer(layer: number, query: Float32Array, entryPoint: string): string {
    let curr = entryPoint;
    let currDist = this.distance(query, this.nodes.get(curr)!.vector);
    let improved = true;
    while (improved) {
      improved = false;
      const conns = this.graph.get(layer)?.get(curr);
      if (!conns) break;
      for (const n of conns) {
        const nNode = this.nodes.get(n);
        if (!nNode) continue;
        const nDist = this.distance(query, nNode.vector);
        if (nDist < currDist) {
          curr = n;
          currDist = nDist;
          improved = true;
        }
      }
    }
    return curr;
  }

  /**
   * Best-first search on a single layer returning up to `ef` nearest
   * candidates. Maintains a min-heap of candidates to explore and a
   * max-heap of results (so the worst result can be evicted in O(1)).
   */
  private searchLayer(
    layer: number,
    query: Float32Array,
    entryPoint: string,
    ef: number,
  ): Candidate[] {
    const visited = new Set<string>([entryPoint]);
    const epNode = this.nodes.get(entryPoint);
    if (!epNode) return [];
    const epDist = this.distance(query, epNode.vector);

    const candidates = new MinHeap();
    const results = new MaxHeap();
    candidates.push({ id: entryPoint, dist: epDist });
    results.push({ id: entryPoint, dist: epDist });

    while (candidates.size() > 0) {
      const c = candidates.pop()!;
      const worst = results.peek();
      if (worst && c.dist > worst.dist && results.size() >= ef) break;

      const conns = this.graph.get(layer)?.get(c.id);
      if (!conns) continue;
      for (const n of conns) {
        if (visited.has(n)) continue;
        visited.add(n);
        const nNode = this.nodes.get(n);
        if (!nNode) continue;
        const nDist = this.distance(query, nNode.vector);
        const worstResult = results.peek();
        if (!worstResult || results.size() < ef || nDist < worstResult.dist) {
          candidates.push({ id: n, dist: nDist });
          results.push({ id: n, dist: nDist });
          if (results.size() > ef) results.pop();
        }
      }
    }
    // Return sorted ascending by distance.
    return results.toArray().sort((a, b) => a.dist - b.dist);
  }

  /**
   * Select up to `M` neighbors from a sorted candidate list. Uses the
   * simple "M nearest" heuristic (the original HNSW paper also describes
   * a more sophisticated heuristic that promotes diversity; the simple
   * heuristic is fine for our corpus sizes and is faster).
   */
  private selectNeighbors(candidates: Candidate[], M: number): string[] {
    return candidates.slice(0, M).map((c) => c.id);
  }

  /**
   * Prune a node's connections on a layer to its `M` nearest neighbors.
   * Called when adding a bidirectional link pushes a neighbor over the
   * layer's connection cap.
   */
  private pruneConnections(layer: number, nodeId: string, maxConn: number): void {
    const layerGraph = this.graph.get(layer);
    if (!layerGraph) return;
    const conns = layerGraph.get(nodeId);
    if (!conns || conns.size <= maxConn) return;
    const node = this.nodes.get(nodeId);
    if (!node) return;
    // Re-rank neighbors by distance to this node, keep the closest maxConn.
    const ranked: Candidate[] = [];
    for (const n of conns) {
      const nNode = this.nodes.get(n);
      if (!nNode) continue;
      ranked.push({ id: n, dist: this.distance(node.vector, nNode.vector) });
    }
    ranked.sort((a, b) => a.dist - b.dist);
    const keep = new Set(ranked.slice(0, maxConn).map((c) => c.id));
    // Remove the rest (bidirectionally).
    for (const n of conns) {
      if (!keep.has(n)) {
        conns.delete(n);
        const nConns = layerGraph.get(n);
        if (nConns) nConns.delete(nodeId);
      }
    }
  }

  /**
   * Sample a random level using the logarithmic decay distribution from
   * the HNSW paper: `level = floor(-ln(uniform()) * mL)` where
   * `mL = 1 / ln(M)`. This produces an exponential decay — most nodes
   * end up at level 0, with exponentially fewer at each higher level.
   */
  private randomLevel(): number {
    const mL = 1 / Math.log(Math.max(2, this.M));
    const u = Math.random();
    // Guard against log(0).
    const safe = Math.max(u, 1e-12);
    return Math.floor(-Math.log(safe) * mL);
  }

  /**
   * Cosine distance: `1 - cos(θ)`. Assumes both vectors are already
   * L2-normalized (which `add()` / `search()` enforce before calling
   * here). For non-normalized inputs the result is still a valid
   * distance in [0, 2] but the relative ordering may differ from true
   * cosine distance — call `l2Normalize` upstream to avoid this.
   */
  private distance(a: Float32Array, b: Float32Array): number {
    let dot = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) dot += a[i]! * b[i]!;
    return 1 - dot;
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────

/**
 * L2-normalize a vector in place-safe fashion (returns a new
 * `Float32Array`). Zero vectors are returned unchanged.
 */
function l2Normalize(vec: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i]! * vec[i]!;
  norm = Math.sqrt(norm);
  if (norm === 0) return new Float32Array(vec);
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i]! / norm;
  return out;
}

// ─── Min / Max heaps ─────────────────────────────────────────────────────

/**
 * Min-heap of `Candidate` keyed by `dist`. Used as the exploration
 * frontier in {@link HNSWIndex.searchLayer}.
 */
class MinHeap {
  private readonly arr: Candidate[] = [];

  size(): number {
    return this.arr.length;
  }

  push(c: Candidate): void {
    this.arr.push(c);
    this.bubbleUp(this.arr.length - 1);
  }

  pop(): Candidate | undefined {
    if (this.arr.length === 0) return undefined;
    const top = this.arr[0]!;
    const last = this.arr.pop()!;
    if (this.arr.length > 0) {
      this.arr[0] = last;
      this.sinkDown(0);
    }
    return top;
  }

  peek(): Candidate | undefined {
    return this.arr[0];
  }

  toArray(): Candidate[] {
    return [...this.arr];
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.arr[i]!.dist < this.arr[parent]!.dist) {
        [this.arr[i], this.arr[parent]] = [this.arr[parent]!, this.arr[i]!];
        i = parent;
      } else break;
    }
  }

  private sinkDown(i: number): void {
    const n = this.arr.length;
    while (true) {
      const left = i * 2 + 1;
      const right = i * 2 + 2;
      let smallest = i;
      if (left < n && this.arr[left]!.dist < this.arr[smallest]!.dist) smallest = left;
      if (right < n && this.arr[right]!.dist < this.arr[smallest]!.dist) smallest = right;
      if (smallest === i) break;
      [this.arr[i], this.arr[smallest]] = [this.arr[smallest]!, this.arr[i]!];
      i = smallest;
    }
  }
}

/**
 * Max-heap of `Candidate` keyed by `dist`. Used as the result set in
 * {@link HNSWIndex.searchLayer} so the worst (largest-distance) element
 * can be evicted in O(1) when the set exceeds `ef`.
 */
class MaxHeap {
  private readonly arr: Candidate[] = [];

  size(): number {
    return this.arr.length;
  }

  push(c: Candidate): void {
    this.arr.push(c);
    this.bubbleUp(this.arr.length - 1);
  }

  pop(): Candidate | undefined {
    if (this.arr.length === 0) return undefined;
    const top = this.arr[0]!;
    const last = this.arr.pop()!;
    if (this.arr.length > 0) {
      this.arr[0] = last;
      this.sinkDown(0);
    }
    return top;
  }

  peek(): Candidate | undefined {
    return this.arr[0];
  }

  toArray(): Candidate[] {
    return [...this.arr];
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.arr[i]!.dist > this.arr[parent]!.dist) {
        [this.arr[i], this.arr[parent]] = [this.arr[parent]!, this.arr[i]!];
        i = parent;
      } else break;
    }
  }

  private sinkDown(i: number): void {
    const n = this.arr.length;
    while (true) {
      const left = i * 2 + 1;
      const right = i * 2 + 2;
      let largest = i;
      if (left < n && this.arr[left]!.dist > this.arr[largest]!.dist) largest = left;
      if (right < n && this.arr[right]!.dist > this.arr[largest]!.dist) largest = right;
      if (largest === i) break;
      [this.arr[i], this.arr[largest]] = [this.arr[largest]!, this.arr[i]!];
      i = largest;
    }
  }
}
