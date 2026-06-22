/**
 * @file index.ts
 * @description Barrel re-export for `@sanix/completions`.
 *
 * @packageDocumentation
 */

export {
  CompletionGenerator,
  type CompletionSpec,
  type CompletionCommand,
  type CompletionFlag,
  type CompletionArg,
  type CompletionValues,
  type GenerateOptions,
} from './CompletionGenerator.js';

export {
  InstallHelper,
  type InstallOptions,
  type InstallResult,
} from './InstallHelper.js';

export {
  renderBash,
} from './templates/bash.js';

export {
  renderZsh,
} from './templates/zsh.js';

export {
  renderFish,
} from './templates/fish.js';

export {
  renderPowerShell,
} from './templates/powershell.js';

export {
  renderElvish,
} from './templates/elvish.js';

export {
  SHELL_INFO,
  type ShellKind,
  type RenderOptions,
  type ShellInfo,
} from './templates/index.js';
