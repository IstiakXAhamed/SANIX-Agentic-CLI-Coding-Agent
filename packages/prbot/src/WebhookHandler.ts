/**
 * @file WebhookHandler.ts
 * @description Accepts webhook deliveries from the four supported
 * platforms, normalises them into a {@link WebhookPayload}, and routes
 * them to a user-supplied handler. Each platform's webhook format is
 * different, so per-platform parsers live below.
 *
 * The handler is framework-agnostic: it accepts a raw HTTP request
 * (expressed as a `(headers, body)` tuple) so it can be wired into any
 * HTTP framework (Express, Fastify, Hono, raw Node http, etc.).
 *
 * @packageDocumentation
 */

import type { Platform, WebhookPayload } from './types.js';

/** The signature of a user-supplied webhook event handler. */
export type WebhookHandlerFn = (payload: WebhookPayload) => void | Promise<void>;

/** Options accepted by {@link WebhookHandler}. */
export interface WebhookHandlerOptions {
  /** Optional shared secret for HMAC signature verification. */
  readonly secret?: string;
  /** Whether to skip signature verification (default `false`). */
  readonly skipSignatureCheck?: boolean;
}

/**
 * Normalises and routes webhook deliveries.
 *
 * ```ts
 * const handler = new WebhookHandler();
 * handler.on('github', async (payload) => {
 *   if (payload.event === 'pull_request.opened') {
 *     const prId = payload.prId!;
 *     await bot.review(prId);
 *   }
 * });
 *
 * // In your HTTP framework:
 * app.post('/webhook', async (req, res) => {
 *   const payload = await handler.parse(req.headers, req.body);
 *   await handler.dispatch(payload);
 *   res.status(200).end();
 * });
 * ```
 */
export class WebhookHandler {
  /** Per-platform handler functions. */
  readonly #handlers: Map<Platform, WebhookHandlerFn[]> = new Map();
  /** Catch-all handler invoked for every payload, regardless of platform. */
  #catchAll: WebhookHandlerFn | null = null;
  /** Options. */
  readonly #options: WebhookHandlerOptions;

  /**
   * @param options - Handler options (see {@link WebhookHandlerOptions}).
   */
  constructor(options: WebhookHandlerOptions = {}) {
    this.#options = options;
  }

  /**
   * Register a handler for a specific platform. Multiple handlers per
   * platform are supported and called in registration order.
   *
   * @param platform - The platform to handle.
   * @param fn       - The handler function.
   */
  on(platform: Platform, fn: WebhookHandlerFn): void {
    const arr = this.#handlers.get(platform) ?? [];
    arr.push(fn);
    this.#handlers.set(platform, arr);
  }

  /**
   * Register a catch-all handler invoked for every payload, regardless
   * of platform. Useful for logging or metrics.
   *
   * @param fn - The handler function.
   */
  onAny(fn: WebhookHandlerFn): void {
    this.#catchAll = fn;
  }

  /**
   * Parse raw HTTP request headers + body into a normalised
   * {@link WebhookPayload}. The platform is auto-detected from the
   * headers. Throws if the platform cannot be detected or the signature
   * verification fails.
   *
   * @param headers - HTTP request headers (case-insensitive keys).
   * @param body    - The raw request body (string or already-parsed object).
   * @returns The normalised payload.
   */
  async parse(headers: Record<string, string | string[] | undefined>, body: string | Record<string, unknown> | undefined): Promise<WebhookPayload> {
    const platform = this.#detectPlatform(headers);
    if (!platform) throw new Error('Could not detect platform from headers');
    if (!this.#options.skipSignatureCheck && this.#options.secret) {
      this.#verifySignature(platform, headers, body, this.#options.secret);
    }
    const raw = typeof body === 'string' ? JSON.parse(body) : (body ?? {});
    return this.#normalise(platform, headers, raw);
  }

  /**
   * Dispatch a parsed payload to all registered handlers (platform
   * handlers first, then the catch-all). Handlers are awaited in
   * sequence; a thrown error in one handler does not prevent the next
   * from running (it is logged and re-thrown only after all handlers
   * have been called).
   *
   * @param payload - The payload to dispatch.
   */
  async dispatch(payload: WebhookPayload): Promise<void> {
    const errors: unknown[] = [];
    const handlers = this.#handlers.get(payload.platform) ?? [];
    for (const fn of handlers) {
      try {
        await fn(payload);
      } catch (e) {
        errors.push(e);
      }
    }
    if (this.#catchAll) {
      try {
        await this.#catchAll(payload);
      } catch (e) {
        errors.push(e);
      }
    }
    if (errors.length > 0) throw errors[0];
  }

  /**
   * Convenience method that parses and dispatches in one call.
   *
   * @param headers - HTTP request headers.
   * @param body    - The raw request body.
   */
  async handle(headers: Record<string, string | string[] | undefined>, body: string | Record<string, unknown> | undefined): Promise<WebhookPayload> {
    const payload = await this.parse(headers, body);
    await this.dispatch(payload);
    return payload;
  }

  /** Auto-detect the platform from the request headers. */
  #detectPlatform(headers: Record<string, string | string[] | undefined>): Platform | undefined {
    const h = lowercaseKeys(headers);
    if (h['x-github-event'] !== undefined) return 'github';
    if (h['x-gitlab-event'] !== undefined) return 'gitlab';
    if (h['x-event-key'] !== undefined && String(h['x-event-key']).startsWith('pullrequest:')) return 'bitbucket';
    if (h['x-gitea-event'] !== undefined || h['x-gogs-event'] !== undefined) return 'gitea';
    return undefined;
  }

  /** Verify the HMAC signature of the request body. */
  #verifySignature(platform: Platform, headers: Record<string, string | string[] | undefined>, body: string | Record<string, unknown> | undefined, secret: string): void {
    const h = lowercaseKeys(headers);
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body ?? {});
    let sigHeader: string | undefined;
    switch (platform) {
      case 'github': sigHeader = h['x-hub-signature-256'] as string | undefined; break;
      case 'gitlab': sigHeader = h['x-gitlab-token'] as string | undefined; break;
      case 'bitbucket': sigHeader = undefined; break; // Bitbucket Cloud doesn't sign.
      case 'gitea': sigHeader = h['x-gitea-signature'] as string | undefined; break;
    }
    if (!sigHeader) {
      if (platform === 'gitlab' && sigHeader === secret) return;
      throw new Error(`Missing signature header for ${platform}`);
    }
    // For GitLab, the token is compared directly (no HMAC).
    if (platform === 'gitlab') {
      if (sigHeader !== secret) throw new Error('GitLab token mismatch');
      return;
    }
    // For HMAC-based platforms, verify with sha256.
    const expected = 'sha256=' + hmacSha256Hex(secret, bodyStr);
    if (!safeEqual(expected, sigHeader)) throw new Error(`${platform} signature mismatch`);
  }

  /** Normalise a platform-specific payload into a {@link WebhookPayload}. */
  #normalise(platform: Platform, headers: Record<string, string | string[] | undefined>, raw: Record<string, unknown>): WebhookPayload {
    const h = lowercaseKeys(headers);
    switch (platform) {
      case 'github': {
        const event = String(h['x-github-event'] ?? 'ping');
        const action = (raw['action'] as string | undefined) ?? '';
        const prNumber = (raw['pull_request'] as { number?: number } | undefined)?.number;
        const repo = (raw['repository'] as { full_name?: string } | undefined)?.full_name ?? '';
        return {
          platform,
          event: action ? `${event}.${action}` : event,
          prId: prNumber,
          repo,
          raw,
        };
      }
      case 'gitlab': {
        const eventKind = String(h['x-gitlab-event'] ?? 'Push Hook');
        const attrs = (raw['object_attributes'] as { iid?: number; action?: string; target_kind?: string } | undefined) ?? {};
        const project = (raw['project'] as { path_with_namespace?: string } | undefined)?.path_with_namespace ?? '';
        return {
          platform,
          event: eventKind.replace(/\s+/g, '_').toLowerCase() + (attrs.action ? `.${attrs.action}` : ''),
          prId: attrs.iid,
          repo: project,
          raw,
        };
      }
      case 'bitbucket': {
        const eventKey = String(h['x-event-key'] ?? 'pullrequest:updated');
        const data = (raw['data'] as { pullrequest?: { id?: number }; repository?: { full_name?: string } } | undefined) ?? {};
        return {
          platform,
          event: eventKey,
          prId: data.pullrequest?.id,
          repo: data.repository?.full_name ?? '',
          raw,
        };
      }
      case 'gitea': {
        const event = String(h['x-gitea-event'] ?? 'push');
        const action = (raw['action'] as string | undefined) ?? '';
        const prNumber = (raw['pull_request'] as { number?: number } | undefined)?.number;
        const repo = (raw['repository'] as { full_name?: string } | undefined)?.full_name ?? '';
        return {
          platform,
          event: action ? `${event}.${action}` : event,
          prId: prNumber,
          repo,
          raw,
        };
      }
      default: {
        const exhaustive: never = platform;
        throw new Error(`Unknown platform: ${String(exhaustive)}`);
      }
    }
  }
}

/** Lowercase all keys of a headers object for case-insensitive lookup. */
function lowercaseKeys(headers: Record<string, string | string[] | undefined>): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

/** Compute the HMAC-SHA256 of `data` with `key` as a hex string. */
function hmacSha256Hex(key: string, data: string): string {
  // Use Node's crypto via a lazy require to keep this file portable.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHmac } = require('node:crypto') as typeof import('node:crypto');
  return createHmac('sha256', key).update(data).digest('hex');
}

/** Constant-time string comparison to defeat timing attacks. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
