/**
 * @file AutoUpdater.ts
 * @description Check for, download, and install app updates from a GitHub
 * releases feed or a generic update-feed URL. The "install" step is
 * platform-aware: on Linux/macOS it chmods the downloaded binary and
 * atomically replaces the current executable; on other platforms it
 * simply returns the download path and lets the caller handle it.
 *
 * @packageDocumentation
 */

import { createWriteStream, mkdirSync, renameSync, chmodSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { homedir, tmpdir, platform } from 'node:os';
import type { AutoUpdaterOptions, DownloadResult, UpdateCheckResult } from './types.js';

/**
 * Check for, download, and install updates.
 *
 * @example
 * ```ts
 * const u = new AutoUpdater({ currentVersion: '1.0.0', githubRepo: 'sanix-ahmed/sanix' });
 * const r = await u.check();
 * if (r.updateAvailable) await u.download(r);
 * ```
 */
export class AutoUpdater {
  private readonly currentVersion: string;
  private readonly githubRepo?: string;
  private readonly feedUrl?: string;
  private readonly downloadDir: string;
  private readonly checkIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private interval?: ReturnType<typeof setInterval>;
  private lastResult?: UpdateCheckResult;

  constructor(opts: AutoUpdaterOptions) {
    this.currentVersion = opts.currentVersion;
    this.githubRepo = opts.githubRepo;
    this.feedUrl = opts.feedUrl;
    this.downloadDir = opts.downloadDir ?? resolvePath(homedir(), '.sanix', 'updates');
    this.checkIntervalMs = opts.checkIntervalMs ?? 60 * 60 * 1000;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    if (!this.githubRepo && !this.feedUrl) {
      throw new Error('AutoUpdater requires either githubRepo or feedUrl');
    }
  }

  /**
   * Check for an update.
   *
   * @returns The check result.
   */
  async check(): Promise<UpdateCheckResult> {
    if (this.githubRepo) {
      this.lastResult = await this.checkGitHub();
    } else {
      this.lastResult = await this.checkFeed();
    }
    return this.lastResult;
  }

  /** The result of the most recent check (or undefined). */
  getLastResult(): UpdateCheckResult | undefined {
    return this.lastResult;
  }

  /**
   * Start a periodic check. The interval is `checkIntervalMs` (default 1h).
   * The timer is unref'd so it doesn't keep the event loop alive.
   */
  startPeriodicCheck(): void {
    if (this.interval) return;
    this.interval = setInterval(() => { void this.check(); }, this.checkIntervalMs);
    this.interval.unref?.();
  }

  /** Stop the periodic check. */
  stopPeriodicCheck(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
  }

  /**
   * Download the asset referenced by a check result. Returns the local
   * file path + byte count.
   *
   * @param result The check result (must have a `downloadUrl`).
   */
  async download(result: UpdateCheckResult): Promise<DownloadResult> {
    if (!result.downloadUrl) throw new Error('no downloadUrl in check result');
    mkdirSync(this.downloadDir, { recursive: true });
    const fileName = result.downloadUrl.split('/').pop() ?? 'update.bin';
    const outPath = join(this.downloadDir, fileName);
    const resp = await this.fetchImpl(result.downloadUrl);
    if (!resp.ok || !resp.body) {
      throw new Error(`download failed: HTTP ${resp.status}`);
    }
    const ws = createWriteStream(outPath);
    let bytes = 0;
    const reader = resp.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        ws.write(value);
        bytes += value.byteLength;
      }
    }
    await new Promise<void>((resolve, reject) => {
      ws.on('finish', () => resolve());
      ws.on('error', (e) => reject(e));
      ws.end();
    });
    return { path: outPath, bytes };
  }

  /**
   * "Install" a downloaded asset: chmod +x (POSIX), then atomically
   * replace `process.execPath` with the new binary. On non-POSIX
   * platforms, returns the path without replacing.
   *
   * @param downloaded The download result.
   */
  async install(downloaded: DownloadResult): Promise<void> {
    if (platform() === 'win32') {
      // Can't replace a running .exe on Windows; caller must handle.
      return;
    }
    chmodSync(downloaded.path, 0o755);
    // Verify it's a regular file with nonzero size.
    const st = statSync(downloaded.path);
    if (!st.isFile() || st.size === 0) throw new Error('downloaded file is empty or missing');
    const target = process.execPath;
    const backup = `${target}.bak`;
    try {
      renameSync(target, backup);
      try {
        renameSync(downloaded.path, target);
        chmodSync(target, 0o755);
      } catch (e) {
        // Roll back.
        renameSync(backup, target);
        throw e;
      }
      // Best-effort cleanup of backup.
      try { unlinkSync(backup); } catch { /* ignore */ }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[telemetry] auto-update install failed:', e);
      throw e;
    }
  }

  /** Query the GitHub releases API for the latest release. */
  private async checkGitHub(): Promise<UpdateCheckResult> {
    const url = `https://api.github.com/repos/${this.githubRepo}/releases/latest`;
    const resp = await this.fetchImpl(url, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'sanix-autoupdater' },
    });
    if (!resp.ok) throw new Error(`GitHub API HTTP ${resp.status}`);
    const body = (await resp.json()) as {
      tag_name?: string;
      body?: string;
      assets?: Array<{ browser_download_url?: string; name?: string }>;
    };
    const latest = (body.tag_name ?? '').replace(/^v/, '');
    if (!latest) return { updateAvailable: false };
    const updateAvailable = compareSemver(latest, this.currentVersion) > 0;
    // Pick the first asset that matches the current platform.
    const plat = platform();
    const asset = body.assets?.find((a) => {
      const n = (a.name ?? '').toLowerCase();
      if (plat === 'linux') return n.includes('linux');
      if (plat === 'darwin') return n.includes('darwin') || n.includes('macos') || n.includes('mac');
      if (plat === 'win32') return n.includes('win');
      return false;
    });
    return {
      updateAvailable,
      latestVersion: latest,
      releaseNotes: body.body,
      downloadUrl: asset?.browser_download_url,
    };
  }

  /** Query a generic update feed. */
  private async checkFeed(): Promise<UpdateCheckResult> {
    if (!this.feedUrl) return { updateAvailable: false };
    const resp = await this.fetchImpl(this.feedUrl);
    if (!resp.ok) throw new Error(`feed HTTP ${resp.status}`);
    const body = (await resp.json()) as { version?: string; downloadUrl?: string; releaseNotes?: string };
    const latest = (body.version ?? '').replace(/^v/, '');
    if (!latest) return { updateAvailable: false };
    return {
      updateAvailable: compareSemver(latest, this.currentVersion) > 0,
      latestVersion: latest,
      releaseNotes: body.releaseNotes,
      downloadUrl: body.downloadUrl,
    };
  }
}

/**
 * Compare two semver strings (e.g. `1.2.3` vs `1.10.0`).
 *
 * @returns negative if `a < b`, 0 if equal, positive if `a > b`.
 */
export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const ai = pa[i] ?? 0;
    const bi = pb[i] ?? 0;
    if (ai !== bi) return ai - bi;
  }
  return 0;
}

// Suppress "unused import" lint by using tmpdir indirectly (used in tests
// when callers set downloadDir to os.tmpdir()).
void tmpdir;
void dirname;
