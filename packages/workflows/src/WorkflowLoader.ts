/**
 * @file WorkflowLoader.ts
 * @description YAML → Workflow parser + Zod validator + filesystem
 * loader. The loader is the single entry point for converting a
 * declarative workflow document (authored as a `.yaml` file or a YAML
 * string) into a validated {@link Workflow} object the
 * {@link WorkflowExecutor} can run.
 *
 * Workflow search paths (in priority order):
 *   1. `./.sanix/workflows/`  — project-local workflows (highest priority).
 *   2. `~/.sanix/workflows/`  — user-global workflows.
 *   3. `@sanix/workflows/builtin` — built-in workflows shipped with the
 *      package (code-review, bug-fix, feature-implement, refactor,
 *      docs-generate, security-audit, test-coverage).
 *
 * @packageDocumentation
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { z } from 'zod';

// Synchronous require for `js-yaml` — keeps `parse()` synchronous per the
// public API. (Dynamic `import()` would force `parse` to be async.)
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type JsYamlModule = typeof import('js-yaml');
let _yaml: JsYamlModule | undefined;
/**
 * Lazily-loaded `js-yaml` module. Loaded on first call to `parse()` so
 * environments that never parse YAML don't pay the require cost.
 */
function yaml(): JsYamlModule {
  if (!_yaml) _yaml = require('js-yaml') as JsYamlModule;
  return _yaml;
}
import type {
  Workflow,
  WorkflowInput,
  WorkflowOutput,
  WorkflowStep,
  WorkflowValue,
  WorkflowCondition,
} from './types.js';
import { BUILTIN_WORKFLOWS } from './builtin/index.js';

// ─── Zod schemas ───────────────────────────────────────────────────────────

/**
 * Zod schema for {@link WorkflowValue}. A discriminated union on the
 * shape of the object — `literal | ref | input | template`.
 *
 * The cast through `unknown` is needed because `z.lazy()` infers an
 * output type where object keys with `z.unknown()` values are
 * optional, but the canonical `WorkflowValue` declares them required.
 * The runtime behavior is correct (Zod accepts exactly the four
 * shapes); only the static type needs the assertion.
 */
const WorkflowValueSchema = z.lazy(() =>
  z.union([
    // `.strict()` on each variant is required so a payload like
    // `{ input: 'items' }` doesn't accidentally match the `literal`
    // schema (which would strip the unknown `input` key and leave an
    // empty object). With strict, only the variant whose declared
    // keys exactly match the input succeeds.
    z.object({ literal: z.unknown() }).strict(),
    z.object({ ref: z.string() }).strict(),
    z.object({ input: z.string() }).strict(),
    z.object({ template: z.string() }).strict(),
  ]),
) as unknown as z.ZodType<WorkflowValue>;

/**
 * Zod schema for {@link WorkflowCondition}. Recursive — `operands` and
 * `operand` allow nested `and`/`or`/`not` trees.
 */
const WorkflowConditionSchema = z.lazy(() =>
  z.object({
    op: z.enum([
      'eq', 'ne', 'gt', 'lt', 'gte', 'lte',
      'contains', 'startsWith', 'endsWith', 'matches',
      'exists', 'notExists',
      'and', 'or', 'not',
    ]),
    left: WorkflowValueSchema.optional(),
    right: WorkflowValueSchema.optional(),
    operands: z.array(WorkflowConditionSchema).optional(),
    operand: WorkflowConditionSchema.optional(),
  }),
) as unknown as z.ZodType<WorkflowCondition>;

/**
 * Zod schema for {@link WorkflowStep}. Recursive — `body`, `branches`,
 * `onSuccess`, `onFailure` allow arbitrarily-nested step trees.
 */
const WorkflowStepSchema = z.lazy(() =>
  z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    type: z.enum(['tool', 'agent', 'parallel', 'conditional', 'loop', 'transform', 'wait']),
    tool: z.string().optional(),
    inputs: z.record(z.string(), WorkflowValueSchema).optional(),
    condition: WorkflowConditionSchema.optional(),
    branches: z.array(
      z.object({
        when: WorkflowConditionSchema,
        then: z.array(WorkflowStepSchema),
      }),
    ).optional(),
    body: z.array(WorkflowStepSchema).optional(),
    parallelism: z.number().int().positive().optional(),
    forEach: WorkflowValueSchema.optional(),
    transform: z.string().optional(),
    waitMs: z.number().int().nonnegative().optional(),
    retry: z.object({ max: z.number().int().nonnegative(), backoffMs: z.number().int().nonnegative() }).optional(),
    timeout: z.number().int().positive().optional(),
    onSuccess: z.array(WorkflowStepSchema).optional(),
    onFailure: z.array(WorkflowStepSchema).optional(),
  }),
) as unknown as z.ZodType<WorkflowStep>;

/** Zod schema for {@link WorkflowInput}. */
const WorkflowInputSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['string', 'number', 'boolean', 'file', 'directory']),
  description: z.string().default(''),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
}) as unknown as z.ZodType<WorkflowInput>;

/**
 * The full Zod schema for a {@link Workflow} document. Mirrors the
 * `Workflow` interface in `types.ts` exactly.
 */
export const WorkflowSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  version: z.string().default('0.0.0'),
  inputs: z.array(WorkflowInputSchema).default([]),
  steps: z.array(WorkflowStepSchema),
  outputs: z.array(
    z.object({
      name: z.string().min(1),
      value: WorkflowValueSchema,
    }),
  ).default([]),
  onError: z.enum(['continue', 'abort', 'rollback']).optional(),
  defaults: z.record(z.string(), z.unknown()).optional(),
}) as unknown as z.ZodType<Workflow>;

// ─── Loader ────────────────────────────────────────────────────────────────

/**
 * Loads and validates {@link Workflow} objects from YAML strings,
 * `.yaml` files, or directories of `.yaml`/`.yml` files.
 *
 * @example
 * ```ts
 * const loader = new WorkflowLoader();
 *
 * // From a string.
 * const wf = loader.parse(`
 *   name: hello
 *   description: Say hello.
 *   version: 1.0.0
 *   inputs: []
 *   steps:
 *     - id: greet
 *       name: Greet
 *       type: tool
 *       tool: bash
 *       inputs:
 *         command: { literal: 'echo hi' }
 *   outputs: []
 * `);
 *
 * // From a file.
 * const wf2 = await loader.loadFile('~/.sanix/workflows/deploy.yaml');
 *
 * // From a directory.
 * const all = await loader.loadDir('./.sanix/workflows/');
 *
 * // By name (searches project-local, user-global, and built-in).
 * const wf3 = await loader.find('code-review');
 * ```
 */
export class WorkflowLoader {
  /** Project-local workflow directory (highest priority). */
  readonly projectDir: string;
  /** User-global workflow directory. */
  readonly userDir: string;

  constructor() {
    this.projectDir = path.resolve(process.cwd(), '.sanix', 'workflows');
    this.userDir = path.join(os.homedir(), '.sanix', 'workflows');
  }

  /**
   * Parse a YAML string into a validated {@link Workflow}.
   *
   * @param yaml - YAML source text.
   * @returns Validated workflow.
   * @throws {Error} if the YAML is malformed or fails Zod validation
   *   (the error message names the failing field).
   *
   * @example
   * ```ts
   * const wf = loader.parse(yamlText);
   * console.log(wf.name, wf.steps.length);
   * ```
   */
  parse(yaml: string): Workflow {
    const parsed = this.parseYaml(yaml);
    return this.validate(parsed);
  }

  /**
   * Validate an already-parsed workflow object (e.g. from JSON). Useful
   * for editors / programmatic workflow builders that bypass YAML.
   *
   * @param workflow - The raw workflow object (any shape).
   * @returns Validated workflow (with defaults applied).
   * @throws {Error} on Zod validation failure.
   */
  validate(workflow: unknown): Workflow {
    const result = WorkflowSchema.safeParse(workflow);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `  at ${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('\n');
      throw new Error(`Invalid workflow: validation failed:\n${issues}`);
    }
    this.assertUniqueStepIds(result.data.steps);
    return result.data;
  }

  /**
   * Load a workflow from a `.yaml`/`.yml` file. `~` is expanded to the
   * home directory.
   *
   * @param filePath - Path to the YAML file (absolute, relative, or `~/`-prefixed).
   * @returns Validated workflow.
   */
  async loadFile(filePath: string): Promise<Workflow> {
    const resolved = this.expandPath(filePath);
    const text = await fs.readFile(resolved, 'utf-8');
    return this.parse(text);
  }

  /**
   * Load every workflow in a directory (non-recursive). Files matching
   * `*.yaml` or `*.yml` are loaded; everything else is skipped.
   *
   * @param dir - Directory path (absolute, relative, or `~/`-prefixed).
   * @returns Array of validated workflows (empty if the directory
   *   doesn't exist or contains no YAML files).
   */
  async loadDir(dir: string): Promise<Workflow[]> {
    const resolved = this.expandPath(dir);
    let entries: string[];
    try {
      entries = await fs.readdir(resolved);
    } catch {
      return [];
    }
    const yamlFiles = entries.filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
    const workflows: Workflow[] = [];
    for (const f of yamlFiles) {
      try {
        workflows.push(await this.loadFile(path.join(resolved, f)));
      } catch (err) {
        // Skip a malformed file but log the issue.
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[workflows] skipping ${f}: ${msg}\n`);
      }
    }
    return workflows;
  }

  /**
   * Find a workflow by name. Searches (in order):
   *   1. `./.sanix/workflows/<name>.yaml` (project-local)
   *   2. `~/.sanix/workflows/<name>.yaml` (user-global)
   *   3. Built-in workflows (shipped with the package).
   *
   * @param name - Workflow name (matches the `name` field in YAML).
   * @returns The matching workflow, or `null` if not found.
   */
  async find(name: string): Promise<Workflow | null> {
    // 1. Project-local.
    const fromProject = await this.tryLoad(path.join(this.projectDir, `${name}.yaml`));
    if (fromProject) return fromProject;
    const fromProjectYml = await this.tryLoad(path.join(this.projectDir, `${name}.yml`));
    if (fromProjectYml) return fromProjectYml;

    // 2. User-global.
    const fromUser = await this.tryLoad(path.join(this.userDir, `${name}.yaml`));
    if (fromUser) return fromUser;
    const fromUserYml = await this.tryLoad(path.join(this.userDir, `${name}.yml`));
    if (fromUserYml) return fromUserYml;

    // 3. Built-in.
    return BUILTIN_WORKFLOWS.find((w) => w.name === name) ?? null;
  }

  /**
   * List all known workflow names + descriptions (project-local,
   * user-global, and built-in, de-duplicated by name with project-local
   * taking priority).
   *
   * @returns Array of `{ name, description, builtin }`.
   */
  async listAll(): Promise<Array<{ name: string; description: string; builtin: boolean }>> {
    const map = new Map<string, { name: string; description: string; builtin: boolean }>();
    // Built-ins first (lowest priority).
    for (const w of BUILTIN_WORKFLOWS) {
      map.set(w.name, { name: w.name, description: w.description, builtin: true });
    }
    // User-global overrides built-ins.
    for (const w of await this.loadDir(this.userDir)) {
      map.set(w.name, { name: w.name, description: w.description, builtin: false });
    }
    // Project-local overrides everything.
    for (const w of await this.loadDir(this.projectDir)) {
      map.set(w.name, { name: w.name, description: w.description, builtin: false });
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  // ── Internals ──────────────────────────────────────────────────────────

  /**
   * Try to load a file; return null if it doesn't exist (instead of
   * throwing). Other errors (parse / validation) still propagate.
   */
  private async tryLoad(filePath: string): Promise<Workflow | null> {
    try {
      await fs.access(filePath);
    } catch {
      return null;
    }
    return this.loadFile(filePath);
  }

  /**
   * Expand `~/` to the home directory. Already-absolute / relative
   * paths are returned unchanged (relative paths are resolved against
   * `process.cwd()`).
   */
  private expandPath(p: string): string {
    if (p === '~') return os.homedir();
    if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
    if (path.isAbsolute(p)) return p;
    return path.resolve(process.cwd(), p);
  }

  /**
   * Parse YAML synchronously using the lazily-loaded `js-yaml` module.
   *
   * @throws {Error} if the YAML is malformed.
   */
  private parseYaml(text: string): unknown {
    // Already-parsed object — be lenient (accepts JSON / JS objects).
    if (typeof text === 'object' && text !== null) return text;
    return yaml().load(text, { filename: 'workflow.yaml' });
  }

  /**
   * Walk the step tree and assert every `id` is unique. Duplicate IDs
   * create ambiguous `${steps.<id>.result}` references — the executor
   * would silently use whichever ran last, which is the kind of bug
   * that's painful to debug after the fact. Surface it loudly instead.
   *
   * @throws {Error} listing all duplicate IDs found.
   */
  private assertUniqueStepIds(steps: WorkflowStep[]): void {
    const seen = new Map<string, number>();
    const visit = (step: WorkflowStep): void => {
      seen.set(step.id, (seen.get(step.id) ?? 0) + 1);
      step.body?.forEach(visit);
      step.branches?.forEach((b) => b.then.forEach(visit));
      step.onSuccess?.forEach(visit);
      step.onFailure?.forEach(visit);
    };
    steps.forEach(visit);
    const dupes = [...seen.entries()].filter(([, n]) => n > 1);
    if (dupes.length > 0) {
      const list = dupes.map(([id, n]) => `  '${id}' (appears ${n} times)`).join('\n');
      throw new Error(
        `Invalid workflow: duplicate step IDs detected — ` +
        `each step id must be unique across the whole tree:\n${list}`,
      );
    }
  }
}
