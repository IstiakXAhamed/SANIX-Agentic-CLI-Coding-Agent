/**
 * @file VaultManager.ts
 * @description Top-level orchestrator for `@sanix/vault`.
 *
 * Wraps all 7 providers behind a unified, provider-agnostic API:
 *
 * ```ts
 * const mgr = new VaultManager({ defaultProvider: '1password' });
 * await mgr.authenticate('1password', { account: 'me@example.com', password: '...' });
 * const entries = await mgr.list();
 * const secret = await mgr.get('GitHub');
 * ```
 *
 * Features:
 *   - Multi-provider: register several providers, switch at runtime.
 *   - Caching: lookups are cached for `cacheTtlMs` (default 30s).
 *   - Masking: when `maskInLogs` is set, passwords are masked in
 *     serialised output (for safe logging).
 *   - Aggregated search across all unlocked providers.
 */

import { OnePasswordProvider } from './providers/OnePasswordProvider.js';
import { BitwardenProvider } from './providers/BitwardenProvider.js';
import { HashiCorpVaultProvider } from './providers/HashiCorpVaultProvider.js';
import { LastPassProvider } from './providers/LastPassProvider.js';
import { KeePassProvider } from './providers/KeePassProvider.js';
import { PassProvider } from './providers/PassProvider.js';
import { JSONProvider } from './providers/JSONProvider.js';
import type {
  LookupResult,
  SecretEntry,
  VaultManagerOptions,
  VaultProvider,
  VaultProviderKind,
  VaultProviderOptions,
} from './types.js';

interface CacheEntry {
  entry: SecretEntry;
  provider: VaultProviderKind;
  expiresAt: number;
}

/**
 * Top-level vault facade.
 */
export class VaultManager {
  private readonly providers = new Map<VaultProviderKind, VaultProvider>();
  private readonly cache = new Map<string, CacheEntry>();
  private readonly opts: Required<VaultManagerOptions>;

  /**
   * @param opts Manager options.
   */
  constructor(opts: VaultManagerOptions = {}) {
    this.opts = {
      defaultProvider: opts.defaultProvider ?? 'json',
      cacheTtlMs: opts.cacheTtlMs ?? 30000,
      maskInLogs: opts.maskInLogs ?? true,
    };
    // Register built-in providers.
    this.registerProvider(new OnePasswordProvider());
    this.registerProvider(new BitwardenProvider());
    this.registerProvider(new HashiCorpVaultProvider());
    this.registerProvider(new LastPassProvider());
    this.registerProvider(new KeePassProvider());
    this.registerProvider(new PassProvider());
    this.registerProvider(new JSONProvider());
  }

  /**
   * Register a custom provider.
   */
  public registerProvider(provider: VaultProvider): void {
    this.providers.set(provider.kind, provider);
  }

  /**
   * Get a provider by kind.
   */
  public getProvider(kind: VaultProviderKind): VaultProvider | undefined {
    return this.providers.get(kind);
  }

  /**
   * List all registered provider kinds.
   */
  public listProviders(): VaultProviderKind[] {
    return [...this.providers.keys()];
  }

  /**
   * Authenticate against a provider.
   */
  public async authenticate(kind: VaultProviderKind, opts: VaultProviderOptions): Promise<void> {
    const provider = this.requireProvider(kind);
    await provider.authenticate(opts);
  }

  /**
   * List secrets from a provider (or the default).
   */
  public async list(kind?: VaultProviderKind): Promise<SecretEntry[]> {
    const provider = this.requireProvider(kind ?? this.opts.defaultProvider);
    this.ensureUnlocked(provider);
    return provider.list();
  }

  /**
   * List secrets across all unlocked providers.
   */
  public async listAll(): Promise<Array<SecretEntry & { provider: VaultProviderKind }>> {
    const out: Array<SecretEntry & { provider: VaultProviderKind }> = [];
    for (const [kind, provider] of this.providers) {
      if (!provider.isUnlocked()) continue;
      try {
        const entries = await provider.list();
        out.push(...entries.map((e) => ({ ...e, provider: kind })));
      } catch {
        // skip providers that fail
      }
    }
    return out;
  }

  /**
   * Get a single secret. Uses cache when available.
   */
  public async get(id: string, kind?: VaultProviderKind): Promise<LookupResult> {
    const providerKind = kind ?? this.opts.defaultProvider;
    const cached = this.cache.get(`${providerKind}:${id}`);
    if (cached && cached.expiresAt > Date.now()) {
      return { entry: cached.entry, provider: cached.provider, cached: true };
    }
    const provider = this.requireProvider(providerKind);
    this.ensureUnlocked(provider);
    const entry = await provider.get(id);
    if (!entry) throw new Error(`Secret ${id} not found in ${providerKind}`);
    this.cache.set(`${providerKind}:${id}`, {
      entry,
      provider: providerKind,
      expiresAt: Date.now() + this.opts.cacheTtlMs,
    });
    return { entry, provider: providerKind, cached: false };
  }

  /**
   * Create a secret.
   */
  public async create(entry: Omit<SecretEntry, 'id' | 'provider'>, kind?: VaultProviderKind): Promise<string> {
    const provider = this.requireProvider(kind ?? this.opts.defaultProvider);
    this.ensureUnlocked(provider);
    const id = await provider.create(entry);
    this.invalidate(`${provider.kind}:${id}`);
    return id;
  }

  /**
   * Update a secret.
   */
  public async update(id: string, patch: Partial<Omit<SecretEntry, 'id' | 'provider'>>, kind?: VaultProviderKind): Promise<void> {
    const provider = this.requireProvider(kind ?? this.opts.defaultProvider);
    this.ensureUnlocked(provider);
    await provider.update(id, patch);
    this.invalidate(`${provider.kind}:${id}`);
  }

  /**
   * Delete a secret.
   */
  public async delete(id: string, kind?: VaultProviderKind): Promise<void> {
    const provider = this.requireProvider(kind ?? this.opts.defaultProvider);
    this.ensureUnlocked(provider);
    await provider.delete(id);
    this.invalidate(`${provider.kind}:${id}`);
  }

  /**
   * Lock a provider.
   */
  public async lock(kind?: VaultProviderKind): Promise<void> {
    const provider = this.requireProvider(kind ?? this.opts.defaultProvider);
    await provider.lock();
    this.invalidateProvider(provider.kind);
  }

  /**
   * Lock all providers.
   */
  public async lockAll(): Promise<void> {
    for (const provider of this.providers.values()) {
      try { await provider.lock(); } catch { /* ignore */ }
    }
    this.cache.clear();
  }

  /**
   * Search across all unlocked providers.
   */
  public async search(query: string): Promise<Array<SecretEntry & { provider: VaultProviderKind; score: number }>> {
    const lower = query.toLowerCase();
    const all = await this.listAll();
    return all
      .map((e) => {
        let score = 0;
        if (e.title.toLowerCase().includes(lower)) score += 100;
        if (e.username?.toLowerCase().includes(lower)) score += 50;
        if (e.url?.toLowerCase().includes(lower)) score += 30;
        if (e.tags?.some((t) => t.toLowerCase().includes(lower))) score += 20;
        if (e.notes?.toLowerCase().includes(lower)) score += 10;
        return { ...e, score };
      })
      .filter((e) => e.score > 0)
      .sort((a, b) => b.score - a.score);
  }

  /**
   * Mask a secret for logging.
   */
  public mask(value: string | undefined): string {
    if (!value) return '';
    if (!this.opts.maskInLogs) return value;
    if (value.length <= 4) return '****';
    return value.slice(0, 2) + '*'.repeat(Math.max(4, value.length - 4)) + value.slice(-2);
  }

  /**
   * Clear the cache.
   */
  public clearCache(): void {
    this.cache.clear();
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  private requireProvider(kind: VaultProviderKind): VaultProvider {
    const provider = this.providers.get(kind);
    if (!provider) throw new Error(`Unknown vault provider: ${kind}`);
    return provider;
  }

  private ensureUnlocked(provider: VaultProvider): void {
    if (!provider.isUnlocked()) {
      throw new Error(`Provider ${provider.kind} is not unlocked — call authenticate() first`);
    }
  }

  private invalidate(key: string): void {
    this.cache.delete(key);
  }

  private invalidateProvider(kind: VaultProviderKind): void {
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(`${kind}:`)) this.cache.delete(key);
    }
  }
}
