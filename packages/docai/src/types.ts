/**
 * @file types.ts
 * @description Shared types for `@sanix/docai` — document AI primitives
 * consumed by the format detector, per-format processors, OCR, the
 * summarizer, and the orchestrating `DocumentPipeline`.
 *
 * @packageDocumentation
 */

/**
 * Supported document formats. The `FormatDetector` maps file
 * extensions, MIME types, and magic bytes to these values.
 */
export type DocumentFormat =
  | 'pdf'
  | 'docx'
  | 'doc'
  | 'pptx'
  | 'ppt'
  | 'xlsx'
  | 'xls'
  | 'csv'
  | 'html'
  | 'image'
  | 'text'
  | 'markdown'
  | 'json'
  | 'unknown';

/**
 * Result of detecting a document's format.
 */
export interface FormatDetectionResult {
  /** Detected format. */
  format: DocumentFormat;
  /** The MIME type guessed from extension / magic bytes. */
  mimeType: string;
  /** Confidence 0–1. */
  confidence: number;
  /** How the format was determined. */
  source: 'extension' | 'mimetype' | 'magic' | 'sniff';
}

/**
 * A single extracted text block with positional metadata.
 */
export interface TextBlock {
  /** 0-based page / sheet / slide index. */
  page: number;
  /** Block text (already de-hyphenated, trimmed). */
  text: string;
  /** Block kind — paragraph, heading, list-item, table-cell, code, caption. */
  kind: 'paragraph' | 'heading' | 'list-item' | 'table-cell' | 'code' | 'caption' | 'title';
  /** Heading level (1–6) when `kind === 'heading'`. */
  level?: number;
  /** Bounding box in document coordinates (points / px). */
  bbox?: BoundingBox;
  /** Reading order (0-based, monotonic within a page). */
  order: number;
  /** Confidence 0–1 for OCR-extracted blocks. */
  confidence?: number;
}

/** A 2D bounding box. */
export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A table extracted from a document. */
export interface ExtractedTable {
  /** 0-based page / sheet index. */
  page: number;
  /** Header row cells. */
  headers: string[];
  /** Data rows (each row = array of cell strings). */
  rows: string[][];
  /** Optional caption / title above the table. */
  caption?: string;
}

/** An image extracted from a document. */
export interface ExtractedImage {
  /** 0-based page / slide index. */
  page: number;
  /** Inline data URI (`data:image/png;base64,...`) or extracted file path. */
  dataUri: string;
  /** MIME type. */
  mimeType: string;
  /** Original width in px (if known). */
  width?: number;
  /** Original height in px (if known). */
  height?: number;
  /** Optional alt / caption text. */
  caption?: string;
}

/** Document metadata. */
export interface DocumentMetadata {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string[];
  creator?: string;
  producer?: string;
  creationDate?: string;
  modificationDate?: string;
  pageCount?: number;
  wordCount?: number;
  language?: string;
}

/**
 * The full extraction result for a single document.
 */
export interface ExtractionResult {
  /** Source file path or identifier. */
  source: string;
  /** Detected format. */
  format: DocumentFormat;
  /** Extracted text blocks in reading order. */
  blocks: TextBlock[];
  /** Extracted tables. */
  tables: ExtractedTable[];
  /** Extracted images. */
  images: ExtractedImage[];
  /** Document metadata. */
  metadata: DocumentMetadata;
  /** The full plain text (concatenated blocks). */
  text: string;
  /** Wall-clock duration in ms. */
  durationMs: number;
  /** Warnings emitted during extraction. */
  warnings: string[];
  /** Whether OCR was used. */
  ocrUsed: boolean;
}

/**
 * Options for a document processor.
 */
export interface ProcessorOptions {
  /** Run OCR on image-only PDFs / images. Default `true`. */
  ocr?: boolean;
  /** OCR language(s) — e.g. `eng`, `eng+fra`. Default `eng`. */
  ocrLanguage?: string;
  /** Extract embedded images. Default `false`. */
  extractImages?: boolean;
  /** Extract tables. Default `true`. */
  extractTables?: boolean;
  /** Max pages to process (0 = all). Default `0`. */
  maxPages?: number;
  /** Password for encrypted PDFs. */
  password?: string;
}

/**
 * A document processor — one implementation per format.
 */
export interface DocumentProcessor {
  /** Format handled by this processor. */
  readonly format: DocumentFormat;
  /** File extensions this processor accepts. */
  readonly extensions: string[];
  /**
   * Extract text + structure from a buffer.
   */
  process(buffer: Buffer, source: string, opts?: ProcessorOptions): Promise<ExtractionResult>;
}

/**
 * Options for the `Summarizer`.
 */
export interface SummarizerOptions {
  /** Target summary length in sentences. Default `3`. */
  sentences?: number;
  /** Target summary length in words (overrides `sentences` when set). */
  maxWords?: number;
  /** Method — `extractive` (default) or `llm` (requires a provider). */
  method?: 'extractive' | 'llm';
  /** LLM provider function — `(text) => Promise<string>`. Required for `method: 'llm'`. */
  llm?: (text: string) => Promise<string>;
}

/**
 * Result of summarization.
 */
export interface SummaryResult {
  /** The summary text. */
  summary: string;
  /** Method used. */
  method: 'extractive' | 'llm';
  /** Key sentences (for extractive method). */
  keySentences?: string[];
  /** Word count of the source. */
  sourceWords: number;
  /** Word count of the summary. */
  summaryWords: number;
  /** Compression ratio (summary words / source words). */
  ratio: number;
}

/**
 * Options for the `DocumentPipeline`.
 */
export interface PipelineOptions extends ProcessorOptions, SummarizerOptions {
  /** Summarize after extraction. Default `false`. */
  summarize?: boolean;
  /** Auto-detect format if not provided. Default `true`. */
  autoDetect?: boolean;
}

/**
 * Full pipeline result — extraction + optional summary.
 */
export interface PipelineResult extends ExtractionResult {
  /** Summary, if `summarize` was requested. */
  summary?: SummaryResult;
}
