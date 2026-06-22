/**
 * @file Shell tools barrel.
 */
export {
  BashTool,
  BashInputSchema,
  BashOutputSchema,
} from './BashTool.js';
export type { BashInput, BashOutput } from './BashTool.js';

export {
  StartProcessTool,
  KillProcessTool,
  StartProcessInputSchema,
  StartProcessOutputSchema,
  KillProcessInputSchema,
  KillProcessOutputSchema,
  processRegistry,
} from './ProcessManager.js';
export type {
  StartProcessInput,
  StartProcessOutput,
  KillProcessInput,
  KillProcessOutput,
  TrackedProcess,
} from './ProcessManager.js';

export {
  EnvManagerTool,
  GetEnvInputSchema,
  GetEnvOutputSchema,
} from './EnvManager.js';
export type { GetEnvInput, GetEnvOutput } from './EnvManager.js';
