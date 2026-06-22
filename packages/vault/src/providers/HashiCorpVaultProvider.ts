/**
 * @file HashiCorpVaultProvider.ts
 * @description HashiCorp Vault provider via the `vault` CLI (HTTP API).
 *
 * Wraps `vault kv get`, `vault kv list`, `vault kv put`,
 * `vault kv delete`, and `vault login`.
 *
 * Vault stores secrets as key-value maps at a path. Each path becomes
 * a `SecretEntry` whose `fields` are the KV map.
 */

import { BaseCLIVault } from './BaseCLIVault.js';
import type { SecretEntry, VaultProviderOptions } from '../types.js';

interface KvList {
  data?: { keys?: string[] };
}

interface KvSecret {
  data?: {
    data?: Record<string, unknown>;
    metadata?: { created_time?: string; updated_time?: string };
  };
}

/** HashiCorp Vault provider. */
export class HashiCorpVaultProvider extends BaseCLIVault {
  public readonly kind = 'hashicorp' as const;
  public readonly displayName = 'HashiCorp Vault';
  protected readonly binaryName = 'vault';
  private mountPath = 'secret';
  private recursive = true;

  /** Authenticate — set address + token. */
  public async authenticate(opts: VaultProviderOptions): Promise<void> {
    this.authOpts = opts;
    if (opts.cliPath) this.cliPath = opts.cliPath;
    if (opts.address) process.env.VAULT_ADDR = opts.address;
    if (opts.token) process.env.VAULT_TOKEN = opts.token;
    if (!process.env.VAULT_TOKEN && !opts.token) {
      throw new Error('HashiCorp Vault: token required (set token or VAULT_TOKEN env)');
    }
    // Verify connectivity.
    try {
      await this.execCLI(['token', 'lookup'], { timeoutMs: 5000 });
      this.unlocked = true;
    } catch (e) {
      throw new Error(`HashiCorp Vault: authentication failed — ${(e as Error).message}`);
    }
  }

  /** Set the KV mount path (default `secret`). */
  public setMount(mount: string): void {
    this.mountPath = mount;
  }

  /** List all secrets (recursive walk of the KV mount). */
  public async list(): Promise<SecretEntry[]> {
    const out: SecretEntry[] = [];
    await this.walk(this.mountPath, out);
    return out;
  }

  /** Get a single secret by path. */
  public async get(id: string): Promise<SecretEntry | null> {
    try {
      const { stdout } = await this.execCLI(['kv', 'get', '-format=json', id]);
      const secret = this.parseJSON<KvSecret>(stdout, `kv get ${id}`);
      const data = secret.data?.data ?? {};
      return this.toEntry(id, data, secret.data?.metadata);
    } catch {
      return null;
    }
  }

  /** Create (put) a secret. */
  public async create(entry: Omit<SecretEntry, 'id' | 'provider'>): Promise<string> {
    const path = entry.title.startsWith(this.mountPath) ? entry.title : `${this.mountPath}/${entry.title}`;
    const kv: Record<string, string> = {};
    if (entry.username) kv.username = entry.username;
    if (entry.password) kv.password = entry.password;
    if (entry.url) kv.url = entry.url;
    if (entry.notes) kv.notes = entry.notes;
    if (entry.totp) kv.totp = entry.totp;
    for (const f of entry.fields ?? []) kv[f.name] = f.value;
    const args = ['kv', 'put', path];
    for (const [k, v] of Object.entries(kv)) args.push(`${k}=${v}`);
    await this.execCLI(args);
    return path;
  }

  /** Update (patch) a secret. */
  public async update(id: string, patch: Partial<Omit<SecretEntry, 'id' | 'provider'>>): Promise<void> {
    const args = ['kv', 'patch', id];
    if (patch.username) args.push(`username=${patch.username}`);
    if (patch.password) args.push(`password=${patch.password}`);
    if (patch.url) args.push(`url=${patch.url}`);
    if (patch.notes) args.push(`notes=${patch.notes}`);
    await this.execCLI(args);
  }

  /** Delete a secret. */
  public async delete(id: string): Promise<void> {
    await this.execCLI(['kv', 'delete', id]);
  }

  /** Lock — clear the token. */
  public async lock(): Promise<void> {
    delete process.env.VAULT_TOKEN;
    this.unlocked = false;
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  private async walk(path: string, out: SecretEntry[]): Promise<void> {
    let result: KvList;
    try {
      const { stdout } = await this.execCLI(['kv', 'list', '-format=json', path]);
      result = this.parseJSON<KvList>(stdout, `kv list ${path}`);
    } catch {
      return; // path doesn't exist or no permission
    }
    const keys = result.data?.keys ?? [];
    for (const key of keys) {
      const fullPath = `${path}/${key}`;
      if (key.endsWith('/')) {
        if (this.recursive) await this.walk(fullPath.slice(0, -1), out);
      } else {
        const entry = await this.get(fullPath);
        if (entry) out.push(entry);
      }
    }
  }

  private toEntry(path: string, data: Record<string, unknown>, metadata?: { created_time?: string; updated_time?: string }): SecretEntry {
    const username = typeof data.username === 'string' ? data.username : undefined;
    const password = typeof data.password === 'string' ? data.password : undefined;
    const url = typeof data.url === 'string' ? data.url : undefined;
    const notes = typeof data.notes === 'string' ? data.notes : undefined;
    const totp = typeof data.totp === 'string' ? data.totp : undefined;
    const fields = Object.entries(data)
      .filter(([k]) => !['username', 'password', 'url', 'notes', 'totp'].includes(k))
      .map(([name, value]) => ({ name, value: String(value), type: 'text' as const }));
    return {
      id: path,
      title: path.split('/').pop() ?? path,
      username,
      password,
      url,
      notes,
      totp,
      fields,
      folder: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : undefined,
      createdAt: metadata?.created_time,
      updatedAt: metadata?.updated_time,
      provider: 'hashicorp',
    };
  }
}
