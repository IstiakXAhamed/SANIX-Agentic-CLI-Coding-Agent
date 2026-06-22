/**
 * @file Debounce.ts
 * @description Three debouncing primitives:
 *
 *   - `debounce(fn, ms)` — call `fn` only after `ms` of silence.
 *   - `throttle(fn, ms)` — call `fn` at most once per `ms`.
 *   - `asyncDebounce(fn, ms)` — like `debounce`, but `fn` is async; only
 *     one in-flight call at a time, with the latest arguments.
 *
 * All return a function with `.cancel()` and `.flush()` methods.
 *
 * @packageDocumentation
 */

/** A debounced function with extra control methods. */
export interface Debounced<A extends unknown[], R> {
  (...args: A): void;
  /** Cancel any pending invocation. */
  cancel(): void;
  /** Immediately invoke any pending call with the latest arguments. */
  flush(): void;
}

/**
 * Debounce: only invoke `fn` after `ms` of silence.
 *
 * @example
 * ```ts
 * const d = debounce((s: string) => console.log(s), 100);
 * d('a'); d('b'); d('c'); // after 100ms: logs 'c'
 * ```
 */
export function debounce<A extends unknown[], R>(
  fn: (...args: A) => R,
  ms: number,
): Debounced<A, R> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastArgs: A | undefined;
  const wrapped = ((...args: A): void => {
    lastArgs = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      const a = lastArgs;
      lastArgs = undefined;
      if (a) fn(...a);
    }, ms);
  }) as Debounced<A, R>;
  wrapped.cancel = (): void => {
    if (timer) { clearTimeout(timer); timer = undefined; }
    lastArgs = undefined;
  };
  wrapped.flush = (): void => {
    if (timer) { clearTimeout(timer); timer = undefined; }
    if (lastArgs) { const a = lastArgs; lastArgs = undefined; fn(...a); }
  };
  return wrapped;
}

/** A throttled function with extra control methods. */
export interface Throttled<A extends unknown[], R> {
  (...args: A): void;
  /** Cancel the trailing invocation. */
  cancel(): void;
  /** Immediately invoke the trailing call (if any). */
  flush(): void;
}

/**
 * Throttle: invoke `fn` at most once per `ms`. The leading edge fires
 * immediately; the trailing edge fires after `ms` if there were calls
 * during the window.
 *
 * @example
 * ```ts
 * const t = throttle((x: number) => console.log(x), 100);
 * for (let i = 0; i < 100; i++) t(i); // logs 0 immediately, then 99 after 100ms
 * ```
 */
export function throttle<A extends unknown[], R>(
  fn: (...args: A) => R,
  ms: number,
): Throttled<A, R> {
  let lastCall = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let trailingArgs: A | undefined;
  const wrapped = ((...args: A): void => {
    const now = Date.now();
    const remaining = ms - (now - lastCall);
    if (remaining <= 0) {
      if (timer) { clearTimeout(timer); timer = undefined; }
      lastCall = now;
      fn(...args);
    } else {
      trailingArgs = args;
      if (!timer) {
        timer = setTimeout(() => {
          lastCall = Date.now();
          timer = undefined;
          if (trailingArgs) { const a = trailingArgs; trailingArgs = undefined; fn(...a); }
        }, remaining);
      }
    }
  }) as Throttled<A, R>;
  wrapped.cancel = (): void => {
    if (timer) { clearTimeout(timer); timer = undefined; }
    trailingArgs = undefined;
  };
  wrapped.flush = (): void => {
    if (timer) { clearTimeout(timer); timer = undefined; }
    if (trailingArgs) { const a = trailingArgs; trailingArgs = undefined; fn(...a); }
  };
  return wrapped;
}

/** An async-debounced function. */
export interface AsyncDebounced<A extends unknown[], R> {
  (...args: A): Promise<R>;
  /** Cancel any pending invocation. */
  cancel(): void;
}

/**
 * Async debounce: like {@link debounce}, but `fn` is async. Only one
 * in-flight call at a time; the latest arguments win.
 *
 * @example
 * ```ts
 * const d = asyncDebounce(async (q: string) => await search(q), 200);
 * const r = await d('hello');
 * ```
 */
export function asyncDebounce<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  ms: number,
): AsyncDebounced<A, R> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastArgs: A | undefined;
  let pendingResolvers: Array<(v: R) => void> = [];
  let pendingRejecters: Array<(e: Error) => void> = [];
  let inFlight = false;
  const trigger = async (): Promise<void> => {
    if (inFlight || !lastArgs) return;
    const args = lastArgs;
    const resolves = pendingResolvers;
    const rejects = pendingRejecters;
    lastArgs = undefined;
    pendingResolvers = [];
    pendingRejecters = [];
    inFlight = true;
    try {
      const result = await fn(...args);
      for (const r of resolves) r(result);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      for (const r of rejects) r(e);
    } finally {
      inFlight = false;
    }
    // If a new call arrived while we were in flight, schedule another.
    if (lastArgs) {
      timer = setTimeout(() => { timer = undefined; void trigger(); }, ms);
      timer.unref?.();
    }
  };
  const wrapped = ((...args: A): Promise<R> => {
    lastArgs = args;
    if (timer) clearTimeout(timer);
    return new Promise<R>((resolveP, rejectP) => {
      pendingResolvers.push(resolveP);
      pendingRejecters.push(rejectP);
      timer = setTimeout(() => { timer = undefined; void trigger(); }, ms);
      timer.unref?.();
    });
  }) as AsyncDebounced<A, R>;
  wrapped.cancel = (): void => {
    if (timer) { clearTimeout(timer); timer = undefined; }
    const e = new Error('canceled');
    for (const r of pendingRejecters) r(e);
    pendingResolvers = [];
    pendingRejecters = [];
    lastArgs = undefined;
  };
  return wrapped;
}
