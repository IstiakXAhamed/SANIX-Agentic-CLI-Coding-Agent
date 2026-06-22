/**
 * @file ConnectionPool.ts
 * @description An HTTP connection pool with keep-alive, per-host concurrency
 * limits, and basic retry/backoff. Uses Node's built-in `http.Agent` /
 * `https.Agent` under the hood — no external HTTP library required.
 *
 * @packageDocumentation
 */

import { Agent, get, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, get as httpsGet, request as httpsRequest } from 'node:https';
import { URL } from 'node:url';

/** Options for {@link ConnectionPool}. */
export interface ConnectionPoolOptions {
  /** Max keep-alive sockets per host. Default 8. */
  maxSocketsPerHost?: number;
  /** Keep-alive timeout ms (server-side). Default 30s. */
  keepAliveMs?: number;
  /** Whether to enable keep-alive (default true). */
  keepAlive?: boolean;
  /** Max retries per request. Default 2. */
  maxRetries?: number;
  /** Base backoff ms (exponential). Default 200. */
  baseBackoffMs?: number;
}

/** A pending HTTP request's options. */
export interface PoolRequestOptions {
  /** HTTP method. Default `GET`. */
  method?: string;
  /** Request headers. */
  headers?: Record<string, string>;
  /** Request body (string or Buffer). */
  body?: string | Buffer;
  /** Per-request timeout ms. Default 30s. */
  timeoutMs?: number;
}

/** Result of a {@link ConnectionPool.request}. */
export interface PoolResponse {
  /** HTTP status code. */
  status: number;
  /** Response headers (lowercased). */
  headers: Record<string, string | string[]>;
  /** Response body as a string. */
  body: string;
  /** Whether the request succeeded (2xx). */
  ok: boolean;
  /** Wall-clock ms the request took. */
  durationMs: number;
}

/**
 * A pooled HTTP client with keep-alive + retry.
 *
 * @example
 * ```ts
 * const pool = new ConnectionPool({ maxSocketsPerHost: 16 });
 * const r = await pool.request('https://api.example.com/users');
 * ```
 */
export class ConnectionPool {
  private readonly httpAgent: Agent;
  private readonly httpsAgent: HttpsAgent;
  private readonly maxRetries: number;
  private readonly baseBackoffMs: number;

  constructor(opts: ConnectionPoolOptions = {}) {
    const keepAlive = opts.keepAlive ?? true;
    const maxSockets = opts.maxSocketsPerHost ?? 8;
    const keepAliveMsecs = opts.keepAliveMs ?? 30_000;
    this.httpAgent = new Agent({ keepAlive, maxSockets, keepAliveMsecs });
    this.httpsAgent = new HttpsAgent({ keepAlive, maxSockets, keepAliveMsecs });
    this.maxRetries = opts.maxRetries ?? 2;
    this.baseBackoffMs = opts.baseBackoffMs ?? 200;
  }

  /**
   * Issue an HTTP request with retry + keep-alive.
   *
   * @param url The URL.
   * @param opts See {@link PoolRequestOptions}.
   */
  async request(url: string, opts: PoolRequestOptions = {}): Promise<PoolResponse> {
    let lastErr: Error | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.singleRequest(url, opts);
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        if (attempt < this.maxRetries) {
          await sleep(this.baseBackoffMs * 2 ** attempt);
        }
      }
    }
    throw lastErr ?? new Error('request failed');
  }

  /** Issue a single (no-retry) request. */
  private singleRequest(url: string, opts: PoolRequestOptions): Promise<PoolResponse> {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const isHttps = u.protocol === 'https:';
      const agent = isHttps ? this.httpsAgent : this.httpAgent;
      const reqFn = isHttps ? httpsRequest : httpRequest;
      const getFn = isHttps ? httpsGet : get;
      const method = opts.method ?? 'GET';
      const timeoutMs = opts.timeoutMs ?? 30_000;
      const start = Date.now();

      const headers = { ...(opts.headers ?? {}) };
      if (opts.body && !headers['content-length']) {
        headers['content-length'] = String(Buffer.byteLength(opts.body));
      }

      const req = reqFn(
        {
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port || (isHttps ? 443 : 80),
          path: `${u.pathname}${u.search}`,
          method,
          headers,
          agent,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers as Record<string, string | string[]>,
              body,
              ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
              durationMs: Date.now() - start,
            });
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`timeout after ${timeoutMs}ms`));
      });
      if (opts.body) req.write(opts.body);
      req.end();
      // Touch getFn so tree-shakers don't drop it (kept for API parity).
      void getFn;
    });
  }

  /** Destroy all sockets + release resources. */
  async destroy(): Promise<void> {
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
  }
}

/** Promise-based sleep. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
