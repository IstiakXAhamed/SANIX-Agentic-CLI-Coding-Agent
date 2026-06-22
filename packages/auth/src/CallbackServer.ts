/**
 * @file CallbackServer.ts
 * @description A tiny, throwaway `http` server that listens on `localhost`
 *   for the OAuth 2.0 redirect carrying `?code=...&state=...`. It exists
 *   only for the duration of one login flow: {@link start} brings it up,
 *   {@link waitForCode} resolves (or rejects) on the first matching
 *   callback, and {@link stop} tears it down.
 *
 *   Design notes:
 *     - Listens **only** on `127.0.0.1` so the loopback redirect never
 *       exposes anything to the network. (RFC 8252 §8.3 mandates loopback
 *       redirection for native apps.)
 *     - Validates the `state` parameter against the value passed to the
 *       constructor — any mismatch is treated as a CSRF attempt and the
 *       promise rejects with `AUTH_STATE_MISMATCH`.
 *     - Honors the provider-supplied `?error=` / `?error_description=` if
 *       the user denied consent, surfacing it as `AUTH_CALLBACK_ERROR`.
 *     - Always renders a small HTML page back to the browser so the user
 *       gets immediate feedback ("You can close this tab now") instead of
 *       a connection-reset error.
 *
 * @packageDocumentation
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { AuthError } from './types.js';

/** Result returned by {@link OAuthCallbackServer.waitForCode}. */
export interface CallbackResult {
  /** The authorization `code` to be exchanged for tokens. */
  readonly code: string;
  /** The `state` echoed back by the provider — always matches the constructor. */
  readonly state: string;
}

/**
 * Localhost HTTP server that captures the OAuth 2.0 authorization callback.
 *
 * One instance per login attempt. Not thread-safe across concurrent flows
 * on the same port — callers should ensure the port is free (the
 * pre-configured per-provider port is chosen to make collisions unlikely).
 *
 * @example
 * ```ts
 * const server = new OAuthCallbackServer(8788, '/callback', stateToken);
 * await server.start();
 * // …open browser to auth URL…
 * const { code, state } = await server.waitForCode(600_000);
 * await server.stop();
 * ```
 */
export class OAuthCallbackServer {
  private readonly port: number;
  private readonly path: string;
  private readonly expectedState: string;
  private server: Server | null = null;
  /**
   * List of pending waiters. Each call to {@link waitForCode} adds an
   * entry; on first callback (or timeout) every waiter is settled and the
   * list is cleared. This makes multiple concurrent waiters see the same
   * outcome rather than only the most-recent one.
   */
  private waiters: Array<{
    resolve: (r: CallbackResult) => void;
    reject: (e: AuthError) => void;
    timer: NodeJS.Timeout;
  }> = [];

  /**
   * @param port - TCP port to listen on (loopback only).
   * @param path - URL path that should accept the callback, e.g. `'/callback'`.
   * @param state - The opaque `state` token sent in the authorization
   *   request; the callback must echo it back unchanged.
   */
  public constructor(port: number, path: string, state: string) {
    this.port = port;
    // Normalize the path so both `/callback` and `callback` work.
    this.path = path.startsWith('/') ? path : `/${path}`;
    this.expectedState = state;
  }

  /**
   * Bring up the HTTP server on `127.0.0.1:<port>`. Resolves once the
   * socket is actually listening.
   *
   * @throws {Error} If the port is already in use or the OS refuses to
   *   bind.
   */
  public start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => this.handleRequest(req, res));
      server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          reject(
            new Error(
              `OAuthCallbackServer: port ${this.port} is already in use. ` +
                `Another SANIX login flow may be in progress, or another app is bound to this port.`,
            ),
          );
        } else {
          reject(err);
        }
      });
      server.listen(this.port, '127.0.0.1', () => {
        this.server = server;
        resolve();
      });
    });
  }

  /**
   * Wait for the first matching callback to arrive. Resolves with the
   * `code` + `state`; rejects with `AUTH_TIMEOUT` after `timeoutMs`, with
   * `AUTH_STATE_MISMATCH` on a state mismatch, or with `AUTH_CALLBACK_ERROR`
   * if the provider sent back an `error` parameter (e.g. the user denied
   * consent).
   *
   * Calling this multiple times is safe — the second call returns a promise
   * that resolves with the same result (or rejects with the same error).
   *
   * @param timeoutMs - How long to wait. Defaults to 10 minutes.
   * @returns The {@link CallbackResult}.
   */
  public waitForCode(timeoutMs: number = 600_000): Promise<CallbackResult> {
    return new Promise<CallbackResult>((resolve, reject) => {
      // Build the waiter first with a sentinel timer; the real timer needs
      // to reference `waiter` (to remove it from the list on timeout), so
      // we close over it after construction.
      const waiter = {
        resolve,
        reject,
        timer: undefined as unknown as NodeJS.Timeout,
      };
      waiter.timer = setTimeout(() => {
        // Remove this waiter from the list and reject it.
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(
          new AuthError(
            'AUTH_TIMEOUT',
            `OAuth login timed out after ${timeoutMs} ms waiting for the callback on ` +
              `http://127.0.0.1:${this.port}${this.path}`,
          ),
        );
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  /**
   * Close the HTTP server. Safe to call multiple times. Resolves once the
   * underlying socket is fully closed.
   */
  public stop(): Promise<void> {
    // Clear every pending waiter's timeout. We deliberately do NOT reject
    // them here — `stop` is the cleanup path called after `waitForCode` has
    // already settled (in the happy path) or is about to be re-awaited by
    // the caller. Clearing timeouts prevents leaks.
    for (const w of this.waiters) {
      clearTimeout(w.timer);
    }
    this.waiters = [];
    const server = this.server;
    if (!server) return Promise.resolve();
    return new Promise<void>((resolve) => {
      server.close(() => {
        this.server = null;
        resolve();
      });
      // If there are any lingering open connections, force-close them so
      // server.close() actually completes promptly.
      server.closeAllConnections?.();
    });
  }

  /**
   * Inner request handler. Parses the query string, validates state,
   * renders the success/error HTML, and resolves/rejects the pending
   * {@link waitForCode} promise.
   */
  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? '/';
    const pathOnly = url.split('?', 1)[0];
    if (pathOnly !== this.path) {
      // Not our callback; respond 404 so the browser doesn't hang.
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const query = this.parseQuery(url.slice(pathOnly.length + 1));
    const code = query.get('code');
    const state = query.get('state');
    const error = query.get('error');
    const errorDescription = query.get('error_description') ?? '';
    const errorUri = query.get('error_uri') ?? '';

    let html: string;
    let status: number;
    let result: { kind: 'ok'; code: string; state: string } | { kind: 'err'; authError: AuthError } | null = null;

    if (error) {
      status = 400;
      html = this.renderErrorPage(error, errorDescription, errorUri);
      result = {
        kind: 'err',
        authError: new AuthError(
          'AUTH_CALLBACK_ERROR',
          `Provider returned error: ${error}${errorDescription ? ` — ${errorDescription}` : ''}`,
        ),
      };
    } else if (!code || !state) {
      status = 400;
      html = this.renderErrorPage(
        'invalid_request',
        'Missing `code` or `state` parameter in the OAuth callback.',
        '',
      );
      result = {
        kind: 'err',
        authError: new AuthError(
          'AUTH_CALLBACK_ERROR',
          'OAuth callback is missing the `code` or `state` parameter',
        ),
      };
    } else if (state !== this.expectedState) {
      status = 400;
      html = this.renderErrorPage(
        'state_mismatch',
        'The `state` token returned by the provider did not match the one we sent. ' +
          'This may indicate a CSRF attempt or a stale browser tab.',
        '',
      );
      result = {
        kind: 'err',
        authError: new AuthError(
          'AUTH_STATE_MISMATCH',
          `OAuth state mismatch: expected ${this.expectedState}, received ${state}`,
        ),
      };
    } else {
      status = 200;
      html = this.renderSuccessPage();
      result = { kind: 'ok', code, state };
    }

    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);

    // Settle every pending waiter (there is normally exactly one, but the
    // API supports multiple concurrent `waitForCode` callers — all see the
    // same outcome). Snapshot then clear so any settle-time re-entrancy is
    // safe.
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) {
      clearTimeout(w.timer);
      if (result && result.kind === 'ok') {
        w.resolve({ code: result.code, state: result.state });
      } else if (result && result.kind === 'err') {
        w.reject(result.authError);
      }
    }
    // Auto-stop the server once we've handled the callback. The caller
    // may still call stop() — that's a no-op.
    if (result) {
      void this.stop().catch(() => {
        /* ignore */
      });
    }
  }

  /** Tiny URLSearchParams-based query parser that handles `+` and `%xx`. */
  private parseQuery(qs: string): URLSearchParams {
    return new URLSearchParams(qs);
  }

  /** Static HTML for the success case. Branded but minimal. */
  private renderSuccessPage(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>SANIX — Sign-in successful</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
         background:#0D1117;color:#E6EDF3;margin:0;padding:0;display:flex;align-items:center;
         justify-content:center;min-height:100vh}
    .card{max-width:480px;padding:2.5rem 2rem;border:1px solid #30363D;border-radius:12px;
          background:#0D1117;text-align:center}
    h1{color:#39D353;font-size:1.4rem;margin:0 0 .75rem}
    p{color:#8B949E;line-height:1.5;margin:.5rem 0}
    .brand{color:#00D4FF;font-weight:600;letter-spacing:.05em}
    .ok{font-size:2.5rem;margin-bottom:.5rem}
  </style>
</head>
<body>
  <div class="card">
    <div class="ok" aria-hidden="true">✓</div>
    <h1>Sign-in successful</h1>
    <p>You can close this tab now and return to <span class="brand">SANIX</span> in your terminal.</p>
  </div>
</body>
</html>`;
  }

  /** Static HTML for any error case (provider error, state mismatch, etc.). */
  private renderErrorPage(error: string, description: string, uri: string): string {
    const safeError = this.escapeHtml(error);
    const safeDesc = this.escapeHtml(description);
    const safeUri = this.escapeHtml(uri);
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>SANIX — Sign-in failed</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
         background:#0D1117;color:#E6EDF3;margin:0;padding:0;display:flex;align-items:center;
         justify-content:center;min-height:100vh}
    .card{max-width:480px;padding:2.5rem 2rem;border:1px solid #30363D;border-radius:12px;
          background:#0D1117;text-align:center}
    h1{color:#FF4D4D;font-size:1.4rem;margin:0 0 .75rem}
    p{color:#8B949E;line-height:1.5;margin:.5rem 0}
    code{background:#161B22;padding:.15rem .4rem;border-radius:4px;color:#FFB347;font-size:.9em}
    .brand{color:#00D4FF;font-weight:600;letter-spacing:.05em}
    .err{font-size:2.5rem;margin-bottom:.5rem}
  </style>
</head>
<body>
  <div class="card">
    <div class="err" aria-hidden="true">✗</div>
    <h1>Sign-in failed</h1>
    <p><span class="brand">SANIX</span> could not complete the OAuth flow.</p>
    <p>Error: <code>${safeError}</code></p>
    ${safeDesc ? `<p>${safeDesc}</p>` : ''}
    ${safeUri ? `<p><a href="${safeUri}" target="_blank" rel="noopener noreferrer">More info</a></p>` : ''}
    <p>Please close this tab and try again from your terminal.</p>
  </div>
</body>
</html>`;
  }

  /** Minimal HTML-escaper to prevent reflected XSS in the error page. */
  private escapeHtml(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}
