/**
 * @file builtin/index.ts
 * @description Built-in workflow catalog. Loads the YAML files in this
 * directory at module load time, parses them via `js-yaml`, performs
 * basic structural validation, and exports them as `BUILTIN_WORKFLOWS`.
 *
 * To avoid a circular import with {@link WorkflowLoader} (which uses
 * `BUILTIN_WORKFLOWS` in its `find()` and `listAll()` methods), this
 * module does NOT depend on `WorkflowLoader` — it parses + validates
 * inline. Callers that want full Zod validation can pass the resulting
 * `Workflow` objects through `loader.validate()`.
 *
 * The YAML files are the source of truth — users can read / copy /
 * modify them on disk. The runtime loader searches a few candidate
 * directories so the same code works in:
 *   - dev mode (running from `src/builtin/`)
 *   - bundled single-file mode (`dist/index.js` with yaml files copied
 *     to `dist/builtin/`)
 *   - bundled multi-entry mode (`dist/builtin/index.js`)
 *
 * @packageDocumentation
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type { Workflow, WorkflowStep } from '../types.js';

// Synchronous require for `js-yaml` — keeps the builtin loader
// self-contained (no WorkflowLoader dep → no circular import).
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type JsYamlModule = typeof import('js-yaml');
let _yaml: JsYamlModule | undefined;
function yaml(): JsYamlModule {
  if (!_yaml) _yaml = require('js-yaml') as JsYamlModule;
  return _yaml;
}

/** The directory this module lives in (works in dev and bundled modes). */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Names of the built-in workflow YAML files (without extension). */
const BUILTIN_NAMES = [
  'code-review',
  'bug-fix',
  'feature-implement',
  'refactor',
  'docs-generate',
  'security-audit',
  'test-coverage',
] as const;

/**
 * Find a YAML file by name, searching a few candidate directories.
 * Throws if the file can't be found in any of them.
 */
function loadYaml(name: string): string {
  const candidates = [
    // dev mode: src/builtin/<name>.yaml
    path.join(__dirname, `${name}.yaml`),
    // bundled single-file: dist/builtin/<name>.yaml (yaml files copied
    // next to dist/index.js under dist/builtin/)
    path.join(__dirname, 'builtin', `${name}.yaml`),
    // bundled multi-entry: dist/builtin/<name>.yaml (this file lives
    // at dist/builtin/index.js, parent is dist/, so ../builtin/<name>.yaml)
    path.join(__dirname, '..', 'builtin', `${name}.yaml`),
  ];
  for (const p of candidates) {
    try {
      return readFileSync(p, 'utf-8');
    } catch {
      // try next candidate
    }
  }
  throw new Error(
    `Could not find built-in workflow '${name}.yaml' in any of:\n  ` +
    candidates.join('\n  '),
  );
}

/**
 * Lightweight structural validation of a parsed workflow. The full
 * Zod-based validation lives in {@link WorkflowLoader.validate}; this
 * inline check exists to keep this module dependency-free (avoiding
 * the WorkflowLoader → builtin → WorkflowLoader cycle).
 *
 * @throws {Error} on any structural problem.
 */
function validateBuiltin(workflow: unknown, name: string): Workflow {
  if (!workflow || typeof workflow !== 'object') {
    throw new Error(`Built-in '${name}' is not an object`);
  }
  const w = workflow as Partial<Workflow>;
  if (typeof w.name !== 'string' || !w.name) {
    throw new Error(`Built-in '${name}' is missing a 'name' string`);
  }
  if (typeof w.description !== 'string') {
    throw new Error(`Built-in '${name}' is missing a 'description' string`);
  }
  if (typeof w.version !== 'string') {
    throw new Error(`Built-in '${name}' is missing a 'version' string`);
  }
  if (!Array.isArray(w.steps)) {
    throw new Error(`Built-in '${name}' is missing a 'steps' array`);
  }
  if (!Array.isArray(w.inputs)) {
    throw new Error(`Built-in '${name}' is missing an 'inputs' array`);
  }
  if (!Array.isArray(w.outputs)) {
    throw new Error(`Built-in '${name}' is missing an 'outputs' array`);
  }
  // Walk the step tree and assert unique IDs (same check as the loader).
  const seen = new Map<string, number>();
  const visit = (step: WorkflowStep): void => {
    if (typeof step.id !== 'string' || !step.id) {
      throw new Error(`Built-in '${name}' has a step without an id`);
    }
    seen.set(step.id, (seen.get(step.id) ?? 0) + 1);
    step.body?.forEach(visit);
    step.branches?.forEach((b) => b.then.forEach(visit));
    step.onSuccess?.forEach(visit);
    step.onFailure?.forEach(visit);
  };
  w.steps.forEach(visit);
  const dupes = [...seen.entries()].filter(([, n]) => n > 1);
  if (dupes.length > 0) {
    throw new Error(
      `Built-in '${name}' has duplicate step IDs: ` +
      dupes.map(([id]) => id).join(', '),
    );
  }
  return w as Workflow;
}

/**
 * The full list of built-in workflows shipped with `@sanix/workflows`.
 * Parsed and validated once at module load. Each entry is a fresh
 * `Workflow` object (safe to mutate per-call without affecting the
 * canonical built-in).
 */
export const BUILTIN_WORKFLOWS: Workflow[] = BUILTIN_NAMES.map((name) => {
  const text = loadYaml(name);
  let parsed: unknown;
  try {
    parsed = yaml().load(text, { filename: `${name}.yaml` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse built-in '${name}.yaml': ${msg}`);
  }
  return validateBuiltin(parsed, name);
});

/**
 * Look up a built-in workflow by name. Returns `null` if no built-in
 * workflow has that name.
 *
 * @example
 * ```ts
 * import { getBuiltinWorkflow } from '@sanix/workflows';
 * const review = getBuiltinWorkflow('code-review');
 * ```
 */
export function getBuiltinWorkflow(name: string): Workflow | null {
  return BUILTIN_WORKFLOWS.find((w) => w.name === name) ?? null;
}

/**
 * List the names of all built-in workflows.
 */
export function listBuiltinWorkflows(): string[] {
  return BUILTIN_WORKFLOWS.map((w) => w.name);
}
