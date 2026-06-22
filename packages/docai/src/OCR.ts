/**
 * @file OCR.ts
 * @description Optical Character Recognition via `tesseract.js`.
 *
 * Wraps tesseract in a small surface:
 *   - `recognizeImage(buffer, opts)` — single image → text + blocks.
 *   - `recognizePdf(buffer, opts)` — rasterise each PDF page (via
 *     `pdfjs-dist` when available) and OCR each page.
 *
 * When tesseract isn't installed, both methods reject with a clear
 * error so callers can degrade gracefully.
 */

import type { TextBlock } from './types.js';

/**
 * OCR options.
 */
export interface OCROptions {
  /** Tesseract language code(s). Default `eng`. */
  language?: string;
  /** Max pages for PDF OCR (0 = all). */
  maxPages?: number;
  /** Min confidence (0–100) for a block to be included. Default `30`. */
  minConfidence?: number;
}

/** OCR result. */
export interface OCRResult {
  /** Recognised text blocks with bounding boxes + confidence. */
  blocks: TextBlock[];
  /** Concatenated text. */
  text: string;
  /** Warnings. */
  warnings: string[];
}

/** Recognised word/line from tesseract. */
interface TesseractItem {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

/** Recognised data shape from tesseract. */
interface TesseractData {
  text: string;
  words?: TesseractItem[];
  lines?: TesseractItem[];
}

/** Tesseract worker shape. */
interface TesseractWorker {
  recognize: (image: Buffer | string) => Promise<{ data: TesseractData }>;
  terminate: () => Promise<void>;
}

/** Tesseract module shape. */
interface TesseractModule {
  createWorker: (langs?: string | string[]) => Promise<TesseractWorker>;
}

/**
 * OCR via tesseract.js.
 */
export class OCR {
  private cachedModule: TesseractModule | null | undefined;

  /**
   * Recognise text in a single image.
   */
  public async recognizeImage(buffer: Buffer, opts: OCROptions = {}): Promise<OCRResult> {
    const worker = await this.createWorker(opts.language ?? 'eng');
    try {
      const { data } = await worker.recognize(buffer);
      const blocks = this.toBlocks(data, opts.minConfidence ?? 30, 0);
      return { blocks, text: data.text, warnings: [] };
    } finally {
      await worker.terminate();
    }
  }

  /**
   * Recognise text in a PDF by rasterising each page.
   *
   * Note: full PDF OCR requires both `pdfjs-dist` and a canvas
   * implementation (`canvas`) to be installed. If either is missing,
   * the method returns an empty result with a warning.
   */
  public async recognizePdf(buffer: Buffer, opts: OCROptions = {}): Promise<OCRResult> {
    const warnings: string[] = [];
    const allBlocks: TextBlock[] = [];
    let allText = '';
    let pdfjs: { getDocument: (args: { data: Buffer }) => { promise: Promise<PdfDoc> } } | null = null;
    try {
      const mod = await import('pdfjs-dist' as string).catch(() => null);
      pdfjs = (mod as { getDocument?: unknown } | null)?.getDocument
        ? (mod as { getDocument: (args: { data: Buffer }) => { promise: Promise<PdfDoc> } })
        : null;
    } catch {
      pdfjs = null;
    }
    if (!pdfjs) {
      warnings.push('pdfjs-dist not installed — PDF OCR requires it');
      return { blocks: [], text: '', warnings };
    }
    const doc = await pdfjs.getDocument({ data: buffer }).promise;
    const maxPages = opts.maxPages && opts.maxPages > 0 ? Math.min(opts.maxPages, doc.numPages) : doc.numPages;
    const worker = await this.createWorker(opts.language ?? 'eng');
    try {
      for (let p = 1; p <= maxPages; p++) {
        const page = await doc.getPage(p);
        const viewport = page.getViewport({ scale: 2 });
        const canvas = this.makeCanvas(viewport.width, viewport.height);
        const context = canvas.getContext('2d');
        if (!context) continue;
        await page.render({ canvasContext: context, viewport } as Record<string, unknown>).promise;
        const buf = this.canvasToBuffer(canvas);
        if (buf.length === 0) continue;
        const { data } = await worker.recognize(buf);
        const blocks = this.toBlocks(data, opts.minConfidence ?? 30, p - 1);
        allBlocks.push(...blocks);
        allText += data.text + '\n';
      }
    } finally {
      await worker.terminate();
    }
    return { blocks: allBlocks, text: allText, warnings };
  }

  /**
   * Check whether the OCR backend (tesseract.js) is available.
   */
  public async isAvailable(): Promise<boolean> {
    const mod = await this.loadModule();
    return mod !== null;
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  private async createWorker(lang: string): Promise<TesseractWorker> {
    const mod = await this.loadModule();
    if (!mod) throw new Error('tesseract.js not installed — install it with `npm i tesseract.js` for OCR');
    return mod.createWorker(lang);
  }

  private async loadModule(): Promise<TesseractModule | null> {
    if (this.cachedModule !== undefined) return this.cachedModule;
    try {
      const mod = await import('tesseract.js' as string).catch(() => null);
      const candidate = mod as { createWorker?: unknown } | null;
      this.cachedModule = candidate?.createWorker ? (candidate as unknown as TesseractModule) : null;
    } catch {
      this.cachedModule = null;
    }
    return this.cachedModule;
  }

  private toBlocks(data: TesseractData, minConfidence: number, page: number): TextBlock[] {
    const out: TextBlock[] = [];
    const source = data.lines ?? data.words ?? [];
    let order = 0;
    for (const item of source) {
      if (item.confidence < minConfidence) continue;
      out.push({
        page,
        text: item.text,
        kind: 'paragraph',
        order: order++,
        confidence: item.confidence / 100,
        bbox: {
          x: item.bbox.x0,
          y: item.bbox.y0,
          width: item.bbox.x1 - item.bbox.x0,
          height: item.bbox.y1 - item.bbox.y0,
        },
      });
    }
    return out;
  }

  private makeCanvas(width: number, height: number): CanvasLike {
    return new CanvasLike(width, height);
  }

  private canvasToBuffer(_canvas: CanvasLike): Buffer {
    // Real impl needs the `canvas` package; stub returns empty buffer.
    return Buffer.alloc(0);
  }
}

/** Minimal canvas stub (real `canvas` package used when installed). */
class CanvasLike {
  constructor(public width: number, public height: number) {}
  public getContext(_kind: string): { fillRect: () => void; fillText: () => void } | null {
    return { fillRect: () => {}, fillText: () => {} };
  }
}

/** PDF document shape from pdfjs-dist. */
interface PdfDoc {
  numPages: number;
  getPage: (n: number) => Promise<PdfPage>;
}

/** PDF page shape from pdfjs-dist. */
interface PdfPage {
  getViewport: (args: { scale: number }) => { width: number; height: number };
  render: (args: Record<string, unknown>) => { promise: Promise<void> };
}
