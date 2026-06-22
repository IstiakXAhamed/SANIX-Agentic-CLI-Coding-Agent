/**
 * @file DocumentReader — read Markdown / PDF / DOCX into plain text.
 *
 * - Markdown: just read text.
 * - PDF: try `pdftotext` shell command, else error gracefully.
 * - DOCX: extract `word/document.xml` via unzip.
 */
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import {
  type SanixTool,
  type ToolContext,
  type ToolResult,
  type ToolPermission,
  z,
  resolvePath,
  okResult,
  errResult,
} from '../types.js';

const execFileP = promisify(execFile);

/** Input schema for `read_document`. */
export const ReadDocumentInputSchema = z.object({
  path: z.string().min(1),
  format: z.enum(['pdf', 'docx', 'markdown', 'auto']).default('auto'),
});

/** Output schema for `read_document`. */
export const ReadDocumentOutputSchema = z.object({
  text: z.string(),
  pages: z.number().int().optional(),
  metadata: z.record(z.string(), z.unknown()),
});

export type ReadDocumentInput = z.infer<typeof ReadDocumentInputSchema>;
export type ReadDocumentOutput = z.infer<typeof ReadDocumentOutputSchema>;

function detectFormat(p: string): 'pdf' | 'docx' | 'markdown' | null {
  const ext = path.extname(p).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (ext === '.docx') return 'docx';
  if (ext === '.md' || ext === '.markdown' || ext === '.mdx') return 'markdown';
  return null;
}

/** Check whether a binary is on PATH. */
async function isAvailable(cmd: string): Promise<boolean> {
  try {
    await execFileP(cmd, ['--version'], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/** Convert a PDF to text using `pdftotext` (poppler). */
async function pdfToText(absPath: string): Promise<{ text: string; pages: number }> {
  if (!(await isAvailable('pdftotext'))) {
    throw new Error('pdftotext binary not found (install poppler-utils)');
  }
  const { stdout } = await execFileP('pdftotext', ['-layout', absPath, '-'], {
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
  });
  // Count form feeds (\f) as page separators.
  const pages = stdout.split('\f').filter((s) => s.trim().length > 0).length;
  return { text: stdout, pages: Math.max(1, pages) };
}

/** Extract `word/document.xml` from a .docx (which is a zip). */
async function docxToText(absPath: string): Promise<string> {
  // Use Node's built-in decompression via a spawned `unzip -p` if available.
  // Otherwise fall back to a tiny zip reader. We prefer `unzip` for simplicity.
  if (await isAvailable('unzip')) {
    try {
      const { stdout } = await execFileP(
        'unzip',
        ['-p', absPath, 'word/document.xml'],
        { maxBuffer: 64 * 1024 * 1024, timeout: 30_000 },
      );
      return stripDocxXml(stdout);
    } catch {
      /* fall through */
    }
  }
  // Native fallback: read the zip and look for the document.xml entry.
  const buf = await fs.readFile(absPath);
  return extractDocxFromBuffer(buf);
}

/** Strip XML tags from word/document.xml and extract paragraph breaks. */
function stripDocxXml(xml: string): string {
  return xml
    .replace(/<w:p[ >]/g, '\n<w:p ')
    .replace(/<w:br\s*\/>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Minimal local-zip extraction for word/document.xml. */
function extractDocxFromBuffer(buf: Buffer): string {
  // A ZIP file is a sequence of file entries ending with a central directory.
  // We scan for the local file header signature (PK\x03\x04) and look for the
  // entry whose name is "word/document.xml".
  const sig = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const target = Buffer.from('word/document.xml', 'utf-8');
  let offset = 0;
  while (offset < buf.length - 4) {
    const idx = buf.indexOf(sig, offset);
    if (idx === -1) break;
    offset = idx + 4;
    // Local file header layout (after signature):
    // 2 bytes version, 2 bytes flags, 2 bytes compression method,
    // 2 bytes mod time, 2 bytes mod date, 4 bytes CRC-32,
    // 4 bytes compressed size, 4 bytes uncompressed size,
    // 2 bytes filename length, 2 bytes extra length, then filename, extra, data.
    if (offset + 26 > buf.length) break;
    const compression = buf.readUInt16LE(offset + 6);
    const compressedSize = buf.readUInt32LE(offset + 14);
    const fnLen = buf.readUInt16LE(offset + 22);
    const extraLen = buf.readUInt16LE(offset + 24);
    const fnStart = offset + 26;
    if (fnStart + fnLen > buf.length) break;
    const filename = buf.subarray(fnStart, fnStart + fnLen);
    offset = fnStart + fnLen + extraLen;
    if (filename.equals(target)) {
      const data = buf.subarray(offset, offset + compressedSize);
      if (compression === 0) {
        return stripDocxXml(data.toString('utf-8'));
      }
      // compression === 8 → DEFLATE. Use zlib.inflateRawSync for raw DEFLATE.
      const inflated = inflateRawSync(data);
      return stripDocxXml(inflated.toString('utf-8'));
    }
  }
  throw new Error('could not extract word/document.xml from docx (and unzip not available)');
}

/**
 * DocumentReaderTool — read a Markdown / PDF / DOCX file into text.
 *
 * @example
 * ```ts
 * const res = await new DocumentReaderTool().execute(
 *   { path: 'spec.pdf' },
 *   ctx,
 * );
 * ```
 */
export class DocumentReaderTool
  implements SanixTool<ReadDocumentInput, ReadDocumentOutput>
{
  readonly name = 'read_document';
  readonly description =
    'Read a Markdown / PDF / DOCX file into plain text. PDF uses pdftotext (poppler). DOCX extracts word/document.xml.';
  readonly inputSchema = ReadDocumentInputSchema;
  readonly outputSchema = ReadDocumentOutputSchema;
  readonly permissions: ToolPermission[] = ['filesystem:read'];
  readonly maxTokensInput = 256;
  readonly maxTokensOutput = 32_000;

  async execute(
    input: ReadDocumentInput,
    context: ToolContext,
  ): Promise<ToolResult<ReadDocumentOutput>> {
    const start = Date.now();
    const absPath = resolvePath(input.path, context.cwd);
    try {
      const fmt = input.format === 'auto' ? detectFormat(absPath) : input.format;
      if (!fmt) {
        return errResult<ReadDocumentOutput>(
          `read_document: cannot detect format for ${path.basename(absPath)}`,
          Date.now() - start,
        );
      }
      if (fmt === 'markdown') {
        const text = await fs.readFile(absPath, 'utf-8');
        const lines = text.split('\n').length;
        return okResult<ReadDocumentOutput>(
          { text, pages: 1, metadata: { lines, format: 'markdown' } },
          Date.now() - start,
        );
      }
      if (fmt === 'pdf') {
        const { text, pages } = await pdfToText(absPath);
        return okResult<ReadDocumentOutput>(
          { text, pages, metadata: { format: 'pdf' } },
          Date.now() - start,
        );
      }
      const text = await docxToText(absPath);
      return okResult<ReadDocumentOutput>(
        { text, metadata: { format: 'docx' } },
        Date.now() - start,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errResult<ReadDocumentOutput>(
        `read_document failed: ${msg}`,
        Date.now() - start,
      );
    }
  }

  formatForContext(result: ReadDocumentOutput): string {
    const pages = result.pages ? ` (${result.pages} pages)` : '';
    const body =
      result.text.length > 8000
        ? `${result.text.slice(0, 4000)}\n…[truncated]…\n${result.text.slice(-4000)}`
        : result.text;
    return `document${pages}\n${body}`;
  }
}
