/**
 * @file index.ts
 * @description Barrel re-export for `@sanix/vault`.
 *
 * @packageDocumentation
 */

export {
  VaultManager,
} from './VaultManager.js';

export {
  OnePasswordProvider,
} from './providers/OnePasswordProvider.js';

export {
  BitwardenProvider,
} from './providers/BitwardenProvider.js';

export {
  HashiCorpVaultProvider,
} from './providers/HashiCorpVaultProvider.js';

export {
  LastPassProvider,
} from './providers/LastPassProvider.js';

export {
  KeePassProvider,
} from './providers/KeePassProvider.js';

export {
  PassProvider,
} from './providers/PassProvider.js';

export {
  JSONProvider,
} from './providers/JSONProvider.js';

export {
  BaseCLIVault,
  type CLIResult,
} from './providers/BaseCLIVault.js';

export type {
  VaultProviderKind,
  SecretEntry,
  SecretFieldType,
  VaultProviderOptions,
  VaultProvider,
  VaultManagerOptions,
  LookupResult,
  VaultError,
} from './types.js';

export { VaultError } from './types.js';
