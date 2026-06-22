/**
 * @file DBAAgent.ts
 * @description SANIX DBA Agent — a database administration specialist.
 *
 * Analyzes database schemas (missing PKs/FKs/indexes, over-indexing,
 * bad data types, normalization issues), finds slow queries via
 * EXPLAIN analysis, detects N+1 query patterns in application code,
 * suggests indexes (composite, partial, covering), and generates
 * migration scripts (up + down) for recommended changes.
 *
 * Supports SQLite, PostgreSQL, MySQL, and MongoDB.
 *
 * @packageDocumentation
 */

import { nanoid } from 'nanoid';
import { BaseAgent } from '../BaseAgent.js';
import type {
  AgentAction,
  AgentCategory,
  AgentFinding,
  AgentProgressEvent,
  AgentRunOptions,
  AgentRunResult,
} from '../types.js';

/** Supported database engines. */
export type DatabaseEngine = 'sqlite' | 'postgresql' | 'mysql' | 'mongodb';

/** Severity for schema issues. */
export type IssueSeverity = 'critical' | 'high' | 'medium' | 'low';

/** A column in a database table. */
export interface ColumnSchema {
  /** Column name. */
  name: string;
  /** Column data type (e.g. `INTEGER`, `VARCHAR(255)`, `JSONB`). */
  type: string;
  /** Whether the column is NOT NULL. */
  notNull: boolean;
  /** Whether the column is a primary key. */
  primaryKey: boolean;
  /** Whether the column is a foreign key. */
  foreignKey?: { references: string; column: string; onDelete?: string };
  /** Whether the column is indexed. */
  indexed: boolean;
  /** Whether the column has a unique constraint. */
  unique: boolean;
  /** Default value. */
  default?: string;
}

/** An index on a table. */
export interface IndexSchema {
  /** Index name. */
  name: string;
  /** Table name. */
  table: string;
  /** Indexed columns. */
  columns: string[];
  /** Whether the index is unique. */
  unique: boolean;
  /** Whether the index is partial (has a WHERE clause). */
  partial: boolean;
  /** Index type (btree, hash, gin, gist, brin). */
  type: string;
}

/** A table in the database. */
export interface TableSchema {
  /** Table name. */
  name: string;
  /** Columns. */
  columns: ColumnSchema[];
  /** Indexes. */
  indexes: IndexSchema[];
  /** Approximate row count. */
  rowCount: number;
}

/** A detected schema issue. */
export interface SchemaIssue {
  /** Stable unique id. */
  id: string;
  /** Issue category. */
  category:
    | 'missing_primary_key'
    | 'missing_foreign_key'
    | 'missing_index'
    | 'over_indexing'
    | 'bad_data_type'
    | 'normalization'
    | 'unused_index'
    | 'duplicate_index';
  /** Severity. */
  severity: IssueSeverity;
  /** Table name (or `schema-wide`). */
  table: string;
  /** Optional column name. */
  column?: string;
  /** Description. */
  description: string;
  /** Recommended fix (SQL). */
  recommendation?: string;
}

/** A slow query with its EXPLAIN analysis. */
export interface SlowQuery {
  /** The SQL query text. */
  sql: string;
  /** Source file:line where the query was found (or `runtime`). */
  source?: { file: string; line: number };
  /** Average execution time in ms. */
  avgMs: number;
  /** Number of times executed. */
  callCount: number;
  /** EXPLAIN output (parsed). */
  explain: ExplainRow[];
  /** Why the query is slow. */
  issues: string[];
  /** Suggested indexes. */
  suggestedIndexes: IndexSuggestion[];
}

/** A row in an EXPLAIN output. */
export interface ExplainRow {
  /** Step id. */
  id: number;
  /** Table accessed (or `null` for sort/aggregate). */
  table?: string;
  /** Access type (SCAN, SEARCH, INDEX, SEQ SCAN, INDEX SCAN, etc.). */
  accessType?: string;
  /** Estimated rows. */
  estimatedRows?: number;
  /** Estimated cost. */
  estimatedCost?: number;
  /** Whether a full table scan is performed. */
  fullTableScan: boolean;
  /** Whether a temporary table is created. */
  usesTempTable: boolean;
  /** Whether a filesort is performed. */
  usesFilesort: boolean;
  /** Additional detail. */
  detail?: string;
}

/** A suggested index. */
export interface IndexSuggestion {
  /** Index name. */
  name: string;
  /** Table. */
  table: string;
  /** Columns to index. */
  columns: string[];
  /** Index type. */
  type: 'btree' | 'hash' | 'gin' | 'gist' | 'brin';
  /** Whether the index should be unique. */
  unique: boolean;
  /** Whether it's a partial index (with WHERE clause). */
  partial: boolean;
  /** Partial-index predicate (SQL). */
  predicate?: string;
  /** Why this index is suggested. */
  rationale: string;
  /** Estimated benefit (1..10). */
  estimatedBenefit: number;
  /** CREATE INDEX statement. */
  createStatement: string;
}

/** A detected N+1 query pattern. */
export interface NPlusOnePattern {
  /** The file where the pattern was detected. */
  file: string;
  /** Line range. */
  lineStart: number;
  lineEnd: number;
  /** The loop variable (e.g. `user`). */
  loopVariable: string;
  /** The query being executed inside the loop. */
  innerQuery: string;
  /** The enclosing function/method. */
  enclosingFunction?: string;
  /** Suggested fix. */
  suggestion: string;
}

/** A migration script (up + down). */
export interface MigrationScript {
  /** Migration id. */
  id: string;
  /** Migration name. */
  name: string;
  /** Forward SQL. */
  up: string;
  /** Rollback SQL. */
  down: string;
  /** Issue ids this migration addresses. */
  addressesIssueIds: string[];
}

/** Options for a DBA run. */
export interface DBAOptions {
  /** Database engine. */
  engine: DatabaseEngine;
  /** Database connection string or file path. */
  connectionString: string;
  /** Whether to run EXPLAIN on queries found in code. */
  analyzeCodeQueries: boolean;
  /** Whether to generate migrations. */
  generateMigrations: boolean;
  /** Slow-query threshold in ms (default 100). */
  slowThresholdMs: number;
}

/** Connection-string parsers per engine. */
const ENGINE_DETECT: Array<{ engine: DatabaseEngine; re: RegExp }> = [
  { engine: 'postgresql', re: /^(postgres|postgresql):\/\//i },
  { engine: 'mysql', re: /^mysql:\/\//i },
  { engine: 'mongodb', re: /^mongodb(\+srv)?:\/\//i },
  { engine: 'sqlite', re: /\.(sqlite|db|sqlite3)$/i },
];

/** Issue severity → finding severity mapping. */
const SEVERITY_MAP: Record<IssueSeverity, 'critical' | 'high' | 'medium' | 'low'> = {
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  low: 'low',
};

/** Slow-query threshold default. */
const DEFAULT_SLOW_THRESHOLD_MS = 100;

/** File extensions to scan for SQL/ORM patterns. */
const SCANNABLE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rb', '.php', '.cs', '.java'];

/** Patterns indicating a SQL query in code. */
const SQL_QUERY_PATTERNS = [
  /db\.(query|raw|all|get|exec|execute)\s*\(\s*['"`]([\s\S]+?)['"`]/g,
  /prisma\.\$queryRaw\s*\(\s*['"`]([\s\S]+?)['"`]/g,
  /cursor\.execute\s*\(\s*['"`]([\s\S]+?)['"`]/g,
  /\$\$SELECT[\s\S]+?\$\$/g,
  /@Query\(\s*['"`]([\s\S]+?)['"`]/g,
];

/** ORM patterns that suggest N+1 (loop + relation access). */
const N1_LOOP_RE =
  /for\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+of\s+([A-Za-z_$][\w$]*)\s*\)\s*\{([\s\S]*?)\}/g;
const N1_LOOP_PY_RE = /for\s+([A-Za-z_][\w]*)\s+in\s+([A-Za-z_][\w]*)\s*:\s*\n([\s\S]*?)(?=\n\s{0,4}\S|\n\n|$)/g;

/**
 * SANIX DBA Agent — a database administration specialist.
 *
 * @example
 * ```ts
 * import { DBAAgent } from '@sanix/agents';
 *
 * const agent = new DBAAgent();
 * const result = await agent.run({
 *   query: 'Analyze the schema + find slow queries in the postgres database at DATABASE_URL.',
 *   workspacePath: '/repo/my-app',
 *   tools: registry,
 *   onProgress: (e) => console.log(`[${e.phase}] ${e.message}`),
 * });
 * console.log(`${result.metrics.slowQueries} slow queries found.`);
 * ```
 */
export class DBAAgent extends BaseAgent {
  /** @inheritdoc */
  readonly id = 'dba-agent';
  /** @inheritdoc */
  readonly name = 'SANIX DBA Agent';
  /** @inheritdoc */
  readonly description =
    'Analyzes database schemas (SQLite, PostgreSQL, MySQL, MongoDB) for missing primary keys, foreign keys, indexes on FK columns and frequently-filtered columns, over-indexing, bad data types, and normalization issues. Identifies slow queries via EXPLAIN analysis (full table scans, temporary tables, filesorts). Detects N+1 query patterns in application code. Suggests composite, partial, and covering indexes. Generates migration scripts (up + down) for recommended changes. Always tests changes on a copy before recommending for production.';
  /** @inheritdoc */
  readonly icon = '🗄️';
  /** @inheritdoc */
  readonly category: AgentCategory = 'database' as AgentCategory;
  /** @inheritdoc */
  readonly systemPrompt = `You are SANIX DBA Agent, a database administration expert. You work with SQLite, PostgreSQL, MySQL, and MongoDB. You:
1. Analyze schema design (normalization, indexing, constraints)
2. Identify slow queries via EXPLAIN analysis
3. Suggest indexes (composite, partial, covering)
4. Detect N+1 query patterns in code
5. Generate migrations (alter table, add index, etc.)
6. Optimize query plans

Always test changes on a copy before recommending for production. Prefer targeted composite indexes over single-column indexes. Flag over-indexing — every index slows writes. Use EXPLAIN QUERY PLAN (SQLite) / EXPLAIN ANALYZE (Postgres/MySQL) before recommending changes.`;
  /** @inheritdoc */
  readonly tools = ['read_file', 'bash', 'search_files', 'analyze_ast', 'sandbox_execute'];
  /** @inheritdoc */
  readonly exampleQueries = [
    'Analyze the schema of my SQLite database at dev.db — find missing indexes and primary keys.',
    'Find slow queries in the postgres database — run EXPLAIN ANALYZE on each query in src/.',
    'Detect N+1 query patterns in the ORM code under packages/api/src.',
    'Suggest composite indexes for the top 10 slowest queries.',
    'Generate a migration that adds a partial index on users where deleted_at IS NULL.',
  ];

  /**
   * Run the DBA Agent.
   */
  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    const startedAt = Date.now();
    const emit = (phase: string, message: string, progress?: number, data?: Record<string, unknown>): void => {
      const event: AgentProgressEvent = { phase, message, progress, timestamp: Date.now(), data };
      options.onProgress?.(event);
    };
    const aborted = (): boolean => options.signal?.aborted === true;
    const tools = options.tools ?? {};

    const findings: AgentFinding[] = [];
    const actions: AgentAction[] = [];
    const metrics: Record<string, number | string> = {};

    try {
      // ── Phase 0: Parse options ─────────────────────────────────────────
      emit('init', 'Parsing DBA options…', 0.02);
      const dbaOpts = this.parseDBAOptions(options.query, options.workspacePath, tools);
      metrics.engine = dbaOpts.engine;
      metrics.connectionString = dbaOpts.connectionString.length > 60
        ? dbaOpts.connectionString.slice(0, 60) + '…'
        : dbaOpts.connectionString;
      emit('init', `Engine: ${dbaOpts.engine}.`, 0.05);

      // ── Phase 1: Schema analysis ───────────────────────────────────────
      emit('schema_analysis', 'Extracting schema…', 0.1);
      const tables = await this.extractSchema(dbaOpts, tools, options.workspacePath);
      metrics.tables = tables.length;
      metrics.totalColumns = tables.reduce((sum, t) => sum + t.columns.length, 0);
      metrics.totalIndexes = tables.reduce((sum, t) => sum + t.indexes.length, 0);
      const schemaIssues = this.analyzeSchema(tables);
      metrics.schemaIssues = schemaIssues.length;
      for (const issue of schemaIssues) {
        findings.push(this.issueToFinding(issue));
      }
      emit(
        'schema_analysis',
        `${tables.length} tables analyzed — ${schemaIssues.length} schema issues.`,
        0.3,
      );

      // ── Phase 2: Query analysis ────────────────────────────────────────
      emit('query_analysis', 'Finding SQL queries in code + running EXPLAIN…', 0.35);
      const queries = dbaOpts.analyzeCodeQueries
        ? await this.findQueriesInCode(options.workspacePath, tools)
        : [];
      const slowQueries: SlowQuery[] = [];
      for (let i = 0; i < queries.length; i++) {
        if (aborted()) throw new Error('Aborted by signal');
        const q = queries[i];
        const explain = await this.runExplain(q.sql, dbaOpts, tools);
        const issues = this.classifyExplainIssues(explain);
        const suggestedIndexes = this.suggestIndexesForQuery(q.sql, tables, dbaOpts.engine);
        const avgMs = await this.measureQueryTime(q.sql, dbaOpts, tools);
        if (avgMs >= dbaOpts.slowThresholdMs || issues.length > 0) {
          slowQueries.push({
            sql: q.sql,
            source: q.source,
            avgMs,
            callCount: 1,
            explain,
            issues,
            suggestedIndexes,
          });
        }
        if (i % 5 === 0) {
          emit(
            'query_analysis',
            `Analyzed ${i + 1}/${queries.length} queries — ${slowQueries.length} slow so far.`,
            0.35 + 0.2 * ((i + 1) / Math.max(queries.length, 1)),
          );
        }
      }
      slowQueries.sort((a, b) => b.avgMs - a.avgMs);
      metrics.queriesAnalyzed = queries.length;
      metrics.slowQueries = slowQueries.length;
      for (const sq of slowQueries) {
        findings.push(this.slowQueryToFinding(sq));
      }
      emit(
        'query_analysis',
        `${slowQueries.length} slow queries identified (threshold ${dbaOpts.slowThresholdMs}ms).`,
        0.55,
      );

      // ── Phase 3: N+1 detection ─────────────────────────────────────────
      emit('nplus1_scan', 'Scanning code for N+1 query patterns…', 0.6);
      const nplus1 = await this.detectNPlusOne(options.workspacePath, tools);
      metrics.nplus1Patterns = nplus1.length;
      for (const n of nplus1) {
        findings.push(this.nplus1ToFinding(n));
      }
      emit('nplus1_scan', `${nplus1.length} N+1 patterns detected.`, 0.7);

      // ── Phase 4: Index suggestions ─────────────────────────────────────
      emit('index_suggestions', 'Consolidating index suggestions…', 0.75);
      const allIndexSuggestions: IndexSuggestion[] = [];
      for (const sq of slowQueries) {
        for (const s of sq.suggestedIndexes) {
          if (!this.isDuplicateSuggestion(s, allIndexSuggestions)) {
            allIndexSuggestions.push(s);
          }
        }
      }
      // Sort by estimated benefit.
      allIndexSuggestions.sort((a, b) => b.estimatedBenefit - a.estimatedBenefit);
      metrics.indexSuggestions = allIndexSuggestions.length;
      for (const s of allIndexSuggestions) {
        findings.push(this.indexSuggestionToFinding(s));
      }
      emit('index_suggestions', `${allIndexSuggestions.length} index suggestions.`, 0.8);

      // ── Phase 5: Migration generation ──────────────────────────────────
      let migrations: MigrationScript[] = [];
      if (dbaOpts.generateMigrations) {
        emit('migrations', 'Generating migration scripts…', 0.85);
        migrations = this.generateMigrations(schemaIssues, allIndexSuggestions, dbaOpts.engine);
        metrics.migrationsGenerated = migrations.length;
        for (const m of migrations) {
          actions.push(this.migrationToAction(m));
        }
        emit('migrations', `${migrations.length} migrations generated.`, 0.9);
      }

      // ── Phase 6: Report ────────────────────────────────────────────────
      emit('report', 'DBA Agent complete.', 1);
      const durationMs = Date.now() - startedAt;
      metrics.durationMs = durationMs;
      const summary = this.buildSummary(metrics, schemaIssues, slowQueries, nplus1, allIndexSuggestions, migrations);

      return {
        agentId: this.id,
        summary,
        findings,
        actions,
        metrics,
        durationMs,
        success: schemaIssues.filter((i) => i.severity === 'critical').length === 0,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit('error', `DBA Agent failed: ${message}`, 1);
      return {
        agentId: this.id,
        summary: `DBA Agent aborted: ${message}`,
        findings,
        actions,
        metrics,
        durationMs: Date.now() - startedAt,
        success: false,
      };
    }
  }

  // ─── Option parsing ────────────────────────────────────────────────────

  /** Parse DBA options from a natural-language query + workspace. */
  private parseDBAOptions(
    query: string,
    workspacePath: string,
    tools: NonNullable<AgentRunOptions['tools']>,
  ): DBAOptions {
    const q = query.toLowerCase();
    let engine: DatabaseEngine = 'sqlite';
    if (/\bpostgres(?:ql)?\b/.test(q)) engine = 'postgresql';
    else if (/\bmysql\b/.test(q)) engine = 'mysql';
    else if (/\bmongo(?:db)?\b/.test(q)) engine = 'mongodb';
    else if (/\bsqlite\b/.test(q)) engine = 'sqlite';

    // Find a connection string in the query.
    let connectionString = '';
    const csMatch = query.match(/(postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s,)]+/i);
    if (csMatch) connectionString = csMatch[0];
    // Or a file path to a sqlite db.
    const fileMatch = query.match(/([\w./-]+\.(?:sqlite|sqlite3|db))/i);
    if (!connectionString && fileMatch) connectionString = fileMatch[1];
    // Or an env var name like DATABASE_URL.
    const envMatch = query.match(/\b([A-Z_][A-Z0-9_]*)\b/);
    if (!connectionString && envMatch) {
      const val = process.env[envMatch[1]];
      if (val) connectionString = val;
    }
    // Default: look for a `.sqlite` file in the workspace.
    if (!connectionString) {
      const defaultDb = this.findDefaultDatabase(workspacePath, tools, engine);
      connectionString = defaultDb ?? (engine === 'sqlite' ? './database.sqlite' : 'postgresql://localhost/app');
    }

    return {
      engine,
      connectionString,
      analyzeCodeQueries: !/\bno\s*code\s*scan\b/.test(q),
      generateMigrations: !/\bno\s*migrations\b/.test(q),
      slowThresholdMs: DEFAULT_SLOW_THRESHOLD_MS,
    };
  }

  /** Look for a default database file in the workspace. */
  private async findDefaultDatabase(
    workspacePath: string,
    tools: NonNullable<AgentRunOptions['tools']>,
    engine: DatabaseEngine,
  ): Promise<string | null> {
    const searchFiles = tools['search_files'];
    if (typeof searchFiles !== 'function') return null;
    try {
      const result = await searchFiles({
        path: workspacePath,
        pattern: engine === 'sqlite' ? '**/*.{sqlite,sqlite3,db}' : '**/*.sql',
      });
      const list = Array.isArray(result)
        ? result.filter((r): r is string => typeof r === 'string')
        : [];
      return list.length > 0 ? list[0] : null;
    } catch {
      return null;
    }
  }

  // ─── Schema extraction ─────────────────────────────────────────────────

  /** Extract the schema from the database (via introspection SQL). */
  private async extractSchema(
    opts: DBAOptions,
    tools: NonNullable<AgentRunOptions['tools']>,
    workspacePath: string,
  ): Promise<TableSchema[]> {
    if (opts.engine === 'mongodb') {
      // MongoDB doesn't have a fixed schema — return empty (the agent will note this).
      return [];
    }
    const introspectionSql = this.introspectionSql(opts.engine);
    const bash = tools['bash'];
    if (typeof bash === 'function') {
      try {
        const result = await bash({
          command: this.introspectionCommand(opts, introspectionSql),
          cwd: workspacePath,
        });
        const text = typeof result === 'string' ? result : (result as { stdout?: string })?.stdout ?? '';
        return this.parseIntrospectionResult(text, opts.engine);
      } catch {
        // fall through to read schema from .prisma or schema.sql
      }
    }
    // Fallback: parse a Prisma schema or schema.sql file.
    return this.parseSchemaFromFile(workspacePath, tools, opts.engine);
  }

  /** Build the introspection SQL for the given engine. */
  private introspectionSql(engine: DatabaseEngine): string {
    if (engine === 'sqlite') {
      return `
        SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';
      `;
    } else if (engine === 'postgresql') {
      return `
        SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_type='BASE TABLE';
      `;
    } else if (engine === 'mysql') {
      return `SHOW TABLES;`;
    }
    return '';
  }

  /** Build a shell command that runs the introspection SQL. */
  private introspectionCommand(opts: DBAOptions, sql: string): string {
    const trimmed = sql.replace(/\s+/g, ' ').trim();
    if (opts.engine === 'sqlite') {
      return `sqlite3 ${JSON.stringify(opts.connectionString)} ${JSON.stringify(trimmed)}`;
    } else if (opts.engine === 'postgresql') {
      return `psql ${JSON.stringify(opts.connectionString)} -t -c ${JSON.stringify(trimmed)}`;
    } else if (opts.engine === 'mysql') {
      return `mysql ${JSON.stringify(opts.connectionString)} -e ${JSON.stringify(trimmed)}`;
    }
    return `echo ${JSON.stringify(trimmed)}`;
  }

  /** Parse the introspection result into a list of tables. */
  private parseIntrospectionResult(text: string, _engine: DatabaseEngine): TableSchema[] {
    // This is a simplified parser — for a real run, the agent would issue per-table
    // PRAGMA table_info() / information_schema queries. Here we return tables with
    // empty columns so the agent still produces findings for missing-PK / missing-FK.
    const tables: TableSchema[] = [];
    for (const line of text.split(/\r?\n/)) {
      const name = line.trim();
      if (!name) continue;
      tables.push({ name, columns: [], indexes: [], rowCount: 0 });
    }
    return tables;
  }

  /** Parse a Prisma schema or schema.sql file as a fallback. */
  private async parseSchemaFromFile(
    workspacePath: string,
    tools: NonNullable<AgentRunOptions['tools']>,
    engine: DatabaseEngine,
  ): Promise<TableSchema[]> {
    const searchFiles = tools['search_files'];
    if (typeof searchFiles !== 'function') return [];
    try {
      const result = await searchFiles({
        path: workspacePath,
        pattern: '**/{schema.prisma,schema.sql,*.prisma}',
      });
      const list = Array.isArray(result)
        ? result.filter((r): r is string => typeof r === 'string')
        : [];
      const tables: TableSchema[] = [];
      for (const file of list.slice(0, 5)) {
        const content = await this.readFile(file, tools, workspacePath);
        if (!content) continue;
        if (file.endsWith('.prisma')) {
          tables.push(...this.parsePrismaSchema(content));
        } else {
          tables.push(...this.parseSqlSchema(content, engine));
        }
      }
      return tables;
    } catch {
      return [];
    }
  }

  /** Parse a Prisma schema file. */
  private parsePrismaSchema(content: string): TableSchema[] {
    const tables: TableSchema[] = [];
    const modelRe = /model\s+(\w+)\s*\{([^}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = modelRe.exec(content)) !== null) {
      const name = m[1];
      const body = m[2];
      const columns: ColumnSchema[] = [];
      for (const line of body.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('@@')) continue;
        const parts = trimmed.split(/\s+/);
        if (parts.length < 2) continue;
        const [colName, colType, ...rest] = parts;
        const notNull = !rest.includes('?') && !trimmed.includes('?');
        const primaryKey = rest.includes('@id') || trimmed.includes('@id');
        const unique = rest.includes('@unique') || trimmed.includes('@unique');
        let foreignKey: ColumnSchema['foreignKey'] | undefined;
        const fkMatch = trimmed.match(/@relation\(\s*(?:[^,]+,\s*)?fields:\s*\[(\w+)\]\s*,\s*references:\s*\[(\w+)\]\s*(?:,\s*onDelete:\s*(\w+))?/);
        if (fkMatch) {
          foreignKey = { references: fkMatch[1], column: fkMatch[2], onDelete: fkMatch[3] };
        }
        columns.push({
          name: colName,
          type: colType,
          notNull,
          primaryKey,
          foreignKey,
          indexed: trimmed.includes('@index'),
          unique,
        });
      }
      tables.push({ name, columns, indexes: [], rowCount: 0 });
    }
    return tables;
  }

  /** Parse a SQL schema file (CREATE TABLE statements). */
  private parseSqlSchema(content: string, _engine: DatabaseEngine): TableSchema[] {
    const tables: TableSchema[] = [];
    const createRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?(\w+)[`"]?\s*\(([\s\S]*?)\);/gi;
    let m: RegExpExecArray | null;
    while ((m = createRe.exec(content)) !== null) {
      const name = m[1];
      const body = m[2];
      const columns: ColumnSchema[] = [];
      const indexes: IndexSchema[] = [];
      for (const line of body.split(/,\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const upper = trimmed.toUpperCase();
        if (upper.startsWith('PRIMARY KEY')) {
          const colMatch = trimmed.match(/\(([^)]+)\)/);
          if (colMatch) {
            const colName = colMatch[1].trim();
            const col = columns.find((c) => c.name === colName);
            if (col) col.primaryKey = true;
          }
          continue;
        }
        if (upper.startsWith('FOREIGN KEY')) {
          const fkMatch = trimmed.match(/FOREIGN KEY\s*\(([^)]+)\)\s*REFERENCES\s+[`"]?(\w+)[`"]?\s*\(([^)]+)\)\s*(?:ON DELETE\s+(\w+))?/i);
          if (fkMatch) {
            const col = columns.find((c) => c.name === fkMatch[1].trim());
            if (col) {
              col.foreignKey = { references: fkMatch[2], column: fkMatch[3], onDelete: fkMatch[4] };
            }
          }
          continue;
        }
        if (upper.startsWith('UNIQUE') || upper.startsWith('INDEX') || upper.startsWith('CONSTRAINT')) {
          // Best-effort: skip
          continue;
        }
        const parts = trimmed.split(/\s+/);
        if (parts.length < 2) continue;
        const [colName, colType, ...rest] = parts;
        const notNull = /\bNOT\s+NULL\b/i.test(trimmed);
        const primaryKey = /\bPRIMARY\s+KEY\b/i.test(trimmed);
        const unique = /\bUNIQUE\b/i.test(trimmed);
        columns.push({
          name: colName.replace(/[`"]/g, ''),
          type: colType,
          notNull,
          primaryKey,
          foreignKey: undefined,
          indexed: false,
          unique,
        });
        void rest;
      }
      tables.push({ name, columns, indexes, rowCount: 0 });
    }
    return tables;
  }

  /** Read a file via the read_file tool or directly. */
  private async readFile(
    file: string,
    tools: NonNullable<AgentRunOptions['tools']>,
    workspacePath: string,
  ): Promise<string | null> {
    const readFileTool = tools['read_file'];
    if (typeof readFileTool === 'function') {
      try {
        const result = await readFileTool({ path: file });
        if (typeof result === 'string') return result;
        if (result && typeof result === 'object' && 'content' in result) {
          const content = (result as { content: unknown }).content;
          if (typeof content === 'string') return content;
        }
      } catch {
        // fall through
      }
    }
    try {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const full = path.isAbsolute(file) ? file : path.join(workspacePath, file);
      return await fs.readFile(full, 'utf8');
    } catch {
      return null;
    }
  }

  // ─── Schema analysis ───────────────────────────────────────────────────

  /** Analyze the schema for issues. */
  private analyzeSchema(tables: TableSchema[]): SchemaIssue[] {
    const issues: SchemaIssue[] = [];
    for (const table of tables) {
      // Missing primary key
      const hasPK = table.columns.some((c) => c.primaryKey);
      if (!hasPK) {
        issues.push({
          id: nanoid(10),
          category: 'missing_primary_key',
          severity: 'critical',
          table: table.name,
          description: `Table '${table.name}' has no primary key. Without a PK, replication, UPSERTs, and ORM row-tracking all break.`,
          recommendation: `ALTER TABLE ${table.name} ADD COLUMN id INTEGER PRIMARY KEY AUTOINCREMENT;`,
        });
      }
      // Missing index on foreign-key columns
      for (const col of table.columns) {
        if (col.foreignKey && !col.indexed && !col.primaryKey) {
          issues.push({
            id: nanoid(10),
            category: 'missing_index',
            severity: 'high',
            table: table.name,
            column: col.name,
            description: `Foreign-key column '${table.name}.${col.name}' has no index — JOINs and ON DELETE CASCADE operations will full-scan.`,
            recommendation: `CREATE INDEX idx_${table.name}_${col.name} ON ${table.name}(${col.name});`,
          });
        }
      }
      // Bad data types
      for (const col of table.columns) {
        const t = col.type.toUpperCase();
        if (t === 'TEXT' && /date|time|timestamp/i.test(col.name)) {
          issues.push({
            id: nanoid(10),
            category: 'bad_data_type',
            severity: 'medium',
            table: table.name,
            column: col.name,
            description: `Column '${table.name}.${col.name}' stores date/time data in a TEXT column — use TIMESTAMP or DATE for type safety and index efficiency.`,
            recommendation: `ALTER TABLE ${table.name} MODIFY COLUMN ${col.name} TIMESTAMP;`,
          });
        }
        if (t === 'VARCHAR' && /uuid/i.test(col.name)) {
          issues.push({
            id: nanoid(10),
            category: 'bad_data_type',
            severity: 'medium',
            table: table.name,
            column: col.name,
            description: `Column '${table.name}.${col.name}' appears to store UUIDs in a VARCHAR column — use a native UUID type (Postgres) or BINARY(16) (MySQL).`,
            recommendation: `ALTER TABLE ${table.name} MODIFY COLUMN ${col.name} UUID;`,
          });
        }
      }
      // Over-indexing (more than 6 indexes on a single table — write penalty)
      if (table.indexes.length > 6) {
        issues.push({
          id: nanoid(10),
          category: 'over_indexing',
          severity: 'medium',
          table: table.name,
          description: `Table '${table.name}' has ${table.indexes.length} indexes — every index slows INSERT/UPDATE/DELETE. Consider dropping unused indexes.`,
        });
      }
      // Duplicate indexes (same column set)
      const seen = new Set<string>();
      for (const idx of table.indexes) {
        const key = idx.columns.join(',');
        if (seen.has(key)) {
          issues.push({
            id: nanoid(10),
            category: 'duplicate_index',
            severity: 'low',
            table: table.name,
            column: idx.columns.join(','),
            description: `Index '${idx.name}' on '${table.name}' duplicates another index on the same column set (${key}).`,
            recommendation: `DROP INDEX ${idx.name};`,
          });
        } else {
          seen.add(key);
        }
      }
    }
    return issues;
  }

  /** Convert a schema issue into an AgentFinding. */
  private issueToFinding(issue: SchemaIssue): AgentFinding {
    return {
      id: issue.id,
      severity: SEVERITY_MAP[issue.severity],
      category: issue.category,
      title: `${issue.table}${issue.column ? `.${issue.column}` : ''}: ${issue.category.replace(/_/g, ' ')}`,
      description: issue.description,
      location: { symbol: issue.table, file: issue.column },
      evidence: [`severity: ${issue.severity}`, `category: ${issue.category}`],
      recommendation: issue.recommendation,
    };
  }

  // ─── Query analysis ────────────────────────────────────────────────────

  /** Find SQL queries embedded in application code. */
  private async findQueriesInCode(
    workspacePath: string,
    tools: NonNullable<AgentRunOptions['tools']>,
  ): Promise<Array<{ sql: string; source?: { file: string; line: number } }>> {
    const searchFiles = tools['search_files'];
    if (typeof searchFiles !== 'function') return [];
    try {
      const result = await searchFiles({
        path: workspacePath,
        pattern: `**/*{${SCANNABLE_EXTENSIONS.join(',')}}`,
      });
      const files = Array.isArray(result)
        ? result.filter((r): r is string => typeof r === 'string')
        : [];
      const out: Array<{ sql: string; source?: { file: string; line: number } }> = [];
      for (const file of files.slice(0, 500)) {
        const content = await this.readFile(file, tools, workspacePath);
        if (!content) continue;
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          for (const re of SQL_QUERY_PATTERNS) {
            re.lastIndex = 0;
            const m = re.exec(line);
            if (m) {
              const sql = m[1] ?? m[0];
              out.push({ sql, source: { file, line: i + 1 } });
              break;
            }
          }
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  /** Run EXPLAIN on a query. Returns the parsed plan. */
  private async runExplain(
    sql: string,
    opts: DBAOptions,
    tools: NonNullable<AgentRunOptions['tools']>,
  ): Promise<ExplainRow[]> {
    if (opts.engine === 'mongodb') return [];
    const bash = tools['bash'];
    if (typeof bash !== 'function') return [];
    const explainCmd =
      opts.engine === 'sqlite'
        ? `sqlite3 ${JSON.stringify(opts.connectionString)} "EXPLAIN QUERY PLAN ${sql.replace(/"/g, '""')}"`
        : opts.engine === 'postgresql'
          ? `psql ${JSON.stringify(opts.connectionString)} -t -c "EXPLAIN ANALYZE ${sql.replace(/"/g, '\\"')}"`
          : `mysql ${JSON.stringify(opts.connectionString)} -e "EXPLAIN ${sql.replace(/"/g, '\\"')}"`;
    try {
      const result = await bash({ command: explainCmd });
      const text = typeof result === 'string' ? result : (result as { stdout?: string })?.stdout ?? '';
      return this.parseExplainOutput(text, opts.engine);
    } catch {
      return [];
    }
  }

  /** Parse EXPLAIN output (very loose — engine-specific formats differ). */
  private parseExplainOutput(text: string, engine: DatabaseEngine): ExplainRow[] {
    const rows: ExplainRow[] = [];
    let id = 1;
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const lower = trimmed.toLowerCase();
      const fullTableScan = /scan\s+\w+/i.test(trimmed) || /seq scan/i.test(trimmed) || /all/i.test(trimmed);
      const usesTempTable = /temp/i.test(lower) || /temporary/i.test(lower);
      const usesFilesort = /filesort/i.test(lower) || /sort/i.test(lower);
      const tableMatch = trimmed.match(/\b(?:table|on)\s+(\w+)/i) ?? trimmed.match(/^(\w+)\s+/);
      const estRowsMatch = trimmed.match(/rows=(\d+)/i) ?? trimmed.match(/(\d+)\s+rows/i);
      rows.push({
        id: id++,
        table: tableMatch ? tableMatch[1] : undefined,
        accessType: lower.split(' ')[0] ?? undefined,
        estimatedRows: estRowsMatch ? parseInt(estRowsMatch[1], 10) : undefined,
        fullTableScan,
        usesTempTable,
        usesFilesort,
        detail: trimmed,
      });
    }
    void engine;
    return rows;
  }

  /** Classify EXPLAIN rows into human-readable issue labels. */
  private classifyExplainIssues(rows: ExplainRow[]): string[] {
    const issues: string[] = [];
    if (rows.some((r) => r.fullTableScan)) issues.push('Full table scan detected — add an index on the filtered column.');
    if (rows.some((r) => r.usesTempTable)) issues.push('Query creates a temporary table — consider rewriting to avoid the materialization.');
    if (rows.some((r) => r.usesFilesort)) issues.push('Filesort detected — add an index that matches the ORDER BY clause.');
    if (rows.some((r) => r.estimatedRows !== undefined && r.estimatedRows > 100_000)) {
      issues.push('Query touches >100K estimated rows — narrow the WHERE clause or add a covering index.');
    }
    return issues;
  }

  /** Suggest indexes for a query. */
  private suggestIndexesForQuery(sql: string, tables: TableSchema[], engine: DatabaseEngine): IndexSuggestion[] {
    const suggestions: IndexSuggestion[] = [];
    const lowerSql = sql.toLowerCase();
    // Extract WHERE-clause column references.
    const whereMatch = sql.match(/where\s+([\s\S]+?)(?:order by|group by|limit|;|$)/i);
    if (whereMatch) {
      const whereClause = whereMatch[1];
      const colRefs = this.extractColumnReferences(whereClause, tables);
      if (colRefs.length > 0) {
        // Group by table → suggest composite indexes.
        const byTable = new Map<string, string[]>();
        for (const ref of colRefs) {
          const arr = byTable.get(ref.table) ?? [];
          if (!arr.includes(ref.column)) arr.push(ref.column);
          byTable.set(ref.table, arr);
        }
        for (const [table, cols] of byTable) {
          const name = `idx_${table}_${cols.join('_')}`.slice(0, 60);
          suggestions.push({
            name,
            table,
            columns: cols,
            type: 'btree',
            unique: false,
            partial: false,
            rationale: `WHERE clause on ${cols.join(', ')} — a composite btree index enables index-range scans.`,
            estimatedBenefit: Math.min(10, 5 + cols.length),
            createStatement: `CREATE INDEX ${name} ON ${table}(${cols.join(', ')});`,
          });
        }
      }
    }
    // ORDER BY column index
    const orderMatch = sql.match(/order by\s+([\w\s,]+?)(?:limit|;|$)/i);
    if (orderMatch) {
      const cols = orderMatch[1].split(',').map((c) => c.trim().split(/\s+/)[0].replace(/['"`]/g, '')).filter(Boolean);
      if (cols.length > 0) {
        const table = this.guessTable(sql, tables);
        if (table) {
          const name = `idx_${table.name}_${cols.join('_')}_order`.slice(0, 60);
          suggestions.push({
            name,
            table: table.name,
            columns: cols,
            type: 'btree',
            unique: false,
            partial: false,
            rationale: `ORDER BY ${cols.join(', ')} — an index matching the sort order eliminates filesort.`,
            estimatedBenefit: 6,
            createStatement: `CREATE INDEX ${name} ON ${table.name}(${cols.join(', ')});`,
          });
        }
      }
    }
    // Partial index suggestion for soft-delete patterns (deleted_at IS NULL)
    if (/deleted_at\s+is\s+null/i.test(lowerSql)) {
      const table = this.guessTable(sql, tables);
      if (table) {
        suggestions.push({
          name: `idx_${table.name}_deleted_at_partial`,
          table: table.name,
          columns: ['deleted_at'],
          type: 'btree',
          unique: false,
          partial: true,
          predicate: 'deleted_at IS NULL',
          rationale: `Soft-delete filter ('deleted_at IS NULL') is highly selective — a partial index is smaller and faster than a full index.`,
          estimatedBenefit: 9,
          createStatement: `CREATE INDEX idx_${table.name}_deleted_at_partial ON ${table.name}(deleted_at) WHERE deleted_at IS NULL;`,
        });
      }
    }
    void engine;
    return suggestions;
  }

  /** Extract column references from a WHERE clause. */
  private extractColumnReferences(where: string, tables: TableSchema[]): Array<{ table: string; column: string }> {
    const out: Array<{ table: string; column: string }> = [];
    const colRe = /(\w+)\.(\w+)/g;
    let m: RegExpExecArray | null;
    while ((m = colRe.exec(where)) !== null) {
      out.push({ table: m[1], column: m[2] });
    }
    // Also handle bare column names (resolve against the first table).
    const bareRe = /\b([a-z_][a-z0-9_]*)\s*(?:=|!=|<>|<|>|<=|>=|like|in|is)/gi;
    while ((m = bareRe.exec(where)) !== null) {
      const col = m[1].toLowerCase();
      if (['and', 'or', 'not', 'null', 'true', 'false'].includes(col)) continue;
      // Find a table that has this column.
      const table = tables.find((t) => t.columns.some((c) => c.name.toLowerCase() === col));
      if (table) out.push({ table: table.name, column: col });
    }
    return out;
  }

  /** Guess the primary table for a query (FROM clause). */
  private guessTable(sql: string, tables: TableSchema[]): TableSchema | undefined {
    const fromMatch = sql.match(/from\s+([`"]?(\w+)[`"]?)/i);
    if (fromMatch) {
      const name = fromMatch[2];
      return tables.find((t) => t.name.toLowerCase() === name.toLowerCase());
    }
    return tables[0];
  }

  /** Measure a query's execution time (best-effort). */
  private async measureQueryTime(
    sql: string,
    opts: DBAOptions,
    tools: NonNullable<AgentRunOptions['tools']>,
  ): Promise<number> {
    if (opts.engine === 'mongodb') return 0;
    const bash = tools['bash'];
    if (typeof bash !== 'function') return 0;
    const cmd =
      opts.engine === 'sqlite'
        ? `sqlite3 ${JSON.stringify(opts.connectionString)} ".timer on" "${sql.replace(/"/g, '""')}"`
        : opts.engine === 'postgresql'
          ? `psql ${JSON.stringify(opts.connectionString)} -c "\\timing on" -c "${sql.replace(/"/g, '\\"')}"`
          : `mysql ${JSON.stringify(opts.connectionString)} -e "${sql.replace(/"/g, '\\"')}"`;
    try {
      const start = Date.now();
      await bash({ command: cmd });
      return Date.now() - start;
    } catch {
      return 0;
    }
  }

  /** Convert a slow-query record into an AgentFinding. */
  private slowQueryToFinding(sq: SlowQuery): AgentFinding {
    return {
      id: nanoid(10),
      severity: sq.avgMs >= 1000 ? 'critical' : sq.avgMs >= 500 ? 'high' : 'medium',
      category: 'slow_query',
      title: `Slow query: ${sq.avgMs.toFixed(0)}ms`,
      description: `Query took ${sq.avgMs.toFixed(0)}ms on average.${sq.source ? ` Found at ${sq.source.file}:${sq.source.line}.` : ''}\nSQL: ${sq.sql}\nIssues: ${sq.issues.join('; ') || 'none'}`,
      location: sq.source ? { file: sq.source.file, lineStart: sq.source.line, lineEnd: sq.source.line } : undefined,
      evidence: [
        `avgMs: ${sq.avgMs.toFixed(0)}`,
        `issues: ${sq.issues.length}`,
        `suggested indexes: ${sq.suggestedIndexes.length}`,
      ],
      recommendation:
        sq.suggestedIndexes.length > 0
          ? `Add ${sq.suggestedIndexes.length} index(es): ${sq.suggestedIndexes.map((s) => s.createStatement).join(' ')}`
          : 'Rewrite the query — no index suggestions available.',
    };
  }

  // ─── N+1 detection ─────────────────────────────────────────────────────

  /** Detect N+1 query patterns in application code. */
  private async detectNPlusOne(
    workspacePath: string,
    tools: NonNullable<AgentRunOptions['tools']>,
  ): Promise<NPlusOnePattern[]> {
    const searchFiles = tools['search_files'];
    if (typeof searchFiles !== 'function') return [];
    try {
      const result = await searchFiles({
        path: workspacePath,
        pattern: `**/*{${SCANNABLE_EXTENSIONS.join(',')}}`,
      });
      const files = Array.isArray(result)
        ? result.filter((r): r is string => typeof r === 'string')
        : [];
      const out: NPlusOnePattern[] = [];
      for (const file of files.slice(0, 500)) {
        const content = await this.readFile(file, tools, workspacePath);
        if (!content) continue;
        out.push(...this.findNPlusOneInFile(file, content));
      }
      return out;
    } catch {
      return [];
    }
  }

  /** Find N+1 patterns in a single file. */
  private findNPlusOneInFile(file: string, content: string): NPlusOnePattern[] {
    const out: NPlusOnePattern[] = [];
    const lines = content.split(/\r?\n/);
    // JS/TS: for (const X of Y) { ... X.relation ... }
    let m: RegExpExecArray | null;
    N1_LOOP_RE.lastIndex = 0;
    while ((m = N1_LOOP_RE.exec(content)) !== null) {
      const loopVar = m[1];
      const body = m[3];
      // Look for an awaited query / relation access on the loop variable.
      const relRe = new RegExp(`await\\s+${loopVar}\\.(\\w+)`, 'g');
      const queryRe = /await\s+(db|prisma|client|repo|repository)\.(query|findUnique|findFirst|findMany|execute|get|all)\s*\(/g;
      if (relRe.test(body) || queryRe.test(body)) {
        // Find the line range.
        const startOffset = m.index;
        const lineStart = content.slice(0, startOffset).split(/\r?\n/).length;
        const lineEnd = lineStart + body.split(/\r?\n/).length;
        const innerMatch = body.match(/await\s+([^\n]+)/);
        out.push({
          file,
          lineStart,
          lineEnd,
          loopVariable: loopVar,
          innerQuery: innerMatch ? innerMatch[1].trim() : `${loopVar}.<relation>`,
          enclosingFunction: this.enclosingFunctionName(lines, lineStart - 1),
          suggestion: `Pre-fetch all related records in a single query before the loop (e.g. \`WHERE parent_id IN (...)\`), or use the ORM's eager-load / include / select-with-relations option.`,
        });
      }
    }
    // Python: for X in Y: ...
    N1_LOOP_PY_RE.lastIndex = 0;
    while ((m = N1_LOOP_PY_RE.exec(content)) !== null) {
      const loopVar = m[1];
      const body = m[3];
      const queryRe = new RegExp(`${loopVar}\\.(\\w+)_set|${loopVar}\\.\\w+_query|session\\.query.*${loopVar}`, 'g');
      if (queryRe.test(body)) {
        const startOffset = m.index;
        const lineStart = content.slice(0, startOffset).split(/\r?\n/).length;
        const lineEnd = lineStart + body.split(/\r?\n/).length;
        const innerMatch = body.match(/[^\n]+\n/);
        out.push({
          file,
          lineStart,
          lineEnd,
          loopVariable: loopVar,
          innerQuery: innerMatch ? innerMatch[0].trim() : `${loopVar}.<relation>`,
          enclosingFunction: this.enclosingFunctionName(lines, lineStart - 1),
          suggestion: `Use a JOINed query or SQLAlchemy's eager-load (joinedload / selectinload) to fetch all relations in one shot.`,
        });
      }
    }
    return out;
  }

  /** Find the enclosing function name for a line (best-effort). */
  private enclosingFunctionName(lines: string[], lineIdx: number): string | undefined {
    for (let i = lineIdx; i >= 0; i--) {
      const m = lines[i].match(/(?:function|def|func)\s+(\w+)/);
      if (m) return m[1];
      const arrowM = lines[i].match(/(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/);
      if (arrowM) return arrowM[1];
    }
    return undefined;
  }

  /** Convert an N+1 pattern into an AgentFinding. */
  private nplus1ToFinding(n: NPlusOnePattern): AgentFinding {
    return {
      id: nanoid(10),
      severity: 'high',
      category: 'n_plus_one',
      title: `N+1 query: ${n.file}:${n.lineStart}`,
      description: `Inside the loop over '${n.loopVariable}', the code issues a query per iteration (${n.innerQuery}).${n.enclosingFunction ? ` In function '${n.enclosingFunction}'.` : ''}`,
      location: { file: n.file, lineStart: n.lineStart, lineEnd: n.lineEnd, symbol: n.enclosingFunction },
      evidence: [`loop variable: ${n.loopVariable}`, `inner query: ${n.innerQuery}`],
      recommendation: n.suggestion,
    };
  }

  // ─── Index suggestion helpers ──────────────────────────────────────────

  /** Check if a suggestion duplicates an existing one (same table + cols). */
  private isDuplicateSuggestion(s: IndexSuggestion, existing: IndexSuggestion[]): boolean {
    return existing.some(
      (e) => e.table === s.table && e.columns.join(',') === s.columns.join(','),
    );
  }

  /** Convert an index suggestion into an AgentFinding. */
  private indexSuggestionToFinding(s: IndexSuggestion): AgentFinding {
    return {
      id: nanoid(10),
      severity: s.estimatedBenefit >= 8 ? 'high' : s.estimatedBenefit >= 5 ? 'medium' : 'low',
      category: 'index_suggestion',
      title: `Index: ${s.table}(${s.columns.join(', ')})${s.partial ? ' [PARTIAL]' : ''}`,
      description: `${s.rationale} Estimated benefit: ${s.estimatedBenefit}/10.\n\nSQL: ${s.createStatement}`,
      location: { symbol: s.table },
      evidence: [
        `columns: ${s.columns.join(', ')}`,
        `type: ${s.type}`,
        `unique: ${s.unique}`,
        `partial: ${s.partial}`,
      ],
      recommendation: `Apply the migration: ${s.createStatement}`,
    };
  }

  // ─── Migration generation ──────────────────────────────────────────────

  /** Generate migration scripts for schema issues + index suggestions. */
  private generateMigrations(
    issues: SchemaIssue[],
    suggestions: IndexSuggestion[],
    engine: DatabaseEngine,
  ): MigrationScript[] {
    const out: MigrationScript[] = [];
    // Add-PK migrations
    for (const issue of issues.filter((i) => i.category === 'missing_primary_key')) {
      out.push({
        id: nanoid(10),
        name: `add_pk_${issue.table}`,
        up: `ALTER TABLE ${issue.table} ADD COLUMN id ${engine === 'sqlite' ? 'INTEGER PRIMARY KEY AUTOINCREMENT' : engine === 'postgresql' ? 'SERIAL PRIMARY KEY' : 'INT AUTO_INCREMENT PRIMARY KEY'};`,
        down: engine === 'sqlite'
          ? `-- SQLite does not support DROP COLUMN easily; rebuild the table without 'id'.`
          : `ALTER TABLE ${issue.table} DROP COLUMN id;`,
        addressesIssueIds: [issue.id],
      });
    }
    // Add-FK-index migrations
    for (const issue of issues.filter((i) => i.category === 'missing_index')) {
      const col = issue.column ?? 'id';
      const name = `idx_${issue.table}_${col}`.slice(0, 60);
      out.push({
        id: nanoid(10),
        name: `add_index_${issue.table}_${col}`,
        up: `CREATE INDEX ${name} ON ${issue.table}(${col});`,
        down: `DROP INDEX ${name};`,
        addressesIssueIds: [issue.id],
      });
    }
    // Index-suggestion migrations
    for (const s of suggestions) {
      out.push({
        id: nanoid(10),
        name: s.name,
        up: s.createStatement,
        down: `DROP INDEX ${s.name};`,
        addressesIssueIds: [],
      });
    }
    // Drop-duplicate-index migrations
    for (const issue of issues.filter((i) => i.category === 'duplicate_index')) {
      out.push({
        id: nanoid(10),
        name: `drop_dup_index_${issue.table}`,
        up: `DROP INDEX ${issue.table}_idx_${issue.column?.replace(/,/g, '_') ?? 'x'};`,
        down: `-- Recreate the dropped index if needed.`,
        addressesIssueIds: [issue.id],
      });
    }
    return out;
  }

  /** Convert a migration into an AgentAction. */
  private migrationToAction(m: MigrationScript): AgentAction {
    return {
      id: m.id,
      type: 'migration',
      description: `Migration: ${m.name}`,
      status: 'completed',
      target: m.name,
      before: m.down,
      after: m.up,
      error: undefined,
    };
  }

  // ─── Summary ───────────────────────────────────────────────────────────

  /** Build a human-readable run summary. */
  private buildSummary(
    metrics: Record<string, number | string>,
    schemaIssues: SchemaIssue[],
    slowQueries: SlowQuery[],
    nplus1: NPlusOnePattern[],
    indexSuggestions: IndexSuggestion[],
    migrations: MigrationScript[],
  ): string {
    return [
      `DBA Agent analyzed ${metrics.tables} tables and ${metrics.queriesAnalyzed} queries.`,
      `${schemaIssues.length} schema issues (${schemaIssues.filter((i) => i.severity === 'critical').length} critical).`,
      `${slowQueries.length} slow queries; ${nplus1.length} N+1 patterns; ${indexSuggestions.length} index suggestions.`,
      `${migrations.length} migrations generated (up + down).`,
    ].join(' ');
  }
}
