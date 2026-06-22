/**
 * @file index.ts
 * @description Barrel re-export for `@sanix/docai`.
 *
 * @packageDocumentation
 */

export {
  DocumentPipeline,
} from './DocumentPipeline.js';

export {
  FormatDetector,
} from './FormatDetector.js';

export {
  PDFProcessor,
} from './PDFProcessor.js';

export {
  DOCXProcessor,
} from './DOCXProcessor.js';

export {
  PPTXProcessor,
} from './PPTXProcessor.js';

export {
  XLSXProcessor,
} from './XLSXProcessor.js';

export {
  HTMLProcessor,
} from './HTMLProcessor.js';

export {
  ImageProcessor,
} from './ImageProcessor.js';

export {
  OCR,
  type OCROptions,
  type OCRResult,
} from './OCR.js';

export {
  Summarizer,
} from './Summarizer.js';

export type {
  DocumentFormat,
  FormatDetectionResult,
  TextBlock,
  BoundingBox,
  ExtractedTable,
  ExtractedImage,
  DocumentMetadata,
  ExtractionResult,
  ProcessorOptions,
  DocumentProcessor,
  SummarizerOptions,
  SummaryResult,
  PipelineOptions,
  PipelineResult,
} from './types.js';
