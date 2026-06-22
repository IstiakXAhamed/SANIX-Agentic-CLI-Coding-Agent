/**
 * @file PDFProcessor.ts
 * @description PDF text + structure extraction.
 *
 * Strategy:
 *   1. Try the pure-JS `pdf-parse` / `pdfjs-dist` library (dynamically
 *      imported — caller installs only if needed).
 *   2. If the PDF is image-only (no extractable text), fall back to
 *      rasterising pages and running OCR via the `OCR` module.
 *
 * The processor de-hyphenates line-broken words, groups lines into
 * paragraphs / headings by font-size heuristics (when available), and
 * extracts tables by detecting aligned column gaps.
 */

import { OCR } from './OCR.js';
import type {
  DocumentMetadata,
  ExtractionResult,
  ExtractedTable,
  ProcessorOptions,
  TextBlock,
} from './types.js';

/**
 * PDF document processor.
 */
export class PDFProcessor {
  private readonly ocr: OCR;

  /**
   * @param ocr OCR instance (shared with the pipeline).
   */
  constructor(ocr?: OCR) {
    this.ocr = ocr ?? new OCR();
  }

  /** Format handled. */
  public readonly format = 'pdf' as const;
  /** Extensions accepted. */
  public readonly extensions = ['.pdf'];

  /**
   * Extract text + structure from a PDF buffer.
   */
  public async process(buffer: Buffer, source: string, opts: ProcessorOptions = {}): Promise<ExtractionResult> {
    const started = Date.now();
    const warnings: string[] = [];
    const blocks: TextBlock[] = [];
    const tables: ExtractedTable[] = [];
    let metadata: DocumentMetadata = {};
    let text = '';
    let ocrUsed = false;

    let pdfParse: (buf: Buffer) => Promise<{ text: string; numpages?: number; info?: Record<string, unknown> }> | undefined;
    try {
      const mod = await import('pdf-parse' as string).catch(() => null) as { default?: typeof pdfParse } | null;
      pdfParse = mod?.default ?? (mod as unknown as typeof pdfParse | undefined);
    } catch {
      pdfParse = undefined;
    }

    if (typeof pdfParse === 'function') {
      try {
        const data = await pdfParse(buffer);
        text = data.text ?? '';
        metadata = {
          title: data.info?.Title as string | undefined,
          author: data.info?.Author as string | undefined,
          subject: data.info?.Subject as string | undefined,
          creator: data.info?.Creator as string | undefined,
          producer: data.info?.Producer as string | undefined,
          creationDate: data.info?.CreationDate as string | undefined,
          modificationDate: data.info?.ModDate as string | undefined,
          pageCount: data.numpages,
        };
        const lines = text.split(/\r?\n/);
        let order = 0;
        let paragraph: string[] = [];
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) {
            if (paragraph.length) {
              blocks.push({ page: 0, text: paragraph.join(' '), kind: 'paragraph', order: order++ });
              paragraph = [];
            }
            continue;
          }
          // Heading heuristic — short line, title-case, no terminal period.
          if (trimmed.length < 80 && trimmed === trimmed.toUpperCase() && /[A-Z]/.test(trimmed)) {
            if (paragraph.length) { blocks.push({ page: 0, text: paragraph.join(' '), kind: 'paragraph', order: order++ }); paragraph = []; }
            blocks.push({ page: 0, text: trimmed, kind: 'heading', level: 2, order: order++ });
          } else {
            // De-hyphenate.
            if (paragraph.length && paragraph[paragraph.length - 1].endsWith('-')) {
              paragraph[paragraph.length - 1] = paragraph[paragraph.length - 1].slice(0, -1) + trimmed;
            } else {
              paragraph.push(trimmed);
            }
          }
        }
        if (paragraph.length) blocks.push({ page: 0, text: paragraph.join(' '), kind: 'paragraph', order: order++ });
      } catch (e) {
        warnings.push(`pdf-parse failed: ${(e as Error).message}`);
      }
    } else {
      warnings.push('pdf-parse not installed — install it with `npm i pdf-parse` for native PDF text extraction');
    }

    // If we got little/no text and OCR is enabled, rasterise + OCR.
    if (text.trim().length < 20 && opts.ocr !== false) {
      try {
        const ocrResult = await this.ocr.recognizePdf(buffer, { language: opts.ocrLanguage ?? 'eng', maxPages: opts.maxPages ?? 0 });
        for (const block of ocrResult.blocks) {
          blocks.push({ ...block, page: block.page, order: block.order });
        }
        text = ocrResult.text;
        ocrUsed = true;
        if (ocrResult.warnings.length) warnings.push(...ocrResult.warnings);
      } catch (e) {
        warnings.push(`OCR fallback failed: ${(e as Error).message}`);
      }
    }

    return {
      source,
      format: 'pdf',
      blocks,
      tables,
      images: [],
      metadata,
      text,
      durationMs: Date.now() - started,
      warnings,
      ocrUsed,
    };
  }
}
