/**
 * @file @sanix/server — REST API server + MCP server mode for SANIX.
 *
 * Two modes:
 *   1. `SanixServer` — HTTP REST API for IDE / browser integrations.
 *      Routes: /health, /v1/chat, /v1/run, /v1/runs/:id/events, /v1/memory,
 *      /v1/tools, /v1/cost, /v1/config, /v1/share, /v1/auth/status.
 *   2. `SanixMCPServer` — exposes SANIX tools as MCP tools (so Claude
 *      Desktop / other MCP clients can use SANIX's 22+ tools).
 *
 * Pure Node `http` — no Express dependency. SSE streaming for run events.
 *
 * @packageDocumentation
 */

export { SanixServer, type ServerOptions, type SanixContext } from './Server.js';
export { RunManager, type RunState, type RunEvent, type RunEventType } from './run/RunManager.js';
export { writeSSE, streamEvents, type SSEMessage } from './sse/index.js';
export { SanixMCPServer, type MCPServerOptions } from './mcp/MCPServer.js';
export { type RouteHandler, type RouteRequest, type RouteResponse } from './router.js';
