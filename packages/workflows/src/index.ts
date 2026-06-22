/**
 * @file index.ts
 * @description Public entry point for `@sanix/workflows`. Re-exports
 * the full surface of the declarative YAML agent pipeline runtime:
 *
 *   - **types**        — Workflow, WorkflowStep, WorkflowValue,
 *     WorkflowCondition, WorkflowContext, WorkflowResult, etc.
 *   - **loader**       — WorkflowLoader (+ WorkflowSchema for editors)
 *   - **executor**     — WorkflowExecutor (+ events + options)
 *   - **builtins**     — BUILTIN_WORKFLOWS, getBuiltinWorkflow,
 *     listBuiltinWorkflows
 *   - **personas**     — PERSONAS, getPersona, listPersonas,
 *     AgentPersona type, all 8 persona constants
 *   - **composer**     — ToolComposer, CompositeTool spec,
 *     READ_AND_SUMMARIZE_SPEC example
 *   - **cli**          — listWorkflows, getWorkflow, runWorkflow,
 *     WorkflowCliContext
 *
 * Import paths:
 *   import { WorkflowLoader, WorkflowExecutor, PERSONAS, BUILTIN_WORKFLOWS } from '@sanix/workflows';
 *   import { runWorkflow } from '@sanix/workflows';
 *
 * @packageDocumentation
 */

// ── Types ───────────────────────────────────────────────────────────────────
export type {
  Workflow,
  WorkflowInput,
  WorkflowStep,
  WorkflowValue,
  WorkflowCondition,
  WorkflowOutput,
  WorkflowContext,
  StepStatus,
  WorkflowResult,
} from './types.js';

// ── Loader ──────────────────────────────────────────────────────────────────
export {
  WorkflowLoader,
  WorkflowSchema,
} from './WorkflowLoader.js';

// ── Executor ────────────────────────────────────────────────────────────────
export {
  WorkflowExecutor,
  type WorkflowExecutorOptions,
  type WorkflowExecutorEvents,
  type AgentLoopFactory,
} from './WorkflowExecutor.js';

// ── Built-in workflows ──────────────────────────────────────────────────────
export {
  BUILTIN_WORKFLOWS,
  getBuiltinWorkflow,
  listBuiltinWorkflows,
} from './builtin/index.js';

// ── Personas ────────────────────────────────────────────────────────────────
export {
  PERSONAS,
  getPersona,
  listPersonas,
  type AgentPersona,
  RESEARCHER_PERSONA,
  CODER_PERSONA,
  REVIEWER_PERSONA,
  ARCHITECT_PERSONA,
  DEBUGGER_PERSONA,
  EXPLAINER_PERSONA,
  PLANNER_PERSONA,
  WRITER_PERSONA,
} from './personas/index.js';

// ── Tool composer ───────────────────────────────────────────────────────────
export {
  ToolComposer,
  type ToolComposerOptions,
  type CompositeTool,
  READ_AND_SUMMARIZE_SPEC,
} from './ToolComposer.js';

// ── CLI helpers ─────────────────────────────────────────────────────────────
export {
  listWorkflows,
  getWorkflow,
  runWorkflow,
  type WorkflowCliContext,
} from './cli.js';
