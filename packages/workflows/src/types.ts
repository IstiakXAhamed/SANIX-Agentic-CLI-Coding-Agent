/**
 * @file types.ts
 * @description Core type definitions for `@sanix/workflows` — the
 * declarative YAML agent pipeline runtime.
 *
 * A {@link Workflow} is a named, versioned sequence of {@link WorkflowStep}s
 * that consume typed {@link WorkflowInput}s, branch on
 * {@link WorkflowCondition}s, and produce typed {@link WorkflowOutput}s.
 * Steps may be nested (parallel / conditional / loop bodies) and may
 * reference each other's results via {@link WorkflowValue} refs.
 *
 * The types are designed to be JSON/YAML-serializable so a workflow can
 * be authored as a `.yaml` file and loaded by {@link WorkflowLoader}.
 *
 * @packageDocumentation
 */

// ─── Workflow root ─────────────────────────────────────────────────────────

/**
 * Top-level workflow document. Parsed from YAML by {@link WorkflowLoader}
 * and executed by {@link WorkflowExecutor}.
 *
 * @example
 * ```yaml
 * name: deploy
 * description: Build and deploy the service.
 * version: 1.0.0
 * inputs:
 *   - name: service
 *     type: string
 *     required: true
 *   - name: dryRun
 *     type: boolean
 *     default: false
 * steps:
 *   - id: build
 *     name: Build image
 *     type: tool
 *     tool: bash
 *     inputs:
 *       command: { template: 'docker build -t ${inputs.service} .' }
 *   - id: publish
 *     name: Push image
 *     type: tool
 *     tool: bash
 *     inputs:
 *       command: { template: 'docker push ${inputs.service}' }
 *     condition:
 *       op: eq
 *       left: { input: dryRun }
 *       right: { literal: false }
 * outputs:
 *   - name: image
 *     value: { ref: 'steps.build.result' }
 * onError: abort
 * ```
 */
export interface Workflow {
  /** Unique workflow name (used as the CLI lookup key). */
  name: string;
  /** Human-readable description, surfaced by `listWorkflows()`. */
  description: string;
  /** Semantic version (MAJOR.MINOR.PATCH). */
  version: string;
  /** Declared inputs (validated against `inputs` map at execute time). */
  inputs: WorkflowInput[];
  /** Ordered list of top-level steps. */
  steps: WorkflowStep[];
  /** Outputs computed at the end of execution. */
  outputs: WorkflowOutput[];
  /** Error policy: continue to next step, abort the workflow, or
   * rollback (run `onFailure` sub-steps on every preceding step). */
  onError?: 'continue' | 'abort' | 'rollback';
  /** Default values applied to inputs when not supplied by the caller. */
  defaults?: Record<string, unknown>;
}

// ─── Inputs ────────────────────────────────────────────────────────────────

/**
 * A typed workflow input. Validated by {@link WorkflowLoader.validate}
 * and resolved by the executor before step execution begins.
 */
export interface WorkflowInput {
  /** Input name — used as the key in the `inputs` map passed to `execute`. */
  name: string;
  /** Value type. `file`/`directory` are validated to be existing paths. */
  type: 'string' | 'number' | 'boolean' | 'file' | 'directory';
  /** Human-readable description, surfaced in CLI help / error messages. */
  description: string;
  /** When true, the caller MUST supply this input. Default `false`. */
  required?: boolean;
  /** Default value used when the caller omits the input. */
  default?: unknown;
}

// ─── Steps ─────────────────────────────────────────────────────────────────

/**
 * A single unit of work in a workflow. The `type` discriminates the
 * remaining fields; see the field-level JSDoc for which apply to which
 * type.
 *
 * Every step has a unique `id` (across the whole workflow tree, including
 * nested bodies / branches / onSuccess / onFailure). Other steps
 * reference its result via `{ ref: 'steps.<id>.result' }`.
 */
export interface WorkflowStep {
  /** Unique step identifier. Referenced by `${steps.<id>.result}`. */
  id: string;
  /** Human-readable step name (for logging / progress UI). */
  name: string;
  /** Discriminator — see field docs below for which fields apply. */
  type: 'tool' | 'agent' | 'parallel' | 'conditional' | 'loop' | 'transform' | 'wait';
  /** Tool name — required when `type === 'tool'`. */
  tool?: string;
  /** Inputs to the step (tool args, agent goal inputs, etc.). */
  inputs?: Record<string, WorkflowValue>;
  /** Condition for `conditional` (top-level — prefer `branches`). */
  condition?: WorkflowCondition;
  /** Branch list for `conditional`. First matching `when` wins. */
  branches?: { when: WorkflowCondition; then: WorkflowStep[] }[];
  /** Body steps for `loop` / `parallel`. */
  body?: WorkflowStep[];
  /** Max concurrent steps in a `parallel` block. Default 4. */
  parallelism?: number;
  /** Iterable for `loop` — must evaluate to an array. */
  forEach?: WorkflowValue;
  /** JS expression for `transform` — runs in a sandboxed `new Function()`. */
  transform?: string;
  /** Milliseconds to sleep for `wait`. */
  waitMs?: number;
  /** Retry policy: re-run on failure up to `max` times with exponential
   * backoff starting at `backoffMs`. */
  retry?: { max: number; backoffMs: number };
  /** Hard timeout in milliseconds — aborts the step after N ms. */
  timeout?: number;
  /** Sub-steps run after the main step succeeds. */
  onSuccess?: WorkflowStep[];
  /** Sub-steps run after the main step fails (and after retries). */
  onFailure?: WorkflowStep[];
}

// ─── Values ────────────────────────────────────────────────────────────────

/**
 * A discriminated union describing a value reference inside a workflow.
 *
 * - `literal` — a JSON value embedded in the YAML.
 * - `ref` — a path reference to a previous step's output, e.g.
 *   `'steps.greet.result.name'`. Resolved against {@link WorkflowContext.steps}.
 * - `input` — a workflow input name, e.g. `'filename'`. Resolved against
 *   {@link WorkflowContext.inputs}.
 * - `template` — a string with `${...}` interpolation. Each `${expr}`
 *   is itself evaluated as a path reference.
 *
 * @example
 * ```yaml
 * inputs:
 *   command: { template: 'echo "Hello, ${inputs.name}!"' }
 *   limit:   { literal: 10 }
 *   prev:    { ref: 'steps.build.result.exitCode' }
 *   name:    { input: 'username' }
 * ```
 */
export type WorkflowValue =
  | { literal: unknown }
  | { ref: string }
  | { input: string }
  | { template: string };

// ─── Conditions ────────────────────────────────────────────────────────────

/**
 * Boolean condition tree. Leaves compare two {@link WorkflowValue}s
 * with one of the comparison operators; internal nodes combine with
 * `and` / `or` / `not`.
 *
 * `exists` / `notExists` only consult `left` (the value being tested).
 */
export interface WorkflowCondition {
  /** Operator — see op table in JSDoc. */
  op:
    | 'eq'
    | 'ne'
    | 'gt'
    | 'lt'
    | 'gte'
    | 'lte'
    | 'contains'
    | 'startsWith'
    | 'endsWith'
    | 'matches'
    | 'exists'
    | 'notExists'
    | 'and'
    | 'or'
    | 'not';
  /** Left operand (for binary comparisons). */
  left?: WorkflowValue;
  /** Right operand (for binary comparisons). */
  right?: WorkflowValue;
  /** Operand list for `and` / `or`. */
  operands?: WorkflowCondition[];
  /** Single operand for `not`. */
  operand?: WorkflowCondition;
}

// ─── Outputs ───────────────────────────────────────────────────────────────

/**
 * A named output computed at workflow completion. The `value` is
 * evaluated against the final {@link WorkflowContext}.
 */
export interface WorkflowOutput {
  /** Output name — becomes a key in {@link WorkflowResult.outputs}. */
  name: string;
  /** Value reference — evaluated at the end of execution. */
  value: WorkflowValue;
}

// ─── Runtime context ───────────────────────────────────────────────────────

/**
 * Per-step status snapshot stored in {@link WorkflowContext.steps}.
 */
export interface StepStatus {
  /** Lifecycle state. */
  status: 'pending' | 'running' | 'success' | 'failed' | 'skipped';
  /** The step's output (tool result, agent result, transform result). */
  result?: unknown;
  /** Error message (present when `status === 'failed'`). */
  error?: string;
  /** Wall-clock start time (ms since epoch). */
  startedAt?: number;
  /** Wall-clock end time (ms since epoch). */
  endedAt?: number;
}

/**
 * Mutable runtime context handed to every step. Carries the resolved
 * inputs, the per-step status map, a free-form variables bag for
 * cross-step state (e.g. loop iteration items), and an event sink.
 *
 * Created fresh per `WorkflowExecutor.execute()` call.
 */
export interface WorkflowContext {
  /** Resolved workflow inputs (after defaults applied). */
  inputs: Record<string, unknown>;
  /** Per-step status map — keyed by step `id`. */
  steps: Map<string, StepStatus>;
  /** Mutable bag for cross-step state (loop item, accumulators, etc.). */
  variables: Map<string, unknown>;
  /** Event sink — forwards to the executor's EventEmitter. */
  emit: (event: string, payload: unknown) => void;
}

// ─── Result ────────────────────────────────────────────────────────────────

/**
 * Result returned by {@link WorkflowExecutor.execute}. Contains the
 * final status, evaluated outputs, per-step summary, and total
 * wall-clock duration.
 */
export interface WorkflowResult {
  /** Workflow name (from {@link Workflow.name}). */
  workflowName: string;
  /** Terminal status. `aborted` means `onError: 'abort'` triggered. */
  status: 'success' | 'failed' | 'aborted';
  /** Evaluated outputs (keyed by {@link WorkflowOutput.name}). */
  outputs: Record<string, unknown>;
  /** Per-step summary (in execution order). */
  steps: Array<{
    id: string;
    name: string;
    status: string;
    durationMs: number;
    error?: string;
  }>;
  /** Total wall-clock duration in milliseconds. */
  totalDurationMs: number;
}
