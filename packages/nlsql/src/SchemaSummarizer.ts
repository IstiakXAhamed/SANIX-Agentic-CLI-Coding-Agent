/**
 * @file SchemaSummarizer.ts
 * @description Produces a compact, LLM-friendly textual summary of a
 * `DatabaseSchema`.
 *
 * The summary is what gets fed into an LLM's context when generating
 * SQL from natural language. It includes:
 *
 *   - Table names + row counts + descriptions
 *   - Column names, types, and which are PK / FK
 *   - Sample values (when available) so the LLM knows the data shape
 *   - Foreign-key relationships (so the LLM knows how to JOIN)
 *
 * The summary is dialect-aware and stays under a configurable token
 * budget by truncating long column lists and sample arrays.
 */

import type { DatabaseSchema, TableSchema } from './types.js';

/**
 * Options for `SchemaSummarizer.summarize`.
 */
export interface SummarizeOptions {
  /** Include sample values. Default `true`. */
  includeSamples?: boolean;
  /** Max chars per table summary. Default `1500`. */
  maxCharsPerTable?: number;
  /** Max tables to include (0 = all). Default `0`. */
  maxTables?: number;
  /** Include row counts. Default `true`. */
  includeRowCounts?: boolean;
}

/**
 * Produces a textual schema summary for LLM context.
 *
 * @example
 * ```ts
 * const summarizer = new SchemaSummarizer();
 * const text = summarizer.summarize(schema);
 * ```
 */
export class SchemaSummarizer {
  /**
   * Produce the summary.
   */
  public summarize(schema: DatabaseSchema, opts: SummarizeOptions = {}): string {
    const includeSamples = opts.includeSamples ?? true;
    const maxChars = opts.maxCharsPerTable ?? 1500;
    const maxTables = opts.maxTables ?? 0;
    const includeRowCounts = opts.includeRowCounts ?? true;
    const lines: string[] = [];
    lines.push(`Database dialect: ${schema.dialect}`);
    lines.push(`Tables: ${schema.tables.length}`);
    lines.push('');

    const tables = maxTables > 0 ? schema.tables.slice(0, maxTables) : schema.tables;
    for (const table of tables) {
      lines.push(this.summarizeTable(table, { includeSamples, maxChars, includeRowCounts }));
    }

    // Relationships.
    if (schema.relationships.length > 0) {
      lines.push('Relationships:');
      for (const r of schema.relationships) {
        lines.push(`  ${r.fromTable}.${r.fromColumn} → ${r.toTable}.${r.toColumn} (${r.cardinality})`);
      }
    }
    return lines.join('\n');
  }

  /**
   * Produce a compact JSON summary (for programmatic consumers).
   */
  public summarizeJSON(schema: DatabaseSchema, opts: SummarizeOptions = {}): string {
    const maxTables = opts.maxTables ?? 0;
    const tables = maxTables > 0 ? schema.tables.slice(0, maxTables) : schema.tables;
    const compact = tables.map((t) => ({
      name: t.name,
      schema: t.schema,
      rowCount: t.rowCount,
      description: t.description,
      columns: t.columns.map((c) => ({
        name: c.name,
        type: c.type,
        kind: c.kind,
        pk: c.isPrimaryKey,
        fk: c.isForeignKey ? `${c.references?.table}.${c.references?.column}` : null,
        nullable: c.nullable,
        samples: opts.includeSamples === false ? undefined : (c.samples ?? []).slice(0, 5),
      })),
    }));
    return JSON.stringify({ dialect: schema.dialect, tables, relationships: schema.relationships }, null, 2);
  }

  /**
   * Summarize one table.
   */
  public summarizeTable(table: TableSchema, opts: { includeSamples: boolean; maxChars: number; includeRowCounts: boolean }): string {
    const lines: string[] = [];
    const header = opts.includeRowCounts && table.rowCount !== undefined
      ? `Table: ${table.name} (~${table.rowCount} rows)`
      : `Table: ${table.name}`;
    lines.push(header);
    if (table.description) lines.push(`  Description: ${table.description}`);
    lines.push('  Columns:');
    for (const c of table.columns) {
      const parts: string[] = [c.name, c.type];
      if (c.isPrimaryKey) parts.push('PK');
      if (c.isForeignKey && c.references) parts.push(`FK→${c.references.table}.${c.references.column}`);
      if (!c.nullable) parts.push('NOT NULL');
      if (c.unique && !c.isPrimaryKey) parts.push('UNIQUE');
      if (opts.includeSamples && c.samples && c.samples.length > 0) {
        const s = c.samples.slice(0, 5).map((v) => JSON.stringify(v)).join(', ');
        parts.push(`samples=[${s}]`);
      }
      if (c.description) parts.push(`// ${c.description}`);
      lines.push(`    ${parts.join(' ')}`);
    }
    let out = lines.join('\n');
    if (out.length > opts.maxChars) {
      out = out.slice(0, opts.maxChars - 3) + '...';
    }
    return out + '\n';
  }
}
