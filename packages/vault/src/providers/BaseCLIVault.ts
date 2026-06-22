/**
 * @file BaseCLIVault.ts
 * @description Shared base class for CLI-backed vault providers
 * (1Password, Bitwarden, HashiCorp, LastPass, pass).
 *
 * Encapsulates:
 *   - `execCLI` — run the provider's CLI with args, return stdout.
 *   - `ensureCLI` — verify the binary is installed.
 *   - `parseJSON` — safe JSON.parse with a helpful error.
 *   - masking helpers.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SecretEntry, VaultProvider, VaultProviderKind, VaultProviderOptions } from './types.js';

const execFileAsync = promisify(execFile);

/** Result of a CLI invocation. */
export interface CLIResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Base class for CLI-backed vault providers.
 */
export abstract class BaseCLIVault implements VaultProvider {
  /** Provider kind. */
  public abstract readonly kind: VaultProviderKind;
  /** Display name. */
  public abstract readonly displayName: string;
  /** Default CLI binary name. */
  protected abstract readonly binaryName: string;

  /** Cached CLI path override. */
  protected cliPath: string | null = null;
  /** Whether the provider is currently unlocked. */
  protected unlocked = false;
  /** Cached auth options. */
  protected authOpts: VaultProviderOptions = {};

  /** Whether the provider is available (CLI installed). */
  public async isAvailable(): Promise<boolean> {
    try {
      await this.execCLI(['--version'], { timeoutMs: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  /** Authenticate / unlock — subclasses override. */
  public abstract authenticate(opts: VaultProviderOptions): Promise<void>;

  /** List secrets — subclasses override. */
  public abstract list(): Promise<SecretEntry[]>;

  /** Get a single secret — subclasses override. */
  public abstract get(id: string): Promise<SecretEntry | null>;

  /** Create a secret — subclasses override. */
  public abstract create(entry: Omit<SecretEntry, 'id' | 'provider'>): Promise<string>;

  /** Update a secret — subclasses override. */
  public abstract update(id: string, patch: Partial<Omit<SecretEntry, 'id' | 'provider'>>): Promise<void>;

  /** Delete a secret — subclasses override. */
  public abstract delete(id: string): Promise<void>;

  /** Lock the vault. */
  public async lock(): Promise<void> {
    this.unlocked = false;
  }

  /** Is the provider currently unlocked? */
  public isUnlocked(): boolean {
    return this.unlocked;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Run the provider's CLI with args.
   * @param args CLI args.
   * @param opts Execution options.
   */
  protected async execCLI(args: string[], opts: { timeoutMs?: number; stdin?: string; env?: Record<string, string> } = {}): Promise<CLIResult> {
    const bin = this.cliPath ?? this.binaryName;
    try {
      const { stdout, stderr } = await execFileAsync(bin, args, {
        timeout: opts.timeoutMs ?? 30000,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, ...opts.env },
        input: opts.stdin,
      });
      return { stdout, stderr, code: 0 };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; code?: number | string; message: string };
      const code = typeof err.code === 'number' ? err.code : -1;
      const msg = err.stderr || err.message;
      throw new Error(`${this.displayName} CLI failed (code ${code}): ${msg}`);
    }
  }

  /**
   * Parse JSON from CLI stdout with a helpful error.
   */
  protected parseJSON<T>(stdout: string, context: string): T {
    const trimmed = stdout.trim();
    if (!trimmed) {
      throw new Error(`${this.displayName}: empty output from ${context}`);
    }
    try {
      return JSON.parse(trimmed) as T;
    } catch (e) {
      throw new Error(`${this.displayName}: invalid JSON from ${context}: ${(e as Error).message}`);
    }
  }

  /**
   * Mask a secret value for logging.
   */
  protected mask(value: string | undefined): string {
    if (!value) return '';
    if (value.length <= 4) return '****';
    return value.slice(0, 2) + '*'.repeat(Math.max(4, value.length - 4)) + value.slice(-2);
  }
}
