/**
 * @file SQLGenerator.ts
 * @description Generates SQL from a natural-language question.
 *
 * Two strategies:
 *
 *   - **Rule-based** (default): parses the question with regex +
 *     keyword spotting against the schema, then builds a SELECT
 *     statement with the right columns, JOINs, filters, group-by,
 *     order-by, and limit. Works without any LLM.
 *   - **LLM-backed**: when an `NLSQLLLM.generateSQL` function is
 *     provided, the question + a `SchemaSummarizer` summary are sent
 *     to the LLM and the returned SQL is lightly normalised.
 *
 * The generator is dialect-aware (quoting identifiers, LIMIT syntax).
 */

import { SchemaSummarizer } from './SchemaSummarizer.js';
import type {
  DatabaseSchema,
  GenerationResult,
  NLSQLLLM,
  ParsedQuery,
  SQLDialect,
} from './types.js';

/**
 * Options for `SQLGenerator.generate`.
 */
export interface GenerateOptions {
  /** Default LIMIT when the question doesn't specify one. Default `100`. */
  defaultLimit?: number;
  /** LLM function (enables LLM mode). */
  llm?: NLSQLLLM;
}

/**
 * Generates SQL from natural language.
 *
 * @example
 * ```ts
 * const gen = new SQLGenerator(schema);
 * const result = gen.generate('top 5 customers by revenue');
 * ```
 */
export class SQLGenerator {
  private readonly summarizer = new SchemaSummarizer();

  /**
   * @param schema Database schema.
   */
  constructor(private readonly schema: DatabaseSchema) {}

  /**
   * Generate SQL from a question.
   */
  public async generate(question: string, opts: GenerateOptions = {}): Promise<GenerationResult> {
    if (opts.llm) {
      return this.generateLLM(question, opts.llm);
    }
    return Promise.resolve(this.generateRule(question, opts.defaultLimit ?? 100));
  }

  /**
   * Rule-based generation.
   */
  public generateRule(question: string, defaultLimit = 100): GenerationResult {
    const parsed = this.parse(question);
    const sql = this.buildSQL(parsed, defaultLimit);
    return {
      sql,
      params: this.extractParams(parsed),
      parsed,
      confidence: parsed.tables.length > 0 ? 0.7 : 0.3,
      explanation: this.explain(parsed),
      method: 'rule',
    };
  }

  /**
   * LLM-backed generation.
   */
  public async generateLLM(question: string, llm: NLSQLLLM): Promise<GenerationResult> {
    const summary = this.summarizer.summarize(this.schema, { maxCharsPerTable: 800 });
    const { sql, explanation } = await llm.generateSQL(question, summary);
    const parsed = this.parse(question);
    return {
      sql: this.normalise(sql),
      params: [],
      parsed,
      confidence: 0.85,
      explanation,
      method: 'llm',
    };
  }

  /**
   * Parse a question into structured intent (rule-based).
   */
  public parse(question: string): ParsedQuery {
    const lower = question.toLowerCase();
    const tables = this.findTables(lower);
    const columns = this.findColumns(lower, tables);
    const aggregations = this.findAggregations(lower, columns);
    const groupBy = this.findGroupBy(lower, columns, aggregations);
    const orderBy = this.findOrderBy(lower, columns, aggregations);
    const filters = this.findFilters(lower, columns);
    const limit = this.findLimit(lower);
    const timeRange = this.findTimeRange(lower, columns);
    const intent = this.detectIntent(lower, aggregations, groupBy, orderBy, timeRange);
    return { question, tables, columns, aggregations, groupBy, orderBy, filters, limit, timeRange, intent };
  }

  // ─── Parsing helpers ──────────────────────────────────────────────────────

  private findTokens(lower: string): string[] {
    return (lower.match(/[a-z_][a-z0-9_]+/g) ?? []);
  }

  private findTables(lower: string): string[] {
    const tokens = this.findTokens(lower);
    const out: string[] = [];
    for (const t of this.schema.tables) {
      const lname = t.name.toLowerCase();
      if (tokens.includes(lname) || tokens.includes(this.singular(lname))) {
        out.push(t.name);
      }
    }
    // Fallback: if no tables matched, but question mentions common nouns,
    // pick the table whose name has the most token overlap.
    if (out.length === 0 && this.schema.tables.length > 0) {
      let best: { name: string; score: number } | null = null;
      for (const t of this.schema.tables) {
        const parts = t.name.toLowerCase().split(/[_\s]+/);
        let score = 0;
        for (const p of parts) if (tokens.includes(p)) score++;
        if (score > 0 && (!best || score > best.score)) best = { name: t.name, score };
      }
      if (best) out.push(best.name);
    }
    return [...new Set(out)];
  }

  private singular(name: string): string {
    if (name.endsWith('ies')) return name.slice(0, -3) + 'y';
    if (name.endsWith('ses')) return name.slice(0, -2);
    if (name.endsWith('s') && !name.endsWith('ss')) return name.slice(0, -1);
    return name;
  }

  private findColumns(lower: string, tables: string[]): string[] {
    const tokens = this.findTokens(lower);
    const out: string[] = [];
    const tableSchemas = this.schema.tables.filter((t) => tables.includes(t.name));
    const searchTables = tableSchemas.length > 0 ? tableSchemas : this.schema.tables;
    for (const t of searchTables) {
      for (const c of t.columns) {
        if (tokens.includes(c.name.toLowerCase())) out.push(c.name);
      }
    }
    return [...new Set(out)];
  }

  private findAggregations(lower: string, columns: string[]): Array<{ func: string; column?: string }> {
    const out: Array<{ func: string; column?: string }> = [];
    if (/\b(count|number of|how many)\b/.test(lower)) {
      out.push({ func: 'COUNT', column: columns[0] ?? '*' });
    }
    if (/\b(sum|total|revenue)\b/.test(lower)) {
      out.push({ func: 'SUM', column: this.findNumericColumn(columns) });
    }
    if (/\b(average|avg|mean)\b/.test(lower)) {
      out.push({ func: 'AVG', column: this.findNumericColumn(columns) });
    }
    if (/\b(min|minimum|lowest|cheapest)\b/.test(lower)) {
      out.push({ func: 'MIN', column: this.findNumericColumn(columns) });
    }
    if (/\b(max|maximum|highest|top|most)\b/.test(lower)) {
      out.push({ func: 'MAX', column: this.findNumericColumn(columns) });
    }
    if (/\b(distinct|unique)\b/.test(lower)) {
      out.push({ func: 'DISTINCT', column: columns[0] });
    }
    return out;
  }

  private findNumericColumn(columns: string[]): string | undefined {
    for (const col of columns) {
      const schema = this.findColumnSchema(col);
      if (schema && (schema.kind === 'integer' || schema.kind === 'float')) return col;
    }
    return columns[0];
  }

  private findColumnSchema(name: string) {
    for (const t of this.schema.tables) {
      for (const c of t.columns) {
        if (c.name.toLowerCase() === name.toLowerCase()) return c;
      }
    }
    return undefined;
  }

  private findGroupBy(lower: string, columns: string[], aggs: Array<{ func: string }>): string[] {
    if (aggs.length === 0) return [];
    if (/\b(by|per|for each|grouped by)\b/.test(lower)) {
      const nonAgg = columns.filter((c) => !aggs.some((a) => a.column === c));
      return nonAgg.length > 0 ? nonAgg : [];
    }
    return [];
  }

  private findOrderBy(lower: string, columns: string[], aggs: Array<{ func: string; column?: string }>): Array<{ column: string; direction: 'ASC' | 'DESC' }> {
    const out: Array<{ column: string; direction: 'ASC' | 'DESC' }> = [];
    if (/\b(top|highest|most|best|largest|maximum)\b/.test(lower)) {
      const col = aggs.find((a) => a.func === 'MAX' || a.func === 'SUM' || a.func === 'COUNT')?.column ?? columns[0];
      if (col) out.push({ column: col, direction: 'DESC' });
    } else if (/\b(bottom|lowest|least|worst|smallest|minimum)\b/.test(lower)) {
      const col = aggs.find((a) => a.func === 'MIN')?.column ?? columns[0];
      if (col) out.push({ column: col, direction: 'ASC' });
    } else if (/\b(recent|latest|newest|oldest)\b/.test(lower)) {
      const dateCol = columns.find((c) => {
        const s = this.findColumnSchema(c);
        return s && (s.kind === 'date' || s.kind === 'datetime');
      });
      if (dateCol) out.push({ column: dateCol, direction: /\boldest\b/.test(lower) ? 'ASC' : 'DESC' });
    }
    return out;
  }

  private findFilters(lower: string, columns: string[]): ParsedQuery['filters'] {
    const out: ParsedQuery['filters'] = [];
    // "where X = Y", "X is Y", "X > Y"
    const patterns: Array<{ re: RegExp; op: ParsedQuery['filters'][0]['operator'] }> = [
      { re: /(\w+)\s*(=|equals?|is)\s*['"]?([\w.-]+)['"]?/i, op: '=' },
      { re: /(\w+)\s*(!=|not equal to|isn't)\s*['"]?([\w.-]+)['"]?/i, op: '!=' },
      { re: /(\w+)\s*(>=|greater than or equal to|at least)\s*([\w.-]+)/i, op: '>=' },
      { re: /(\w+)\s*(<=|less than or equal to|at most)\s*([\w.-]+)/i, op: '<=' },
      { re: /(\w+)\s*(>|greater than|more than)\s*([\w.-]+)/i, op: '>' },
      { re: /(\w+)\s*(<|less than|fewer than)\s*([\w.-]+)/i, op: '<' },
    ];
    for (const { re, op } of patterns) {
      const m = re.exec(lower);
      if (m) {
        const col = m[1];
        const val = m[3];
        if (columns.includes(col) || this.findColumnSchema(col)) {
          const schema = this.findColumnSchema(col);
          const typed: string | number = schema && (schema.kind === 'integer' || schema.kind === 'float') ? Number(val) : val;
          out.push({ column: col, operator: op, value: typed });
        }
      }
    }
    return out;
  }

  private findLimit(lower: string): number | undefined {
    const m = /\b(top|first|last|limit)\s+(\d+)\b/i.exec(lower) ?? /\b(\d+)\s+(results?|rows?|records?)\b/i.exec(lower);
    if (m) return Number(m[2] ?? m[1]);
    return undefined;
  }

  private findTimeRange(lower: string, columns: string[]): ParsedQuery['timeRange'] | undefined {
    const dateCol = columns.find((c) => {
      const s = this.findColumnSchema(c);
      return s && (s.kind === 'date' || s.kind === 'datetime');
    });
    if (!dateCol) return undefined;
    const yearMatch = /\bin\s+(\d{4})\b/i.exec(lower);
    if (yearMatch) return { column: dateCol, start: `${yearMatch[1]}-01-01`, end: `${yearMatch[1]}-12-31` };
    const lastMatch = /\b(last|past)\s+(\d+)\s+(day|days|week|weeks|month|months|year|years)\b/i.exec(lower);
    if (lastMatch) {
      const n = Number(lastMatch[2]);
      const unit = lastMatch[3];
      return { column: dateCol, start: this.relativeDate(n, unit), end: new Date().toISOString().slice(0, 10) };
    }
    return undefined;
  }

  private relativeDate(n: number, unit: string): string {
    const d = new Date();
    if (unit.startsWith('day')) d.setDate(d.getDate() - n);
    else if (unit.startsWith('week')) d.setDate(d.getDate() - n * 7);
    else if (unit.startsWith('month')) d.setMonth(d.getMonth() - n);
    else if (unit.startsWith('year')) d.setFullYear(d.getFullYear() - n);
    return d.toISOString().slice(0, 10);
  }

  private detectIntent(
    lower: string,
    aggs: Array<{ func: string }>,
    groupBy: string[],
    orderBy: Array<{ direction: 'ASC' | 'DESC' }>,
    timeRange: ParsedQuery['timeRange'],
  ): ParsedQuery['intent'] {
    if (timeRange || /\b(over time|trend|monthly|daily|yearly)\b/.test(lower)) return 'trend';
    if (orderBy.length > 0 && orderBy[0].direction === 'DESC') return 'rank';
    if (groupBy.length > 0) return 'aggregate';
    if (aggs.some((a) => a.func === 'COUNT')) return 'count';
    if (aggs.length > 0) return 'aggregate';
    if (/\b(compare|comparison|versus|vs)\b/.test(lower)) return 'compare';
    if (/\b(distribution|histogram|breakdown)\b/.test(lower)) return 'distribution';
    return 'select';
  }

  // ─── SQL building ─────────────────────────────────────────────────────────

  private buildSQL(parsed: ParsedQuery, defaultLimit: number): string {
    const q = (s: string) => this.quoteIdent(s);
    const tables = parsed.tables.length > 0 ? parsed.tables : [];
    if (tables.length === 0) return '-- No tables could be identified in the question';

    // SELECT clause
    const selectParts: string[] = [];
    if (parsed.aggregations.length === 0) {
      const cols = parsed.columns.length > 0 ? parsed.columns : ['*'];
      for (const c of cols) selectParts.push(c === '*' ? '*' : q(c));
    } else {
      for (const a of parsed.aggregations) {
        if (a.func === 'COUNT' && (!a.column || a.column === '*')) {
          selectParts.push('COUNT(*)');
        } else if (a.func === 'DISTINCT') {
          selectParts.push(`COUNT(DISTINCT ${q(a.column ?? '*')})`);
        } else {
          selectParts.push(`${a.func}(${q(a.column ?? '*')})`);
        }
      }
      for (const c of parsed.groupBy) selectParts.push(q(c));
    }

    // FROM + JOINs
    const from = q(tables[0]);
    const joins: string[] = [];
    if (tables.length > 1) {
      for (let i = 1; i < tables.length; i++) {
        const rel = this.findRelationship(tables[0], tables[i]);
        if (rel) {
          joins.push(`JOIN ${q(tables[i])} ON ${q(rel.fromTable)}.${q(rel.fromColumn)} = ${q(rel.toTable)}.${q(rel.toColumn)}`);
        } else {
          joins.push(`JOIN ${q(tables[i])} ON TRUE`);
        }
      }
    }

    // WHERE
    const whereParts: string[] = [];
    for (const f of parsed.filters) {
      whereParts.push(this.renderFilter(f, q));
    }
    if (parsed.timeRange) {
      const col = q(parsed.timeRange.column);
      if (parsed.timeRange.start) whereParts.push(`${col} >= '${parsed.timeRange.start}'`);
      if (parsed.timeRange.end) whereParts.push(`${col} <= '${parsed.timeRange.end}'`);
    }

    // GROUP BY
    const groupByClause = parsed.groupBy.length > 0 ? ` GROUP BY ${parsed.groupBy.map(q).join(', ')}` : '';

    // ORDER BY
    const orderByClause = parsed.orderBy.length > 0
      ? ` ORDER BY ${parsed.orderBy.map((o) => `${q(o.column)} ${o.direction}`).join(', ')}`
      : '';

    // LIMIT
    const limit = parsed.limit ?? defaultLimit;
    const limitClause = this.limitClause(limit);

    const where = whereParts.length > 0 ? ` WHERE ${whereParts.join(' AND ')}` : '';
    return `SELECT ${selectParts.join(', ')} FROM ${from}${joins.length ? ' ' + joins.join(' ') : ''}${where}${groupByClause}${orderByClause}${limitClause};`;
  }

  private renderFilter(f: ParsedQuery['filters'][0], q: (s: string) => string): string {
    const col = q(f.column);
    switch (f.operator) {
      case 'IS NULL': return `${col} IS NULL`;
      case 'IS NOT NULL': return `${col} IS NOT NULL`;
      case 'IN':
      case 'NOT IN':
        return Array.isArray(f.value) ? `${col} ${f.operator} (${f.value.map((v) => this.literal(v)).join(', ')})` : `${col} ${f.operator} (${this.literal(f.value)})`;
      case 'BETWEEN':
        return Array.isArray(f.value) ? `${col} BETWEEN ${this.literal(f.value[0])} AND ${this.literal(f.value[1])}` : `${col} = ${this.literal(f.value)}`;
      case 'LIKE':
      case 'ILIKE':
        return `${col} ${f.operator} ${this.literal(f.value)}`;
      default:
        return `${col} ${f.operator} ${this.literal(f.value)}`;
    }
  }

  private literal(v: string | number | boolean | null): string {
    if (v === null) return 'NULL';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    return `'${String(v).replace(/'/g, "''")}'`;
  }

  private limitClause(limit: number): string {
    switch (this.schema.dialect) {
      case 'sqlserver':
      case 'oracle':
        return ` FETCH FIRST ${limit} ROWS ONLY`;
      default:
        return ` LIMIT ${limit}`;
    }
  }

  private quoteIdent(name: string): string {
    switch (this.schema.dialect) {
      case 'mysql': case 'mariadb': return `\`${name}\``;
      case 'sqlserver': return `[${name}]`;
      case 'postgres': case 'oracle': return `"${name}"`;
      case 'sqlite': return `"${name}"`;
    }
  }

  private findRelationship(a: string, b: string) {
    return this.schema.relationships.find((r) =>
      (r.fromTable === a && r.toTable === b) || (r.fromTable === b && r.toTable === a),
    );
  }

  private extractParams(parsed: ParsedQuery): unknown[] {
    return parsed.filters.map((f) => f.value);
  }

  private explain(parsed: ParsedQuery): string {
    const parts: string[] = [];
    parts.push(`Querying ${parsed.tables.join(', ')}`);
    if (parsed.aggregations.length) parts.push(`with ${parsed.aggregations.map((a) => `${a.func}(${a.column ?? '*'})`).join(', ')}`);
    if (parsed.groupBy.length) parts.push(`grouped by ${parsed.groupBy.join(', ')}`);
    if (parsed.filters.length) parts.push(`filtered by ${parsed.filters.length} condition(s)`);
    if (parsed.orderBy.length) parts.push(`ordered by ${parsed.orderBy.map((o) => `${o.column} ${o.direction}`).join(', ')}`);
    if (parsed.limit) parts.push(`limited to ${parsed.limit} rows`);
    return parts.join(', ') + '.';
  }

  private normalise(sql: string): string {
    let s = sql.trim();
    if (!s.endsWith(';')) s += ';';
    return s;
  }

  /** Dialect accessor (used by tests / consumers). */
  public getDialect(): SQLDialect {
    return this.schema.dialect;
  }
}
