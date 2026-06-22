/**
 * @file LazyLoader.ts
 * @description Defer module loading until first use. Wraps `import()`
 * behind a memoized promise so subsequent calls return the cached module.
 * The registry tracks all lazy-loaded modules for diagnostics + bulk
 * preloading.
 *
 * @packageDocumentation
 */

/** A registered lazy module. */
interface LazyModule<T> {
  /** The spec passed to `import()`. */
  spec: string;
  /** The in-flight or resolved promise. */
  promise?: Promise<T>;
  /** Whether the module has been loaded. */
  loaded: boolean;
  /** Wall-clock ms spent loading (set after load). */
  loadMs?: number;
}

/**
 * A registry of lazy-loaded modules.
 *
 * @example
 * ```ts
 * const l = new LazyLoader();
 * const mod = await l.load('./heavy.js');  // first call: imports
 * const mod2 = await l.load('./heavy.js'); // second call: cached
 * l.snapshot(); // [{ spec: './heavy.js', loaded: true, loadMs: 42 }]
 * ```
 */
export class LazyLoader {
  private readonly modules = new Map<string, LazyModule<unknown>>();

  /**
   * Load (or return the cached) module. The first call triggers a dynamic
   * `import()`; subsequent calls with the same spec return the same promise.
   *
   * @param spec The module specifier (e.g. `./heavy.js` or `lodash`).
   */
  async load<T>(spec: string): Promise<T> {
    let entry = this.modules.get(spec) as LazyModule<T> | undefined;
    if (!entry) {
      entry = { spec, loaded: false };
      this.modules.set(spec, entry as LazyModule<unknown>);
    }
    if (entry.promise) return entry.promise;
    const start = Date.now();
    entry.promise = import(spec).then((m: T) => {
      entry.loaded = true;
      entry.loadMs = Date.now() - start;
      return m;
    });
    return entry.promise;
  }

  /**
   * Preload a list of modules in parallel. Returns when all have loaded
   * (or rejected — errors are returned, not thrown).
   *
   * @param specs Module specifiers.
   */
  async preload(specs: readonly string[]): Promise<Array<{ spec: string; ok: boolean; error?: string }>> {
    const results = await Promise.allSettled(specs.map((s) => this.load(s)));
    return results.map((r, i) => ({
      spec: specs[i],
      ok: r.status === 'fulfilled',
      error: r.status === 'rejected' ? String(r.reason) : undefined,
    }));
  }

  /** Whether a module has been loaded (resolved) yet. */
  isLoaded(spec: string): boolean {
    return this.modules.get(spec)?.loaded ?? false;
  }

  /** Snapshot of all registered lazy modules (for diagnostics). */
  snapshot(): Array<{ spec: string; loaded: boolean; loadMs?: number }> {
    return [...this.modules.values()].map((m) => ({ spec: m.spec, loaded: m.loaded, loadMs: m.loadMs }));
  }

  /** Number of registered lazy modules. */
  get size(): number {
    return this.modules.size;
  }

  /** Number of modules that have finished loading. */
  get loadedCount(): number {
    let n = 0;
    for (const m of this.modules.values()) if (m.loaded) n++;
    return n;
  }
}
