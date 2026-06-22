/**
 * @file PassProvider.ts
 * @description The Unix `pass` password store provider.
 *
 * `pass` stores each secret as a GPG-encrypted file under
 * `~/.password-store/`. The first line of each file is the password;
 * subsequent lines are free-form metadata (often `url:`, `user:`,
 * `otpauth:`).
 *
 * Wraps `pass ls`, `pass show`, `pass insert`, `pass edit`, `pass rm`.
 */

import { BaseCLIVault } from './BaseCLIVault.js';
import type { SecretEntry, VaultProviderOptions } from '../types.js';

/** `pass` provider. */
export class PassProvider extends BaseCLIVault {
  public readonly kind = 'pass' as const;
  public readonly displayName = 'pass';
  protected readonly binaryName = 'pass';

  /** Authentication is implicit (GPG agent / keyring). Verify setup. */
  public async authenticate(opts: VaultProviderOptions): Promise<void> {
    this.authOpts = opts;
    if (opts.cliPath) this.cliPath = opts.cliPath;
    if (opts.gpgKey) process.env.PASSWORD_STORE_KEY = opts.gpgKey;
    try {
      await this.execCLI(['ls'], { timeoutMs: 5000 });
      this.unlocked = true;
    } catch (e) {
      throw new Error(`pass: store not initialised — ${(e as Error).message}`);
    }
  }

  /** List all entries (walks the tree). */
  public async list(): Promise<SecretEntry[]> {
    const { stdout } = await this.execCLI(['ls', '--flat']);
    return stdout.trim().split(/\r?\n/).filter((l) => l.trim()).map((path) => ({
      id: path,
      title: path.split('/').pop() ?? path,
      folder: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : undefined,
      provider: 'pass' as const,
    }));
  }

  /** Get a single entry. */
  public async get(id: string): Promise<SecretEntry | null> {
    try {
      const { stdout } = await this.execCLI(['show', id]);
      return this.parse(id, stdout);
    } catch {
      return null;
    }
  }

  /** Create (insert) a new entry. */
  public async create(entry: Omit<SecretEntry, 'id' | 'provider'>): Promise<string> {
    const path = entry.folder ? `${entry.folder}/${entry.title}` : entry.title;
    const lines = [entry.password ?? ''];
    if (entry.username) lines.push(`user: ${entry.username}`);
    if (entry.url) lines.push(`url: ${entry.url}`);
    if (entry.notes) lines.push(entry.notes);
    if (entry.totp) lines.push(`otpauth: ${entry.totp}`);
    await this.execCLI(['insert', '-m', '-f', path], { stdin: lines.join('\n') });
    return path;
  }

  /** Update an entry (rewrite). */
  public async update(id: string, patch: Partial<Omit<SecretEntry, 'id' | 'provider'>>): Promise<void> {
    const existing = await this.get(id);
    if (!existing) throw new Error(`pass: entry ${id} not found`);
    const merged: Omit<SecretEntry, 'id' | 'provider'> = {
      title: patch.title ?? existing.title,
      username: patch.username ?? existing.username,
      password: patch.password ?? existing.password,
      url: patch.url ?? existing.url,
      notes: patch.notes ?? existing.notes,
      totp: patch.totp ?? existing.totp,
      folder: existing.folder,
    };
    await this.create(merged);
  }

  /** Delete an entry. */
  public async delete(id: string): Promise<void> {
    await this.execCLI(['rm', '-f', id]);
  }

  /** Lock — no-op (GPG agent handles locking). */
  public async lock(): Promise<void> {
    this.unlocked = false;
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  private parse(id: string, stdout: string): SecretEntry {
    const lines = stdout.split(/\r?\n/);
    const password = lines[0];
    const meta: Record<string, string | undefined> = {};
    for (let i = 1; i < lines.length; i++) {
      const m = /^(url|user|username|otpauth|totp|notes):\s*(.*)$/i.exec(lines[i]);
      if (m) {
        const key = m[1].toLowerCase();
        const val = m[2];
        if (key === 'user' || key === 'username') meta.username = val;
        else if (key === 'url') meta.url = val;
        else if (key === 'otpauth' || key === 'totp') meta.totp = val;
        else meta.notes = val;
      }
    }
    return {
      id,
      title: id.split('/').pop() ?? id,
      password,
      username: meta.username,
      url: meta.url,
      totp: meta.totp,
      notes: meta.notes,
      folder: id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : undefined,
      provider: 'pass',
    };
  }
}
