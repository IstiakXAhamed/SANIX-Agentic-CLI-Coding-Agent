/**
 * @file FormatDetector.ts
 * @description Detects a document's format from extension, MIME type,
 * or magic bytes.
 *
 * Detection order:
 *   1. Magic bytes (most reliable — `PK` = OOXML, `%PDF` = PDF, etc.)
 *   2. File extension
 *   3. MIME type
 *   4. Content sniff (HTML tags, JSON braces, CSV delimiter density)
 *
 * Returns a `FormatDetectionResult` with confidence + source so the
 * caller can decide whether to trust the detection.
 */

import { extname } from 'node:path';
import type { DocumentFormat, FormatDetectionResult } from './types.js';

const EXT_MAP: Record<string, DocumentFormat> = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.doc': 'doc',
  '.pptx': 'pptx',
  '.ppt': 'ppt',
  '.xlsx': 'xlsx',
  '.xls': 'xls',
  '.csv': 'csv',
  '.html': 'html',
  '.htm': 'html',
  '.xhtml': 'html',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.bmp': 'image',
  '.tiff': 'image',
  '.tif': 'image',
  '.txt': 'text',
  '.log': 'text',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.json': 'json',
};

const MIME_MAP: Record<string, DocumentFormat> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel': 'xls',
  'text/csv': 'csv',
  'text/html': 'html',
  'application/xhtml+xml': 'html',
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/gif': 'image',
  'image/webp': 'image',
  'image/bmp': 'image',
  'image/tiff': 'image',
  'text/plain': 'text',
  'text/markdown': 'markdown',
  'application/json': 'json',
};

/**
 * Detects a document's format.
 *
 * @example
 * ```ts
 * const detector = new FormatDetector();
 * const result = detector.detect('/path/to/file.pdf', buffer);
 * ```
 */
export class FormatDetector {
  /**
   * Detect format from filename + optional buffer.
   * @param filename Filename or path.
   * @param buffer Optional file contents (for magic-byte detection).
   * @param mimeType Optional MIME type (e.g. from HTTP headers).
   */
  public detect(filename: string, buffer?: Buffer, mimeType?: string): FormatDetectionResult {
    // 1. Magic bytes (highest confidence).
    if (buffer) {
      const magic = this.detectMagic(buffer);
      if (magic) {
        return { format: magic.format, mimeType: magic.mimeType, confidence: 0.98, source: 'magic' };
      }
    }
    // 2. Extension.
    const ext = extname(filename).toLowerCase();
    if (ext && EXT_MAP[ext]) {
      return {
        format: EXT_MAP[ext],
        mimeType: MIME_MAP[ext] ?? 'application/octet-stream',
        confidence: 0.85,
        source: 'extension',
      };
    }
    // 3. MIME type.
    if (mimeType && MIME_MAP[mimeType]) {
      return { format: MIME_MAP[mimeType], mimeType, confidence: 0.8, source: 'mimetype' };
    }
    // 4. Sniff content.
    if (buffer) {
      const sniffed = this.sniff(buffer);
      if (sniffed) {
        return { format: sniffed.format, mimeType: sniffed.mimeType, confidence: 0.7, source: 'sniff' };
      }
    }
    return { format: 'unknown', mimeType: mimeType ?? 'application/octet-stream', confidence: 0, source: 'extension' };
  }

  /**
   * Detect from magic bytes only.
   */
  public detectMagic(buffer: Buffer): { format: DocumentFormat; mimeType: string } | null {
    if (buffer.length < 4) return null;
    // PDF
    if (buffer.subarray(0, 4).toString('ascii') === '%PDF') {
      return { format: 'pdf', mimeType: 'application/pdf' };
    }
    // OOXML / OLE — all start with PK (zip) or D0 CF 11 E0 (OLE)
    if (buffer[0] === 0x50 && buffer[1] === 0x4b) {
      // It's a ZIP — disambiguate by [Content_Types].xml entries. We can't
      // unzip here cheaply, so inspect the first 50 bytes for hints.
      const head = buffer.subarray(0, Math.min(2000, buffer.length)).toString('latin1');
      if (head.includes('word/')) return { format: 'docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
      if (head.includes('ppt/')) return { format: 'pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
      if (head.includes('xl/')) return { format: 'xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
      // Generic ZIP — could still be docx/pptx/xlsx with minimal structure.
      return { format: 'docx', mimeType: 'application/zip' };
    }
    // OLE2 compound document (doc, xls, ppt)
    if (buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0) {
      return { format: 'doc', mimeType: 'application/x-ole-storage' };
    }
    // PNG
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
      return { format: 'image', mimeType: 'image/png' };
    }
    // JPEG
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return { format: 'image', mimeType: 'image/jpeg' };
    }
    // GIF
    if (buffer.subarray(0, 3).toString('ascii') === 'GIF') {
      return { format: 'image', mimeType: 'image/gif' };
    }
    // WebP — RIFF....WEBP
    if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
      return { format: 'image', mimeType: 'image/webp' };
    }
    // BMP
    if (buffer.subarray(0, 2).toString('ascii') === 'BM') {
      return { format: 'image', mimeType: 'image/bmp' };
    }
    // TIFF
    if ((buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00) ||
        (buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a)) {
      return { format: 'image', mimeType: 'image/tiff' };
    }
    return null;
  }

  /**
   * Sniff text content for HTML / JSON / CSV / Markdown.
   */
  public sniff(buffer: Buffer): { format: DocumentFormat; mimeType: string } | null {
    const head = buffer.subarray(0, Math.min(2048, buffer.length)).toString('utf8').trimStart();
    if (!head) return null;
    // HTML
    if (/^<!doctype\s+html/i.test(head) || /^<html/i.test(head) || (/^\s*<\w+[\s>]/.test(head) && /<\/\w+>/.test(head))) {
      return { format: 'html', mimeType: 'text/html' };
    }
    // JSON
    if ((head.startsWith('{') && head.endsWith('}')) || (head.startsWith('[') && head.endsWith(']'))) {
      try { JSON.parse(buffer.toString('utf8')); return { format: 'json', mimeType: 'application/json' }; } catch { /* not json */ }
    }
    // Markdown — heading or fenced code at start
    if (/^#{1,6}\s/.test(head) || /^```/.test(head)) {
      return { format: 'markdown', mimeType: 'text/markdown' };
    }
    // CSV — count delimiter density across first few lines
    const lines = head.split(/\r?\n/).slice(0, 5).filter((l) => l.length > 0);
    if (lines.length >= 2) {
      const counts = lines.map((l) => (l.match(/,/g) ?? []).length);
      if (counts.every((c) => c > 0 && c === counts[0])) {
        return { format: 'csv', mimeType: 'text/csv' };
      }
    }
    return { format: 'text', mimeType: 'text/plain' };
  }

  /**
   * Return all supported formats.
   */
  public supportedFormats(): DocumentFormat[] {
    return ['pdf', 'docx', 'doc', 'pptx', 'ppt', 'xlsx', 'xls', 'csv', 'html', 'image', 'text', 'markdown', 'json'];
  }
}
