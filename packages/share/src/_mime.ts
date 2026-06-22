/**
 * @file _mime.ts
 * @description Tiny extension → MIME map. We avoid pulling in `mime-types`
 *   (a runtime dep) — the handful of extensions SANIX operators
 *   actually share (json, tar.gz, png, md) is well under 50, and a
 *   hand-rolled map keeps the bundle small and the lookup synchronous.
 *
 * @packageDocumentation
 */

/** Mapping of lowercase extension (without dot) → MIME type. */
const MIME_BY_EXT: Readonly<Record<string, string>> = Object.freeze({
  // Text
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  rst: 'text/x-rst',
  // Code
  ts: 'text/typescript',
  tsx: 'text/typescript',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  jsx: 'text/javascript',
  json: 'application/json',
  jsonl: 'application/x-jsonlines',
  py: 'text/x-python',
  rb: 'text/x-ruby',
  go: 'text/x-go',
  rs: 'text/x-rust',
  java: 'text/x-java',
  c: 'text/x-c',
  cpp: 'text/x-c++',
  h: 'text/x-c',
  sh: 'application/x-sh',
  bash: 'application/x-sh',
  zsh: 'application/x-sh',
  yml: 'application/x-yaml',
  yaml: 'application/x-yaml',
  toml: 'application/toml',
  ini: 'text/plain',
  html: 'text/html',
  css: 'text/css',
  // Data
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  // Archives
  gz: 'application/gzip',
  tgz: 'application/gzip',
  'tar.gz': 'application/gzip',
  zip: 'application/zip',
  tar: 'application/x-tar',
  // Images
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  // Documents
  pdf: 'application/pdf',
  // Misc
  log: 'text/plain',
  env: 'text/plain',
  lock: 'text/plain',
  bin: 'application/octet-stream',
});

/**
 * Detect a MIME type from a filename. Returns
 * `application/octet-stream` for unknown extensions.
 *
 * @param filename - Filename (path components stripped automatically).
 *
 * @example
 * ```ts
 * mimeFromFilename('foo.tar.gz'); // 'application/gzip'
 * mimeFromFilename('README.md');  // 'text/markdown'
 * ```
 */
export function mimeFromFilename(filename: string): string {
  const base = filename.split('/').pop() ?? filename;
  const lower = base.toLowerCase();
  if (lower.endsWith('.tar.gz')) return MIME_BY_EXT['tar.gz']!;
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  const ext = lower.slice(dot + 1);
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}
