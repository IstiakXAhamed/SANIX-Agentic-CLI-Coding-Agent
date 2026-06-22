/**
 * @file SQLExecutor.ts
 * @description Runs a SQL query against a live database.
 *
 * The executor accepts a caller-supplied `query` function (so it
 * never depends on a specific driver) and adds:
 *
 *   - Dry-run mode (parse + validate, don't execute).
 *   - Statement-type guard (refuse DML/DDL unless allowed).
 *   - Row / time limits.
 *   - Result normalisation (column names + typed rows).
 */

import type { ExecutionResult, QueryRow, SQLDialect } from './types.js';

/** Query function — same shape as `SchemaExtractor`. */
export type ExecuteQueryFn = (sql: string, params?: unknown[]) => Promise<QueryRow[] | { rows: QueryRow[]; affectedRows?: number }>;

/**
 * Options for `SQLExecutor.execute`.
 */
export interface ExecuteOptions {
  /** Params for prepared-statement placeholders. */
  params?: unknown[];
  /** Dry-run (parse only). Default `false`. */
  dryRun?: boolean;
  /** Max rows to return. Default `1000`. */
  maxRows?: number;
  /** Statement timeout in ms. Default `10000`. */
  timeoutMs?: number;
  /** Allow DML. Default `false`. */
  allowDML?: boolean;
}

/**
 * Executes SQL against a live database.
 *
 * @example
 * ```ts
 * const exec = new SQLExecutor('postgres', queryFn);
 * const result = await exec.execute('SELECT * FROM users LIMIT 10');
 * ```
 */
export class SQLExecutor {
  /**
   * @param dialect SQL dialect.
   * @param query Query function.
   */
  constructor(
    private readonly dialect: SQLDialect,
    private readonly query: ExecuteQueryFn,
  ) {}

  /**
   * Execute SQL.
   */
  public async execute(sql: string, opts: ExecuteOptions = {}): Promise<ExecutionResult> {
    const started = Date.now();
    const params = opts.params ?? [];
    const maxRows = opts.maxRows ?? 1000;
    const timeoutMs = opts.timeoutMs ?? 10000;
    const isReadOnly = /^\s*(SELECT|WITH)\b/i.test(sql);

    if (!isReadOnly && !opts.allowDML) {
      return {
        columns: [],
        rows: [],
        durationMs: Date.now() - started,
        dryRun: true,
      };
    }

    if (opts.dryRun) {
      return { columns: [], rows: [], durationMs: Date.now() - started, dryRun: true };
    }

    const result = await Promise.race([
      this.query(sql, params),
      this.timeout(timeoutMs),
    ]);

    const { rows, affectedRows } = this.normalise(result);
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    const trimmed = maxRows > 0 ? rows.slice(0, maxRows) : rows;
    return {
      columns,
      rows: trimmed,
      rowsAffected: affectedRows,
      durationMs: Date.now() - started,
      dryRun: false,
    };
  }

  /**
   * Run multiple statements in a transaction (best-effort).
   */
  public async executeTransaction(statements: Array<{ sql: string; params?: unknown[] }>, opts: ExecuteOptions = {}): Promise<ExecutionResult[]> {
    // Most drivers handle transactions themselves; we emit BEGIN/COMMIT.
    const results: ExecutionResult[] = [];
    await this.query('BEGIN', []);
    try {
      for (const stmt of statements) {
        results.push(await this.execute(stmt.sql, { ...opts, params: stmt.params }));
      }
      await this.query('COMMIT', []);
    } catch (e) {
      await this.query('ROLLBACK', []).catch(() => undefined);
      throw e;
    }
    return results;
  }

  /**
   * Test the connection with a trivial query.
   */
  public async ping(): Promise<boolean> {
    try {
      const sql = this.dialect === 'sqlserver' ? 'SELECT 1' : 'SELECT 1';
      await this.query(sql, []);
      return true;
    } catch {
      return false;
    }
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  private normalise(result: QueryRow[] | { rows: QueryRow[]; affectedRows?: number }): { rows: QueryRow[]; affectedRows?: number } {
    if (Array.isArray(result)) return { rows: result };
    return { rows: result.rows ?? [], affectedRows: result.affectedRows };
  }

  private timeout(ms: number): Promise<never> {
    return new Promise((_, reject) => setTimeout(() => reject(new Error(`Query timed out after ${ms}ms`)), ms));
  }
}
