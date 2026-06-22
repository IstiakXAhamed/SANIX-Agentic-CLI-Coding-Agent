/**
 * @file MCPToolBridge — adapts an MCP server tool into a SanixTool.
 *
 * Constructor takes `(tool: MCPToolDef, client: MCPClient, serverName: string)`.
 * `execute()` delegates to `client.callTool()`. The MCP tool's JSON-Schema
 * `inputSchema` is wrapped in a Zod passthrough schema (MCP schemas are
 * arbitrary JSON-Schema, not Zod, so we accept any object and let the
 * server validate).
 */
import { z } from 'zod';
import {
  type SanixTool,
  type ToolContext,
  type ToolResult,
  type ToolPermission,
  okResult,
  errResult,
} from '../types.js';
import type { MCPClient, MCPToolDef } from './MCPClient.js';

/** Bridge an MCP tool into a SanixTool. */
export class MCPToolBridge implements SanixTool<Record<string, unknown>, unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodTypeAny;
  readonly outputSchema: z.ZodTypeAny;
  readonly permissions: ToolPermission[];
  readonly maxTokensInput = 16_000;
  readonly maxTokensOutput = 16_000;

  /**
   * @param tool       Tool definition from `MCPClient.listTools()`.
   * @param client     The owning MCPClient.
   * @param serverName Name of the MCP server that owns this tool.
   */
  constructor(
    private readonly tool: MCPToolDef,
    private readonly client: MCPClient,
    private readonly serverName: string,
  ) {
    this.name = `mcp__${serverName}__${tool.name}`;
    this.description =
      tool.description ?? `MCP tool ${tool.name} on server ${serverName}`;
    // MCP tools declare their input as JSON-Schema; we accept any object.
    this.inputSchema = z.record(z.string(), z.unknown());
    this.outputSchema = z.unknown();
    this.permissions = ['mcp:call'];
  }

  async execute(
    input: Record<string, unknown>,
    _context: ToolContext,
  ): Promise<ToolResult<unknown>> {
    const start = Date.now();
    try {
      const result = await this.client.callTool(this.serverName, this.tool.name, input);
      return okResult(result, Date.now() - start);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errResult<unknown>(
        `mcp call ${this.serverName}/${this.tool.name} failed: ${msg}`,
        Date.now() - start,
      );
    }
  }

  formatForContext(result: unknown): string {
    if (typeof result === 'string') return result;
    try {
      const json = JSON.stringify(result);
      return json.length > 8000 ? `${json.slice(0, 8000)}…[truncated]` : json;
    } catch {
      return String(result);
    }
  }

  /** The server name this tool belongs to. */
  get server(): string {
    return this.serverName;
  }

  /** The original MCP tool name (without the `mcp__server__` prefix). */
  get mcpToolName(): string {
    return this.tool.name;
  }
}
