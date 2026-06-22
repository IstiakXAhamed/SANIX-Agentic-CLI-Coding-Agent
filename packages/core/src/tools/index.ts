/**
 * @file tools/index.ts
 * @description Barrel re-export for `@sanix/core/tools`. Surface:
 *   - Interfaces: `SanixTool`, `ToolPermission`, `ToolContext`, `ToolResult`,
 *     `AnySanixTool`, `RegisteredTool`, `ToolRegistryEvents`
 *   - Registry: `ToolRegistry` (+ `RegisterOptions`, `ExecuteOptions`)
 *   - Validator: `ToolValidator` (+ `ValidationResult`, `estimateToolTokens`)
 *   - Result helpers: `ok`, `fail`, `withTiming`, `sumTokens`, `sumDuration`,
 *     `firstFailure`
 *
 * Import paths:
 *   import { ToolRegistry, SanixTool, ok, fail } from '@sanix/core/tools';
 */

export type {
  SanixTool,
  AnySanixTool,
  ToolPermission,
  ToolContext,
  ToolResult,
  RegisteredTool,
  ToolRegistryEvents,
} from './interfaces.js';

export {
  ToolRegistry,
  type RegisterOptions,
  type ExecuteOptions,
} from './ToolRegistry.js';

export {
  ToolValidator,
  type ValidationResult,
  estimateToolTokens,
} from './ToolValidator.js';

export {
  ok,
  fail,
  withTiming,
  sumTokens,
  sumDuration,
  firstFailure,
} from './ToolResult.js';
