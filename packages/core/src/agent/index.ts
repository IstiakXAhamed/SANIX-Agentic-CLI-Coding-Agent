/**
 * @file agent/index.ts
 * @description Barrel re-export for `@sanix/core/agent`. Surface:
 *   - Types: `AgentState`, `AgentResult`, `RunContext`, `Decision` (union
 *     of TOOL_CALL / LLM_COMPLETION / SPAWN_SUBAGENT / COMPLETE / ABORT /
 *     ASK_USER), `SubTask`, `SubAgentHandle`, `SubAgentResult`,
 *     `AgentReport`, `TaskNode`, `Plan`, `TaskType`, `WorldModel`,
 *     `ActionRecord`, `TaskResult`, `ReflectionResult`, `AgentLoopEvents`
 *   - Loop: `AgentLoop` (+ `AgentLoopOptions`)
 *   - Planner: `Planner` (+ `PlannerOptions`, `PlanSchema`, `TaskSchema`)
 *   - Executor: `Executor` (+ `ExecutorOptions`)
 *   - Reflector: `Reflector` (+ `ReflectorOptions`)
 *   - SubAgentManager: `SubAgentManager` (+ `SubAgentManagerEvents`,
 *     `SubAgentManagerOptions`)
 *
 * Import paths:
 *   import { AgentLoop, Planner } from '@sanix/core/agent';
 */

export type {
  ActionRecord,
  AgentLoopEvents,
  AgentReport,
  AgentResult,
  AgentState,
  AskUserDecision,
  AbortDecision,
  CompleteDecision,
  Decision,
  LLMCompletionDecision,
  Plan,
  ReflectionResult,
  RunContext,
  SpawnSubAgentDecision,
  SubAgentHandle,
  SubAgentResult,
  SubTask,
  TaskNode,
  TaskResult,
  TaskType,
  ToolCallDecision,
  WorldModel,
} from './types.js';

export {
  AgentLoop,
  type AgentLoopOptions,
} from './AgentLoop.js';

export {
  Planner,
  type PlannerOptions,
  PlanSchema,
  TaskSchema,
  type PlanSchemaT,
  type TaskSchemaT,
  extractJson,
  zodToJsonSchema,
} from './Planner.js';

export {
  Executor,
  type ExecutorOptions,
} from './Executor.js';

export {
  Reflector,
  type ReflectorOptions,
} from './Reflector.js';

export {
  SubAgentManager,
  type SubAgentManagerEvents,
  type SubAgentManagerOptions,
} from './SubAgentManager.js';
