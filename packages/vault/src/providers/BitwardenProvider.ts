/**
 * @file BitwardenProvider.ts
 * @description Bitwarden vault provider via the `bw` CLI.
 *
 * Wraps `bw login`, `bw unlock`, `bw list items`, `bw get item`,
 * `bw create item`, `bw edit item`, `bw delete item`, `bw lock`.
 *
 * Authentication requires `bw login` (interactive, one-time) then
 * `bw unlock` per session — the unlock password is passed via stdin
 * and the resulting session token is reused for subsequent calls.
 */

import { BaseCLIVault } from './BaseCLIVault.js';
import type { SecretEntry, VaultProviderOptions } from '../types.js';

interface BwItem {
  id: string;
  name: string;
  folderId?: string;
  login?: { username?: string; password?: string; uris?: Array<{ uri: string }>; totp?: string };
  notes?: string;
  fields?: Array<{ name: string; value: string; type: number }>;
  collectionIds?: string[];
}

/** Bitwarden vault provider. */
export class BitwardenProvider extends BaseCLIVault {
  public readonly kind = 'bitwarden' as const;
  public readonly displayName = 'Bitwarden';
  protected readonly binaryName = 'bw';
  private session: string | null = null;

  /** Authenticate — unlock the vault. */
  public async authenticate(opts: VaultProviderOptions): Promise<void> {
    this.authOpts = opts;
    if (opts.cliPath) this.cliPath = opts.cliPath;
    if (opts.session) {
      this.session = opts.session;
      this.unlocked = true;
      return;
    }
    if (!opts.password) throw new Error('Bitwarden: password required to unlock');
    const { stdout } = await this.execCLI(['unlock', '--raw'], { stdin: opts.password });
    this.session = stdout.trim();
    if (!this.session) throw new Error('Bitwarden: unlock failed (no session token)');
    this.unlocked = true;
  }

  /** List all items. */
  public async list(): Promise<SecretEntry[]> {
    const { stdout } = await this.execCLI(['list', 'items'], { env: this.env() });
    const items = this.parseJSON<BwItem[] | { data: BwItem[] }>(stdout, 'list items');
    const arr = Array.isArray(items) ? items : (items.data ?? []);
    return arr.map((it) => this.toEntry(it));
  }

  /** Get a single item. */
  public async get(id: string): Promise<SecretEntry | null> {
    try {
      const { stdout } = await this.execCLI(['get', 'item', id], { env: this.env() });
      return this.toEntry(this.parseJSON<BwItem>(stdout, `get item ${id}`));
    } catch {
      return null;
    }
  }

  /** Create a new item. */
  public async create(entry: Omit<SecretEntry, 'id' | 'provider'>): Promise<string> {
    const payload = {
      type: 1, // Login
      name: entry.title,
      notes: entry.notes ?? null,
      login: {
        username: entry.username ?? null,
        password: entry.password ?? null,
        uris: entry.url ? [{ uri: entry.url }] : [],
        totp: entry.totp ?? null,
      },
    };
    const { stdout } = await this.execCLI(['create', 'item', JSON.stringify(payload)], { env: this.env() });
    return this.parseJSON<BwItem>(stdout, 'create item').id;
  }

  /** Update an item. */
  public async update(id: string, patch: Partial<Omit<SecretEntry, 'id' | 'provider'>>): Promise<void> {
    const existing = await this.get(id);
    if (!existing) throw new Error(`Bitwarden: item ${id} not found`);
    const payload = {
      type: 1,
      name: patch.title ?? existing.title,
      notes: patch.notes ?? existing.notes ?? null,
      login: {
        username: patch.username ?? existing.username ?? null,
        password: patch.password ?? existing.password ?? null,
        uris: patch.url ? [{ uri: patch.url }] : (existing.url ? [{ uri: existing.url }] : []),
        totp: patch.totp ?? existing.totp ?? null,
      },
    };
    await this.execCLI(['edit', 'item', id, JSON.stringify(payload)], { env: this.env() });
  }

  /** Delete an item. */
  public async delete(id: string): Promise<void> {
    await this.execCLI(['delete', 'item', id], { env: this.env() });
  }

  /** Lock the vault. */
  public async lock(): Promise<void> {
    try { await this.execCLI(['lock']); } catch { /* ignore */ }
    this.session = null;
    this.unlocked = false;
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  private env(): Record<string, string> {
    return this.session ? { BW_SESSION: this.session } : {};
  }

  private toEntry(it: BwItem): SecretEntry {
    return {
      id: it.id,
      title: it.name,
      username: it.login?.username,
      password: it.login?.password,
      url: it.login?.uris?.[0]?.uri,
      totp: it.login?.totp,
      notes: it.notes,
      fields: it.fields?.map((f) => ({ name: f.name, value: f.value, type: f.type === 1 ? 'password' : 'text' })),
      folder: it.folderId,
      tags: it.collectionIds,
      provider: 'bitwarden',
    };
  }
}
