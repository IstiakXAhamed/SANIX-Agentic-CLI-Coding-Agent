/**
 * @file ImageProcessor.ts
 * @description Image (.png, .jpg, …) text extraction via OCR.
 *
 * Delegates to the `OCR` module (which uses `tesseract.js` when
 * installed) to extract text from raster images. Also extracts basic
 * image metadata (dimensions, format) when `sharp` is available.
 */

import { OCR } from './OCR.js';
import type {
  DocumentMetadata,
  ExtractionResult,
  ProcessorOptions,
  TextBlock,
} from './types.js';

/**
 * Image document processor.
 */
export class ImageProcessor {
  private readonly ocr: OCR;

  /**
   * @param ocr OCR instance (shared with the pipeline).
   */
  constructor(ocr?: OCR) {
    this.ocr = ocr ?? new OCR();
  }

  /** Format handled. */
  public readonly format = 'image' as const;
  /** Extensions accepted. */
  public readonly extensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.tif'];

  /**
   * Extract text from an image via OCR.
   */
  public async process(buffer: Buffer, source: string, opts: ProcessorOptions = {}): Promise<ExtractionResult> {
    const started = Date.now();
    const warnings: string[] = [];
    const blocks: TextBlock[] = [];
    const metadata: DocumentMetadata = {};

    // Dimensions via sharp (optional).
    try {
      const sharp = (await import('sharp' as string).catch(() => null)) as
        | ((buf: Buffer) => { metadata: () => Promise<{ width?: number; height?: number; format?: string }> })
        | null;
      if (sharp) {
        const meta = await sharp(buffer).metadata();
        if (meta.width) metadata.wordCount = undefined;
        // Stash dims in subject for downstream consumers.
        if (meta.width && meta.height) {
          metadata.subject = `${meta.format ?? 'image'} ${meta.width}x${meta.height}`;
        }
      }
    } catch {
      /* sharp optional */
    }

    if (opts.ocr === false) {
      warnings.push('OCR disabled — image produced no text');
    } else {
      try {
        const result = await this.ocr.recognizeImage(buffer, { language: opts.ocrLanguage ?? 'eng' });
        for (const block of result.blocks) {
          blocks.push({ ...block, page: 0 });
        }
        if (result.warnings.length) warnings.push(...result.warnings);
      } catch (e) {
        warnings.push(`OCR failed: ${(e as Error).message}`);
      }
    }

    const text = blocks.map((b) => b.text).join('\n');
    return {
      source,
      format: 'image',
      blocks,
      tables: [],
      images: [{ page: 0, dataUri: `data:${metadata.subject?.split(' ')[0] ?? 'image/png'};base64,${buffer.toString('base64')}`, mimeType: 'image/png' }],
      metadata,
      text,
      durationMs: Date.now() - started,
      warnings,
      ocrUsed: blocks.length > 0,
    };
  }
}
