/**
 * @file KeePassProvider.ts
 * @description KeePass vault provider (.kdbx files) via `kdbxweb`
 * (dynamic import) or the `keepassxc-cli` binary.
 *
 * Two modes:
 *   - **Native** (`kdbxweb` installed): read + write the .kdbx file
 *     directly in-process — no external CLI needed.
 *   - **CLI** (`keepassxc-cli` installed): invoke `keepassxc-cli`
 *     (`ls`, `show`, `add`, `edit`, `rm`) for each operation.
 *
 * Authentication requires the master password + the .kdbx file path.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { BaseCLIVault } from './BaseCLIVault.js';
import type { SecretEntry, VaultProviderOptions } from '../types.js';

interface KdbxEntry {
  uuid: { id?: string };
  fields: Record<string, { value?: unknown }>;
  parentGroup?: { name?: string };
}

interface KdbxDb {
  getGroups: () => Array<{ entries: KdbxEntry[]; name: string }>;
  getDefaultGroup: () => { entries: KdbxEntry[]; name: string };
  createEntry: (group: unknown, preset: unknown) => KdbxEntry;
  save: () => Promise<Uint8Array>;
}

interface KdbxModule {
  Kdbx: { load: (data: ArrayBuffer, credentials: unknown) => Promise<KdbxDb>; create: (credentials: unknown, name: string) => KdbxDb };
  Credentials: { new (password: { password: string }): unknown };
}

/** KeePass vault provider. */
export class KeePassProvider extends BaseCLIVault {
  public readonly kind = 'keepass' as const;
  public readonly displayName = 'KeePass';
  protected readonly binaryName = 'keepassxc-cli';
  private dbPath: string | null = null;
  private masterPassword: string | null = null;
  private nativeModule: KdbxModule | null = null;
  private db: KdbxDb | null = null;

  /** Authenticate — unlock the .kdbx file. */
  public async authenticate(opts: VaultProviderOptions): Promise<void> {
    this.authOpts = opts;
    if (opts.cliPath) this.cliPath = opts.cliPath;
    if (!opts.filePath) throw new Error('KeePass: filePath required');
    if (!opts.password) throw new Error('KeePass: master password required');
    this.dbPath = opts.filePath;
    this.masterPassword = opts.password;
    // Try native mode first.
    try {
      const mod = await import('kdbxweb' as string).catch(() => null);
      const candidate = mod as unknown as KdbxModule | null;
      if (candidate?.Kdbx && candidate?.Credentials) {
        this.nativeModule = candidate;
        const data = await readFile(opts.filePath);
        const creds = new candidate.Credentials({ password: opts.password });
        this.db = await candidate.Kdbx.load(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), creds);
        this.unlocked = true;
        return;
      }
    } catch {
      this.nativeModule = null;
    }
    // Fall back to CLI.
    try {
      await this.execCLI(['ls', '-q', opts.filePath], { stdin: opts.password, timeoutMs: 10000 });
      this.unlocked = true;
    } catch (e) {
      throw new Error(`KeePass: failed to unlock ${opts.filePath} — ${(e as Error).message}`);
    }
  }

  /** List all entries. */
  public async list(): Promise<SecretEntry[]> {
    if (this.nativeMode()) return this.listNative();
    const { stdout } = await this.execCLI(['ls', '-f', '%T|%U|%P|%url|%N|%g', this.dbPath!], { stdin: this.masterPassword! });
    return stdout.trim().split(/\r?\n/).filter((l) => l.trim()).map((line) => this.parseListLine(line));
  }

  /** Get a single entry. */
  public async get(id: string): Promise<SecretEntry | null> {
    if (this.nativeMode()) return this.getNative(id);
    try {
      const { stdout } = await this.execCLI(['show', '-q', this.dbPath!, id], { stdin: this.masterPassword! });
      return this.parseShow(id, stdout);
    } catch {
      return null;
    }
  }

  /** Create a new entry. */
  public async create(entry: Omit<SecretEntry, 'id' | 'provider'>): Promise<string> {
    if (this.nativeMode()) return this.createNative(entry);
    const args = ['add', '-q', this.dbPath!, entry.title];
    if (entry.username) args.push('-u', entry.username);
    if (entry.password) args.push('-p', entry.password);
    if (entry.url) args.push('--url', entry.url);
    await this.execCLI(args, { stdin: this.masterPassword! });
    return entry.title;
  }

  /** Update an entry. */
  public async update(id: string, patch: Partial<Omit<SecretEntry, 'id' | 'provider'>>): Promise<void> {
    if (this.nativeMode()) {
      await this.updateNative(id, patch);
      return;
    }
    const args = ['edit', '-q', this.dbPath!, id];
    if (patch.username) args.push('-u', patch.username);
    if (patch.password) args.push('-p', patch.password);
    if (patch.url) args.push('--url', patch.url);
    await this.execCLI(args, { stdin: this.masterPassword! });
  }

  /** Delete an entry. */
  public async delete(id: string): Promise<void> {
    if (this.nativeMode()) {
      // kdbxweb deletion requires direct API; fall through to CLI if available.
    }
    await this.execCLI(['rm', '-q', this.dbPath!, id], { stdin: this.masterPassword! });
  }

  /** Lock — clear in-memory db. */
  public async lock(): Promise<void> {
    this.db = null;
    this.masterPassword = null;
    this.unlocked = false;
  }

  /** Save the native db back to disk (after create/update). */
  public async save(): Promise<void> {
    if (!this.nativeMode() || !this.db || !this.dbPath) return;
    const data = await this.db.save();
    await writeFile(this.dbPath, Buffer.from(data));
  }

  // ─── Native mode helpers ──────────────────────────────────────────────────

  private nativeMode(): boolean {
    return this.nativeModule !== null && this.db !== null;
  }

  private listNative(): SecretEntry[] {
    const out: SecretEntry[] = [];
    const groups = this.db!.getGroups();
    for (const g of groups) {
      for (const e of g.entries) out.push(this.toEntry(e, g.name));
    }
    const defaultGroup = this.db!.getDefaultGroup();
    for (const e of defaultGroup.entries) out.push(this.toEntry(e, defaultGroup.name));
    return out;
  }

  private getNative(id: string): SecretEntry | null {
    const entries = this.listNative();
    return entries.find((e) => e.id === id) ?? null;
  }

  private createNative(entry: Omit<SecretEntry, 'id' | 'provider'>): string {
    const group = this.db!.getDefaultGroup();
    const created = this.db!.createEntry(group, {
      fields: {
        Title: entry.title,
        UserName: entry.username ?? '',
        Password: entry.password ?? '',
        URL: entry.url ?? '',
        Notes: entry.notes ?? '',
      },
    });
    void created;
    void this.save();
    return entry.title;
  }

  private async updateNative(id: string, patch: Partial<Omit<SecretEntry, 'id' | 'provider'>>): Promise<void> {
    const entries = this.db!.getGroups().flatMap((g) => g.entries);
    const entry = entries.find((e) => (e.uuid.id ?? '') === id);
    if (!entry) throw new Error(`KeePass: entry ${id} not found`);
    if (patch.username !== undefined) entry.fields.UserName = { value: patch.username };
    if (patch.password !== undefined) entry.fields.Password = { value: patch.password };
    if (patch.url !== undefined) entry.fields.URL = { value: patch.url };
    if (patch.notes !== undefined) entry.fields.Notes = { value: patch.notes };
    await this.save();
  }

  private toEntry(e: KdbxEntry, group: string): SecretEntry {
    const f = e.fields;
    const value = (k: string) => (typeof f[k]?.value === 'string' ? (f[k].value as string) : undefined);
    return {
      id: e.uuid.id ?? value('Title') ?? '',
      title: value('Title') ?? '',
      username: value('UserName'),
      password: value('Password'),
      url: value('URL'),
      notes: value('Notes'),
      folder: group,
      provider: 'keepass',
    };
  }

  // ─── CLI mode helpers ─────────────────────────────────────────────────────

  private parseListLine(line: string): SecretEntry {
    const [title, username, , url, notes, group] = line.split('|');
    return { id: title, title, username, url, notes, folder: group, provider: 'keepass' };
  }

  private parseShow(id: string, stdout: string): SecretEntry {
    const lines = stdout.split(/\r?\n/);
    const get = (key: string) => {
      const l = lines.find((x) => x.startsWith(`${key}: `));
      return l ? l.slice(`${key}: `.length) : undefined;
    };
    return {
      id,
      title: get('Title') ?? id,
      username: get('UserName'),
      password: get('Password'),
      url: get('URL'),
      notes: get('Notes'),
      provider: 'keepass',
    };
  }
}
