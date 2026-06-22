/**
 * @file SQLValidator.ts
 * @description Validates generated SQL for syntax + safety.
 *
 * The validator does *not* run the SQL — it parses it with a small
 * hand-written tokenizer that recognises the SELECT / INSERT /
 * UPDATE / DELETE / WITH grammar and checks:
 *
 *   - Balanced parentheses / quotes.
 *   - Required clauses (e.g. SELECT needs a FROM for table queries).
 *   - No forbidden statements (DROP, TRUNCATE, ALTER, GRANT, …)
 *     unless explicitly allowed.
 *   - Destructive statements (UPDATE / DELETE) have a WHERE clause.
 *   - SELECT has a LIMIT when `requireLimit` is set.
 *   - Parameter placeholders (`?` / `$1`) match the param count.
 */

import type { SQLDialect, ValidationResult } from './types.js';

/** Statements that are always forbidden unless `allowDestructive`. */
const FORBIDDEN = new Set([
  'DROP', 'TRUNCATE', 'ALTER', 'GRANT', 'REVOKE', 'SHUTDOWN', 'DETACH',
  'ATTACH', 'VACUUM', 'REINDEX', 'ANALYZE',
]);

/**
 * Options for `SQLValidator.validate`.
 */
export interface ValidateOptions {
  /** Allow DML (INSERT/UPDATE/DELETE). Default `false`. */
  allowDML?: boolean;
  /** Allow DDL (CREATE/DROP/ALTER). Default `false`. */
  allowDDL?: boolean;
  /** Require LIMIT on SELECT. Default `false`. */
  requireLimit?: boolean;
  /** Expected number of `?` placeholders. */
  expectedParamCount?: number;
  /** Max SQL length (chars). Default `10000`. */
  maxLength?: number;
}

/**
 * SQL syntax + safety validator.
 *
 * @example
 * ```ts
 * const v = new SQLValidator('postgres');
 * const result = v.validate("SELECT * FROM users WHERE id = 1");
 * if (!result.valid) console.error(result.errors);
 * ```
 */
export class SQLValidator {
  /**
   * @param dialect SQL dialect (affects allowed syntax).
   */
  constructor(private readonly dialect: SQLDialect) {}

  /**
   * Validate SQL.
   */
  public validate(sql: string, opts: ValidateOptions = {}): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const safetyIssues: string[] = [];
    const maxLen = opts.maxLength ?? 10000;

    if (!sql || !sql.trim()) {
      return { valid: false, errors: ['Empty SQL'], warnings, safetyIssues, risk: 'high' };
    }
    if (sql.length > maxLen) {
      errors.push(`SQL exceeds max length (${sql.length} > ${maxLen})`);
    }

    // Tokenize.
    const tokens = this.tokenize(sql);
    if (tokens.length === 0) {
      errors.push('No tokens parsed from SQL');
    }

    // Balanced parens / quotes.
    const balance = this.checkBalance(sql);
    if (balance.errors.length) errors.push(...balance.errors);

    // First keyword = statement type.
    const stmtType = tokens[0]?.toUpperCase() ?? '';
    if (!stmtType) {
      errors.push('Could not determine statement type');
    } else if (FORBIDDEN.has(stmtType) && !opts.allowDDL) {
      errors.push(`Forbidden statement: ${stmtType}`);
      safetyIssues.push(`DDL/destructive statement "${stmtType}" not allowed`);
    } else if ((stmtType === 'INSERT' || stmtType === 'UPDATE' || stmtType === 'DELETE') && !opts.allowDML) {
      errors.push(`DML statement "${stmtType}" not allowed (set allowDML: true)`);
      safetyIssues.push(`DML statement "${stmtType}" blocked`);
    }

    // SELECT-specific checks.
    if (stmtType === 'SELECT' || stmtType === 'WITH') {
      const upper = sql.toUpperCase();
      if (stmtType === 'SELECT' && !/\bFROM\b/.test(upper) && !/\bSELECT\s+\d+\s*;?\s*$/.test(sql.trim())) {
        warnings.push('SELECT without FROM — may be a constant query');
      }
      if (opts.requireLimit && !/\bLIMIT\b/.test(upper) && !/\bFETCH\s+FIRST\b/.test(upper)) {
        warnings.push('SELECT without LIMIT — may return many rows');
      }
      // Detect SELECT * (discouraged).
      if (/\bSELECT\s+\*/.test(upper)) {
        warnings.push('SELECT * — consider specifying columns');
      }
    }

    // UPDATE/DELETE must have WHERE.
    if (stmtType === 'UPDATE' || stmtType === 'DELETE') {
      if (!/\bWHERE\b/.test(sql.toUpperCase())) {
        safetyIssues.push(`${stmtType} without WHERE — affects all rows`);
      }
    }

    // Multiple statements (semicolons) — block unless it's a trailing semicolon.
    const semicolons = (sql.match(/;/g) ?? []).length;
    const trimmedEnd = sql.trimEnd();
    const trailingSemi = trimmedEnd.endsWith(';') ? 1 : 0;
    if (semicolons > trailingSemi) {
      errors.push('Multiple statements detected — only one statement allowed');
      safetyIssues.push('Multiple SQL statements');
    }

    // Comment-based injection.
    if (/--/.test(sql) || /\/\*/.test(sql)) {
      warnings.push('SQL contains comments — verify provenance');
    }

    // Parameter count.
    if (opts.expectedParamCount !== undefined) {
      const placeholders = this.countPlaceholders(sql);
      if (placeholders !== opts.expectedParamCount) {
        warnings.push(`Placeholder count ${placeholders} != expected ${opts.expectedParamCount}`);
      }
    }

    const risk = this.assessRisk(safetyIssues, errors, stmtType, opts);
    return {
      valid: errors.length === 0,
      errors,
      warnings,
      safetyIssues,
      risk,
    };
  }

  /**
   * Quick check — is this a read-only query?
   */
  public isReadOnly(sql: string): boolean {
    const first = (this.tokenize(sql)[0] ?? '').toUpperCase();
    return first === 'SELECT' || first === 'WITH';
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  private tokenize(sql: string): string[] {
    const re = /'[^']*'|"[^"]*"|`[^`]*`|\[[^\]]*\]|\$\d+|:\w+|\?|[A-Za-z_][A-Za-z0-9_]*|\d+|[(),.;=<>!+\-*/%]+|\S/g;
    return sql.match(re) ?? [];
  }

  private checkBalance(sql: string): { errors: string[] } {
    const errors: string[] = [];
    let paren = 0;
    let inSingle = false;
    let inDouble = false;
    let inBacktick = false;
    for (let i = 0; i < sql.length; i++) {
      const c = sql[i];
      if (inSingle) { if (c === "'") inSingle = false; continue; }
      if (inDouble) { if (c === '"') inDouble = false; continue; }
      if (inBacktick) { if (c === '`') inBacktick = false; continue; }
      if (c === "'") inSingle = true;
      else if (c === '"') inDouble = true;
      else if (c === '`') inBacktick = true;
      else if (c === '(') paren++;
      else if (c === ')') paren--;
      if (paren < 0) { errors.push('Unbalanced ")"'); paren = 0; }
    }
    if (paren > 0) errors.push('Unbalanced "("');
    if (inSingle) errors.push('Unterminated single-quote');
    if (inDouble) errors.push('Unterminated double-quote');
    if (inBacktick) errors.push('Unterminated backtick');
    return { errors };
  }

  private countPlaceholders(sql: string): number {
    // Count `?` outside of quotes.
    let count = 0;
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < sql.length; i++) {
      const c = sql[i];
      if (inSingle) { if (c === "'") inSingle = false; continue; }
      if (inDouble) { if (c === '"') inDouble = false; continue; }
      if (c === "'") inSingle = true;
      else if (c === '"') inDouble = true;
      else if (c === '?') count++;
    }
    return count;
  }

  private assessRisk(
    safetyIssues: string[],
    errors: string[],
    stmtType: string,
    opts: ValidateOptions,
  ): ValidationResult['risk'] {
    if (errors.some((e) => /forbidden/i.test(e))) return 'critical';
    if (safetyIssues.some((s) => /without WHERE/i.test(s))) return 'high';
    if (safetyIssues.length > 1) return 'medium';
    if (stmtType === 'INSERT' || stmtType === 'UPDATE' || stmtType === 'DELETE') {
      return opts.allowDML ? 'low' : 'high';
    }
    if (stmtType === 'SELECT' || stmtType === 'WITH') return 'safe';
    return 'low';
  }
}
