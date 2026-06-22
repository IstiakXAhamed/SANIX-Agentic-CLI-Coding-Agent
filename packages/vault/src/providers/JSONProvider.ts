/**
 * @file JSONProvider.ts
 * @description A pure-JS JSON-file vault provider — for local dev / testing.
 *
 * Stores secrets as a JSON array in a single file, optionally encrypted
 * with AES-256-GCM using the master password (via Node's built-in
 * `crypto`). When no password is supplied, the file is stored as
 * plain JSON (with a warning).
 *
 * This provider is the only one that needs no external CLI — it's
 * always available.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  pbkdf2Sync,
  createHash,
} from 'node:crypto';
import { nanoid } from 'nanoid';
import type { SecretEntry, VaultProvider, VaultProviderOptions, VaultProviderKind } from '../types.js';

interface StoredFile {
  encrypted: boolean;
  salt?: string;
  iv?: string;
  data: string;
}

/**
 * JSON-file vault provider.
 */
export class JSONProvider implements VaultProvider {
  public readonly kind: VaultProviderKind = 'json';
  public readonly displayName = 'JSON File';
  private filePath: string | null = null;
  private password: string | null = null;
  private entries: SecretEntry[] = [];
  private unlocked = false;

  /** Always available. */
  public async isAvailable(): Promise<boolean> {
    return true;
  }

  /** Authenticate — load + (optionally) decrypt the file. */
  public async authenticate(opts: VaultProviderOptions): Promise<void> {
    if (!opts.filePath) throw new Error('JSON vault: filePath required');
    this.filePath = opts.filePath;
    this.password = opts.password ?? null;
    try {
      const raw = await readFile(opts.filePath, 'utf8');
      const stored = JSON.parse(raw) as StoredFile;
      if (stored.encrypted) {
        if (!this.password) throw new Error('JSON vault: password required to decrypt file');
        this.entries = this.decrypt(stored.data, stored.salt!, stored.iv!, this.password);
      } else {
        this.entries = stored.data ? (JSON.parse(stored.data) as SecretEntry[]) : [];
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        this.entries = [];
      } else {
        throw e;
      }
    }
    this.unlocked = true;
  }

  /** List all entries. */
  public async list(): Promise<SecretEntry[]> {
    return [...this.entries];
  }

  /** Get a single entry. */
  public async get(id: string): Promise<SecretEntry | null> {
    return this.entries.find((e) => e.id === id) ?? null;
  }

  /** Create a new entry. */
  public async create(entry: Omit<SecretEntry, 'id' | 'provider'>): Promise<string> {
    const id = nanoid(12);
    const full: SecretEntry = { ...entry, id, provider: 'json' };
    this.entries.push(full);
    await this.save();
    return id;
  }

  /** Update an entry. */
  public async update(id: string, patch: Partial<Omit<SecretEntry, 'id' | 'provider'>>): Promise<void> {
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx < 0) throw new Error(`JSON vault: entry ${id} not found`);
    this.entries[idx] = { ...this.entries[idx], ...patch };
    await this.save();
  }

  /** Delete an entry. */
  public async delete(id: string): Promise<void> {
    this.entries = this.entries.filter((e) => e.id !== id);
    await this.save();
  }

  /** Lock — clear in-memory entries. */
  public async lock(): Promise<void> {
    this.entries = [];
    this.password = null;
    this.unlocked = false;
  }

  /** Is the provider unlocked? */
  public isUnlocked(): boolean {
    return this.unlocked;
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  private async save(): Promise<void> {
    if (!this.filePath) throw new Error('JSON vault: not authenticated');
    const json = JSON.stringify(this.entries, null, 2);
    const stored: StoredFile = { encrypted: false, data: json };
    if (this.password) {
      const salt = randomBytes(16);
      const iv = randomBytes(12);
      const key = this.deriveKey(this.password, salt);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const enc = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      stored.encrypted = true;
      stored.salt = salt.toString('base64');
      stored.iv = iv.toString('base64');
      stored.data = Buffer.concat([enc, tag]).toString('base64');
    }
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(stored, null, 2), 'utf8');
  }

  private decrypt(data: string, saltB64: string, ivB64: string, password: string): SecretEntry[] {
    const salt = Buffer.from(saltB64, 'base64');
    const iv = Buffer.from(ivB64, 'base64');
    const buf = Buffer.from(data, 'base64');
    const tag = buf.subarray(buf.length - 16);
    const enc = buf.subarray(0, buf.length - 16);
    const key = this.deriveKey(password, salt);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return JSON.parse(dec.toString('utf8')) as SecretEntry[];
  }

  private deriveKey(password: string, salt: Buffer): Buffer {
    return pbkdf2Sync(password, salt, 100000, 32, 'sha256');
  }

  /** Fingerprint a master password (for change detection). */
  public static fingerprint(password: string): string {
    return createHash('sha256').update(password).digest('hex').slice(0, 16);
  }
}
