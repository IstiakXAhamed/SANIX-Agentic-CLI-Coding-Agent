/**
 * SANIX Profile Manager
 * ---------------------
 * Named configuration profiles let users keep multiple SANIX configurations
 * side-by-side (e.g. `work`, `personal`, `local-only`) and switch between
 * them instantly with {@link ProfileManager.useProfile}.
 *
 * Profiles are stored as a single JSON document at
 * `~/.sanix/profiles.json`. Each profile holds a {@link ConfigOverride} — a
 * deep-partial of {@link SanixConfig} — which is merged over the defaults at
 * resolve time.
 *
 * @packageDocumentation
 */

import { nanoid } from 'nanoid';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { SanixConfig } from './SanixConfig.js';

/**
 * Recursively partial type used for profile overrides. Arrays are replaced
 * wholesale (rather than element-wise partial) so a profile can fully specify
 * `mcp.servers` without merging with the default list.
 */
export type ConfigOverride = {
  [P in keyof SanixConfig]?: SanixConfig[P] extends (infer _U)[]
    ? SanixConfig[P]
    : SanixConfig[P] extends object
      ? DeepPartial<SanixConfig[P]>
      : SanixConfig[P];
};

/** Internal helper: deep partial of an object type (arrays preserved). */
type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends (infer _U)[]
    ? T[P]
    : T[P] extends object
      ? DeepPartial<T[P]>
      : T[P];
};

/** A single named configuration profile. */
export interface Profile {
  /** Unique human-friendly name (also the map key). */
  name: string;
  /** Stable internal id (nanoid) for cross-referencing. */
  id: string;
  /** Deep-partial overrides applied on top of the default config. */
  overrides: ConfigOverride;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 last-update timestamp. */
  updatedAt: string;
}

/** On-disk shape of `~/.sanix/profiles.json`. */
interface ProfileStore {
  /** Name of the currently-active profile, or `null`. */
  current: string | null;
  /** Map of profile name → {@link Profile}. */
  profiles: Record<string, Profile>;
}

/** The default storage location: `~/.sanix/profiles.json`. */
export const DEFAULT_PROFILES_PATH: string = join(
  homedir(),
  '.sanix',
  'profiles.json',
);

/** Options for constructing a {@link ProfileManager}. */
export interface ProfileManagerOptions {
  /** Override the on-disk store location (primarily for testing). */
  storePath?: string;
}

/**
 * Manages named SANIX configuration profiles.
 *
 * @example
 * ```ts
 * const mgr = new ProfileManager();
 * mgr.createProfile('work', { providers: { default: 'claude-opus-4' } });
 * mgr.useProfile('work');
 * mgr.getCurrentProfile()?.name; // 'work'
 * ```
 */
export class ProfileManager {
  private readonly storePath: string;

  /**
   * @param opts - Optional {@link ProfileManagerOptions}.
   */
  constructor(opts: ProfileManagerOptions = {}) {
    this.storePath = opts.storePath ?? DEFAULT_PROFILES_PATH;
  }

  /**
   * Read the entire profile store from disk. Returns an empty store
   * (`{ current: null, profiles: {} }`) if the file does not exist or is
   * unreadable.
   */
  private readStore(): ProfileStore {
    if (!existsSync(this.storePath)) {
      return { current: null, profiles: {} };
    }
    try {
      const text = readFileSync(this.storePath, 'utf-8');
      const raw = JSON.parse(text) as Partial<ProfileStore>;
      return {
        current: raw.current ?? null,
        profiles: raw.profiles ?? {},
      };
    } catch {
      return { current: null, profiles: {} };
    }
  }

  /** Persist the profile store, creating parent dirs as needed. */
  private writeStore(store: ProfileStore): void {
    const dir = dirname(this.storePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.storePath, JSON.stringify(store, null, 2), 'utf-8');
  }

  /**
   * Create a new named profile from a deep-partial override.
   *
   * @param name - Unique profile name.
   * @param overrides - Deep-partial {@link SanixConfig} to apply on top of
   *                    defaults when this profile is active.
   * @returns The created {@link Profile}.
   * @throws {Error} if a profile with `name` already exists.
   *
   * @example
   * ```ts
   * mgr.createProfile('local', {
   *   providers: { default: 'llama-3.1', configs: { llama: { model: 'llama-3.1-8b', baseURL: 'http://localhost:1234/v1' } } },
   * });
   * ```
   */
  createProfile(name: string, overrides: ConfigOverride): Profile {
    const store = this.readStore();
    if (store.profiles[name] !== undefined) {
      throw new Error(`Profile "${name}" already exists`);
    }
    const now = new Date().toISOString();
    const profile: Profile = {
      name,
      id: nanoid(12),
      overrides,
      createdAt: now,
      updatedAt: now,
    };
    store.profiles[name] = profile;
    // First profile becomes the current profile automatically.
    if (store.current === null) {
      store.current = name;
    }
    this.writeStore(store);
    return profile;
  }

  /**
   * Set the currently-active profile by name.
   *
   * @param name - Name of an existing profile.
   * @throws {Error} if no profile named `name` exists.
   *
   * @example
   * ```ts
   * mgr.useProfile('work');
   * ```
   */
  useProfile(name: string): void {
    const store = this.readStore();
    if (store.profiles[name] === undefined) {
      throw new Error(`Profile "${name}" does not exist`);
    }
    store.current = name;
    this.writeStore(store);
  }

  /**
   * Return the currently-active profile, or `null` if none is set.
   *
   * @example
   * ```ts
   * const current = mgr.getCurrentProfile();
   * if (current) console.log(`Active: ${current.name}`);
   * ```
   */
  getCurrentProfile(): Profile | null {
    const store = this.readStore();
    if (store.current === null) return null;
    return store.profiles[store.current] ?? null;
  }

  /**
   * List all stored profiles. The current profile (if any) is flagged via
   * {@link Profile.name}; callers can compare against
   * {@link getCurrentProfile}.
   *
   * @returns An array of all {@link Profile}s.
   *
   * @example
   * ```ts
   * for (const p of mgr.listProfiles()) {
   *   console.log(p.name);
   * }
   * ```
   */
  listProfiles(): Profile[] {
    return Object.values(this.readStore().profiles);
  }

  /**
   * Permanently delete a profile by name. If the deleted profile was the
   * current one, `current` is reset to `null`.
   *
   * @param name - Name of the profile to delete.
   * @returns `true` if a profile was deleted, `false` if it did not exist.
   *
   * @example
   * ```ts
   * if (mgr.deleteProfile('work')) {
   *   console.log('Deleted work profile');
   * }
   * ```
   */
  deleteProfile(name: string): boolean {
    const store = this.readStore();
    if (store.profiles[name] === undefined) return false;
    delete store.profiles[name];
    if (store.current === name) {
      store.current = null;
    }
    this.writeStore(store);
    return true;
  }

  /**
   * Update the overrides of an existing profile. The `updatedAt` timestamp
   * is refreshed.
   *
   * @param name - Name of the profile to update.
   * @param overrides - New deep-partial overrides (replaces the previous
   *                    value wholesale).
   * @returns The updated {@link Profile}.
   * @throws {Error} if no profile named `name` exists.
   */
  updateProfile(name: string, overrides: ConfigOverride): Profile {
    const store = this.readStore();
    const existing = store.profiles[name];
    if (existing === undefined) {
      throw new Error(`Profile "${name}" does not exist`);
    }
    const updated: Profile = {
      ...existing,
      overrides,
      updatedAt: new Date().toISOString(),
    };
    store.profiles[name] = updated;
    this.writeStore(store);
    return updated;
  }
}
