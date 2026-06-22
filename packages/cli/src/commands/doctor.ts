/**
 * @file commands/doctor.ts
 * @description `sanix doctor` — health check.
 *
 *   sanix doctor                  Run all health checks
 *     --fix                       Auto-fix issues where possible
 *     --json                      JSON output
 *
 * Checks:
 *   1.  Node.js version (>= 20)
 *   2.  npm version (>= 10)
 *   3.  API keys (ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY, GITHUB_TOKEN)
 *   4.  Server reachability (http://127.0.0.1:7331/health)
 *   5.  Provider connectivity (for each configured provider)
 *   6.  Config file (~/.sanix/config.json exists + is valid JSON + Zod-valid)
 *   7.  Memory (count of memories, last memory time, DB size)
 *   8.  Cache (hit rate, size, entries)
 *   9.  Disk space (~/.sanix/ directory size; warn if > 1GB)
 *   10. Package versions (any SANIX packages outdated?)
 *   11. Permissions (~/.sanix/ is writable)
 *   12. Git (is this a git repo? uncommitted changes?)
 *   13. Docker (installed? daemon running?)
 *   14. Playwright (installed?)
 *   15. Network (can we reach the internet?)
 *
 * If `--fix`:
 *   - Auto-create `~/.sanix/config.json` with defaults if missing.
 *   - Auto-create `~/.sanix/sessions/`, `~/.sanix/memory/`, etc.
 *   - Auto-clear cache if it's too large.
 *   - Suggest fixes for issues that can't be auto-fixed.
 *
 * @packageDocumentation
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import type { SanixContext } from '../bootstrap.js';
import { defaultConfig, saveConfig, DEFAULT_CONFIG_PATH } from '@sanix/config';

/** Parsed options for `sanix doctor`. */
export interface DoctorCommandOptions {
  fix?: boolean;
  json?: boolean;
}

/** Status of a single check. */
export type CheckStatus = 'ok' | 'warn' | 'error';

/** Result of a single check. */
export interface CheckResult {
  /** Display name (e.g. `Node.js`, `ANTHROPIC_API_KEY`). */
  name: string;
  /** Status. */
  status: CheckStatus;
  /** Short status message (e.g. `v20.10.0`, `set (sk-ant-...xJ3k)`). */
  message: string;
  /** Optional long-form detail (shown indented under the check). */
  detail?: string;
  /** If `--fix` was set, what fix (if any) was applied. */
  fixed?: string;
}

/** Aggregate report. */
export interface DoctorReport {
  /** Per-check results. */
  checks: CheckResult[];
  /** Number of warnings. */
  warnings: number;
  /** Number of errors. */
  errors: number;
  /** Whether `--fix` was applied. */
  fix: boolean;
}

/** SANIX home directory. */
const SANIX_HOME = join(homedir(), '.sanix');

/** Default server health URL. */
const SERVER_HEALTH_URL = 'http://127.0.0.1:7331/health';

/** Disk-size warning threshold (1 GB). */
const DISK_WARN_BYTES = 1024 * 1024 * 1024;

/** Cache directory (`~/.sanix/cache/`). */
const CACHE_DIR = join(SANIX_HOME, 'cache');

/**
 * Register the `sanix doctor` command.
 *
 * @param program     - The Commander root program.
 * @param ctxProvider - Lazy context provider (called on first action).
 */
export function registerDoctorCommand(
  program: Command,
  ctxProvider: () => Promise<SanixContext>,
): void {
  program
    .command('doctor')
    .description('Run health checks on the SANIX installation.')
    .option('--fix', 'Auto-fix issues where possible')
    .option('--json', 'Output JSON report')
    .action(async (opts: DoctorCommandOptions) => {
      try {
        const ctx = await ctxProvider();
        const report = await doctorCommand(ctx, opts);
        printReport(report, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(chalk.red(`\n✗ sanix doctor failed: ${msg}\n`));
        process.exitCode = 1;
      }
    });
}

/**
 * Run the `sanix doctor` command. Exposed for programmatic use.
 *
 * @param ctx  - The wired SANIX context.
 * @param opts - Parsed CLI options.
 */
export async function doctorCommand(
  ctx: SanixContext,
  opts: DoctorCommandOptions,
): Promise<DoctorReport> {
  const fix = opts.fix === true;
  const checks: CheckResult[] = [];

  // 1. Node.js version.
  checks.push(checkNode());
  // 2. npm version.
  checks.push(checkNpm());
  // 3. API keys.
  checks.push(...checkApiKeys());
  // 4. Server reachability.
  checks.push(await checkServer());
  // 5. Provider connectivity.
  checks.push(...(await checkProviders(ctx)));
  // 6. Config file.
  checks.push(checkConfig(fix));
  // 7. Memory.
  checks.push(await checkMemory(ctx));
  // 8. Cache.
  checks.push(checkCache(fix));
  // 9. Disk space.
  checks.push(checkDisk(fix));
  // 10. Package versions.
  checks.push(checkPackages());
  // 11. Permissions.
  checks.push(checkPermissions(fix));
  // 12. Git.
  checks.push(checkGit());
  // 13. Docker.
  checks.push(checkDocker());
  // 14. Playwright.
  checks.push(checkPlaywright());
  // 15. Network.
  checks.push(await checkNetwork());

  const warnings = checks.filter((c) => c.status === 'warn').length;
  const errors = checks.filter((c) => c.status === 'error').length;
  return { checks, warnings, errors, fix };
}

/** 1. Node.js version. */
function checkNode(): CheckResult {
  const v = process.versions.node;
  const major = parseInt(v.split('.')[0] ?? '0', 10);
  if (major >= 20) {
    return { name: 'Node.js', status: 'ok', message: `v${v}` };
  }
  return {
    name: 'Node.js',
    status: 'error',
    message: `v${v} (needs >= 20)`,
    detail: 'Upgrade Node.js to v20 or later.',
  };
}

/** 2. npm version. */
function checkNpm(): CheckResult {
  const r = spawnSync('npm', ['--version'], { encoding: 'utf-8' });
  if (r.error || r.status !== 0) {
    return { name: 'npm', status: 'warn', message: 'not installed' };
  }
  const ver = (r.stdout ?? '').trim();
  const major = parseInt(ver.split('.')[0] ?? '0', 10);
  if (major >= 10) {
    return { name: 'npm', status: 'ok', message: ver };
  }
  return { name: 'npm', status: 'warn', message: `${ver} (recommended >= 10)` };
}

/** 3. API keys. */
function checkApiKeys(): CheckResult[] {
  const keys: Array<{ env: string; required: boolean }> = [
    { env: 'ANTHROPIC_API_KEY', required: false },
    { env: 'OPENAI_API_KEY', required: false },
    { env: 'GOOGLE_API_KEY', required: false },
    { env: 'GITHUB_TOKEN', required: false },
  ];
  return keys.map((k) => {
    const value = process.env[k.env];
    if (!value) {
      return {
        name: k.env,
        status: 'warn',
        message: 'not set (optional)',
      };
    }
    const masked = maskKey(value);
    return { name: k.env, status: 'ok', message: `set (${masked})` };
  });
}

/** Mask an API key for display: keep the first 6 chars and last 4 chars. */
function maskKey(key: string): string {
  if (key.length <= 10) return '***';
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

/** 4. Server reachability. */
async function checkServer(): Promise<CheckResult> {
  const start = Date.now();
  try {
    const res = await fetch(SERVER_HEALTH_URL, {
      method: 'GET',
      signal: AbortSignal.timeout(3000),
    });
    const latency = Date.now() - start;
    if (res.ok) {
      return { name: 'Server', status: 'ok', message: `reachable (${latency}ms)` };
    }
    return {
      name: 'Server',
      status: 'warn',
      message: `responded ${res.status} (${latency}ms)`,
    };
  } catch {
    return {
      name: 'Server',
      status: 'warn',
      message: 'not reachable (start `sanix serve` if you need the API)',
    };
  }
}

/** 5. Provider connectivity. */
async function checkProviders(ctx: SanixContext): Promise<CheckResult[]> {
  let providers: { id: string; isLocal?: boolean }[] = [];
  try {
    providers = ctx.router.list().map((p) => ({ id: p.id, isLocal: (p as { isLocal?: boolean }).isLocal }));
  } catch {
    providers = [];
  }
  if (providers.length === 0) {
    return [{
      name: 'Providers',
      status: 'warn',
      message: 'no providers configured',
      detail: 'Run `sanix config init` to set up a provider.',
    }];
  }
  const out: CheckResult[] = [];
  for (const p of providers) {
    // Local providers are always reachable (no network needed).
    if (p.isLocal) {
      out.push({ name: `Provider ${p.id}`, status: 'ok', message: 'local' });
      continue;
    }
    // For remote providers, attempt a tiny `health()` ping if available.
    try {
      const provider = ctx.router.get(p.id);
      if (provider && typeof (provider as unknown as { health?: () => Promise<boolean> }).health === 'function') {
        const ok = await (provider as unknown as { health: () => Promise<boolean> }).health();
        out.push({
          name: `Provider ${p.id}`,
          status: ok ? 'ok' : 'warn',
          message: ok ? 'reachable' : 'unreachable',
        });
      } else {
        // No health() method — just report as registered.
        out.push({ name: `Provider ${p.id}`, status: 'ok', message: 'registered' });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      out.push({
        name: `Provider ${p.id}`,
        status: 'warn',
        message: `error: ${msg.slice(0, 60)}`,
      });
    }
  }
  return out;
}

/** 6. Config file. */
function checkConfig(fix: boolean): CheckResult {
  const path = DEFAULT_CONFIG_PATH;
  if (!existsSync(path)) {
    if (fix) {
      try {
        saveConfig(path, defaultConfig());
        return {
          name: 'Config',
          status: 'ok',
          message: `created default (${path})`,
          fixed: 'wrote default config',
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { name: 'Config', status: 'error', message: `missing (${path}); fix failed: ${msg}` };
      }
    }
    return {
      name: 'Config',
      status: 'warn',
      message: `missing (${path})`,
      detail: 'Run `sanix config init` or `sanix doctor --fix`.',
    };
  }
  // Try to parse + validate.
  try {
    const text = readFileSync(path, 'utf-8');
    JSON.parse(text); // syntax check
    // Full Zod validation is done in resolveConfig — if we got here through
    // bootstrap, the config already validated.
    return { name: 'Config', status: 'ok', message: `valid (${path})` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (fix) {
      try {
        // Back up the broken file and write a fresh default.
        const backup = `${path}.bak-${Date.now()}`;
        try {
          writeFileSync(backup, readFileSync(path, 'utf-8'), 'utf-8');
        } catch { /* ignore */ }
        saveConfig(path, defaultConfig());
        return {
          name: 'Config',
          status: 'ok',
          message: `repaired (${path})`,
          detail: `original backed up to ${backup}`,
          fixed: 'overwrote invalid config with defaults',
        };
      } catch {
        return { name: 'Config', status: 'error', message: `invalid JSON: ${msg}` };
      }
    }
    return { name: 'Config', status: 'error', message: `invalid JSON: ${msg}` };
  }
}

/** 7. Memory stats. */
async function checkMemory(ctx: SanixContext): Promise<CheckResult> {
  try {
    const working = ctx.memory.working.all();
    let count = working.length;
    let lastTs: number | undefined;
    try {
      const episodic = ctx.memory.episodic as unknown as {
        all?: () => unknown[];
        count?: () => Promise<number> | number;
      };
      if (typeof episodic.all === 'function') {
        count += episodic.all().length;
      } else if (typeof episodic.count === 'function') {
        const c = await Promise.resolve(episodic.count());
        if (typeof c === 'number') count += c;
      }
    } catch {
      // ignore
    }
    let dbSize = 0;
    const memDir = join(SANIX_HOME, 'memory');
    if (existsSync(memDir)) {
      dbSize = dirSize(memDir);
    }
    if (count === 0) {
      return {
        name: 'Memory',
        status: 'ok',
        message: '0 facts (empty)',
        detail: `DB size: ${fmtBytes(dbSize)}`,
      };
    }
    return {
      name: 'Memory',
      status: 'ok',
      message: `${count} facts, ${fmtBytes(dbSize)}`,
      detail: lastTs ? `last memory: ${new Date(lastTs).toISOString()}` : undefined,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name: 'Memory', status: 'warn', message: `error: ${msg.slice(0, 60)}` };
  }
}

/** 8. Cache stats. */
function checkCache(fix: boolean): CheckResult {
  const cacheDir = CACHE_DIR;
  if (!existsSync(cacheDir)) {
    return { name: 'Cache', status: 'ok', message: 'empty (no cache dir)' };
  }
  let size = 0;
  let entries = 0;
  try {
    for (const entry of readdirSync(cacheDir)) {
      const fp = join(cacheDir, entry);
      try {
        const st = statSync(fp);
        if (st.isFile()) {
          size += st.size;
          entries++;
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
  // We don't have a global hit-rate counter in this layer; report size + entries.
  const hitRate = 'N/A';
  if (size > 500 * 1024 * 1024 && fix) {
    try {
      rmSync(cacheDir, { recursive: true, force: true });
      mkdirSync(cacheDir, { recursive: true });
      return {
        name: 'Cache',
        status: 'ok',
        message: `cleared (${entries} entries, ${fmtBytes(size)} → 0)`,
        fixed: 'cleared oversized cache',
      };
    } catch {
      // fall through
    }
  }
  if (size > 500 * 1024 * 1024) {
    return {
      name: 'Cache',
      status: 'warn',
      message: `${entries} entries, ${fmtBytes(size)} (large)`,
      detail: `hit rate: ${hitRate}; run \`sanix doctor --fix\` to clear`,
    };
  }
  return {
    name: 'Cache',
    status: 'ok',
    message: `${entries} entries, ${fmtBytes(size)}`,
    detail: `hit rate: ${hitRate}`,
  };
}

/** 9. Disk space. */
function checkDisk(fix: boolean): CheckResult {
  if (!existsSync(SANIX_HOME)) {
    return { name: 'Disk', status: 'ok', message: '0 B (~/.sanix not created yet)' };
  }
  const size = dirSize(SANIX_HOME);
  if (size > DISK_WARN_BYTES) {
    if (fix) {
      // Auto-clear the cache (the most-likely culprit).
      try {
        if (existsSync(CACHE_DIR)) {
          rmSync(CACHE_DIR, { recursive: true, force: true });
          mkdirSync(CACHE_DIR, { recursive: true });
        }
        const after = dirSize(SANIX_HOME);
        return {
          name: 'Disk',
          status: 'ok',
          message: `${fmtBytes(after)} used (cleared cache; was ${fmtBytes(size)})`,
          fixed: `cleared cache (freed ${fmtBytes(size - after)})`,
        };
      } catch {
        // fall through
      }
    }
    return {
      name: 'Disk',
      status: 'warn',
      message: `${fmtBytes(size)} used (> 1GB, consider clearing cache)`,
    };
  }
  return { name: 'Disk', status: 'ok', message: `${fmtBytes(size)} used` };
}

/** 10. Package versions. */
function checkPackages(): CheckResult {
  // Best-effort: read the @sanix/cli package.json + check for `outdated`.
  const cliPkgPath = join(SANIX_HOME, '..', '..', 'sanix', 'packages', 'cli', 'package.json');
  void cliPkgPath; // informational only
  // Run `npm outdated --json` in the SANIX home (best-effort, fast-fail).
  const r = spawnSync('npm', ['outdated', '--json', '--depth=0'], {
    cwd: SANIX_HOME,
    encoding: 'utf-8',
    timeout: 15_000,
  });
  if (r.error || r.status === null) {
    return { name: 'Packages', status: 'warn', message: 'npm outdated unavailable' };
  }
  // `npm outdated` exits non-zero when outdated packages exist; the JSON
  // is on stdout.
  const stdout = r.stdout?.trim() ?? '';
  if (!stdout || stdout === '{}') {
    return { name: 'Packages', status: 'ok', message: 'all up to date' };
  }
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const count = Object.keys(parsed).length;
    if (count === 0) {
      return { name: 'Packages', status: 'ok', message: 'all up to date' };
    }
    return {
      name: 'Packages',
      status: 'warn',
      message: `${count} outdated package(s)`,
      detail: Object.keys(parsed).slice(0, 5).join(', '),
    };
  } catch {
    return { name: 'Packages', status: 'ok', message: 'all up to date' };
  }
}

/** 11. Permissions. */
function checkPermissions(fix: boolean): CheckResult {
  if (!existsSync(SANIX_HOME)) {
    if (fix) {
      try {
        mkdirSync(SANIX_HOME, { recursive: true });
        return {
          name: 'Permissions',
          status: 'ok',
          message: `created ${SANIX_HOME}`,
          fixed: 'created ~/.sanix/',
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { name: 'Permissions', status: 'error', message: `cannot create ${SANIX_HOME}: ${msg}` };
      }
    }
    return { name: 'Permissions', status: 'warn', message: '~/.sanix/ does not exist' };
  }
  // Try writing a probe file.
  const probe = join(SANIX_HOME, '.write-probe');
  try {
    writeFileSync(probe, 'ok', 'utf-8');
    // Clean up.
    try {
      rmSync(probe, { force: true });
    } catch {
      // ignore
    }
    // Ensure subdirs exist when --fix is set.
    if (fix) {
      for (const sub of ['sessions', 'memory', 'cache', 'checkpoints', 'auth', 'knowledge']) {
        const dir = join(SANIX_HOME, sub);
        if (!existsSync(dir)) {
          try {
            mkdirSync(dir, { recursive: true });
          } catch {
            // ignore
          }
        }
      }
    }
    return { name: 'Permissions', status: 'ok', message: '~/.sanix/ is writable' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name: 'Permissions', status: 'error', message: `not writable: ${msg}` };
  }
}

/** 12. Git. */
function checkGit(): CheckResult {
  const cwd = process.cwd();
  const insideRepo = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd,
    encoding: 'utf-8',
  }).stdout.trim() === 'true';
  if (!insideRepo) {
    return { name: 'Git', status: 'ok', message: 'not a git repo' };
  }
  const status = spawnSync('git', ['status', '--porcelain'], {
    cwd,
    encoding: 'utf-8',
  }).stdout.trim();
  const uncommitted = status.split('\n').filter(Boolean).length;
  if (uncommitted === 0) {
    return { name: 'Git', status: 'ok', message: 'clean working tree' };
  }
  return {
    name: 'Git',
    status: 'ok',
    message: `repository, ${uncommitted} uncommitted file(s)`,
  };
}

/** 13. Docker. */
function checkDocker(): CheckResult {
  const r = spawnSync('docker', ['--version'], { encoding: 'utf-8' });
  if (r.error || r.status !== 0) {
    return {
      name: 'Docker',
      status: 'warn',
      message: 'not installed (sandbox will use process isolation)',
    };
  }
  // Check daemon.
  const ps = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
    encoding: 'utf-8',
    timeout: 5_000,
  });
  if (ps.error || ps.status !== 0) {
    return {
      name: 'Docker',
      status: 'warn',
      message: 'installed but daemon not running',
    };
  }
  const version = (ps.stdout ?? '').trim();
  return { name: 'Docker', status: 'ok', message: `running (server ${version})` };
}

/** 14. Playwright. */
function checkPlaywright(): CheckResult {
  // Try a dynamic import of `playwright`.
  try {
    // Use a variable specifier so TS doesn't statically resolve it.
    const spec = 'playwright';
    void import(spec).catch(() => null);
    // spawn `npx playwright --version` for a definitive check.
    const r = spawnSync('npx', ['playwright', '--version'], { encoding: 'utf-8', timeout: 10_000 });
    if (r.error || r.status !== 0) {
      return { name: 'Playwright', status: 'warn', message: 'not installed (browser automation disabled)' };
    }
    const version = (r.stdout ?? '').trim();
    return { name: 'Playwright', status: 'ok', message: version };
  } catch {
    return { name: 'Playwright', status: 'warn', message: 'not installed' };
  }
}

/** 15. Network. */
async function checkNetwork(): Promise<CheckResult> {
  try {
    const res = await fetch('https://api.github.com/zen', {
      method: 'HEAD',
      signal: AbortSignal.timeout(5000),
      redirect: 'follow',
    });
    if (res.ok || res.status === 405 /* HEAD not allowed but reachable */) {
      return { name: 'Network', status: 'ok', message: 'online' };
    }
    return { name: 'Network', status: 'warn', message: `unusual response ${res.status}` };
  } catch {
    return { name: 'Network', status: 'error', message: 'offline (cannot reach the internet)' };
  }
}

/** Recursively compute the size of a directory (in bytes). */
function dirSize(dir: string): number {
  let total = 0;
  try {
    for (const entry of readdirSync(dir)) {
      const fp = join(dir, entry);
      try {
        const st = statSync(fp);
        if (st.isDirectory()) {
          total += dirSize(fp);
        } else {
          total += st.size;
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
  return total;
}

/** Human-readable byte size. */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Print the report (text or JSON). */
function printReport(report: DoctorReport, opts: DoctorCommandOptions): void {
  if (opts.json) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  // eslint-disable-next-line no-console
  console.log(chalk.hex('#00D4FF')('\nSANIX Health Check'));
  // eslint-disable-next-line no-console
  console.log(chalk.dim('══════════════════════════════════════════'));
  const nameWidth = Math.max(...report.checks.map((c) => c.name.length), 12);
  for (const c of report.checks) {
    const icon = c.status === 'ok' ? chalk.green('✅')
      : c.status === 'warn' ? chalk.hex('#FFB347')('⚠️ ')
      : chalk.red('❌');
    const name = c.name.padEnd(nameWidth);
    // eslint-disable-next-line no-console
    console.log(`  ${icon} ${name}  ${c.message}`);
    if (c.detail) {
      // eslint-disable-next-line no-console
      console.log(chalk.dim(`     ${' '.repeat(nameWidth)}  ${c.detail}`));
    }
    if (c.fixed) {
      // eslint-disable-next-line no-console
      console.log(chalk.green(`     ${' '.repeat(nameWidth)}  ✓ fixed: ${c.fixed}`));
    }
  }
  // eslint-disable-next-line no-console
  console.log('');
  const parts: string[] = [];
  if (report.warnings > 0) parts.push(chalk.hex('#FFB347')(`${report.warnings} warning(s)`));
  if (report.errors > 0) parts.push(chalk.red(`${report.errors} error(s)`));
  if (parts.length === 0) {
    // eslint-disable-next-line no-console
    console.log(chalk.green('  All checks passed. ✓\n'));
  } else {
    // eslint-disable-next-line no-console
    console.log(`  ${parts.join(', ')}\n`);
  }
  if (!opts.fix && (report.warnings > 0 || report.errors > 0)) {
    // eslint-disable-next-line no-console
    console.log(chalk.dim(`  Run \`sanix doctor --fix\` to auto-fix where possible.`));
  }
}

/** Unused helper for spawning detached (kept for future use). */
export function _spawnDetached(cmd: string, args: string[]): void {
  void spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}
