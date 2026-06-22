/**
 * @file index.ts
 * @description Barrel re-export for `@sanix/nlsql`.
 *
 * @packageDocumentation
 */

export {
  NLSQLManager,
} from './NLSQLManager.js';

export {
  SchemaExtractor,
  type QueryFn,
} from './SchemaExtractor.js';

export {
  SchemaSummarizer,
  type SummarizeOptions,
} from './SchemaSummarizer.js';

export {
  SQLGenerator,
  type GenerateOptions,
} from './SQLGenerator.js';

export {
  SQLValidator,
  type ValidateOptions,
} from './SQLValidator.js';

export {
  SQLExecutor,
  type ExecuteQueryFn,
  type ExecuteOptions,
} from './SQLExecutor.js';

export {
  ChartSuggester,
  type SuggestOptions,
} from './ChartSuggester.js';

export {
  QueryHistory,
} from './QueryHistory.js';

export type {
  SQLDialect,
  ColumnSchema,
  ColumnKind,
  TableSchema,
  ForeignKey,
  DatabaseSchema,
  TableRelationship,
  ParsedQuery,
  Aggregation,
  Filter,
  FilterOperator,
  QueryIntent,
  GenerationResult,
  ValidationResult,
  QueryRow,
  ExecutionResult,
  ChartSuggestion,
  ChartType,
  HistoryEntry,
  NLSQLManagerOptions,
  NLSQLLLM,
  NLSQLResult,
} from './types.js';
