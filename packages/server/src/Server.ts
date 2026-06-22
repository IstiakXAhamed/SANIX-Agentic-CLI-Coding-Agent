/**
 * @file Server — SANIX REST API server. Pure Node `http` (no Express).
 *
 * Routes:
 *   GET    /health
 *   GET    /v1/providers
 *   GET    /v1/providers/:id/status
 *   POST   /v1/chat
 *   POST   /v1/run
 *   GET    /v1/runs/:id
 *   GET    /v1/runs/:id/events      (SSE)
 *   POST   /v1/runs/:id/abort
 *   GET    /v1/memory
 *   POST   /v1/memory
 *   DELETE /v1/memory/:id
 *   GET    /v1/tools
 *   POST   /v1/tools/:name/execute
 *   GET    /v1/cost
 *   GET    /v1/config
 *   POST   /v1/share
 *   GET    /v1/auth/status
 *
 * Auth: if `authToken` is set, all routes except /health require
 * `Authorization: Bearer <token>`.
 *
 * CORS: if `cors: true`, adds `Access-Control-Allow-Origin: *` and handles OPTIONS.
 *
 * @packageDocumentation
 */

import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { Router, type RouteRequest, type RouteResponse } from './router.js';
import { RunManager, type RunEvent } from './run/RunManager.js';
import { streamEvents } from './sse/index.js';

/** The minimal context passed into the server. Mirrors what `bootstrap()` builds in @sanix/cli. */
export interface SanixContext {
  config: unknown;
  providerRouter: {
    list(): unknown[];
    route(req: unknown): Promise<unknown>;
  };
  toolRegistry: {
    list(): Array<{ name: string; description: string; permissions: string[] }>;
    execute(name: string, input: unknown, ctx?: unknown): Promise<unknown>;
  };
  memoryRouter: {
    recall(query: unknown): Promise<unknown[]>;
    store(item: unknown): Promise<void>;
    delete?(id: string): Promise<boolean>;
  };
  costTracker?: {
    summarize(opts?: unknown): unknown;
  };
  shareManager?: {
    share(req: unknown): Promise<unknown>;
  };
  authManager?: {
    status(provider?: string): unknown[];
  };
  agentLoopFactory?: (goal: string, signal: AbortSignal, emit: (type: string, data: Record<string, unknown>) => void) => Promise<unknown>;
}

export interface ServerOptions {
  port?: number;
  host?: string;
  authToken?: string;
  cors?: boolean;
  ctx: SanixContext;
}

const DEFAULT_PORT = 7331;  // SANIX → 72649 → 7+3+3+1=14 → no, just pick 7331 ("SANIX" vibe)
const DEFAULT_HOST = '127.0.0.1';  // loopback by default — never expose publicly without auth

export class SanixServer {
  private httpServer: HttpServer | null = null;
  private readonly router = new Router();
  private readonly runManager = new RunManager();
  private readonly opts: Required<Omit<ServerOptions, 'ctx' | 'authToken' | 'agentLoopFactory'>> & {
    ctx: SanixContext;
    authToken?: string;
  };
  private startTime = 0;

  constructor(opts: ServerOptions) {
    this.opts = {
      port: opts.port ?? DEFAULT_PORT,
      host: opts.host ?? DEFAULT_HOST,
      authToken: opts.authToken,
      cors: opts.cors ?? false,
      ctx: opts.ctx,
    };
    this.registerRoutes();
  }

  private registerRoutes(): void {
    // Health
    this.router.get('/health', async () => this.json({ status: 'ok', version: '1.0.0', uptime: Date.now() - this.startTime }));

    // Providers
    this.router.get('/v1/providers', async () => this.json({ providers: this.opts.ctx.providerRouter.list() }));
    this.router.get('/v1/providers/:id/status', async (req) => {
      const id = req.params['id'] ?? '';
      const statuses = this.opts.ctx.authManager?.status(id) ?? [];
      return this.json({ provider: id, status: statuses[0] ?? null });
    });

    // Chat (single LLM turn — no agent loop)
    this.router.post('/v1/chat', async (req) => {
      const body = (req.body ?? {}) as { messages?: unknown[]; provider?: string; maxTokens?: number; temperature?: number; stream?: boolean };
      if (!Array.isArray(body.messages) || body.messages.length === 0) {
        return this.jsonError(400, 'messages[] required');
      }
      try {
        const result = await this.opts.ctx.providerRouter.route({
          messages: body.messages,
          provider: body.provider,
          maxTokens: body.maxTokens,
          temperature: body.temperature,
        });
        return this.json({ response: result });
      } catch (err) {
        return this.jsonError(500, err instanceof Error ? err.message : String(err));
      }
    });

    // Run (start agent loop)
    this.router.post('/v1/run', async (req) => {
      if (!this.opts.ctx.agentLoopFactory) {
        return this.jsonError(501, 'agentLoopFactory not configured');
      }
      const body = (req.body ?? {}) as { goal?: string; options?: Record<string, unknown> };
      if (typeof body.goal !== 'string' || body.goal.trim().length === 0) {
        return this.jsonError(400, 'goal (string) required');
      }
      const runId = await this.runManager.startRun({
        goal: body.goal,
        agentLoopFactory: async (signal, emit) => {
          return this.opts.ctx.agentLoopFactory!(body.goal ?? '', signal, emit as (type: string, data: Record<string, unknown>) => void);
        },
      });
      return this.json({ runId, status: 'started' }, 202);
    });

    this.router.get('/v1/runs/:id', async (req) => {
      const id = req.params['id'] ?? '';
      const state = this.runManager.getRun(id);
      if (!state) return this.jsonError(404, 'run not found');
      return this.json({ run: state });
    });

    this.router.get('/v1/runs/:id/events', async (req, res) => {
      const id = req.params['id'] ?? '';
      const state = this.runManager.getRun(id);
      if (!state) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'run not found' }));
        return;
      }
      const events = this.runManager.getRunEvents(id);
      await streamEvents(res, events as AsyncIterable<{ event: string; data: unknown }>);
    });

    this.router.post('/v1/runs/:id/abort', async (req) => {
      const id = req.params['id'] ?? '';
      const ok = this.runManager.abortRun(id);
      if (!ok) return this.jsonError(404, 'run not found or already finished');
      return this.json({ runId: id, status: 'aborting' });
    });

    // Memory
    this.router.get('/v1/memory', async (req) => {
      const query = req.query.get('query') ?? '';
      const tier = req.query.get('tier') ?? undefined;
      const items = await this.opts.ctx.memoryRouter.recall({ query, tier });
      return this.json({ memories: items });
    });
    this.router.post('/v1/memory', async (req) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      await this.opts.ctx.memoryRouter.store(body);
      return this.json({ stored: true }, 201);
    });
    this.router.delete('/v1/memory/:id', async (req) => {
      const id = req.params['id'] ?? '';
      if (typeof this.opts.ctx.memoryRouter.delete === 'function') {
        const ok = await this.opts.ctx.memoryRouter.delete(id);
        return this.json({ deleted: ok });
      }
      return this.jsonError(501, 'memoryRouter.delete not implemented');
    });

    // Tools
    this.router.get('/v1/tools', async () => {
      return this.json({ tools: this.opts.ctx.toolRegistry.list() });
    });
    this.router.post('/v1/tools/:name/execute', async (req) => {
      const name = req.params['name'] ?? '';
      const body = (req.body ?? {}) as { input?: unknown };
      try {
        const result = await this.opts.ctx.toolRegistry.execute(name, body.input ?? {});
        return this.json({ result });
      } catch (err) {
        return this.jsonError(500, err instanceof Error ? err.message : String(err));
      }
    });

    // Cost
    this.router.get('/v1/cost', async () => {
      if (!this.opts.ctx.costTracker) return this.jsonError(501, 'cost tracking not configured');
      return this.json({ summary: this.opts.ctx.costTracker.summarize() });
    });

    // Config (redact secrets)
    this.router.get('/v1/config', async () => {
      const cfg = this.opts.ctx.config as Record<string, unknown>;
      return this.json({ config: this.redactSecrets(cfg) });
    });

    // Share
    this.router.post('/v1/share', async (req) => {
      if (!this.opts.ctx.shareManager) return this.jsonError(501, 'sharing not configured');
      const body = (req.body ?? {}) as Record<string, unknown>;
      try {
        const result = await this.opts.ctx.shareManager.share(body);
        return this.json({ share: result }, 201);
      } catch (err) {
        return this.jsonError(500, err instanceof Error ? err.message : String(err));
      }
    });

    // Auth status
    this.router.get('/v1/auth/status', async (req) => {
      const provider = req.query.get('provider') ?? undefined;
      if (!this.opts.ctx.authManager) return this.jsonError(501, 'auth not configured');
      return this.json({ providers: this.opts.ctx.authManager.status(provider) });
    });
  }

  /** Recursively redact sensitive fields in a config object. */
  private redactSecrets(obj: unknown, depth = 0): unknown {
    if (depth > 10 || obj === null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map((v) => this.redactSecrets(v, depth + 1));
    const out: Record<string, unknown> = {};
    const sensitive = /key|token|secret|password|credential/i;
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (sensitive.test(k) && typeof v === 'string' && v.length > 0) {
        out[k] = '<redacted>';
      } else {
        out[k] = this.redactSecrets(v, depth + 1);
      }
    }
    return out;
  }

  private json(body: unknown, status = 200): RouteResponse {
    return { status, headers: { 'Content-Type': 'application/json' }, body };
  }

  private jsonError(status: number, message: string): RouteResponse {
    return { status, headers: { 'Content-Type': 'application/json' }, body: { error: message } };
  }

  /** Verify the bearer token if one is configured. */
  private checkAuth(req: RouteRequest): boolean {
    if (!this.opts.authToken) return true;
    const auth = req.headers['authorization'];
    const token = Array.isArray(auth) ? auth[0] : auth;
    if (typeof token !== 'string') return false;
    const m = /^Bearer\s+(.+)$/i.exec(token);
    return !!m && m[1] === this.opts.authToken;
  }

  /** Apply CORS headers + handle OPTIONS preflight. Returns true if handled. */
  private handleCORS(res: ServerResponse, method: string): boolean {
    if (!this.opts.cors) return false;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return true;
    }
    return false;
  }

  /** Start listening. Resolves when server is ready. */
  async start(): Promise<void> {
    this.startTime = Date.now();
    return new Promise((resolve) => {
      this.httpServer = createServer(async (req, res) => {
        try {
          await this.handleRequest(req, res);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: msg }));
          }
        }
      });
      this.httpServer.listen(this.opts.port, this.opts.host, () => resolve());
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${this.opts.host}:${this.opts.port}`);
    const method = req.method ?? 'GET';

    // CORS preflight
    if (this.handleCORS(res, method)) return;

    // Parse body
    let body: unknown;
    try {
      body = await Router.readBody(req);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: msg }));
      return;
    }

    const routeReq: RouteRequest = {
      method,
      url: url.pathname + url.search,
      path: url.pathname,
      query: url.searchParams,
      params: {},
      headers: req.headers as Record<string, string | string[] | undefined>,
      body,
      raw: req,
    };

    // Auth
    if (!this.checkAuth(routeReq)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    // Match route
    const match = this.router.match(method, url.pathname);
    if (!match) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found', path: url.pathname }));
      return;
    }
    routeReq.params = match.params;

    // Invoke handler
    const result = await match.handler(routeReq, res);
    if (result) {
      const bodyStr = typeof result.body === 'string' ? result.body : JSON.stringify(result.body);
      res.writeHead(result.status, result.headers);
      res.end(bodyStr);
    }
    // If no result, the handler (e.g. SSE) wrote the response itself.
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.httpServer) return resolve();
      this.httpServer.close((err) => err ? reject(err) : resolve());
    });
  }

  get address(): string {
    return `http://${this.opts.host}:${this.opts.port}`;
  }
}
