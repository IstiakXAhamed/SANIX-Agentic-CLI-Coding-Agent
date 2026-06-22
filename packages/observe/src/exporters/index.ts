/**
 * @file exporters/index.ts
 * @description Barrel + factory for the three exporters shipped with
 * `@sanix/observe`.
 *
 * @packageDocumentation
 */

export { createConsoleExporter } from './ConsoleExporter.js';
export { createJSONLExporter } from './JSONLExporter.js';
export { createOTLPExporter } from './OTLPExporter.js';

import { createConsoleExporter } from './ConsoleExporter.js';
import { createJSONLExporter } from './JSONLExporter.js';
import { createOTLPExporter } from './OTLPExporter.js';
import type {
  ConsoleExporterOptions,
  Exporter,
  JSONLExporterOptions,
  OTLPExporterOptions,
} from '../types.js';

/**
 * Construct an exporter by type.
 *
 * @param type - `'console' | 'jsonl' | 'otlp'`.
 * @param opts - Type-specific options (see {@link ConsoleExporterOptions},
 *               {@link JSONLExporterOptions}, {@link OTLPExporterOptions}).
 * @returns An {@link Exporter} instance.
 *
 * @example
 * ```ts
 * const exporter = createExporter('otlp', { endpoint: 'http://localhost:4318/v1/traces' });
 * ```
 */
export function createExporter(
  type: 'console' | 'jsonl' | 'otlp',
  opts?:
    | ConsoleExporterOptions
    | JSONLExporterOptions
    | OTLPExporterOptions,
): Exporter {
  switch (type) {
    case 'console':
      return createConsoleExporter(
        opts as ConsoleExporterOptions | undefined,
      );
    case 'jsonl':
      return createJSONLExporter(opts as JSONLExporterOptions | undefined);
    case 'otlp':
      return createOTLPExporter(opts as OTLPExporterOptions | undefined);
  }
}
