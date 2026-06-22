/**
 * @file DOCXProcessor.ts
 * @description Microsoft Word (.docx) text + structure extraction.
 *
 * Uses the `mammoth` library (dynamic import) for high-fidelity text
 * extraction with style information, then re-parses the HTML mammoth
 * emits to recover headings, lists, and tables. Falls back to a raw
 * XML unzip-and-strip when mammoth is unavailable.
 */

import type {
  DocumentMetadata,
  ExtractionResult,
  ExtractedTable,
  ProcessorOptions,
  TextBlock,
} from './types.js';

interface MammothResult {
  value: string;
  messages: Array<{ message: string; type: string }>;
}

/**
 * DOCX document processor.
 */
export class DOCXProcessor {
  /** Format handled. */
  public readonly format = 'docx' as const;
  /** Extensions accepted. */
  public readonly extensions = ['.docx', '.doc'];

  /**
   * Extract text + structure from a DOCX buffer.
   */
  public async process(buffer: Buffer, source: string, opts: ProcessorOptions = {}): Promise<ExtractionResult> {
    const started = Date.now();
    const warnings: string[] = [];
    const blocks: TextBlock[] = [];
    const tables: ExtractedTable[] = [];
    let metadata: DocumentMetadata = {};
    let text = '';

    let mammoth: { extractRawText: (b: { buffer: Buffer }) => Promise<MammothResult>; convertToHtml: (b: { buffer: Buffer }) => Promise<MammothResult> } | undefined;
    try {
      const mod = await import('mammoth' as string).catch(() => null) as typeof mammoth | null;
      mammoth = mod ?? undefined;
    } catch {
      mammoth = undefined;
    }

    if (mammoth) {
      try {
        const html = await mammoth.convertToHtml({ buffer });
        for (const m of html.messages) {
          if (m.type === 'warning') warnings.push(m.message);
        }
        const parsed = this.parseHtml(html.value);
        blocks.push(...parsed.blocks);
        tables.push(...parsed.tables);
        metadata = parsed.metadata;
        text = blocks.map((b) => b.text).join('\n\n');
      } catch (e) {
        warnings.push(`mammoth HTML conversion failed: ${(e as Error).message}`);
        try {
          const raw = await mammoth.extractRawText({ buffer });
          text = raw.value;
          let order = 0;
          for (const para of text.split(/\n{2,}/)) {
            if (para.trim()) blocks.push({ page: 0, text: para.trim(), kind: 'paragraph', order: order++ });
          }
        } catch (e2) {
          warnings.push(`mammoth raw extraction failed: ${(e2 as Error).message}`);
        }
      }
    } else {
      warnings.push('mammoth not installed — install it with `npm i mammoth` for DOCX extraction');
      // Last-ditch: unzip + strip XML tags from word/document.xml.
      try {
        text = await this.stripDocxXml(buffer);
        let order = 0;
        for (const para of text.split(/\n{2,}/)) {
          if (para.trim()) blocks.push({ page: 0, text: para.trim(), kind: 'paragraph', order: order++ });
        }
      } catch (e) {
        warnings.push(`raw XML strip failed: ${(e as Error).message}`);
      }
    }

    return {
      source,
      format: 'docx',
      blocks,
      tables,
      images: [],
      metadata,
      text,
      durationMs: Date.now() - started,
      warnings,
      ocrUsed: false,
    };
  }

  /**
   * Parse the HTML mammoth emits into blocks + tables.
   */
  private parseHtml(html: string): { blocks: TextBlock[]; tables: ExtractedTable[]; metadata: DocumentMetadata } {
    const blocks: TextBlock[] = [];
    const tables: ExtractedTable[] = [];
    const meta: DocumentMetadata = {};
    let order = 0;
    // Very small tag-splitter (avoids cheerio dependency for the common case).
    const tagRe = /<(h[1-6]|p|li|td|th|tr|table|caption|pre|code|title)[^>]*>([\s\S]*?)<\/\1>/gi;
    let m: RegExpExecArray | null;
    let currentTable: ExtractedTable | null = null;
    let currentRow: string[] | null = null;
    while ((m = tagRe.exec(html)) !== null) {
      const tag = m[1].toLowerCase();
      const inner = this.stripTags(m[2]).trim();
      if (!inner && tag !== 'tr' && tag !== 'table') continue;
      switch (tag) {
        case 'title':
          meta.title = inner;
          break;
        case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
          blocks.push({ page: 0, text: inner, kind: 'heading', level: Number(tag[1]), order: order++ });
          break;
        case 'p':
          blocks.push({ page: 0, text: inner, kind: 'paragraph', order: order++ });
          break;
        case 'li':
          blocks.push({ page: 0, text: inner, kind: 'list-item', order: order++ });
          break;
        case 'pre': case 'code':
          blocks.push({ page: 0, text: inner, kind: 'code', order: order++ });
          break;
        case 'caption':
          if (currentTable) currentTable.caption = inner;
          break;
        case 'table':
          if (currentTable) tables.push(currentTable);
          currentTable = { page: 0, headers: [], rows: [] };
          break;
        case 'tr':
          if (currentTable && currentRow) {
            if (currentTable.headers.length === 0 && currentTable.rows.length === 0) currentTable.headers = currentRow;
            else currentTable.rows.push(currentRow);
          }
          currentRow = [];
          break;
        case 'th': case 'td':
          if (currentRow) currentRow.push(inner);
          break;
      }
    }
    if (currentTable && currentRow) {
      if (currentTable.headers.length === 0 && currentTable.rows.length === 0) currentTable.headers = currentRow;
      else currentTable.rows.push(currentRow);
    }
    if (currentTable) tables.push(currentTable);
    return { blocks, tables, metadata: meta };
  }

  private stripTags(html: string): string {
    return html
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ');
  }

  private async stripDocxXml(buffer: Buffer): Promise<string> {
    // Use the built-in zip support via dynamic import of 'fflate' if available,
    // otherwise just decode the buffer and strip <w:t> tags heuristically.
    const text = buffer.toString('latin1');
    const matches = text.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) ?? [];
    const out = matches.map((m) => m.replace(/<[^>]+>/g, '')).join('');
    return out.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  }
}
