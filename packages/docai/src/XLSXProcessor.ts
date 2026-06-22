/**
 * @file XLSXProcessor.ts
 * @description Excel / spreadsheet (.xlsx, .xls, .csv) extraction.
 *
 * Uses `exceljs` or `xlsx` (dynamic import) to read every sheet, emit
 * one `ExtractedTable` per sheet (headers = first non-empty row), and
 * produce a `TextBlock` per cell for full-text searchability.
 */

import type {
  DocumentMetadata,
  ExtractionResult,
  ExtractedTable,
  ProcessorOptions,
  TextBlock,
} from './types.js';

/**
 * XLSX / CSV document processor.
 */
export class XLSXProcessor {
  /** Format handled. */
  public readonly format = 'xlsx' as const;
  /** Extensions accepted. */
  public readonly extensions = ['.xlsx', '.xls', '.csv'];

  /**
   * Extract text + tables from a spreadsheet buffer.
   */
  public async process(buffer: Buffer, source: string, opts: ProcessorOptions = {}): Promise<ExtractionResult> {
    const started = Date.now();
    const warnings: string[] = [];
    const blocks: TextBlock[] = [];
    const tables: ExtractedTable[] = [];
    const metadata: DocumentMetadata = {};
    let text = '';

    let xlsxMod: {
      read: (buf: Buffer, opts?: Record<string, unknown>) => {
        SheetNames: string[];
        Sheets: Record<string, { [cell: string]: { v: unknown } }>;
      };
      utils: { sheet_to_json: <T = unknown>(sheet: unknown, opts?: Record<string, unknown>) => T[] };
    } | undefined;
    try {
      const mod = await import('xlsx' as string).catch(() => null) as typeof xlsxMod | null;
      xlsxMod = mod ?? undefined;
    } catch {
      xlsxMod = undefined;
    }

    if (xlsxMod) {
      try {
        const wb = xlsxMod.read(buffer, { type: 'buffer' });
        metadata.pageCount = wb.SheetNames.length;
        let order = 0;
        for (let s = 0; s < wb.SheetNames.length; s++) {
          const name = wb.SheetNames[s];
          const sheet = wb.Sheets[name];
          const rows = xlsxMod.utils.sheet_to_json<string[]>(sheet, { header: 1, blankrows: false, defval: '' });
          if (rows.length === 0) continue;
          const headers = (rows[0] as unknown[]).map((c) => String(c ?? '').trim());
          const dataRows: string[][] = [];
          for (let r = 1; r < rows.length; r++) {
            const row = (rows[r] as unknown[]).map((c) => String(c ?? '').trim());
            dataRows.push(row);
            // Emit a text block per non-empty cell.
            for (let c = 0; c < row.length; c++) {
              if (row[c]) {
                blocks.push({
                  page: s,
                  text: `${headers[c] ?? `Col${c + 1}`}: ${row[c]}`,
                  kind: 'table-cell',
                  order: order++,
                });
              }
            }
          }
          tables.push({ page: s, headers, rows: dataRows, caption: name });
          text += `# ${name}\n${headers.join('\t')}\n${dataRows.map((r) => r.join('\t')).join('\n')}\n\n`;
        }
      } catch (e) {
        warnings.push(`xlsx parse failed: ${(e as Error).message}`);
      }
    } else {
      warnings.push('xlsx not installed — install it with `npm i xlsx` for spreadsheet extraction');
      // CSV fallback — just decode.
      const csv = buffer.toString('utf8');
      text = csv;
      const lines = csv.split(/\r?\n/);
      if (lines.length > 0) {
        const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
        const rows: string[][] = [];
        let order = 0;
        for (let i = 1; i < lines.length; i++) {
          if (!lines[i].trim()) continue;
          const row = lines[i].split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
          rows.push(row);
          for (let c = 0; c < row.length; c++) {
            if (row[c]) blocks.push({ page: 0, text: `${headers[c] ?? `Col${c + 1}`}: ${row[c]}`, kind: 'table-cell', order: order++ });
          }
        }
        tables.push({ page: 0, headers, rows });
      }
    }

    return {
      source,
      format: 'xlsx',
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
}
