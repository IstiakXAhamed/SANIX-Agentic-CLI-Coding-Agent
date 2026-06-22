/**
 * @file MCPServer — exposes SANIX tools as MCP tools so external MCP clients
 * (Claude Desktop, VS Code MCP, etc.) can invoke them.
 *
 * Uses `@modelcontextprotocol/sdk` for the protocol layer.
 *
 * Two transports:
 *   - stdio: for Claude Desktop / CLI integration
 *   - http/sse: for remote MCP clients
 *
 * @packageDocumentation
 */

import { Server as MCPSdkServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createServer, type Server as HttpServer } from 'node:http';
import type { SanixContext } from '../Server.js';

export interface MCPServerOptions {
  name?: string;
  version?: string;
  ctx: SanixContext;
}

/**
 * Bridge between SANIX's ToolRegistry and the MCP protocol.
 *
 * Each SANIX tool is exposed as an MCP tool with the same name + description.
 * Input schema is forwarded as-is (SanixTool.inputSchema is a Zod schema; we
 * convert via `.toJSON()` if available, else fall back to a permissive
 * `object` schema).
 *
 * @example
 * ```ts
 * const mcp = new SanixMCPServer(ctx, { name: 'sanix-tools' });
 * await mcp.start('stdio');
 * // Now Claude Desktop can connect via `mcp-server-sanix` config.
 * ```
 */
export class SanixMCPServer {
  private readonly server: MCPSdkServer;
  private readonly ctx: SanixContext;
  private readonly name: string;
  private readonly version: string;
  private httpServer: HttpServer | null = null;
  private sseTransport: SSEServerTransport | null = null;

  constructor(opts: MCPServerOptions) {
    this.ctx = opts.ctx;
    this.name = opts.name ?? 'sanix';
    this.version = opts.version ?? '1.0.0';
    this.server = new MCPSdkServer(
      { name: this.name, version: this.version },
      { capabilities: { tools: {} } },
    );
    this.registerHandlers();
  }

  private registerHandlers(): void {
    // List tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = this.ctx.toolRegistry.list();
      return {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: this.extractInputSchema(t),
        })),
      };
    });

    // Call tool
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const name = request.params.name;
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      try {
        const result = await this.ctx.toolRegistry.execute(name, args);
        // MCP expects an array of content blocks.
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        return {
          content: [{ type: 'text', text }],
          isError: false,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `Tool error: ${msg}` }],
          isError: true,
        };
      }
    });
  }

  /**
   * Extract a JSON Schema from a SanixTool's inputSchema.
   * The inputSchema is typically a Zod schema — Zod schemas expose a
   * `toJSON()` (zod v4) or `_def` (v3) — but our ToolRegistry.list() returns
   * plain metadata, so we fall back to a permissive object schema.
   */
  private extractInputSchema(_tool: { name: string; description: string; permissions: string[] }): object {
    // Permissive schema: accept any object. The actual tool validates via Zod.
    return {
      type: 'object',
      additionalProperties: true,
      description: `${_tool.name} input — see SANIX docs. Tool will validate via Zod.`,
    };
  }

  /** Start the MCP server using the given transport. */
  async start(transport: 'stdio' | 'sse', opts?: { port?: number; host?: string }): Promise<void> {
    if (transport === 'stdio') {
      const t = new StdioServerTransport();
      await this.server.connect(t);
      return;
    }
    if (transport === 'sse') {
      const port = opts?.port ?? 7332;
      const host = opts?.host ?? '127.0.0.1';
      await this.startSSE(port, host);
      return;
    }
    throw new Error(`Unknown transport: ${transport}`);
  }

  private startSSE(port: number, host: string): Promise<void> {
    return new Promise((resolve) => {
      const transports = new Map<string, SSEServerTransport>();
      this.httpServer = createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', `http://${host}:${port}`);
        if (url.pathname === '/sse') {
          // Open a new SSE transport.
          this.sseTransport = new SSEServerTransport('/messages', res);
          transports.set(this.sseTransport.sessionId, this.sseTransport);
          await this.server.connect(this.sseTransport);
          res.on('close', () => {
            if (this.sseTransport) {
              transports.delete(this.sseTransport.sessionId);
            }
          });
          return;
        }
        if (url.pathname === '/messages') {
          const sessionId = url.searchParams.get('sessionId') ?? '';
          const t = transports.get(sessionId);
          if (t) {
            await t.handlePostMessage(req, res);
          } else {
            res.writeHead(404);
            res.end('session not found');
          }
          return;
        }
        res.writeHead(404);
        res.end('not found');
      });
      this.httpServer.listen(port, host, () => {
        // eslint-disable-next-line no-console
        console.error(`SANIX MCP server (SSE) listening on http://${host}:${port}/sse`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.httpServer) {
      await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
      this.httpServer = null;
    }
    await this.server.close();
  }
}
