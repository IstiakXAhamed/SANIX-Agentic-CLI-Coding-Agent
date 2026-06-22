import { defineConfig } from 'tsup';

/**
 * @file tsup.config.ts
 * @description Build config for `@sanix/docai`. ESM-only, DTS bundled.
 * Document-parsing libs (pdf-parse, mammoth, pptxtojson, exceljs,
 * cheerio, tesseract.js) are dynamically imported inside processors
 * and kept external — callers install only what they need.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: false,
  splitting: false,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  platform: 'node',
  treeshake: true,
  external: [
    'nanoid',
    'zod',
    'mime-types',
    'pdf-parse',
    'pdfjs-dist',
    'mammoth',
    'docx',
    'pptxtojson',
    'officeparser',
    'exceljs',
    'xlsx',
    'cheerio',
    'tesseract.js',
    'sharp',
    '@sanix/providers',
  ],
  noExternal: [],
});
