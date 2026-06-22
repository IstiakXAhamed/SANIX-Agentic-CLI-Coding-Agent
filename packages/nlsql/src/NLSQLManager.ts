/**
 * @file NLSQLManager.ts
 * @description Top-level orchestrator for `@sanix/nlsql`.
 *
 * Wires the `SchemaExtractor`, `SchemaSummarizer`, `SQLGenerator`,
 * `SQLValidator`, `SQLExecutor`, `ChartSuggester`, and `QueryHistory`
 * into a single facade. Consumers typically only touch this class:
 *
 * ```ts
 * const mgr = new NLSQLManager({ schema, query });
 * const result = await mgr.ask('top 5 customers by revenue');
 * console.log(result.generation.sql, result.charts);
 * ```
 */

import { nanoid } from 'nanoid';
import { SchemaExtractor, type QueryFn } from './SchemaExtractor.js';
import { SchemaSummarizer } from './SchemaSummarizer.js';
import { SQLGenerator } from './SQLGenerator.js';
import { SQLValidator } from './SQLValidator.js';
import { SQLExecutor, type ExecuteQueryFn } from './SQLExecutor.js';
import { ChartSuggester } from './ChartSuggester.js';
import { QueryHistory } from './QueryHistory.js';
import type {
  DatabaseSchema,
  NLSQLLLM,
  NLSQLManagerOptions,
  NLSQLResult,
  ValidateOptions,
} from './types.js';

/**
 * Top-level NL→SQL facade.
 */
export class NLSQLManager {
  private readonly opts: NLSQLManagerOptions;
  private readonly generator: SQLGenerator;
  private readonly validator: SQLValidator;
  private readonly summarizer = new SchemaSummarizer();
  private readonly chartSuggester = new ChartSuggester();
  private readonly history: QueryHistory;
  private executor: SQLExecutor | null = null;

  /**
   * @param opts Construction options.
   */
  constructor(opts: NLSQLManagerOptions) {
    this.opts = opts;
    this.generator = new SQLGenerator(opts.schema);
    this.validator = new SQLValidator(opts.schema.dialect);
    this.history = new QueryHistory(opts.maxHistory ?? 100);
  }

  /**
   * Attach a live database connection for execution.
   * @param query Query function.
   */
  public connect(query: ExecuteQueryFn): void {
    this.executor = new SQLExecutor(this.opts.schema.dialect, query);
  }

  /**
   * Extract the schema from a live connection (replaces the current schema).
   * @param query Query function.
   */
  public async extractSchema(query: QueryFn): Promise<DatabaseSchema> {
    const extractor = new SchemaExtractor(this.opts.schema.dialect, query);
    const schema = await extractor.extract();
    // Note: replacing the schema requires rebuilding the generator/validator.
    (this.opts as { schema: DatabaseSchema }).schema = schema;
    return schema;
  }

  /**
   * Answer a natural-language question.
   * @param question NL question.
   * @param execute Whether to execute the SQL (requires `connect()`).
   */
  public async ask(question: string, execute = true): Promise<NLSQLResult> {
    const generation = await this.generator.generate(question, {
      defaultLimit: this.opts.defaultLimit ?? 100,
      llm: this.opts.llm,
    });
    const validation = this.validator.validate(generation.sql, {
      allowDML: this.opts.allowDML ?? false,
    } as ValidateOptions);

    let execution;
    if (execute && validation.valid && this.executor) {
      try {
        execution = await this.executor.execute(generation.sql, {
          params: generation.params,
          allowDML: this.opts.allowDML ?? false,
        });
      } catch (e) {
        this.history.record({
          question,
          sql: generation.sql,
          params: generation.params,
          success: false,
          error: (e as Error).message,
          dialect: this.opts.schema.dialect,
        });
        throw e;
      }
    }

    const charts = this.chartSuggester.suggest(generation.parsed, execution);
    const historyId = this.history.record({
      question,
      sql: generation.sql,
      params: generation.params,
      success: validation.valid,
      executionMs: execution?.durationMs,
      rowCount: execution?.rows.length,
      dialect: this.opts.schema.dialect,
    });

    return { question, generation, validation, execution, charts, historyId };
  }

  /**
   * Just generate SQL (no execution, no charts).
   */
  public async generateSQL(question: string): Promise<NLSQLResult['generation']> {
    return this.generator.generate(question, { defaultLimit: this.opts.defaultLimit ?? 100, llm: this.opts.llm });
  }

  /**
   * Just validate SQL.
   */
  public validateSQL(sql: string, opts?: ValidateOptions): NLSQLResult['validation'] {
    return this.validator.validate(sql, opts);
  }

  /**
   * Summarise the schema (for export / debugging).
   */
  public summarizeSchema(): string {
    return this.summarizer.summarize(this.opts.schema);
  }

  /**
   * Access the history store.
   */
  public getHistory(): QueryHistory {
    return this.history;
  }

  /**
   * Get the current schema.
   */
  public getSchema(): DatabaseSchema {
    return this.opts.schema;
  }

  /**
   * Suggest charts for a previously-run query (by history id).
   */
  public suggestCharts(historyId: string): ReturnType<ChartSuggester['suggest']> {
    const entry = this.history.get(historyId);
    if (!entry) return [];
    const parsed = this.generator.parse(entry.question);
    return this.chartSuggester.suggest(parsed);
  }

  /**
   * Set the LLM (for runtime configuration).
   */
  public setLLM(llm: NLSQLLLM): void {
    (this.opts as { llm?: NLSQLLLM }).llm = llm;
  }
}

/** Re-export for convenience. */
export { nanoid };
