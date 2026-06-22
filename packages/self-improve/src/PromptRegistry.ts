/**
 * @file PromptRegistry.ts
 * @description SQLite-backed persistence for prompt variants. Stores every
 * variant + its genealogy (parent id, generation, mutation type, fitness).
 * Supports lineage queries (ancestor chain) and best-variant lookup.
 *
 * @packageDocumentation
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type { MutationType, PromptVariant } from './types.js';

/**
 * PromptRegistry constructor options.
 */
export interface PromptRegistryOptions {
  /** SQLite database path. Default: `~/.sanix/self-improve/prompts.db`. */
  dbPath?: string;
}

interface VariantRow {
  id: string;
  name: string;
  system_prompt: string;
  description: string;
  created_at: number;
  parent: string | null;
  generation: number;
  mutation_type: string | null;
  fitness: number | null;
  samples: number;
}

/**
 * SQLite-backed prompt variant registry.
 *
 * @example
 * ```ts
 * const reg = new PromptRegistry();
 * reg.save(variant);
 * const best = reg.getBest();
 * const lineage = reg.getLineage(best.id);
 * ```
 */
export class PromptRegistry {
  private readonly db: Database.Database;
  private readonly dbPath: string;

  constructor(opts: PromptRegistryOptions = {}) {
    const defaultDir = path.join(os.homedir(), '.sanix', 'self-improve');
    this.dbPath = opts.dbPath ?? path.join(defaultDir, 'prompts.db');
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
  }

  /**
   * Save (insert or replace) a variant.
   */
  save(variant: PromptVariant): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO variants
        (id, name, system_prompt, description, created_at, parent, generation, mutation_type, fitness, samples)
       VALUES (@id, @name, @system_prompt, @description, @created_at, @parent, @generation, @mutation_type, @fitness, @samples)`,
    );
    stmt.run({
      id: variant.id,
      name: variant.name,
      system_prompt: variant.systemPrompt,
      description: variant.description,
      created_at: variant.createdAt,
      parent: variant.parent ?? null,
      generation: variant.generation,
      mutation_type: variant.mutationType ?? null,
      fitness: variant.fitness ?? null,
      samples: variant.samples,
    });
  }

  /**
   * Get a variant by id.
   */
  get(id: string): PromptVariant | null {
    const row = this.db.prepare('SELECT * FROM variants WHERE id = ?').get(id) as VariantRow | undefined;
    return row ? this.rowToVariant(row) : null;
  }

  /**
   * List variants, optionally filtered.
   */
  list(filter?: {
    parent?: string;
    generation?: number;
    mutationType?: MutationType;
    minFitness?: number;
    limit?: number;
  }): PromptVariant[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter?.parent) { where.push('parent = @parent'); params.parent = filter.parent; }
    if (filter?.generation !== undefined) { where.push('generation = @generation'); params.generation = filter.generation; }
    if (filter?.mutationType) { where.push('mutation_type = @mutationType'); params.mutationType = filter.mutationType; }
    if (filter?.minFitness !== undefined) { where.push('fitness >= @minFitness'); params.minFitness = filter.minFitness; }
    const sql = 'SELECT * FROM variants' +
      (where.length > 0 ? ' WHERE ' + where.join(' AND ') : '') +
      ' ORDER BY fitness DESC NULLS LAST, created_at DESC' +
      (filter?.limit ? ' LIMIT @limit' : '');
    if (filter?.limit) params.limit = filter.limit;
    const rows = this.db.prepare(sql).all(params) as VariantRow[];
    return rows.map((r) => this.rowToVariant(r));
  }

  /**
   * Get the highest-fitness variant (or `null` if none stored yet).
   */
  getBest(): PromptVariant | null {
    const row = this.db.prepare(
      'SELECT * FROM variants WHERE fitness IS NOT NULL ORDER BY fitness DESC LIMIT 1',
    ).get() as VariantRow | undefined;
    return row ? this.rowToVariant(row) : null;
  }

  /**
   * Get the full ancestor chain for a variant (oldest first), including the
   * variant itself.
   */
  getLineage(id: string): PromptVariant[] {
    const chain: PromptVariant[] = [];
    let current = this.get(id);
    // Protect against cycles (shouldn't happen, but be defensive).
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      chain.unshift(current);
      if (!current.parent) break;
      current = this.get(current.parent);
    }
    return chain;
  }

  /**
   * Delete a variant by id.
   */
  delete(id: string): void {
    this.db.prepare('DELETE FROM variants WHERE id = ?').run(id);
  }

  /**
   * Close the underlying database handle.
   */
  close(): void {
    this.db.close();
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS variants (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        system_prompt TEXT NOT NULL,
        description   TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        parent        TEXT,
        generation    INTEGER NOT NULL,
        mutation_type TEXT,
        fitness       REAL,
        samples       INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_variants_parent ON variants(parent);
      CREATE INDEX IF NOT EXISTS idx_variants_fitness ON variants(fitness);
      CREATE INDEX IF NOT EXISTS idx_variants_generation ON variants(generation);
    `);
  }

  private rowToVariant(row: VariantRow): PromptVariant {
    return {
      id: row.id,
      name: row.name,
      systemPrompt: row.system_prompt,
      description: row.description,
      createdAt: row.created_at,
      parent: row.parent ?? undefined,
      generation: row.generation,
      mutationType: (row.mutation_type as MutationType | null) ?? undefined,
      fitness: row.fitness ?? undefined,
      samples: row.samples,
    };
  }
}
