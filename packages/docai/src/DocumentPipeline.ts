/**
 * @file DocumentPipeline.ts
 * @description End-to-end document processing pipeline.
 *
 * Wires the `FormatDetector`, per-format processors, `OCR`, and
 * `Summarizer` into a single `process(buffer, opts)` call that:
 *
 *   1. Detects the format (magic bytes → extension → MIME → sniff).
 *   2. Routes to the right processor.
 *   3. Optionally summarizes the extracted text.
 *
 * The pipeline is format-agnostic — callers pass a buffer + filename
 * and get back a structured `PipelineResult`.
 */

import { FormatDetector } from './FormatDetector.js';
import { PDFProcessor } from './PDFProcessor.js';
import { DOCXProcessor } from './DOCXProcessor.js';
import { PPTXProcessor } from './PPTXProcessor.js';
import { XLSXProcessor } from './XLSXProcessor.js';
import { HTMLProcessor } from './HTMLProcessor.js';
import { ImageProcessor } from './ImageProcessor.js';
import { OCR } from './OCR.js';
import { Summarizer } from './Summarizer.js';
import type {
  DocumentFormat,
  DocumentProcessor,
  ExtractionResult,
  PipelineOptions,
  PipelineResult,
  ProcessorOptions,
  TextBlock,
} from './types.js';

/**
 * End-to-end document pipeline.
 *
 * @example
 * ```ts
 * const pipe = new DocumentPipeline();
 * const result = await pipe.process(buffer, 'report.pdf', { summarize: true, sentences: 3 });
 * console.log(result.summary?.summary);
 * ```
 */
export class DocumentPipeline {
  private readonly detector = new FormatDetector();
  private readonly ocr: OCR;
  private readonly summarizer = new Summarizer();
  private readonly processors: Map<DocumentFormat, DocumentProcessor> = new Map();

  /**
   * @param ocr Optional shared OCR instance.
   */
  constructor(ocr?: OCR) {
    this.ocr = ocr ?? new OCR();
    const pdf = new PDFProcessor(this.ocr);
    const docx = new DOCXProcessor();
    const pptx = new PPTXProcessor();
    const xlsx = new XLSXProcessor();
    const html = new HTMLProcessor();
    const image = new ImageProcessor(this.ocr);
    for (const p of [pdf, docx, pptx, xlsx, html, image]) {
      this.processors.set(p.format, p);
    }
  }

  /**
   * Process a document buffer end-to-end.
   * @param buffer File contents.
   * @param filename Filename (used for extension-based detection).
   * @param opts Pipeline options.
   */
  public async process(buffer: Buffer, filename: string, opts: PipelineOptions = {}): Promise<PipelineResult> {
    const started = Date.now();
    const detection = opts.autoDetect === false
      ? { format: this.guessFromExt(filename), mimeType: '', confidence: 1, source: 'extension' as const }
      : this.detector.detect(filename, buffer);

    const processor = this.processors.get(detection.format)
      ?? this.processors.get(this.fallbackFormat(detection.format));

    let extraction: ExtractionResult;
    if (processor) {
      const procOpts: ProcessorOptions = {
        ocr: opts.ocr,
        ocrLanguage: opts.ocrLanguage,
        extractImages: opts.extractImages,
        extractTables: opts.extractTables,
        maxPages: opts.maxPages,
        password: opts.password,
      };
      extraction = await processor.process(buffer, filename, procOpts);
    } else {
      // Unknown format — treat as plain text.
      extraction = this.makeTextExtraction(buffer, filename, started);
    }

    const result: PipelineResult = { ...extraction };

    if (opts.summarize && extraction.text.trim().length > 0) {
      try {
        result.summary = await this.summarizer.summarize(extraction.text, {
          sentences: opts.sentences,
          maxWords: opts.maxWords,
          method: opts.method,
          llm: opts.llm,
        });
      } catch {
        // summarization is best-effort
      }
    }
    return result;
  }

  /**
   * Register a custom processor.
   */
  public registerProcessor(processor: DocumentProcessor): void {
    this.processors.set(processor.format, processor);
  }

  /**
   * Return the format detector (for direct use).
   */
  public getDetector(): FormatDetector {
    return this.detector;
  }

  /**
   * Return the OCR instance.
   */
  public getOCR(): OCR {
    return this.ocr;
  }

  /**
   * Return the summarizer.
   */
  public getSummarizer(): Summarizer {
    return this.summarizer;
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  private guessFromExt(filename: string): DocumentFormat {
    const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
    const det = this.detector.detect(filename);
    return det.format === 'unknown' && ext ? 'text' : det.format;
  }

  private fallbackFormat(f: DocumentFormat): DocumentFormat {
    // Treat legacy Office formats as their OOXML counterparts (best-effort).
    if (f === 'doc') return 'docx';
    if (f === 'ppt') return 'pptx';
    if (f === 'xls') return 'xlsx';
    if (f === 'csv') return 'xlsx';
    if (f === 'markdown') return 'text';
    if (f === 'json') return 'text';
    return f;
  }

  private makeTextExtraction(buffer: Buffer, source: string, started: number): ExtractionResult {
    const text = buffer.toString('utf8');
    const blocks: TextBlock[] = [];
    let order = 0;
    for (const para of text.split(/\n{2,}/)) {
      const trimmed = para.trim();
      if (!trimmed) continue;
      // Markdown heading detection.
      const headingMatch = /^(#{1,6})\s+(.+)$/.exec(trimmed);
      if (headingMatch) {
        blocks.push({ page: 0, text: headingMatch[2], kind: 'heading', level: headingMatch[1].length, order: order++ });
      } else {
        blocks.push({ page: 0, text: trimmed, kind: 'paragraph', order: order++ });
      }
    }
    return {
      source,
      format: 'text',
      blocks,
      tables: [],
      images: [],
      metadata: { wordCount: text.split(/\s+/).filter(Boolean).length },
      text,
      durationMs: Date.now() - started,
      warnings: [],
      ocrUsed: false,
    };
  }
}
