/**
 * @file types.ts
 * @description Shared types for `@sanix/vault` — secret vault integration.
 *
 * @packageDocumentation
 */

/**
 * Supported vault provider kinds.
 */
export type VaultProviderKind =
  | '1password'
  | 'bitwarden'
  | 'hashicorp'
  | 'lastpass'
  | 'keepass'
  | 'pass'
  | 'json';

/** A single secret entry in the unified vault model. */
export interface SecretEntry {
  /** Stable id within the provider (e.g. item uuid). */
  id: string;
  /** Human-friendly title. */
  title: string;
  /** Username / account field, if applicable. */
  username?: string;
  /** Password field. */
  password?: string;
  /** URL / URI. */
  url?: string;
  /** Free-form notes. */
  notes?: string;
  /** TOTP secret (otpauth:// URI or base32). */
  totp?: string;
  /** Custom fields. */
  fields?: Array<{ name: string; value: string; type?: SecretFieldType }>;
  /** Tags / categories. */
  tags?: string[];
  /** Folder / vault / collection name. */
  folder?: string;
  /** Created-at (ISO). */
  createdAt?: string;
  /** Updated-at (ISO). */
  updatedAt?: string;
  /** Provider that owns this entry. */
  provider: VaultProviderKind;
}

/** Custom field type. */
export type SecretFieldType = 'text' | 'password' | 'email' | 'url' | 'otp' | 'concealed' | 'file';

/**
 * Options for a vault provider.
 */
export interface VaultProviderOptions {
  /** Master password / account password. */
  password?: string;
  /** Path to the vault file (for KeePass / JSON providers). */
  filePath?: string;
  /** Vault address (for HashiCorp Vault). */
  address?: string;
  /** Token (for HashiCorp Vault). */
  token?: string;
  /** Account / email / sign-in address. */
  account?: string;
  /** Secret key (1Password secret key). */
  secretKey?: string;
  /** Domain (for 1Password / LastPass). */
  domain?: string;
  /** Path to the CLI binary (override `op`, `bw`, …). */
  cliPath?: string;
  /** Session token / env var passthrough. */
  session?: string;
  /** GPG key id (for `pass`). */
  gpgKey?: string;
}

/**
 * A vault provider — one implementation per backend.
 */
export interface VaultProvider {
  /** Provider kind. */
  readonly kind: VaultProviderKind;
  /** Friendly display name. */
  readonly displayName: string;
  /** Whether the provider is available (CLI installed / file present). */
  isAvailable(): Promise<boolean>;
  /** Authenticate / unlock the vault. */
  authenticate(opts: VaultProviderOptions): Promise<void>;
  /** List all secret entries (without revealing password values by default). */
  list(): Promise<SecretEntry[]>;
  /** Get a single secret by id. */
  get(id: string): Promise<SecretEntry | null>;
  /** Create a new secret. Returns the new id. */
  create(entry: Omit<SecretEntry, 'id' | 'provider'>): Promise<string>;
  /** Update an existing secret. */
  update(id: string, patch: Partial<Omit<SecretEntry, 'id' | 'provider'>>): Promise<void>;
  /** Delete a secret. */
  delete(id: string): Promise<void>;
  /** Lock / sign out. */
  lock(): Promise<void>;
  /** Is the provider currently unlocked? */
  isUnlocked(): boolean;
}

/**
 * Options for the `VaultManager`.
 */
export interface VaultManagerOptions {
  /** Default provider kind. */
  defaultProvider?: VaultProviderKind;
  /** Cache TTL in ms (0 = no cache). Default `30000`. */
  cacheTtlMs?: number;
  /** Mask secrets in logs. Default `true`. */
  maskInLogs?: boolean;
}

/**
 * Result of a lookup.
 */
export interface LookupResult {
  entry: SecretEntry;
  provider: VaultProviderKind;
  cached: boolean;
}

/** Error thrown by vault providers. */
export class VaultError extends Error {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'VaultError';
    this.code = code;
  }
}
