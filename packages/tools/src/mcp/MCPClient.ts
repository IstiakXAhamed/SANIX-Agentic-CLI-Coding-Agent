/**
 * @file MCPClient — connects to Model Context Protocol servers (stdio or
 * HTTP/SSE) using `@modelcontextprotocol/sdk`.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import {
  type SanixTool,
  type ToolContext,
  type ToolResult,
  type ToolPermission,
  z,
  okResult,
  errResult,
} from '../types.js';

/** Stdio MCP server configuration. */
export interface StdioMCPServerConfig {
  type: 'stdio';
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/** HTTP/SSE MCP server configuration. */
export interface HttpMCPServerConfig {
  type: 'http' | 'sse';
  name: string;
  url: string;
  headers?: Record<string, string>;
}

/** Union config accepted by `MCPClient.connect`. */
export type MCPServerConfig = StdioMCPServerConfig | HttpMCPServerConfig;

/** Minimal MCP tool shape returned by `listTools()`. */
export interface MCPToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** An active connection to an MCP server. */
export interface MCPConnection {
  name: string;
  client: Client;
  tools: MCPToolDef[];
}

/**
 * MCPClient — registry of live MCP server connections.
 *
 * @example
 * ```ts
 * const client = new MCPClient();
 * const conn = await client.connect({
 *   type: 'stdio',
 *   name: 'fs',
 *   command: 'npx',
 *   args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
 * });
 * const tools = await client.listTools('fs');
 * ```
 */
export class MCPClient {
  private connections = new Map<string, MCPConnection>();

  /** Connect to a server (stdio or http/sse). */
  async connect(serverConfig: MCPServerConfig): Promise<MCPConnection> {
    // If a connection with the same name exists, disconnect first.
    if (this.connections.has(serverConfig.name)) {
      await this.disconnect(serverConfig.name).catch(() => undefined);
    }

    const transport =
      serverConfig.type === 'stdio'
        ? new StdioClientTransport({
            command: serverConfig.command,
            args: serverConfig.args ?? [],
            env: serverConfig.env,
            cwd: serverConfig.cwd,
          })
        : new SSEClientTransport(new URL(serverConfig.url), {
            requestInit: serverConfig.headers
              ? { headers: serverConfig.headers }
              : undefined,
          });

    const client = new Client(
      { name: 'sanix', version: '1.0.0' },
      { capabilities: {} },
    );
    await client.connect(transport);

    const listRes = await client.listTools();
    const tools: MCPToolDef[] = (listRes.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown> | undefined,
    }));

    const conn: MCPConnection = { name: serverConfig.name, client, tools };
    this.connections.set(serverConfig.name, conn);
    return conn;
  }

  /** Disconnect from a named server. */
  async disconnect(name: string): Promise<void> {
    const conn = this.connections.get(name);
    if (!conn) return;
    try {
      await conn.client.close();
    } finally {
      this.connections.delete(name);
    }
  }

  /** Disconnect from all servers. */
  async disconnectAll(): Promise<void> {
    const names = [...this.connections.keys()];
    await Promise.all(names.map((n) => this.disconnect(n).catch(() => undefined)));
  }

  /** List connected server names. */
  listServers(): string[] {
    return [...this.connections.keys()];
  }

  /** List tools offered by a named server. */
  async listTools(name: string): Promise<MCPToolDef[]> {
    const conn = this.connections.get(name);
    if (!conn) throw new Error(`MCP server not connected: ${name}`);
    const listRes = await conn.client.listTools();
    return (listRes.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown> | undefined,
    }));
  }

  /** Call a tool on a named server. */
  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const conn = this.connections.get(serverName);
    if (!conn) throw new Error(`MCP server not connected: ${serverName}`);
    const result = await conn.client.callTool({ name: toolName, arguments: args });
    return result;
  }

  /** Get the live connection for a server (used by the bridge). */
  getConnection(name: string): MCPConnection | undefined {
    return this.connections.get(name);
  }
}

// Re-export the bridge so callers can construct it directly.
export { MCPToolBridge } from './MCPToolBridge.js';

// Convenience: a SanixTool that wraps `MCPClient.listServers`.
class MCPListServersTool implements SanixTool<Record<string, never>, { servers: string[] }> {
  readonly name = 'mcp_list_servers';
  readonly description = 'List currently-connected MCP servers.';
  readonly inputSchema = z.object({}).strict();
  readonly outputSchema = z.object({ servers: z.array(z.string()) });
  readonly permissions: ToolPermission[] = ['mcp:call'];
  readonly maxTokensInput = 16;
  readonly maxTokensOutput = 256;

  constructor(private readonly client: MCPClient) {}

  async execute(
    _input: Record<string, never>,
    _context: ToolContext,
  ): Promise<ToolResult<{ servers: string[] }>> {
    const start = Date.now();
    const servers = this.client.listServers();
    return okResult({ servers }, Date.now() - start);
  }

  formatForContext(result: { servers: string[] }): string {
    return result.servers.length ? result.servers.join(', ') : '(no MCP servers connected)';
  }
}

export { MCPListServersTool };
