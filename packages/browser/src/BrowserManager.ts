/**
 * @file BrowserManager — owns the Playwright browser + context + pages
 * lifecycle for `@sanix/browser`.
 *
 * Design notes:
 *   - `playwright` is dynamically imported inside `launch()` so the package
 *     loads even when Playwright isn't installed. Tools that call
 *     `manager.getPage()` before `launch()` will trigger an implicit launch.
 *   - The manager is an `eventemitter3` and emits a typed event for every
 *     meaningful lifecycle transition (browser launch, page create/close,
 *     navigation, error).
 *   - Each page is wrapped in a `PageHandle` exposing a stable sync
 *     `url`/`title` (the title is cached on every navigation because
 *     Playwright's `page.title()` is async).
 *   - Pages idle for > 30 minutes are automatically closed by a background
 *     sweeper (configurable via `idleSweepMs` / `maxIdleMs`).
 *   - When `userDataDir` is supplied the manager opens a *persistent*
 *     context (cookies + storage survive across runs). In that mode there
 *     is no separate `Browser` instance — the context IS the browser.
 */
import { EventEmitter } from 'eventemitter3';
import { nanoid } from 'nanoid';
import type { Browser, BrowserContext, Page } from 'playwright';

/**
 * Constructor options for {@link BrowserManager}.
 */
export interface BrowserManagerOptions {
  /** Which Playwright browser driver to launch. Defaults to `chromium`. */
  browser?: 'chromium' | 'firefox' | 'webkit';
  /** Run headless (default `true`). */
  headless?: boolean;
  /** Default navigation/timeout in ms applied to every new page (default 30s). */
  defaultTimeoutMs?: number;
  /** Maximum number of concurrent pages (default 10). */
  maxPages?: number;
  /** If set, launch a persistent context backed by this user-data directory. */
  userDataDir?: string;
  /** Extra args passed to the browser launcher. */
  args?: string[];
}

/**
 * Options accepted by {@link BrowserManager.newPage}.
 */
export interface NewPageOptions {
  /** Navigate to this URL immediately after creating the page. */
  url?: string;
  /** Set the viewport size on the new page. */
  viewport?: { width: number; height: number };
  /** Override the User-Agent header (forces a fresh per-page context). */
  userAgent?: string;
  /** Set the locale (forces a fresh per-page context). */
  locale?: string;
  /** Extra HTTP headers attached to every request from this page. */
  extraHTTPHeaders?: Record<string, string>;
}

/**
 * Options accepted by {@link BrowserManager.screenshot}.
 */
export interface ScreenshotOptions {
  /** Capture the full scrollable page (default `false`). */
  fullPage?: boolean;
  /** Image format (default `png`). */
  type?: 'png' | 'jpeg';
  /** JPEG quality 0–100 (ignored for PNG). */
  quality?: number;
}

/**
 * Stable handle to an open browser page. Returned by
 * {@link BrowserManager.newPage} and {@link BrowserManager.getPage}.
 *
 * The `url` and `title` getters are synchronous and reflect the page's
 * current state (the title is cached on every navigation event).
 */
export interface PageHandle {
  /** Stable unique id for this page. */
  readonly id: string;
  /** Current URL of the page's main frame (sync). */
  readonly url: string;
  /** Cached page title (updated on every navigation). */
  readonly title: string;
  /** Epoch milliseconds when this page was created. */
  readonly createdAt: number;
  /** Close the page (delegates to {@link BrowserManager.closePage}). */
  close(): Promise<void>;
}

/**
 * Event payloads emitted by {@link BrowserManager}.
 */
export interface BrowserManagerEventMap {
  'browser:launched': { browser: 'chromium' | 'firefox' | 'webkit'; persistent: boolean };
  'page:created': { id: string; url: string };
  'page:closed': { id: string };
  'page:navigated': { id: string; url: string; title: string };
  'page:error': { id: string; error: string };
}

/** Idle-sweep interval (5 minutes). */
const IDLE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
/** Pages idle longer than this are auto-closed (30 minutes). */
const MAX_IDLE_MS = 30 * 60 * 1000;

/**
 * Internal per-page bookkeeping. The Playwright `Page` lives here so the
 * tools can reach it via {@link BrowserManager.getPlaywrightPage}.
 */
interface InternalPage {
  id: string;
  page: Page;
  /** The context the page lives in (may be the shared one or a per-page one). */
  context: BrowserContext;
  /** True if we created a private context for this page that must be closed with it. */
  ownsContext: boolean;
  createdAt: number;
  lastActivityAt: number;
  /** Cached page title — Playwright's `page.title()` is async. */
  currentTitle: string;
}

/**
 * Concrete `PageHandle` implementation. Lives in this file so the
 * `InternalPage` reference can be held privately.
 */
class PageHandleImpl implements PageHandle {
  constructor(
    private readonly ref: { current: InternalPage | null },
    private readonly manager: BrowserManager,
  ) {}

  get id(): string {
    const ip = this.ref.current;
    if (!ip) throw new Error('PageHandle: page has been closed');
    return ip.id;
  }

  get url(): string {
    const ip = this.ref.current;
    if (!ip) return 'about:blank';
    try {
      return ip.page.url();
    } catch {
      return 'about:blank';
    }
  }

  get title(): string {
    const ip = this.ref.current;
    return ip ? ip.currentTitle : '';
  }

  get createdAt(): number {
    const ip = this.ref.current;
    if (!ip) throw new Error('PageHandle: page has been closed');
    return ip.createdAt;
  }

  async close(): Promise<void> {
    const ip = this.ref.current;
    if (!ip) return;
    await this.manager.closePage(ip.id);
  }
}

/**
 * BrowserManager — manages Playwright browser instances + contexts + pages.
 *
 * @example
 * ```ts
 * const mgr = new BrowserManager({ headless: true });
 * mgr.on('page:navigated', ({ id, url }) => console.log(id, '→', url));
 * await mgr.launch();
 * const page = await mgr.newPage({ url: 'https://example.com' });
 * console.log(page.title);
 * await mgr.close();
 * ```
 */
export class BrowserManager extends EventEmitter<BrowserManagerEventMap> {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private readonly pages = new Map<string, InternalPage>();
  private readonly handles = new Map<string, PageHandleImpl>();
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private persistent: boolean = false;
  private launching: Promise<void> | null = null;

  constructor(private readonly opts: BrowserManagerOptions = {}) {
    super();
  }

  /**
   * Launch the underlying browser (lazy — Playwright is dynamically
   * imported here). Subsequent calls are no-ops; concurrent callers
   * share the same in-flight launch promise.
   *
   * @throws {Error} if Playwright is not installed.
   */
  async launch(): Promise<void> {
    if (this.browser || this.context) return;
    if (this.launching) return this.launching;
    this.launching = this.doLaunch();
    try {
      await this.launching;
    } finally {
      this.launching = null;
    }
  }

  private async doLaunch(): Promise<void> {
    let pw: typeof import('playwright');
    try {
      pw = await import('playwright');
    } catch {
      throw new Error(
        'Playwright not installed. Run: npm install playwright && npx playwright install chromium',
      );
    }

    const browserType = this.opts.browser ?? 'chromium';
    const headless = this.opts.headless ?? true;
    const args = this.opts.args ?? [];
    const launcher = pw[browserType];

    if (this.opts.userDataDir) {
      // Persistent context — there is no separate Browser instance.
      this.context = await launcher.launchPersistentContext(this.opts.userDataDir, {
        headless,
        args,
      });
      this.persistent = true;
    } else {
      this.browser = await launcher.launch({ headless, args });
      this.context = await this.browser.newContext();
    }

    const timeout = this.opts.defaultTimeoutMs ?? 30_000;
    try {
      this.context.setDefaultTimeout(timeout);
      this.context.setDefaultNavigationTimeout(timeout * 2);
    } catch {
      /* some Playwright builds throw on the navigation timeout setter */
    }

    this.emit('browser:launched', { browser: browserType, persistent: this.persistent });
    this.startIdleSweeper();
  }

  /**
   * Open a new browser page and (optionally) navigate to a URL.
   *
   * If `userAgent`, `locale`, or `viewport` are supplied *and* the manager
   * is not in persistent-context mode, a private per-page context is
   * created so those options take effect (they cannot be set on a `Page`
   * after creation).
   *
   * @example
   * ```ts
   * const page = await mgr.newPage({
   *   url: 'https://example.com',
   *   viewport: { width: 1280, height: 800 },
   * });
   * ```
   */
  async newPage(opts: NewPageOptions = {}): Promise<PageHandle> {
    if (!this.context) await this.launch();
    if (!this.context) {
      throw new Error('BrowserManager: launch() failed — no context available');
    }

    const maxPages = this.opts.maxPages ?? 10;
    if (this.pages.size >= maxPages) {
      throw new Error(
        `BrowserManager: max pages (${maxPages}) reached — close a page first`,
      );
    }

    // Decide whether we need a private per-page context.
    const needsOwnContext =
      !this.persistent && (!!opts.userAgent || !!opts.locale);

    let context = this.context;
    let ownsContext = false;
    if (needsOwnContext && this.browser) {
      context = await this.browser.newContext({
        userAgent: opts.userAgent,
        locale: opts.locale,
        viewport: opts.viewport,
        extraHTTPHeaders: opts.extraHTTPHeaders,
      });
      const timeout = this.opts.defaultTimeoutMs ?? 30_000;
      try {
        context.setDefaultTimeout(timeout);
      } catch {
        /* ignore */
      }
      ownsContext = true;
    }

    const page = await context.newPage();
    const id = nanoid();
    const ref: { current: InternalPage | null } = { current: null };
    const internal: InternalPage = {
      id,
      page,
      context,
      ownsContext,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      currentTitle: '',
    };
    ref.current = internal;
    this.pages.set(id, internal);
    this.handles.set(id, new PageHandleImpl(ref, this));

    if (!ownsContext && opts.viewport) {
      try {
        await page.setViewportSize(opts.viewport);
      } catch {
        /* ignore — race with navigation */
      }
    }
    if (!ownsContext && opts.extraHTTPHeaders) {
      try {
        await page.setExtraHTTPHeaders(opts.extraHTTPHeaders);
      } catch {
        /* ignore */
      }
    }

    // Track navigation + errors.
    page.on('framenavigated', async (frame) => {
      if (frame !== page.mainFrame()) return;
      internal.lastActivityAt = Date.now();
      try {
        internal.currentTitle = await page.title();
      } catch {
        /* ignore */
      }
      this.emit('page:navigated', { id, url: page.url(), title: internal.currentTitle });
    });
    page.on('pageerror', (err) => {
      this.emit('page:error', { id, error: err.message });
    });
    page.on('close', () => {
      if (this.pages.has(id)) {
        this.pages.delete(id);
        this.handles.delete(id);
        ref.current = null;
        this.emit('page:closed', { id });
      }
    });

    this.emit('page:created', { id, url: page.url() });

    if (opts.url) {
      try {
        await page.goto(opts.url, { waitUntil: 'load' });
        internal.currentTitle = await page.title();
      } catch (err) {
        this.emit('page:error', {
          id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return this.handles.get(id)!;
  }

  /**
   * Get a {@link PageHandle} by id, or `null` if no such page exists.
   */
  getPage(id: string): PageHandle | null {
    return this.handles.get(id) ?? null;
  }

  /**
   * List all currently-open pages.
   */
  listPages(): PageHandle[] {
    return Array.from(this.handles.values());
  }

  /**
   * Close a specific page by id. No-op if the page does not exist.
   */
  async closePage(id: string): Promise<void> {
    const internal = this.pages.get(id);
    if (!internal) return;
    try {
      await internal.page.close();
    } catch {
      /* ignore */
    }
    if (internal.ownsContext) {
      try {
        await internal.context.close();
      } catch {
        /* ignore */
      }
    }
    this.pages.delete(id);
    this.handles.delete(id);
    this.emit('page:closed', { id });
  }

  /**
   * Take a screenshot of a page and return it as a `Buffer`.
   *
   * @example
   * ```ts
   * const buf = await mgr.screenshot(pageId, { fullPage: true });
   * fs.writeFileSync('page.png', buf);
   * ```
   */
  async screenshot(id: string, opts: ScreenshotOptions = {}): Promise<Buffer> {
    const internal = this.requireInternal(id);
    internal.lastActivityAt = Date.now();
    const raw = await internal.page.screenshot({
      fullPage: opts.fullPage ?? false,
      type: opts.type ?? 'png',
      quality: opts.type === 'jpeg' ? opts.quality : undefined,
    });
    // Playwright types this as `Uint8Array`, but in Node it's actually a Buffer.
    return Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  }

  /**
   * Internal accessor used by the browser tools: returns the underlying
   * Playwright `Page` so the tools can call `page.click()`, `page.fill()`,
   * etc. without going through the handle abstraction.
   *
   * Marked public so tools in this package can reach it, but consumers
   * outside `@sanix/browser` should prefer the high-level helpers.
   */
  getPlaywrightPage(id: string): Page | null {
    const internal = this.pages.get(id);
    return internal ? internal.page : null;
  }

  /**
   * Close every page + the browser. Safe to call multiple times.
   */
  async close(): Promise<void> {
    this.stopIdleSweeper();
    const ids = Array.from(this.pages.keys());
    await Promise.all(ids.map((id) => this.closePage(id).catch(() => {})));

    if (this.context) {
      try {
        await this.context.close();
      } catch {
        /* ignore */
      }
      this.context = null;
    }
    if (this.browser) {
      try {
        await this.browser.close();
      } catch {
        /* ignore */
      }
      this.browser = null;
    }
    this.persistent = false;
  }

  // ── Internals ─────────────────────────────────────────────────────────

  /** @internal Look up an InternalPage or throw a clear error. */
  private requireInternal(id: string): InternalPage {
    const internal = this.pages.get(id);
    if (!internal) {
      throw new Error(`BrowserManager: page not found (id=${id}). Call browser_navigate first.`);
    }
    return internal;
  }

  /** @internal Start the periodic idle-page sweeper. */
  private startIdleSweeper(): void {
    if (this.idleTimer) return;
    this.idleTimer = setInterval(() => void this.sweepIdle(), IDLE_SWEEP_INTERVAL_MS);
    // Don't keep the Node process alive just for the sweeper.
    if (this.idleTimer && typeof this.idleTimer.unref === 'function') {
      this.idleTimer.unref();
    }
  }

  /** @internal Stop the periodic idle-page sweeper. */
  private stopIdleSweeper(): void {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /** @internal Close pages idle for > MAX_IDLE_MS. */
  private async sweepIdle(): Promise<void> {
    const now = Date.now();
    const stale: string[] = [];
    for (const [id, internal] of this.pages) {
      if (now - internal.lastActivityAt > MAX_IDLE_MS) stale.push(id);
    }
    await Promise.all(stale.map((id) => this.closePage(id).catch(() => {})));
  }

  /** @internal Bump the last-activity timestamp (called by tools). */
  touchPage(id: string): void {
    const internal = this.pages.get(id);
    if (internal) internal.lastActivityAt = Date.now();
  }
}
