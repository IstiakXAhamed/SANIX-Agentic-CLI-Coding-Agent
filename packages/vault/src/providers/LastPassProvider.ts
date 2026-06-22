/**
 * @file LastPassProvider.ts
 * @description LastPass vault provider via the `lpass` CLI.
 *
 * Wraps `lpass login`, `lpass ls`, `lpass show`, `lpass add`,
 * `lpass edit`, `lpass rm`, `lpass logout`.
 *
 * Authentication requires `lpass login <email>` (interactive, one-time)
 * then the master password is supplied per-call via `LPASS_DISABLE_PINENTRY=1`
 * + stdin.
 */

import { BaseCLIVault } from './BaseCLIVault.js';
import type { SecretEntry, VaultProviderOptions } from '../types.js';

interface LpEntry {
  id: string;
  name: string;
  fullname: string;
  username?: string;
  password?: string;
  url?: string;
  notes?: string;
  totp?: string;
  group?: string;
}

/** LastPass vault provider. */
export class LastPassProvider extends BaseCLIVault {
  public readonly kind = 'lastpass' as const;
  public readonly displayName = 'LastPass';
  protected readonly binaryName = 'lpass';
  private username: string | null = null;

  /** Authenticate — log in. */
  public async authenticate(opts: VaultProviderOptions): Promise<void> {
    this.authOpts = opts;
    if (opts.cliPath) this.cliPath = opts.cliPath;
    const account = opts.account ?? opts.username;
    if (!account) throw new Error('LastPass: account (email) required');
    this.username = account;
    // Check current status.
    try {
      await this.execCLI(['status'], { timeoutMs: 5000 });
      this.unlocked = true;
      return;
    } catch {
      // not logged in — proceed
    }
    if (!opts.password) throw new Error('LastPass: master password required to log in');
    process.env.LPASS_DISABLE_PINENTRY = '1';
    await this.execCLI(['login', '--trust', '--force', account], { stdin: opts.password });
    this.unlocked = true;
  }

  /** List all entries. */
  public async list(): Promise<SecretEntry[]> {
    const { stdout } = await this.execCLI(['ls', '--format=%ai|%an|%Au|%Ap|%aU|%aN|%ag']);
    return stdout
      .trim()
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((line) => this.parseListLine(line));
  }

  /** Get a single entry. */
  public async get(id: string): Promise<SecretEntry | null> {
    try {
      const { stdout } = await this.execCLI(['show', '--all', id], { env: { LPASS_DISABLE_PINENTRY: '1' } });
      return this.parseShow(id, stdout);
    } catch {
      return null;
    }
  }

  /** Create a new entry. */
  public async create(entry: Omit<SecretEntry, 'id' | 'provider'>): Promise<string> {
    const args = ['add', '--non-interactive', '--sync=now', entry.title];
    const stdin = [`Username: ${entry.username ?? ''}`, `Password: ${entry.password ?? ''}`, `Url: ${entry.url ?? ''}`, `Notes: ${entry.notes ?? ''}`].join('\n');
    await this.execCLI(args, { stdin });
    // lpass doesn't return the id; re-list to find it.
    const items = await this.list();
    return items.find((i) => i.title === entry.title)?.id ?? entry.title;
  }

  /** Update an entry. */
  public async update(id: string, patch: Partial<Omit<SecretEntry, 'id' | 'provider'>>): Promise<void> {
    const args = ['edit', '--non-interactive', '--sync=now', id];
    const stdin = [
      patch.username !== undefined ? `Username: ${patch.username}` : '',
      patch.password !== undefined ? `Password: ${patch.password}` : '',
      patch.url !== undefined ? `Url: ${patch.url}` : '',
      patch.notes !== undefined ? `Notes: ${patch.notes}` : '',
    ].filter(Boolean).join('\n');
    if (stdin) await this.execCLI(args, { stdin });
  }

  /** Delete an entry. */
  public async delete(id: string): Promise<void> {
    await this.execCLI(['rm', '--sync=now', id]);
  }

  /** Log out. */
  public async lock(): Promise<void> {
    try { await this.execCLI(['logout', '--force']); } catch { /* ignore */ }
    this.unlocked = false;
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  private parseListLine(line: string): SecretEntry {
    const [id, name, username, , url, notes, group] = line.split('|');
    return {
      id,
      title: name,
      username,
      url,
      notes,
      folder: group,
      provider: 'lastpass',
    };
  }

  private parseShow(id: string, stdout: string): SecretEntry {
    const lines = stdout.split(/\r?\n/);
    const get = (key: string) => lines.find((l) => l.startsWith(`${key}: `))?.slice(`${key}: `.length);
    return {
      id,
      title: get('Name') ?? id,
      username: get('Username'),
      password: get('Password'),
      url: get('URL'),
      notes: get('Notes'),
      totp: get('totp'),
      folder: get('Group'),
      provider: 'lastpass',
    };
  }
}
