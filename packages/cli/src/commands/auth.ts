/**
 * @file commands/auth.ts
 * @description `sanix auth <sub>` — OAuth + API-key management for SANIX
 * providers. Built on top of `@sanix/auth`'s {@link AuthManager} (Task A1).
 *
 * Subcommands:
 *
 *   sanix auth login <provider>      Start an OAuth flow.
 *     --client-id <id>               Override the default client id.
 *     --scopes <s1,s2>               Override the default scopes.
 *     --timeout <ms>                 Override the default 10-minute timeout.
 *
 *   sanix auth status [provider]     Show auth status for one or all providers.
 *   sanix auth logout <provider>     Revoke + delete tokens for a provider.
 *   sanix auth refresh <provider>    Force a token refresh.
 *   sanix auth list                  List OAuth-capable providers.
 *   sanix auth whoami [provider]     Show user info from the userInfoEndpoint.
 *
 * @packageDocumentation
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import {
  listOAuthProviders,
  getOAuthProvider,
  type AuthStatus,
  type OAuthProviderConfig,
  type OAuthTokenSet,
} from '@sanix/auth';
import type { SanixContext } from '../bootstrap.js';

/** Options for `sanix auth login`. */
export interface AuthLoginOptions {
  clientId?: string;
  scopes?: string;
  timeout?: number;
}

/**
 * Register the `sanix auth` command tree on a Commander program.
 *
 * @param program     - The Commander program to register on.
 * @param ctxProvider - Async factory that returns a wired {@link SanixContext}.
 */
export function registerAuthCommand(
  program: Command,
  ctxProvider: () => Promise<SanixContext>,
): void {
  const auth = program
    .command('auth')
    .description('Manage OAuth + API-key authentication for SANIX providers.');

  // ── auth login ──────────────────────────────────────────────────────
  auth
    .command('login <provider>')
    .description('Start an OAuth login flow for the given provider.')
    .option('--client-id <id>', 'Override the default OAuth client id')
    .option('--scopes <s1,s2>', 'Comma-separated list of OAuth scopes to request')
    .option('--timeout <ms>', 'Flow timeout in milliseconds (default 600000)', (v: string) => Number(v))
    .action(async (provider: string, opts: AuthLoginOptions) => {
      try {
        const ctx = await ctxProvider();
        await authLogin(ctx, provider, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(chalk.red(`\n✗ sanix auth login failed: ${msg}\n`));
        process.exitCode = 1;
      }
    });

  // ── auth status ─────────────────────────────────────────────────────
  auth
    .command('status [provider]')
    .description('Show authentication status for one or all providers.')
    .action(async (provider?: string) => {
      try {
        const ctx = await ctxProvider();
        authStatus(ctx, provider);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(chalk.red(`\n✗ sanix auth status failed: ${msg}\n`));
        process.exitCode = 1;
      }
    });

  // ── auth logout ─────────────────────────────────────────────────────
  auth
    .command('logout <provider>')
    .description('Revoke and delete tokens for the given provider.')
    .action(async (provider: string) => {
      try {
        const ctx = await ctxProvider();
        await authLogout(ctx, provider);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(chalk.red(`\n✗ sanix auth logout failed: ${msg}\n`));
        process.exitCode = 1;
      }
    });

  // ── auth refresh ────────────────────────────────────────────────────
  auth
    .command('refresh <provider>')
    .description('Force a token refresh for the given provider.')
    .action(async (provider: string) => {
      try {
        const ctx = await ctxProvider();
        await authRefresh(ctx, provider);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(chalk.red(`\n✗ sanix auth refresh failed: ${msg}\n`));
        process.exitCode = 1;
      }
    });

  // ── auth list ───────────────────────────────────────────────────────
  auth
    .command('list')
    .description('List OAuth-capable providers known to SANIX.')
    .action(async () => {
      try {
        const ctx = await ctxProvider();
        authList(ctx);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(chalk.red(`\n✗ sanix auth list failed: ${msg}\n`));
        process.exitCode = 1;
      }
    });

  // ── auth whoami ─────────────────────────────────────────────────────
  auth
    .command('whoami [provider]')
    .description('Show user info fetched from the provider\'s userInfo endpoint.')
    .action(async (provider?: string) => {
      try {
        const ctx = await ctxProvider();
        await authWhoami(ctx, provider);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(chalk.red(`\n✗ sanix auth whoami failed: ${msg}\n`));
        process.exitCode = 1;
      }
    });
}

// ─── Subcommand implementations ──────────────────────────────────────────

/**
 * `sanix auth login <provider>` — start an OAuth flow.
 *
 * Flow:
 *   1. Validate `provider` is OAuth-capable via `listOAuthProviders()`.
 *   2. Call `AuthManager.login(provider, { clientIdOverride, scopes, timeoutMs })`.
 *      On success this returns the stored {@link OAuthTokenSet}.
 *   3. Print the expiry time + a hint to try the provider.
 *   4. On failure (AuthError or other), exit with code 1.
 */
export async function authLogin(
  ctx: SanixContext,
  provider: string,
  opts: AuthLoginOptions,
): Promise<void> {
  // Validate OAuth-capable.
  const oauthProviders = listOAuthProviders();
  if (!oauthProviders.includes(provider)) {
    throw new Error(
      `Provider "${provider}" is not OAuth-capable. OAuth-capable providers: ${
        oauthProviders.join(', ') || '(none)'
      }. Run \`sanix auth list\` for the full list.`,
    );
  }

  const scopes = opts.scopes
    ? opts.scopes.split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;

  // eslint-disable-next-line no-console
  console.log(chalk.cyan(`Starting OAuth flow for "${provider}"…`));

  const tokenSet = await ctx.authManager.login(provider, {
    clientIdOverride: opts.clientId,
    scopes,
    timeoutMs: opts.timeout,
  });

  const expiry = formatExpiry(tokenSet.expiresAt);
  // eslint-disable-next-line no-console
  console.log(chalk.green(`\n✓ Logged in to ${provider}.`));
  // eslint-disable-next-line no-console
  console.log(chalk.dim(`  Token expires: ${expiry}`));
  if (tokenSet.scope) {
    // eslint-disable-next-line no-console
    console.log(chalk.dim(`  Scopes: ${tokenSet.scope}`));
  }
  // eslint-disable-next-line no-console
  console.log(
    chalk.dim(`\n  Try: sanix ask 'hello' --provider ${provider}`),
  );
}

/**
 * `sanix auth status [provider]` — print the auth-status table.
 *
 *   Provider         Method    Authenticated   Expires
 *   ─────────────────────────────────────────────────────
 *   google           oauth     ✓               in 58min
 *   anthropic        api_key   ✓               —
 *   openai           none      ✗               —
 */
export function authStatus(ctx: SanixContext, provider?: string): void {
  // AuthManager.status() returns AuthStatus[] synchronously.
  const statuses = ctx.authManager.status(provider);
  if (statuses.length === 0) {
    // eslint-disable-next-line no-console
    console.log(chalk.dim('No providers configured.'));
    return;
  }

  // Column widths (fixed; matches the spec's example layout).
  const W = { provider: 17, method: 9, authed: 13 };
  // eslint-disable-next-line no-console
  console.log(
    chalk.hex('#00D4FF')(
      `Provider`.padEnd(W.provider) +
        `Method`.padEnd(W.method) +
        `Authenticated`.padEnd(W.authed) +
        `Expires`,
    ),
  );
  // eslint-disable-next-line no-console
  console.log(chalk.dim('─'.repeat(W.provider + W.method + W.authed + 12)));

  for (const row of statuses) {
    const authed = row.authenticated
      ? chalk.green('✓')
      : chalk.red('✗');
    const expires = formatExpires(
      row.expiresAt !== undefined ? new Date(row.expiresAt).toISOString() : undefined,
      row.authenticated,
    );
    // eslint-disable-next-line no-console
    console.log(
      chalk.cyan(row.providerId.padEnd(W.provider)) +
        row.method.padEnd(W.method) +
        `${authed}              `.slice(0, W.authed) +
        expires,
    );
  }
}

/** `sanix auth logout <provider>` — revoke + delete tokens. */
export async function authLogout(
  ctx: SanixContext,
  provider: string,
): Promise<void> {
  await ctx.authManager.logout(provider);
  // eslint-disable-next-line no-console
  console.log(chalk.green(`✓ Logged out of ${provider}.`));
  // eslint-disable-next-line no-console
  console.log(chalk.dim('  Tokens revoked and deleted from disk.'));
}

/** `sanix auth refresh <provider>` — force a token refresh. */
export async function authRefresh(
  ctx: SanixContext,
  provider: string,
): Promise<void> {
  const tokenSet = await ctx.authManager.refresh(provider);
  const expiry = formatExpiry(tokenSet.expiresAt);
  // eslint-disable-next-line no-console
  console.log(chalk.green(`✓ Refreshed ${provider} token.`));
  // eslint-disable-next-line no-console
  console.log(chalk.dim(`  New token expires: ${expiry}`));
}

/**
 * `sanix auth list` — list OAuth-capable providers known to SANIX.
 */
export function authList(ctx: SanixContext): void {
  const ids = listOAuthProviders();
  if (ids.length === 0) {
    // eslint-disable-next-line no-console
    console.log(chalk.dim('No OAuth-capable providers are registered.'));
    return;
  }
  // eslint-disable-next-line no-console
  console.log(chalk.hex('#00D4FF')('OAuth-capable providers:\n'));

  // Status lookup so we can show ✓ / ✗ per provider.
  const statuses: AuthStatus[] = ctx.authManager.status();
  const statusMap = new Map(statuses.map((s) => [s.providerId, s]));

  for (const id of ids) {
    const st = statusMap.get(id);
    const authenticated = st?.authenticated ?? false;
    const mark = authenticated ? chalk.green('✓') : chalk.dim('✗');
    const cfg: OAuthProviderConfig | null = getOAuthProvider(id);
    const display = cfg?.displayName ?? id;
    // eslint-disable-next-line no-console
    console.log(`  ${mark} ${chalk.cyan(id.padEnd(12))} ${chalk.dim(display)}`);
  }
  // eslint-disable-next-line no-console
  console.log(
    chalk.dim(`\n  Use \`sanix auth login <provider>\` to authenticate.`),
  );
}

/** User info returned by `whoami`. */
export interface WhoamiInfo {
  /** Provider id. */
  providerId: string;
  /** Stable user id (provider-specific). */
  userId?: string;
  /** Email (if the provider exposes it). */
  email?: string;
  /** Display name (if the provider exposes it). */
  name?: string;
  /** Raw JSON response (for debugging). */
  raw?: unknown;
}

/**
 * `sanix auth whoami [provider]` — fetch + print user info from the
 * provider's userInfo endpoint. If `provider` is omitted, iterates over
 * every OAuth provider that has a `userInfoEndpoint` and an
 * authenticated token, printing info for each.
 */
export async function authWhoami(
  ctx: SanixContext,
  provider?: string,
): Promise<void> {
  const targets: string[] = provider ? [provider] : listOAuthProviders();
  let printed = false;
  for (const id of targets) {
    const cfg = getOAuthProvider(id);
    if (!cfg || !cfg.userInfoEndpoint) continue;
    const token = await safeGetAccessToken(ctx, id);
    if (!token) continue;

    const info = await fetchUserInfo(cfg, token);
    if (!info) continue;
    printed = true;
    printWhoami(id, info);
  }
  if (!printed) {
    // eslint-disable-next-line no-console
    console.log(
      chalk.yellow(
        provider
          ? `No authenticated user info for "${provider}". Run \`sanix auth login ${provider}\` first.`
          : 'No authenticated providers with a userInfo endpoint. Run `sanix auth login <provider>` first.',
      ),
    );
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/** Format an epoch-ms expiry as a localized string. */
function formatExpiry(expiresAtEpochMs: number): string {
  return new Date(expiresAtEpochMs).toLocaleString();
}

/**
 * Format an ISO expiry timestamp as a human-readable "in Nmin" / "in Ndays"
 * string. Returns '—' for non-expiring credentials or expired tokens.
 */
function formatExpires(expiresAt: string | undefined, authenticated: boolean): string {
  if (!authenticated) return chalk.dim('—');
  if (!expiresAt) return chalk.dim('—');
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return chalk.red('expired');
  if (ms < 60_000) return chalk.yellow(`in ${Math.round(ms / 1000)}s`);
  if (ms < 3_600_000) return chalk.green(`in ${Math.round(ms / 60_000)}min`);
  if (ms < 86_400_000) return chalk.green(`in ${Math.round(ms / 3_600_000)}hr`);
  return chalk.green(`in ${Math.round(ms / 86_400_000)}days`);
}

/**
 * Defensive `AuthManager.getAccessToken()` call — always returns `null`
 * on failure (never throws).
 */
async function safeGetAccessToken(
  ctx: SanixContext,
  providerId: string,
): Promise<string | null> {
  try {
    return await ctx.authManager.getAccessToken(providerId);
  } catch {
    return null;
  }
}

/**
 * Fetch user info from the provider's `userInfoEndpoint`. Returns `null`
 * on any failure (network error, non-200, JSON parse error).
 */
async function fetchUserInfo(
  cfg: OAuthProviderConfig,
  accessToken: string,
): Promise<WhoamiInfo | null> {
  if (!cfg.userInfoEndpoint) return null;
  try {
    const res = await fetch(cfg.userInfoEndpoint, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });
    if (!res.ok) return null;
    const raw = await res.json() as unknown;
    return parseUserInfo(cfg.id, raw);
  } catch {
    return null;
  }
}

/**
 * Parse a raw user-info JSON object into a {@link WhoamiInfo}. Defensive —
 * handles null/non-object payloads and provider-specific field names
 * (GitHub uses `login` + `name` + `email`; Google uses `sub` + `email` +
 * `name`; Microsoft uses `id` / `userPrincipalName`).
 */
function parseUserInfo(providerId: string, raw: unknown): WhoamiInfo | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const info: WhoamiInfo = { providerId };

  // User id — try common field names.
  const userIdKeys = ['sub', 'id', 'userId', 'login'] as const;
  for (const k of userIdKeys) {
    if (typeof r[k] === 'string') {
      info.userId = r[k] as string;
      break;
    }
  }

  // Email — try common field names.
  const emailKeys = ['email', 'mail', 'userPrincipalName', 'emailAddress'] as const;
  for (const k of emailKeys) {
    if (typeof r[k] === 'string') {
      info.email = r[k] as string;
      break;
    }
  }

  // Display name — try common field names.
  const nameKeys = ['name', 'displayName', 'fullName', 'username'] as const;
  for (const k of nameKeys) {
    if (typeof r[k] === 'string') {
      info.name = r[k] as string;
      break;
    }
  }

  info.raw = raw;
  return info;
}

/** Print a {@link WhoamiInfo} in a human-readable format. */
function printWhoami(providerId: string, info: WhoamiInfo): void {
  // eslint-disable-next-line no-console
  console.log(chalk.hex('#00D4FF')(`User info for ${providerId}:\n`));
  if (info.userId) {
    // eslint-disable-next-line no-console
    console.log(`  User ID:  ${chalk.cyan(info.userId)}`);
  }
  if (info.email) {
    // eslint-disable-next-line no-console
    console.log(`  Email:    ${chalk.cyan(info.email)}`);
  }
  if (info.name) {
    // eslint-disable-next-line no-console
    console.log(`  Name:     ${chalk.cyan(info.name)}`);
  }
  if (info.raw) {
    // eslint-disable-next-line no-console
    console.log(chalk.dim('\n  Raw response:'));
    // eslint-disable-next-line no-console
    console.log(chalk.dim(`  ${JSON.stringify(info.raw, null, 2).split('\n').join('\n  ')}`));
  }
}
