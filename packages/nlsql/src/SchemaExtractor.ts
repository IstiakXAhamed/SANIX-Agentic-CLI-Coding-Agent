/**
 * @file SchemaExtractor.ts
 * @description Extracts a `DatabaseSchema` from a live database via
 * INFORMATION_SCHEMA queries (works for Postgres / MySQL / MariaDB /
 * SQL Server / Oracle) or `PRAGMA` introspection (SQLite).
 *
 * The extractor is dialect-aware: it picks the right catalog views and
 * normalises the output into the shared `DatabaseSchema` shape.
 *
 * For dialects that need a live connection, the caller supplies a
 * `query` function `(sql, params) => Promise<QueryRow[]>`. For SQLite
 * the caller can also pass a `better-sqlite3`-style Database.
 */

import type {
  ColumnKind,
  ColumnSchema,
  DatabaseSchema,
  ForeignKey,
  SQLDialect,
  TableRelationship,
  TableSchema,
} from './types.js';

/** A function that runs a SQL query and returns rows. */
export type QueryFn = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

/**
 * Extracts a database schema from a live connection.
 *
 * @example
 * ```ts
 * const extractor = new SchemaExtractor('postgres', query);
 * const schema = await extractor.extract();
 * ```
 */
export class SchemaExtractor {
  /**
   * @param dialect SQL dialect.
   * @param query Query function (returns rows as objects).
   */
  constructor(
    private readonly dialect: SQLDialect,
    private readonly query: QueryFn,
  ) {}

  /**
   * Extract the full schema.
   */
  public async extract(): Promise<DatabaseSchema> {
    const tables = this.dialect === 'sqlite'
      ? await this.extractSQLite()
      : await this.extractStandard();
    const relationships = this.deriveRelationships(tables);
    return { dialect: this.dialect, tables, relationships };
  }

  // ─── SQLite (PRAGMA-based) ────────────────────────────────────────────────

  private async extractSQLite(): Promise<TableSchema[]> {
    const tableRows = await this.query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    );
    const tables: TableSchema[] = [];
    for (const { name } of tableRows) {
      const tableName = String(name);
      const columns = await this.extractSQLiteColumns(tableName);
      const fks = await this.extractSQLiteForeignKeys(tableName);
      let rowCount: number | undefined;
      try {
        const [{ c }] = await this.query(`SELECT COUNT(*) AS c FROM "${tableName}"`);
        rowCount = Number(c);
      } catch { /* ignore */ }
      tables.push({ name: tableName, columns, foreignKeys: fks, rowCount });
    }
    return tables;
  }

  private async extractSQLiteColumns(table: string): Promise<ColumnSchema[]> {
    const rows = await this.query(`PRAGMA table_info("${table}")`);
    return rows.map((r) => {
      const type = String(r.type ?? '').toUpperCase();
      const kind = this.classifyType(type);
      const isPK = Number(r.pk ?? 0) > 0;
      return {
        name: String(r.name),
        type,
        kind,
        isPrimaryKey: isPK,
        isForeignKey: false,
        nullable: !isPK && Number(r.notnull ?? 0) === 0,
        unique: isPK,
        defaultValue: r.dflt_value !== undefined && r.dflt_value !== null ? String(r.dflt_value) : undefined,
      };
    });
  }

  private async extractSQLiteForeignKeys(table: string): Promise<ForeignKey[]> {
    const rows = await this.query(`PRAGMA foreign_key_list("${table}")`);
    return rows.map((r) => ({
      column: String(r.from),
      referencesTable: String(r.table),
      referencesColumn: String(r.to),
    }));
  }

  // ─── Standard INFORMATION_SCHEMA (postgres / mysql / sqlserver / oracle) ──

  private async extractStandard(): Promise<TableSchema[]> {
    const catalog = this.standardTablesSQL();
    const tableRows = await this.query(catalog.tables);
    const tables: TableSchema[] = [];
    for (const tr of tableRows) {
      const name = String(tr.TABLE_NAME ?? tr.table_name);
      const schema = tr.TABLE_SCHEMA ? String(tr.TABLE_SCHEMA) : (tr.table_schema ? String(tr.table_schema) : undefined);
      const columns = await this.extractStandardColumns(name, schema);
      const fks = await this.extractStandardForeignKeys(name, schema);
      tables.push({ name, schema, columns, foreignKeys: fks, rowCount: tr.ROW_COUNT !== undefined ? Number(tr.ROW_COUNT) : undefined, description: tr.TABLE_COMMENT ? String(tr.TABLE_COMMENT) : undefined });
    }
    return tables;
  }

  private async extractStandardColumns(table: string, schema?: string): Promise<ColumnSchema[]> {
    const sql = this.standardColumnsSQL();
    const rows = await this.query(sql, [schema ?? 'public', table]);
    return rows.map((r) => {
      const type = String(r.DATA_TYPE ?? r.data_type ?? '').toUpperCase();
      const name = String(r.COLUMN_NAME ?? r.column_name);
      return {
        name,
        type,
        kind: this.classifyType(type),
        isPrimaryKey: String(r.COLUMN_KEY ?? r.column_key ?? '') === 'PRI',
        isForeignKey: String(r.COLUMN_KEY ?? r.column_key ?? '') === 'MUL',
        nullable: String(r.IS_NULLABLE ?? r.is_nullable ?? '').toUpperCase() === 'YES',
        unique: String(r.COLUMN_KEY ?? r.column_key ?? '') === 'UNI',
        defaultValue: r.COLUMN_DEFAULT !== undefined && r.COLUMN_DEFAULT !== null ? String(r.COLUMN_DEFAULT) : undefined,
        description: r.COLUMN_COMMENT ? String(r.COLUMN_COMMENT) : undefined,
      };
    });
  }

  private async extractStandardForeignKeys(table: string, schema?: string): Promise<ForeignKey[]> {
    const sql = this.standardForeignKeysSQL();
    const rows = await this.query(sql, [schema ?? 'public', table]);
    return rows.map((r) => ({
      column: String(r.COLUMN_NAME ?? r.column_name),
      referencesTable: String(r.REFERENCED_TABLE_NAME ?? r.referenced_table_name),
      referencesColumn: String(r.REFERENCED_COLUMN_NAME ?? r.referenced_column_name),
    }));
  }

  /**
   * Classify a SQL type into a coarse `ColumnKind`.
   */
  public classifyType(type: string): ColumnKind {
    const t = type.toUpperCase();
    if (/^(INT|INTEGER|BIGINT|SMALLINT|TINYINT|MEDIUMINT|SERIAL|BIGSERIAL|IDENTITY)/.test(t)) return 'integer';
    if (/^(FLOAT|DOUBLE|DECIMAL|NUMERIC|REAL|MONEY|SMALLMONEY)/.test(t)) return 'float';
    if (/^(BOOL|BOOLEAN|BIT)/.test(t)) return 'boolean';
    if (/^(DATE)/.test(t)) return 'date';
    if (/^(DATETIME|TIMESTAMP|TIMESTAMPTZ|SMALLDATETIME|TIME)/.test(t)) return 'datetime';
    if (/^(JSON|JSONB)/.test(t)) return 'json';
    if (/^(UUID|UNIQUEIDENTIFIER)/.test(t)) return 'uuid';
    if (/^(BLOB|BYTEA|BINARY|VARBINARY|IMAGE)/.test(t)) return 'binary';
    if (/^(TEXT|CLOB|LONGTEXT|MEDIUMTEXT|TINYTEXT|NTEXT)/.test(t)) return 'text';
    return 'string';
  }

  // ─── Per-dialect SQL templates ───────────────────────────────────────────

  private standardTablesSQL(): { tables: string } {
    switch (this.dialect) {
      case 'postgres': case 'mariadb':
        return { tables: `SELECT table_name AS "TABLE_NAME", table_schema AS "TABLE_SCHEMA" FROM information_schema.tables WHERE table_schema NOT IN ('information_schema','pg_catalog','mysql','performance_schema','sys') ORDER BY table_schema, table_name` };
      case 'mysql':
        return { tables: `SELECT TABLE_NAME, TABLE_SCHEMA, TABLE_COMMENT FROM information_schema.tables WHERE TABLE_SCHEMA NOT IN ('information_schema','mysql','performance_schema','sys') ORDER BY TABLE_SCHEMA, TABLE_NAME` };
      case 'sqlserver':
        return { tables: `SELECT TABLE_NAME, TABLE_SCHEMA FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE' ORDER BY TABLE_SCHEMA, TABLE_NAME` };
      case 'oracle':
        return { tables: `SELECT TABLE_NAME, OWNER AS TABLE_SCHEMA FROM ALL_TABLES WHERE OWNER NOT IN ('SYS','SYSTEM','OUTLN','DBSNMP') ORDER BY OWNER, TABLE_NAME` };
      default:
        return { tables: `SELECT TABLE_NAME, TABLE_SCHEMA FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE' ORDER BY TABLE_SCHEMA, TABLE_NAME` };
    }
  }

  private standardColumnsSQL(): string {
    return `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, COLUMN_COMMENT FROM information_schema.columns WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`;
  }

  private standardForeignKeysSQL(): string {
    return `SELECT COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME FROM information_schema.key_column_usage WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL`;
  }

  // ─── Relationships ─────────────────────────────────────────────────────────

  private deriveRelationships(tables: TableSchema[]): TableRelationship[] {
    const out: TableRelationship[] = [];
    for (const t of tables) {
      for (const fk of t.foreignKeys) {
        out.push({
          fromTable: t.name,
          toTable: fk.referencesTable,
          fromColumn: fk.column,
          toColumn: fk.referencesColumn,
          cardinality: 'many-to-one',
        });
      }
    }
    return out;
  }
}
