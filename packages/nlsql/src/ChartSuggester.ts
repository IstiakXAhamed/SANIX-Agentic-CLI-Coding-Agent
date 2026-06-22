/**
 * @file ChartSuggester.ts
 * @description Suggests appropriate chart types for a query result.
 *
 * Given a `ParsedQuery` (intent + aggregations + group-by) and an
 * optional `ExecutionResult` (columns + sample rows), the suggester
 * picks one or more `ChartSuggestion`s ranked by confidence.
 *
 * Rules (in priority order):
 *
 *   1. `trend` intent + time column → line / area chart.
 *   2. `rank` intent + category + numeric → bar chart.
 *   3. `distribution` intent + single category → pie / donut.
 *   4. `aggregate` intent + group-by + single metric → bar chart.
 *   5. Two numeric columns → scatter.
 *   6. Single numeric column → histogram.
 *   7. Fallback → table.
 */

import type {
  Aggregation,
  ChartSuggestion,
  ChartType,
  ExecutionResult,
  ParsedQuery,
} from './types.js';

/**
 * Options for `ChartSuggester.suggest`.
 */
export interface SuggestOptions {
  /** Max suggestions to return. Default `3`. */
  maxSuggestions?: number;
}

/**
 * Suggests charts for query results.
 *
 * @example
 * ```ts
 * const s = new ChartSuggester();
 * const charts = s.suggest(parsed, execution);
 * ```
 */
export class ChartSuggester {
  /**
   * Suggest charts.
   */
  public suggest(parsed: ParsedQuery, execution?: ExecutionResult, opts: SuggestOptions = {}): ChartSuggestion[] {
    const max = opts.maxSuggestions ?? 3;
    const candidates: ChartSuggestion[] = [];

    const numericCols = this.numericColumns(parsed, execution);
    const categoryCols = this.categoryColumns(parsed, execution);
    const timeCols = this.timeColumns(parsed, execution);
    const agg = parsed.aggregations[0];

    // 1. Trend
    if (parsed.intent === 'trend' && timeCols.length > 0) {
      candidates.push({
        type: 'line' as ChartType,
        title: this.title(parsed, 'Over Time'),
        xColumn: timeCols[0],
        yColumns: numericCols.length > 0 ? numericCols.slice(0, 3) : (agg ? [this.aggColumn(agg)] : []),
        aggregation: agg?.func,
        confidence: 0.9,
        rationale: 'Time-series data with a numeric measure is best shown as a line chart.',
      });
      candidates.push({
        type: 'area' as ChartType,
        title: this.title(parsed, 'Over Time (Area)'),
        xColumn: timeCols[0],
        yColumns: numericCols.length > 0 ? numericCols.slice(0, 3) : (agg ? [this.aggColumn(agg)] : []),
        aggregation: agg?.func,
        confidence: 0.75,
        rationale: 'Area chart emphasises cumulative magnitude over time.',
      });
    }

    // 2. Rank
    if (parsed.intent === 'rank' && categoryCols.length > 0 && (numericCols.length > 0 || agg)) {
      candidates.push({
        type: 'bar' as ChartType,
        title: this.title(parsed, 'Ranked'),
        xColumn: categoryCols[0],
        yColumns: numericCols.length > 0 ? [numericCols[0]] : [this.aggColumn(agg!)],
        seriesColumn: categoryCols[1],
        aggregation: agg?.func,
        confidence: 0.88,
        rationale: 'Categorical data with a ranked numeric measure → bar chart.',
      });
    }

    // 3. Distribution
    if ((parsed.intent === 'distribution' || parsed.intent === 'aggregate') && categoryCols.length > 0 && (numericCols.length > 0 || agg)) {
      const yCol = numericCols[0] ?? this.aggColumn(agg!);
      candidates.push({
        type: 'bar' as ChartType,
        title: this.title(parsed, 'Breakdown'),
        xColumn: categoryCols[0],
        yColumns: [yCol],
        aggregation: agg?.func,
        confidence: 0.8,
        rationale: 'Single category + single measure → bar chart.',
      });
      // Pie/donut if few categories (we can't know exactly without execution, but suggest).
      candidates.push({
        type: 'donut' as ChartType,
        title: this.title(parsed, 'Share'),
        xColumn: categoryCols[0],
        yColumns: [yCol],
        aggregation: agg?.func,
        confidence: 0.6,
        rationale: 'For ≤7 categories, a donut shows share-of-total well.',
      });
    }

    // 4. Scatter — two numerics
    if (numericCols.length >= 2 && parsed.intent !== 'trend') {
      candidates.push({
        type: 'scatter' as ChartType,
        title: this.title(parsed, 'Correlation'),
        xColumn: numericCols[0],
        yColumns: [numericCols[1]],
        seriesColumn: categoryCols[0],
        confidence: 0.65,
        rationale: 'Two numeric columns → scatter reveals correlation.',
      });
    }

    // 5. Histogram — single numeric, no group-by
    if (numericCols.length === 1 && categoryCols.length === 0 && parsed.aggregations.length === 0) {
      candidates.push({
        type: 'histogram' as ChartType,
        title: this.title(parsed, 'Distribution'),
        xColumn: numericCols[0],
        yColumns: ['COUNT'],
        confidence: 0.7,
        rationale: 'Single numeric column → histogram shows distribution.',
      });
    }

    // 6. Compare
    if (parsed.intent === 'compare' && categoryCols.length > 0 && numericCols.length > 0) {
      candidates.push({
        type: 'bar' as ChartType,
        title: this.title(parsed, 'Comparison'),
        xColumn: categoryCols[0],
        yColumns: numericCols.slice(0, 3),
        seriesColumn: categoryCols[1],
        confidence: 0.78,
        rationale: 'Comparison across categories with multiple measures → grouped bar chart.',
      });
    }

    // 7. Fallback — table
    if (candidates.length === 0) {
      candidates.push({
        type: 'table' as ChartType,
        title: this.title(parsed, 'Results'),
        yColumns: numericCols.slice(0, 5),
        confidence: 0.4,
        rationale: 'No clear visual pattern — table presents the raw data.',
      });
    }

    // Re-rank + dedupe by type.
    const seen = new Set<ChartType>();
    const out: ChartSuggestion[] = [];
    for (const c of candidates.sort((a, b) => b.confidence - a.confidence)) {
      if (seen.has(c.type)) continue;
      seen.add(c.type);
      out.push(c);
      if (out.length >= max) break;
    }
    return out;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private numericColumns(parsed: ParsedQuery, execution?: ExecutionResult): string[] {
    if (execution && execution.rows.length > 0) {
      return execution.columns.filter((c) => typeof execution.rows[0][c] === 'number');
    }
    // Heuristic from column names.
    return parsed.columns.filter((c) => /count|sum|total|amount|price|revenue|cost|qty|quantity|score|value|age/i.test(c));
  }

  private categoryColumns(parsed: ParsedQuery, execution?: ExecutionResult): string[] {
    const numeric = new Set(this.numericColumns(parsed, execution));
    const time = new Set(this.timeColumns(parsed, execution));
    if (execution && execution.rows.length > 0) {
      return execution.columns.filter((c) => typeof execution.rows[0][c] === 'string' && !time.has(c));
    }
    return [...parsed.groupBy, ...parsed.columns.filter((c) => !numeric.has(c) && !time.has(c))];
  }

  private timeColumns(parsed: ParsedQuery, _execution?: ExecutionResult): string[] {
    const cols: string[] = [];
    if (parsed.timeRange) cols.push(parsed.timeRange.column);
    for (const c of parsed.columns) {
      if (/date|time|day|month|year|week|timestamp/i.test(c)) cols.push(c);
    }
    return [...new Set(cols)];
  }

  private aggColumn(agg: { func: Aggregation; column?: string }): string {
    return agg.column && agg.column !== '*' ? `${agg.func}(${agg.column})` : `${agg.func}(*)`;
  }

  private title(parsed: ParsedQuery, suffix: string): string {
    const subject = parsed.tables[0] ?? 'Data';
    const subjectPretty = subject.charAt(0).toUpperCase() + subject.slice(1);
    return `${subjectPretty} ${suffix}`;
  }
}
