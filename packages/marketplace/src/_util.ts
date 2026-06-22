/**
 * @file _util.ts
 * @description Internal helpers for `@sanix/marketplace`: path expansion,
 * HTTP fetch with timeout + exponential-backoff retry, an in-memory TTL
 * cache, on-disk content-addressed cache for downloads, SHA-256
 * checksum verification, minimal semver range matching, dangerous-code
 * pattern scanning, and tarball/zip extraction via the system `tar` /
 * `unzip` commands.
 *
 * @packageDocumentation
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  DANGEROUS_PATTERNS,
  HTTP_RETRIES,
  HTTP_TIMEOUT_MS,
  type DangerousPattern,
} from './_constants.js';

// ── Path expansion ──────────────────────────────────────────────────────────

/**
 * Expand a leading `~` to the home directory and resolve to an absolute
 * path. Idempotent on paths that don't start with `~`.
 *
 * @example
 * ```ts
 * expandPath('~/.sanix/plugins'); // '/home/user/.sanix/plugins'
 * expandPath('/abs/path');        // '/abs/path'
 * ```
 */
export function expandPath(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  if (p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return path.resolve(p);
}

/**
 * Ensure a directory exists (recursive). No-op if it already exists.
 */
export async function ensureDir(dir: string): Promise<string> {
  const resolved = expandPath(dir);
  await fs.mkdir(resolved, { recursive: true });
  return resolved;
}

// ── HTTP fetch with timeout + retry ─────────────────────────────────────────

/**
 * Options for {@link fetchJson} / {@link fetchBuffer}.
 */
export interface FetchOpts {
  method?: 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH';
  headers?: Record<string, string>;
  body?: string | Buffer | undefined;
  timeoutMs?: number;
  retries?: number;
  /** Bearer token sent in the `Authorization` header. */
  authToken?: string;
}

/**
 * Outcome of a single HTTP attempt — used internally by the retry loop
 * to decide whether to retry (network error / 5xx) or surface (4xx).
 */
interface HttpOutcome {
  ok: boolean;
  status: number;
  statusText: string;
  buffer: Buffer;
}

/**
 * Perform a single HTTP request with an abort-signal timeout.
 */
async function attempt(url: string, opts: { method: string; headers: Record<string, string>; body?: string | Buffer; timeoutMs: number; authToken?: string }): Promise<HttpOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.authToken) headers['Authorization'] = `Bearer ${opts.authToken}`;
    if (opts.body !== undefined && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    // `fetch()` accepts Buffer as BodyInit at runtime (Node ≥ 18); the
    // lib.dom typings don't reflect this, so cast through `BodyInit`.
    const body = opts.body as BodyInit | null | undefined;
    const res = await fetch(url, {
      method: opts.method,
      headers,
      body,
      signal: controller.signal,
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      buffer: buf,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch a URL with timeout + exponential-backoff retry. Returns the raw
 * response buffer + status. Retries on network errors and 5xx; surfaces
 * 4xx immediately.
 *
 * @internal
 */
export async function fetchRaw(url: string, opts: FetchOpts = {}): Promise<HttpOutcome> {
  const timeoutMs = opts.timeoutMs ?? HTTP_TIMEOUT_MS;
  const retries = opts.retries ?? HTTP_RETRIES;
  let lastError: Error | undefined;
  for (let attemptNum = 0; attemptNum <= retries; attemptNum++) {
    try {
      const outcome = await attempt(url, {
        method: opts.method ?? 'GET',
        headers: opts.headers ?? {},
        body: opts.body,
        timeoutMs,
        authToken: opts.authToken,
      });
      // Retry on 5xx; surface 4xx and 2xx.
      if (outcome.status >= 500 && attemptNum < retries) {
        await sleep(backoffMs(attemptNum));
        continue;
      }
      return outcome;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attemptNum < retries) {
        await sleep(backoffMs(attemptNum));
        continue;
      }
    }
  }
  throw lastError ?? new Error(`fetch failed: ${url}`);
}

/**
 * Fetch and JSON-parse a URL with timeout + retry.
 *
 * @returns The parsed JSON body (typed as `T` — caller is responsible
 *   for runtime validation via Zod or guards).
 * @throws {Error} on network failure, non-2xx status, or JSON parse error.
 */
export async function fetchJson<T>(url: string, opts: FetchOpts = {}): Promise<T> {
  const outcome = await fetchRaw(url, opts);
  if (!outcome.ok) {
    throw new Error(`HTTP ${outcome.status} ${outcome.statusText}: ${url}`);
  }
  return JSON.parse(outcome.buffer.toString('utf8')) as T;
}

/**
 * Fetch a URL as a Buffer with timeout + retry.
 *
 * @throws {Error} on network failure or non-2xx status.
 */
export async function fetchBuffer(url: string, opts: FetchOpts = {}): Promise<Buffer> {
  const outcome = await fetchRaw(url, opts);
  if (!outcome.ok) {
    throw new Error(`HTTP ${outcome.status} ${outcome.statusText}: ${url}`);
  }
  return outcome.buffer;
}

/** Exponential backoff (300ms, 600ms, 1200ms, …) capped at 5s. */
function backoffMs(attempt: number): number {
  return Math.min(5000, 300 * 2 ** attempt);
}

/** Promise-based sleep. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── TTL cache ───────────────────────────────────────────────────────────────

/**
 * A minimal TTL cache. Entries expire after `ttlMs`. Used by
 * `MarketplaceClient` for search results (5 min) and plugin details
 * (1 hour). Downloads use the on-disk content-addressed cache instead.
 *
 * @example
 * ```ts
 * const cache = new TtlCache<string>(60_000);
 * cache.set('k', 'v');
 * cache.get('k'); // 'v' (within 60s) or undefined
 * ```
 */
export class TtlCache<T> {
  private readonly store = new Map<string, { value: T; expiresAt: number }>();
  constructor(private readonly ttlMs: number) {}

  /** Store a value with the cache's TTL. */
  set(key: string, value: T): void {
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  /** Get a value, or `undefined` if absent/expired. */
  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /** Check whether a non-expired entry exists. */
  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /** Remove an entry. */
  delete(key: string): void {
    this.store.delete(key);
  }

  /** Remove all entries. */
  clear(): void {
    this.store.clear();
  }
}

// ── Checksum ────────────────────────────────────────────────────────────────

/**
 * Compute the SHA-256 hex digest of a buffer.
 *
 * @example
 * ```ts
 * const digest = sha256(buf); // 'a1b2c3...'
 * ```
 */
export function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Verify a buffer's SHA-256 against an expected hex digest.
 * Constant-time comparison to avoid timing attacks.
 *
 * @returns `true` if the checksum matches.
 */
export function verifyChecksum(buf: Buffer, expected: string): boolean {
  const actual = sha256(buf).toLowerCase();
  const want = expected.toLowerCase();
  if (actual.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) {
    diff |= actual.charCodeAt(i) ^ want.charCodeAt(i);
  }
  return diff === 0;
}

// ── Semver matching ─────────────────────────────────────────────────────────

/** Parse a semver string (`major.minor.patch[-prerelease][+build]`) into parts. */
export interface SemverParts {
  major: number;
  minor: number;
  patch: number;
  prerelease: string;
}

/**
 * Parse a semver string into its numeric components. Returns `null` if
 * the string is not a valid semver.
 *
 * @example
 * ```ts
 * parseSemver('1.2.3');        // { major: 1, minor: 2, patch: 3, prerelease: '' }
 * parseSemver('2.0.0-beta.1'); // { major: 2, minor: 0, patch: 0, prerelease: 'beta.1' }
 * parseSemver('not-a-version'); // null
 * ```
 */
export function parseSemver(v: string): SemverParts | null {
  const m = /^v?(\d+)\.(\d+)\.(\d)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ?? '',
  };
}

/**
 * Compare two semver parts. Returns negative if `a < b`, positive if
 * `a > b`, 0 if equal. Prerelease < release (per semver spec).
 */
export function compareSemver(a: SemverParts, b: SemverParts): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  // Prerelease: empty > non-empty (1.0.0 > 1.0.0-beta)
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === '') return 1;
  if (b.prerelease === '') return -1;
  return a.prerelease < b.prerelease ? -1 : 1;
}

/**
 * Check whether `version` satisfies a simple semver range.
 *
 * Supported range syntaxes (a subset of npm ranges):
 *   - `'*'` or `''` — any version.
 *   - `'1.2.3'` — exact match.
 *   - `'>=1.0.0'`, `'>1.0.0'`, `'<=2.0.0'`, `'<2.0.0'`
 *   - `'^1.2.3'` — compatible-with (same major).
 *   - `'~1.2.3'` — approximately equivalent (same major.minor).
 *   - `'>=1.0.0 <2.0.0'` — space-separated AND.
 *
 * @example
 * ```ts
 * satisfiesSemver('1.5.0', '^1.0.0'); // true
 * satisfiesSemver('2.0.0', '^1.0.0'); // false
 * satisfiesSemver('1.2.3', '>=1.0.0 <2.0.0'); // true
 * ```
 */
export function satisfiesSemver(version: string, range: string): boolean {
  const v = parseSemver(version);
  if (!v) return false;
  const r = range.trim();
  if (r === '' || r === '*') return true;
  // AND of space-separated comparators.
  const parts = r.split(/\s+/).filter(Boolean);
  return parts.every((part) => satisfiesOne(v, part));
}

function satisfiesOne(v: SemverParts, comparator: string): boolean {
  // Exact version (no operator).
  if (/^\d/.test(comparator)) {
    const target = parseSemver(comparator);
    return target ? compareSemver(v, target) === 0 : false;
  }
  // ^x.y.z — compatible-with (same major, >= specified).
  if (comparator.startsWith('^')) {
    const target = parseSemver(comparator.slice(1));
    if (!target) return false;
    if (v.major !== target.major) return false;
    return compareSemver(v, target) >= 0;
  }
  // ~x.y.z — approximately equivalent (same major.minor, >= specified).
  if (comparator.startsWith('~')) {
    const target = parseSemver(comparator.slice(1));
    if (!target) return false;
    if (v.major !== target.major) return false;
    if (v.minor !== target.minor) return false;
    return compareSemver(v, target) >= 0;
  }
  // >=, >, <=, <.
  const m = /^(>=|>|<=|<)\s*(.+)$/.exec(comparator);
  if (m) {
    const op = m[1];
    const target = parseSemver(m[2]);
    if (!target) return false;
    const cmp = compareSemver(v, target);
    switch (op) {
      case '>=': return cmp >= 0;
      case '>': return cmp > 0;
      case '<=': return cmp <= 0;
      case '<': return cmp < 0;
    }
  }
  return false;
}

// ── Dangerous-pattern scan ──────────────────────────────────────────────────

/**
 * Result of scanning content for dangerous patterns.
 */
export interface ScanResult {
  /** Hard errors (severity `'error'` matches). */
  errors: string[];
  /** Soft warnings (severity `'warn'` matches). */
  warnings: string[];
}

/**
 * Scan a string (inline content / fetched JS) for dangerous patterns.
 * Returns the list of errors and warnings (human-readable labels).
 *
 * @example
 * ```ts
 * const { errors, warnings } = scanDangerousPatterns(content);
 * if (errors.length > 0) throw new Error(`unsafe: ${errors.join(', ')}`);
 * ```
 */
export function scanDangerousPatterns(content: string): ScanResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const dp of DANGEROUS_PATTERNS as readonly DangerousPattern[]) {
    if (dp.pattern.test(content)) {
      if (dp.severity === 'error') errors.push(dp.label);
      else warnings.push(dp.label);
    }
  }
  return { errors, warnings };
}

// ── Tarball / zip extraction ────────────────────────────────────────────────

/**
 * Extract a `.tar.gz` / `.tgz` / `.tar` / `.zip` buffer into a target
 * directory using the system `tar` (or `unzip` for `.zip`) command.
 * Spawns a child process and pipes the buffer to its stdin.
 *
 * @throws {Error} if the archive type is unsupported or extraction fails.
 */
export async function extractArchive(archive: Buffer, targetDir: string, filename: string): Promise<void> {
  await ensureDir(targetDir);
  const lower = filename.toLowerCase();
  const isZip = lower.endsWith('.zip');
  const isTar = lower.endsWith('.tar') || lower.endsWith('.tar.gz') || lower.endsWith('.tgz') || lower.endsWith('.tar.bz2') || lower.endsWith('.tbz2');
  if (!isZip && !isTar) {
    throw new Error(`unsupported archive type: ${filename}`);
  }
  const cmd = isZip ? 'unzip' : 'tar';
  const args = isZip ? ['-o', '-d', targetDir] : ['-xf', '-', '-C', targetDir];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}: ${stderr.trim() || 'no stderr'}`));
    });
    child.stdin.on('error', reject);
    child.stdin.end(archive);
  });
}

// ── JSON read/write helpers ─────────────────────────────────────────────────

/**
 * Read and JSON-parse a file, returning `null` if it doesn't exist.
 */
export async function readJsonOrNull(filePath: string): Promise<unknown> {
  try {
    const text = await fs.readFile(expandPath(filePath), 'utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Write JSON to a file (pretty-printed, 2-space indent). Creates parent
 * directories as needed.
 */
export async function writeJson(filePath: string, value: unknown): Promise<void> {
  const resolved = expandPath(filePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

// ── Safe plugin-id slug ─────────────────────────────────────────────────────

/**
 * Convert a plugin id (`username/plugin-name`) into a filesystem-safe
 * directory name (`username__plugin-name`).
 */
export function idToDirName(id: string): string {
  return id.replace(/[\\/]/g, '__').replace(/[^A-Za-z0-9._-]/g, '_');
}
