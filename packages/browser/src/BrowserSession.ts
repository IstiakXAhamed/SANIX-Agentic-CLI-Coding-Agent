/**
 * @file BrowserSession — high-level helper that chains browser actions
 * into a session against a single page.
 *
 * A `BrowserSession` owns no Playwright state itself; it borrows a
 * {@link BrowserManager} and tracks the page id it opened in `start()`.
 * The session is intentionally stateless across `flow()` calls —
 * callers can interleave `flow()` with manual tool invocations.
 */
import type { BrowserManager, PageHandle } from './BrowserManager.js';
import type {
  BrowserAction,
  BrowserActionResult,
  ClickAction,
  DownloadAction,
  EvaluateAction,
  ExtractAction,
  FillAction,
  GoBackAction,
  GoForwardAction,
  HoverAction,
  NavigateAction,
  PdfAction,
  PressAction,
  ScreenshotAction,
  ScrollAction,
  SelectAction,
  TypeAction,
  UploadAction,
  WaitAction,
} from './types.js';
import { htmlToMarkdown } from './html-to-markdown.js';

/**
 * Options accepted by {@link BrowserSession.start}.
 */
export interface BrowserSessionStartOptions {
  /** Navigation wait condition (default `load`). */
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
}

/**
 * BrowserSession — chain browser actions on a single page.
 *
 * @example
 * ```ts
 * const mgr = new BrowserManager();
 * await mgr.launch();
 * const session = new BrowserSession(mgr);
 * const pageId = await session.start('https://example.com');
 * const results = await session.flow([
 *   { type: 'click', selector: 'a.login' },
 *   { type: 'fill', selector: '#email', value: 'me@example.com' },
 *   { type: 'fill', selector: '#password', value: '••••' },
 *   { type: 'click', selector: 'button[type=submit]' },
 *   { type: 'wait', selector: '.dashboard', timeoutMs: 10_000 },
 *   { type: 'extract', mode: 'markdown' },
 * ]);
 * await mgr.close();
 * ```
 */
export class BrowserSession {
  private pageId: string | null = null;

  constructor(private readonly manager: BrowserManager) {}

  /**
   * Open a new page and navigate to `url`. Returns the pageId.
   */
  async start(url: string, opts: BrowserSessionStartOptions = {}): Promise<string> {
    const handle: PageHandle = await this.manager.newPage({
      url,
    });
    this.pageId = handle.id;
    if (opts.waitUntil) {
      const page = this.manager.getPlaywrightPage(this.pageId);
      if (page) {
        await page.waitForLoadState(opts.waitUntil).catch(() => {
          /* swallow — start() never throws on a load-state timeout */
        });
      }
    }
    return this.pageId;
  }

  /** The pageId this session is operating on (or `null` if `start()` hasn't been called). */
  get currentPageId(): string | null {
    return this.pageId;
  }

  /**
   * Execute a sequence of {@link BrowserAction}s on the session's page.
   *
   * Each action is wrapped in a try/catch; failures are recorded with
   * `success: false` and an `error` message, but execution continues
   * for the remaining actions. Callers can short-circuit by inspecting
   * results between `flow()` calls.
   *
   * @returns An array of {@link BrowserActionResult}s in the same order
   *          as the input `actions` array.
   */
  async flow(actions: BrowserAction[]): Promise<BrowserActionResult[]> {
    if (!this.pageId) {
      throw new Error('BrowserSession.flow: call start(url) first');
    }
    const out: BrowserActionResult[] = [];
    for (const action of actions) {
      const start = Date.now();
      try {
        const output = await this.runOne(action);
        out.push({
          action,
          success: true,
          output,
          durationMs: Date.now() - start,
        });
      } catch (err) {
        out.push({
          action,
          success: false,
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - start,
        });
      }
    }
    return out;
  }

  /**
   * Heuristic main-content extractor. Tries `<article>`, `<main>`,
   * `[role=main]` in order; falls back to `<body>`. Strips
   * nav/footer/script/style/aside before converting to Markdown.
   */
  async extractMainContent(): Promise<string> {
    if (!this.pageId) throw new Error('BrowserSession.extractMainContent: no active page');
    const page = this.manager.getPlaywrightPage(this.pageId);
    if (!page) throw new Error('BrowserSession.extractMainContent: page closed');

    const html = await page.evaluate(() => {
      const selectors = ['article', 'main', '[role="main"]', 'body'];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.textContent && el.textContent.trim().length > 0) {
          // Strip nav/footer/script/style/aside in-place.
          el.querySelectorAll('nav, footer, script, style, aside, noscript').forEach((n) => n.remove());
          return el.outerHTML;
        }
      }
      return document.body.outerHTML;
    });
    return htmlToMarkdown(html ?? '');
  }

  /**
   * Extract every `<a>` tag on the page as `{ text, url }` pairs.
   * Empty-text and duplicate URLs are filtered out.
   */
  async extractLinks(): Promise<Array<{ text: string; url: string }>> {
    if (!this.pageId) throw new Error('BrowserSession.extractLinks: no active page');
    const page = this.manager.getPlaywrightPage(this.pageId);
    if (!page) throw new Error('BrowserSession.extractLinks: page closed');

    const raw = await page.$$eval('a', (els) =>
      els
        .map((e) => ({
          text: (e.textContent ?? '').trim(),
          url: (e as HTMLAnchorElement).href,
        }))
        .filter((l) => l.text && l.url),
    );
    const seen = new Set<string>();
    const out: Array<{ text: string; url: string }> = [];
    for (const l of raw) {
      if (seen.has(l.url)) continue;
      seen.add(l.url);
      out.push(l);
    }
    return out;
  }

  /** Close the session's page (no-op if no session is active). */
  async close(): Promise<void> {
    if (this.pageId) {
      await this.manager.closePage(this.pageId);
      this.pageId = null;
    }
  }

  // ── Per-action dispatch ───────────────────────────────────────────────

  private async runOne(action: BrowserAction): Promise<unknown> {
    if (!this.pageId) throw new Error('no active page');
    const page = this.manager.getPlaywrightPage(this.pageId);
    if (!page) throw new Error('page closed');

    switch (action.type) {
      case 'navigate':
        return this.runNavigate(action);
      case 'click':
        return this.runClick(action);
      case 'type':
        return this.runType(action);
      case 'fill':
        return this.runFill(action);
      case 'scroll':
        return this.runScroll(action);
      case 'screenshot':
        return this.runScreenshot(action);
      case 'extract':
        return this.runExtract(action);
      case 'wait':
        return this.runWait(action);
      case 'evaluate':
        return this.runEvaluate(action);
      case 'select':
        return this.runSelect(action);
      case 'hover':
        return this.runHover(action);
      case 'press':
        return this.runPress(action);
      case 'upload':
        return this.runUpload(action);
      case 'download':
        return this.runDownload(action);
      case 'pdf':
        return this.runPdf(action);
      case 'go_back':
        await page.goBack({ waitUntil: 'load' });
        return { wentBack: true, url: page.url() };
      case 'go_forward':
        await page.goForward({ waitUntil: 'load' });
        return { wentForward: true, url: page.url() };
      case 'reload':
        await page.reload({ waitUntil: 'load' });
        return { reloaded: true, url: page.url() };
      default: {
        // Exhaustiveness guard — if a new action is added to the union
        // without a handler here, TS will fail to compile.
        const _exhaustive: never = action;
        void _exhaustive;
        throw new Error(`BrowserSession.flow: unsupported action type`);
      }
    }
  }

  private async runNavigate(a: NavigateAction) {
    if (!this.pageId) throw new Error('no page');
    const page = this.manager.getPlaywrightPage(this.pageId);
    if (!page) throw new Error('page closed');
    const res = await page.goto(a.url, { waitUntil: a.waitUntil ?? 'load' });
    return {
      url: page.url(),
      title: await page.title().catch(() => ''),
      statusCode: res?.status() ?? 0,
    };
  }

  private async runClick(a: ClickAction) {
    if (!this.pageId) throw new Error('no page');
    const page = this.manager.getPlaywrightPage(this.pageId);
    if (!page) throw new Error('page closed');
    await page.click(a.selector, {
      button: a.button ?? 'left',
      clickCount: a.clickCount ?? 1,
      delay: a.delayMs,
    });
    return { clicked: true };
  }

  private async runType(a: TypeAction) {
    if (!this.pageId) throw new Error('no page');
    const page = this.manager.getPlaywrightPage(this.pageId);
    if (!page) throw new Error('page closed');
    if (a.clearFirst ?? true) {
      await page.fill(a.selector, '').catch(() => {});
    }
    await page.type(a.selector, a.text, { delay: a.delayMs });
    return { typed: true };
  }

  private async runFill(a: FillAction) {
    if (!this.pageId) throw new Error('no page');
    const page = this.manager.getPlaywrightPage(this.pageId);
    if (!page) throw new Error('page closed');
    await page.fill(a.selector, a.value);
    return { filled: true };
  }

  private async runScroll(a: ScrollAction) {
    if (!this.pageId) throw new Error('no page');
    const page = this.manager.getPlaywrightPage(this.pageId);
    if (!page) throw new Error('page closed');
    if (a.selector) {
      const dx = a.x ?? 0;
      const dy = a.y ?? 0;
      await page.$eval(
        a.selector,
        (el: Element, [dx, dy]: [number, number]) => el.scrollBy(dx, dy),
        [dx, dy] as [number, number],
      );
    } else {
      await page.mouse.wheel(a.x ?? 0, a.y ?? 0);
    }
    return { scrolled: true };
  }

  private async runScreenshot(a: ScreenshotAction) {
    if (!this.pageId) throw new Error('no page');
    const buf = await this.manager.screenshot(this.pageId, {
      fullPage: a.fullPage,
      type: a.type_,
      quality: a.quality,
    });
    return {
      imageBase64: buf.toString('base64'),
      bytes: buf.byteLength,
    };
  }

  private async runExtract(a: ExtractAction) {
    if (!this.pageId) throw new Error('no page');
    const page = this.manager.getPlaywrightPage(this.pageId);
    if (!page) throw new Error('page closed');
    const selector = a.selector ?? 'body';
    const mode = a.mode ?? 'text';
    if (mode === 'markdown') {
      const html = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return el ? el.outerHTML : document.documentElement.outerHTML;
      }, selector);
      return { content: htmlToMarkdown(html ?? ''), elements: 1 };
    }
    if (mode === 'text') {
      const texts = await page.$$eval(selector, (els) =>
        els.map((e) => (e as HTMLElement).innerText ?? ''),
      );
      return { content: texts.join('\n'), elements: texts.length };
    }
    if (mode === 'html') {
      const htmls = await page.$$eval(selector, (els) =>
        els.map((e) => (e as HTMLElement).outerHTML),
      );
      return { content: htmls.join('\n'), elements: htmls.length };
    }
    // attribute
    if (!a.attribute) throw new Error('extract: attribute required for attribute mode');
    const attr = a.attribute;
    const vals = await page.$$eval(
      selector,
      (els, name) => els.map((e) => (e as HTMLElement).getAttribute(name) ?? ''),
      attr,
    );
    return { content: vals.join('\n'), elements: vals.length };
  }

  private async runWait(a: WaitAction) {
    if (!this.pageId) throw new Error('no page');
    const page = this.manager.getPlaywrightPage(this.pageId);
    if (!page) throw new Error('page closed');
    if (a.url) {
      await page.waitForURL(a.url, { timeout: a.timeoutMs ?? 30_000 });
    } else if (a.selector) {
      await page.waitForSelector(a.selector, {
        state: a.state ?? 'visible',
        timeout: a.timeoutMs ?? 30_000,
      });
    } else {
      throw new Error('wait: either selector or url required');
    }
    return { waited: true };
  }

  private async runEvaluate(a: EvaluateAction) {
    if (!this.pageId) throw new Error('no page');
    const page = this.manager.getPlaywrightPage(this.pageId);
    if (!page) throw new Error('page closed');
    const result = await page.evaluate(a.script, a.args ?? []);
    return { result };
  }

  private async runSelect(a: SelectAction) {
    if (!this.pageId) throw new Error('no page');
    const page = this.manager.getPlaywrightPage(this.pageId);
    if (!page) throw new Error('page closed');
    await page.selectOption(a.selector, a.value);
    return { selected: true };
  }

  private async runHover(a: HoverAction) {
    if (!this.pageId) throw new Error('no page');
    const page = this.manager.getPlaywrightPage(this.pageId);
    if (!page) throw new Error('page closed');
    await page.hover(a.selector);
    return { hovered: true };
  }

  private async runPress(a: PressAction) {
    if (!this.pageId) throw new Error('no page');
    const page = this.manager.getPlaywrightPage(this.pageId);
    if (!page) throw new Error('page closed');
    await page.keyboard.press(a.key);
    return { pressed: true };
  }

  private async runUpload(a: UploadAction) {
    if (!this.pageId) throw new Error('no page');
    const page = this.manager.getPlaywrightPage(this.pageId);
    if (!page) throw new Error('page closed');
    await page.setInputFiles(a.selector, a.filePath);
    return { uploaded: true };
  }

  private async runDownload(a: DownloadAction) {
    if (!this.pageId) throw new Error('no page');
    const page = this.manager.getPlaywrightPage(this.pageId);
    if (!page) throw new Error('page closed');
    const downloadPromise = page.waitForEvent('download', {
      timeout: a.timeoutMs ?? 30_000,
    });
    if (a.selector) await page.click(a.selector);
    else if (a.url) await page.goto(a.url);
    else throw new Error('download: either url or selector required');
    const dl = await downloadPromise;
    let savePath: string;
    if (a.saveToPath) {
      const { promises: fs } = await import('node:fs');
      const path = await import('node:path');
      await fs.mkdir(path.dirname(a.saveToPath), { recursive: true });
      await dl.saveAs(a.saveToPath);
      savePath = a.saveToPath;
    } else {
      // Playwright saves the download to a temp dir; expose that path.
      savePath = (await dl.path()) ?? '';
    }
    return {
      downloaded: true,
      path: savePath,
      suggestedFilename: dl.suggestedFilename(),
    };
  }

  private async runPdf(a: PdfAction) {
    if (!this.pageId) throw new Error('no page');
    const page = this.manager.getPlaywrightPage(this.pageId);
    if (!page) throw new Error('page closed');
    const raw = await page.pdf({
      format: a.format ?? 'A4',
      landscape: a.landscape ?? false,
      printBackground: a.printBackground ?? true,
    });
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    if (a.saveToPath) {
      const { promises: fs } = await import('node:fs');
      const path = await import('node:path');
      await fs.mkdir(path.dirname(a.saveToPath), { recursive: true });
      await fs.writeFile(a.saveToPath, buf);
      return { bytes: buf.byteLength, path: a.saveToPath };
    }
    return { bytes: buf.byteLength, path: '' };
  }
}
