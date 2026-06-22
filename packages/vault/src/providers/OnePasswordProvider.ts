/**
 * @file OnePasswordProvider.ts
 * @description 1Password vault provider via the `op` CLI.
 *
 * Wraps `op item list`, `op item get`, `op item create`, `op item edit`,
 * `op item delete`, and `op signin` / `op signout`.
 *
 * Authentication modes:
 *   - Biometric (`op` ≥ 2.0 with Touch ID / Windows Hello) — no password needed.
 *   - Service account token (set via `OP_SERVICE_ACCOUNT_TOKEN`).
 *   - Account + secret key + master password (interactive).
 */

import { BaseCLIVault } from './BaseCLIVault.js';
import type { SecretEntry, VaultProviderOptions } from '../types.js';

interface OpItem {
  id: string;
  title: string;
  vault?: { name?: string };
  category?: string;
  urls?: Array<{ href: string }>;
  fields?: Array<{ id: string; label: string; value: string; reference?: string; type?: string }>;
  created_at?: string;
  updated_at?: string;
  tags?: string[];
}

/** 1Password vault provider. */
export class OnePasswordProvider extends BaseCLIVault {
  public readonly kind = '1password' as const;
  public readonly displayName = '1Password';
  protected readonly binaryName = 'op';

  /**
   * Authenticate. With biometric / service-account mode, this is a no-op.
   */
  public async authenticate(opts: VaultProviderOptions): Promise<void> {
    this.authOpts = opts;
    if (opts.cliPath) this.cliPath = opts.cliPath;
    // Service account — set env, no signin needed.
    if (process.env.OP_SERVICE_ACCOUNT_TOKEN || opts.token) {
      if (opts.token) process.env.OP_SERVICE_ACCOUNT_TOKEN = opts.token;
      this.unlocked = true;
      return;
    }
    // Try `op whoami` — if it succeeds, a session is already active.
    try {
      await this.execCLI(['whoami'], { timeoutMs: 5000 });
      this.unlocked = true;
      return;
    } catch {
      // fall through to interactive signin.
    }
    if (opts.account && opts.password) {
      // `op signin` is interactive; we pass account shorthand + use stdin.
      // Note: real interactive signin requires TTY; we set the env var instead.
      const session = await this.runSignin(opts.account, opts.password, opts.secretKey, opts.domain);
      if (session) process.env.OP_SESSION_ACCOUNT = session;
      this.unlocked = true;
      return;
    }
    throw new Error('1Password: provide a service account token, or account + password (with biometric enabled, no auth is needed)');
  }

  /** List all items. */
  public async list(): Promise<SecretEntry[]> {
    const { stdout } = await this.execCLI(['item', 'list', '--format=json']);
    const items = this.parseJSON<OpItem[]>(stdout, 'item list');
    return items.map((it) => this.toEntry(it));
  }

  /** Get a single item. */
  public async get(id: string): Promise<SecretEntry | null> {
    try {
      const { stdout } = await this.execCLI(['item', 'get', id, '--format=json']);
      return this.toEntry(this.parseJSON<OpItem>(stdout, `item get ${id}`));
    } catch {
      return null;
    }
  }

  /** Create a new item. */
  public async create(entry: Omit<SecretEntry, 'id' | 'provider'>): Promise<string> {
    const args = ['item', 'create', '--category=Login', `--title=${entry.title}`];
    if (entry.username) args.push(`username=${entry.username}`);
    if (entry.password) args.push(`password=${entry.password}`);
    if (entry.url) args.push(`url=${entry.url}`);
    if (entry.notes) args.push(`notes=${entry.notes}`);
    const { stdout } = await this.execCLI(args);
    const created = this.parseJSON<OpItem>(stdout, 'item create');
    return created.id;
  }

  /** Update an item. */
  public async update(id: string, patch: Partial<Omit<SecretEntry, 'id' | 'provider'>>): Promise<void> {
    const args = ['item', 'edit', id];
    if (patch.title) args.push(`--title=${patch.title}`);
    if (patch.username) args.push(`username=${patch.username}`);
    if (patch.password) args.push(`password=${patch.password}`);
    if (patch.url) args.push(`url=${patch.url}`);
    await this.execCLI(args);
  }

  /** Delete an item. */
  public async delete(id: string): Promise<void> {
    await this.execCLI(['item', 'delete', id, '--archive']);
  }

  /** Lock — sign out. */
  public async lock(): Promise<void> {
    try { await this.execCLI(['signout']); } catch { /* ignore */ }
    this.unlocked = false;
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  private async runSignin(account: string, password: string, secretKey?: string, domain?: string): Promise<string | null> {
    // `op signin` is interactive; we emulate by passing env + stdin.
    // For non-TTY use, set OP_SERVICE_ACCOUNT_TOKEN or use biometric.
    const args = secretKey ? ['signin', account, secretKey, password] : ['signin', account, password];
    if (domain) args.push(`--signin-address=${domain}`);
    try {
      const { stdout } = await this.execCLI(args, { stdin: password });
      const match = /export OP_SESSION_[^=]+="([^"]+)"/.exec(stdout);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  private toEntry(it: OpItem): SecretEntry {
    const fields = it.fields ?? [];
    const usernameField = fields.find((f) => f.id === 'username' || f.label?.toLowerCase() === 'username');
    const passwordField = fields.find((f) => f.id === 'password' || f.label?.toLowerCase() === 'password');
    return {
      id: it.id,
      title: it.title,
      username: usernameField?.value,
      password: passwordField?.value,
      url: it.urls?.[0]?.href,
      notes: fields.find((f) => f.id === 'notes')?.value,
      totp: fields.find((f) => f.type === 'OTP' || f.label?.toLowerCase() === 'one-time password')?.value,
      fields: fields.filter((f) => f !== usernameField && f !== passwordField).map((f) => ({ name: f.label, value: f.value, type: 'text' })),
      tags: it.tags,
      folder: it.vault?.name,
      createdAt: it.created_at,
      updatedAt: it.updated_at,
      provider: '1password',
    };
  }
}
