/**
 * @file types.ts
 * @description Shared types for `@sanix/nlsql` — natural-language-to-SQL.
 *
 * @packageDocumentation
 */

/**
 * Supported SQL dialects. The generator / validator / executor adapt
 * their output and parsing to the dialect.
 */
export type SQLDialect = 'sqlite' | 'postgres' | 'mysql' | 'mariadb' | 'sqlserver' | 'oracle';

/**
 * A column in a table schema.
 */
export interface ColumnSchema {
  /** Column name. */
  name: string;
  /** SQL type (e.g. `INTEGER`, `VARCHAR(255)`, `TEXT`). */
  type: string;
  /** Normalised data kind for chart suggestion. */
  kind: ColumnKind;
  /** Is this column the primary key? */
  isPrimaryKey: boolean;
  /** Is this column a foreign key? */
  isForeignKey: boolean;
  /** Target table.column for foreign keys. */
  references?: { table: string; column: string };
  /** Nullable? */
  nullable: boolean;
  /** Has a UNIQUE constraint? */
  unique: boolean;
  /** Default value expression, if any. */
  defaultValue?: string;
  /** Human-readable description (from COMMENT / doc). */
  description?: string;
  /** Sample values (for the summarizer). */
  samples?: unknown[];
}

/**
 * Coarse data kind, used for chart suggestions + SQL generation.
 */
export type ColumnKind =
  | 'integer'
  | 'float'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'time'
  | 'string'
  | 'text'
  | 'json'
  | 'binary'
  | 'enum'
  | 'uuid';

/**
 * A table in the schema.
 */
export interface TableSchema {
  /** Table name. */
  name: string;
  /** Schema / namespace (e.g. `public`). */
  schema?: string;
  /** Columns. */
  columns: ColumnSchema[];
  /** Foreign-key relationships to other tables. */
  foreignKeys: ForeignKey[];
  /** Row count (approximate, for summarizer). */
  rowCount?: number;
  /** Human-readable description. */
  description?: string;
}

/** A foreign-key relationship. */
export interface ForeignKey {
  /** Local column. */
  column: string;
  /** Target table. */
  referencesTable: string;
  /** Target column. */
  referencesColumn: string;
}

/** The full database schema. */
export interface DatabaseSchema {
  /** Dialect. */
  dialect: SQLDialect;
  /** Tables. */
  tables: TableSchema[];
  /** All foreign keys (flattened for quick lookup). */
  relationships: TableRelationship[];
}

/** A relationship between two tables (derived from FKs both ways). */
export interface TableRelationship {
  fromTable: string;
  toTable: string;
  fromColumn: string;
  toColumn: string;
  /** `one-to-many` / `many-to-one` / `one-to-one`. */
  cardinality: 'one-to-many' | 'many-to-one' | 'one-to-one';
}

/**
 * A natural-language question parsed into structured intent.
 */
export interface ParsedQuery {
  /** Original question. */
  question: string;
  /** Tables referenced. */
  tables: string[];
  /** Columns referenced (resolved names). */
  columns: string[];
  /** Aggregations requested. */
  aggregations: Aggregation[];
  /** Group-by columns. */
  groupBy: string[];
  /** Order-by columns + direction. */
  orderBy: Array<{ column: string; direction: 'ASC' | 'DESC' }>;
  /** Filters (WHERE clauses). */
  filters: Filter[];
  /** LIMIT, if specified. */
  limit?: number;
  /** Time range, if specified. */
  timeRange?: { column: string; start?: string; end?: string };
  /** Detected intent. */
  intent: QueryIntent;
}

/** Aggregation function. */
export type Aggregation = 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX' | 'DISTINCT';

/** A WHERE-clause filter. */
export interface Filter {
  column: string;
  operator: FilterOperator;
  value: string | number | boolean | null | Array<string | number>;
}

/** Filter operators. */
export type FilterOperator =
  | '=' | '!=' | '<' | '<=' | '>' | '>='
  | 'LIKE' | 'ILIKE' | 'IN' | 'NOT IN'
  | 'IS NULL' | 'IS NOT NULL'
  | 'BETWEEN';

/** High-level query intent. */
export type QueryIntent =
  | 'select'
  | 'aggregate'
  | 'count'
  | 'compare'
  | 'trend'
  | 'rank'
  | 'distribution'
  | 'filter'
  | 'join'
  | 'unknown';

/**
 * Result of SQL generation.
 */
export interface GenerationResult {
  /** Generated SQL. */
  sql: string;
  /** Parameter values for prepared statements. */
  params: unknown[];
  /** Parsed intent that drove the SQL. */
  parsed: ParsedQuery;
  /** Confidence 0–1. */
  confidence: number;
  /** Human-readable explanation. */
  explanation: string;
  /** Method used — `rule` or `llm`. */
  method: 'rule' | 'llm';
}

/**
 * Result of SQL validation.
 */
export interface ValidationResult {
  /** Is the SQL valid? */
  valid: boolean;
  /** Error messages (empty when valid). */
  errors: string[];
  /** Warnings. */
  warnings: string[];
  /** Safety issues (e.g. destructive statement, missing LIMIT). */
  safetyIssues: string[];
  /** Estimated risk level. */
  risk: 'safe' | 'low' | 'medium' | 'high' | 'critical';
}

/**
 * A row in a query result.
 */
export type QueryRow = Record<string, unknown>;

/**
 * Result of SQL execution.
 */
export interface ExecutionResult {
  /** Column names. */
  columns: string[];
  /** Row data. */
  rows: QueryRow[];
  /** Rows affected (for INSERT/UPDATE/DELETE). */
  rowsAffected?: number;
  /** Wall-clock duration in ms. */
  durationMs: number;
  /** Was the query executed or dry-run? */
  dryRun: boolean;
}

/**
 * A chart suggestion.
 */
export interface ChartSuggestion {
  /** Chart type. */
  type: ChartType;
  /** Title. */
  title: string;
  /** X-axis column. */
  xColumn?: string;
  /** Y-axis column(s). */
  yColumns: string[];
  /** Series / grouping column. */
  seriesColumn?: string;
  /** Aggregation used. */
  aggregation?: Aggregation;
  /** Confidence 0–1. */
  confidence: number;
  /** Rationale. */
  rationale: string;
}

/** Supported chart types. */
export type ChartType =
  | 'bar'
  | 'line'
  | 'area'
  | 'pie'
  | 'donut'
  | 'scatter'
  | 'heatmap'
  | 'histogram'
  | 'table'
  | 'gauge'
  | 'funnel'
  | 'boxplot';

/**
 * A query history entry.
 */
export interface HistoryEntry {
  id: string;
  question: string;
  sql: string;
  params: unknown[];
  timestamp: string;
  executionMs?: number;
  rowCount?: number;
  success: boolean;
  error?: string;
  dialect: SQLDialect;
}

/**
 * Options for the `NLSQLManager`.
 */
export interface NLSQLManagerOptions {
  /** Database schema. */
  schema: DatabaseSchema;
  /** LLM function for SQL generation / parsing. Optional — falls back to rules. */
  llm?: NLSQLLLM;
  /** Max history entries to retain. Default `100`. */
  maxHistory?: number;
  /** Default LIMIT for SELECT without one. Default `100`. */
  defaultLimit?: number;
  /** Allow DML (INSERT/UPDATE/DELETE)? Default `false`. */
  allowDML?: boolean;
}

/** LLM interface (caller-supplied). */
export interface NLSQLLLM {
  /** Generate SQL from a question + schema summary. */
  generateSQL(question: string, schemaSummary: string): Promise<{ sql: string; explanation: string }>;
  /** Parse a question into structured intent. */
  parseQuestion(question: string, schemaSummary: string): Promise<ParsedQuery>;
}

/**
 * Full NL→SQL result.
 */
export interface NLSQLResult {
  question: string;
  generation: GenerationResult;
  validation: ValidationResult;
  execution?: ExecutionResult;
  charts: ChartSuggestion[];
  historyId: string;
}
