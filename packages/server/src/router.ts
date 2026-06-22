/**
 * @file Router — minimal URL-pattern based HTTP router (no Express).
 *
 * Supports:
 *   - Method-specific handlers (GET/POST/DELETE/etc.)
 *   - Path parameters (`:id` segments)
 *   - Wildcard catch-all (`*`)
 *   - Middleware chain (each receives request, can short-circuit)
 *
 * @packageDocumentation
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

export interface RouteRequest {
  method: string;
  url: string;
  path: string;
  query: URLSearchParams;
  params: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  raw: IncomingMessage;
}

export interface RouteResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export type RouteHandler = (req: RouteRequest, res: ServerResponse) => Promise<RouteResponse | void>;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

/**
 * Compile a path pattern like `/v1/runs/:id/events` into a RegExp + param name list.
 *
 * `:name` segments become `([^/]+)` capture groups.
 * `*` becomes `(.*)` (catch-all).
 * Literal segments are escaped.
 */
function compilePattern(pattern: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  let regexSrc = '^';
  const segments = pattern.split('/');
  for (const seg of segments) {
    if (seg === '') continue;
    if (seg === '*') {
      regexSrc += '/(.*)';
      paramNames.push('*');
    } else if (seg.startsWith(':')) {
      paramNames.push(seg.slice(1));
      regexSrc += `/([^/]+)`;
    } else {
      regexSrc += '/' + seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  regexSrc += '/?$';
  return { regex: new RegExp(regexSrc), paramNames };
}

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: RouteHandler): void {
    const { regex, paramNames } = compilePattern(pattern);
    this.routes.push({ method: method.toUpperCase(), pattern: regex, paramNames, handler });
  }

  get(pattern: string, handler: RouteHandler): void { this.add('GET', pattern, handler); }
  post(pattern: string, handler: RouteHandler): void { this.add('POST', pattern, handler); }
  put(pattern: string, handler: RouteHandler): void { this.add('PUT', pattern, handler); }
  delete(pattern: string, handler: RouteHandler): void { this.add('DELETE', pattern, handler); }
  options(pattern: string, handler: RouteHandler): void { this.add('OPTIONS', pattern, handler); }

  match(method: string, path: string): { handler: RouteHandler; params: Record<string, string> } | null {
    for (const route of this.routes) {
      if (route.method !== method.toUpperCase() && route.method !== 'ANY') continue;
      const m = route.pattern.exec(path);
      if (!m) continue;
      const params: Record<string, string> = {};
      route.paramNames.forEach((name, i) => {
        if (name === '*') {
          params['*'] = decodeURIComponent(m[i + 1] ?? '');
        } else {
          params[name] = decodeURIComponent(m[i + 1] ?? '');
        }
      });
      return { handler: route.handler, params };
    }
    return null;
  }

  /** Read the request body (JSON or raw text). Returns string for non-JSON. */
  static async readBody(req: IncomingMessage, maxBytes = 10 * 1024 * 1024): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      req.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > maxBytes) {
          reject(new Error(`Body too large (max ${maxBytes} bytes)`));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (buf.length === 0) {
          resolve(undefined);
          return;
        }
        const contentType = (req.headers['content-type'] ?? '').toLowerCase();
        if (contentType.includes('application/json')) {
          try {
            resolve(JSON.parse(buf.toString('utf-8')));
          } catch (err) {
            reject(new Error(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`));
            return;
          }
        } else {
          resolve(buf.toString('utf-8'));
        }
      });
      req.on('error', reject);
    });
  }
}
