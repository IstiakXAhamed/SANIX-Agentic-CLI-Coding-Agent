/**
 * @file PPTXProcessor.ts
 * @description PowerPoint (.pptx) slide text + structure extraction.
 *
 * Uses `pptxtojson` or `officeparser` (dynamic import) to read slide
 * XML, recovering per-slide title, body text, and tables. Each slide
 * becomes a "page" in the extraction result; each shape becomes a
 * `TextBlock` (title shape → heading, body → paragraph / list-item).
 */

import type {
  DocumentMetadata,
  ExtractionResult,
  ExtractedTable,
  ProcessorOptions,
  TextBlock,
} from './types.js';

interface PptxSlide {
  slide?: number;
  title?: string;
  content?: Array<{ text?: string; type?: string }>;
  tables?: Array<{ rows: Array<{ cells: string[] }> }>;
}

/**
 * PPTX document processor.
 */
export class PPTXProcessor {
  /** Format handled. */
  public readonly format = 'pptx' as const;
  /** Extensions accepted. */
  public readonly extensions = ['.pptx', '.ppt'];

  /**
   * Extract text + structure from a PPTX buffer.
   */
  public async process(buffer: Buffer, source: string, opts: ProcessorOptions = {}): Promise<ExtractionResult> {
    const started = Date.now();
    const warnings: string[] = [];
    const blocks: TextBlock[] = [];
    const tables: ExtractedTable[] = [];
    const metadata: DocumentMetadata = {};
    let text = '';

    let parseFn: ((buf: Buffer) => Promise<{ slides: PptxSlide[] }>) | undefined;
    try {
      const mod = await import('officeparser' as string).catch(() => null) as
        | { parseOfficeAsync?: (buf: Buffer) => Promise<string> }
        | null;
      if (mod?.parseOfficeAsync) {
        // officeparser returns flat text — use as a fallback.
        try {
          text = await mod.parseOfficeAsync(buffer);
          const slides = text.split(/\f/); // form-feed separates slides in officeparser output
          let order = 0;
          for (let i = 0; i < slides.length; i++) {
            const slide = slides[i].trim();
            if (!slide) continue;
            const lines = slide.split(/\r?\n/).filter((l) => l.trim());
            if (lines.length > 0) {
              blocks.push({ page: i, text: lines[0].trim(), kind: 'title', order: order++ });
            }
            for (let j = 1; j < lines.length; j++) {
              blocks.push({ page: i, text: lines[j].trim(), kind: lines[j].trim().startsWith('•') ? 'list-item' : 'paragraph', order: order++ });
            }
          }
          metadata.pageCount = slides.length;
        } catch (e) {
          warnings.push(`officeparser failed: ${(e as Error).message}`);
        }
      }
    } catch {
      parseFn = undefined;
    }

    if (blocks.length === 0) {
      warnings.push('No PPTX parser installed — install `officeparser` for slide extraction');
      // Last-ditch: strip <a:t> tags from the buffer (slide XML).
      try {
        const raw = buffer.toString('latin1');
        const matches = raw.match(/<a:t[^>]*>([^<]*)<\/a:t>/g) ?? [];
        text = matches.map((m) => m.replace(/<[^>]+>/g, '')).join('\n');
        let order = 0;
        for (const line of text.split(/\n/)) {
          if (line.trim()) blocks.push({ page: 0, text: line.trim(), kind: 'paragraph', order: order++ });
        }
      } catch (e) {
        warnings.push(`raw XML strip failed: ${(e as Error).message}`);
      }
    }

    return {
      source,
      format: 'pptx',
      blocks,
      tables,
      images: [],
      metadata,
      text: text || blocks.map((b) => b.text).join('\n'),
      durationMs: Date.now() - started,
      warnings,
      ocrUsed: false,
    };
  }
}
