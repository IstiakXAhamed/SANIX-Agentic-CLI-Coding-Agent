/**
 * @file @sanix/tools — aggregate barrel.
 *
 * Re-exports every subsystem and provides `allTools()` returning instances
 * of every built-in tool ready for registration with the core
 * `ToolRegistry`.
 */
import type { SanixTool } from './types.js';

// Value imports for `allTools()` factory below.
import { ReadFileTool, WriteFileTool, EditFileTool, SearchFilesTool, DirectoryTreeTool, WatchFilesTool } from './filesystem/index.js';
import { BashTool, StartProcessTool, KillProcessTool, EnvManagerTool } from './shell/index.js';
import { ASTAnalyzerTool, LinterTool, TestRunnerTool, DependencyAnalyzerTool, CodeIndexerTool } from './code/index.js';
import { WebSearchTool, WebFetchTool, DocumentReaderTool } from './web/index.js';
import { RememberFactTool, RecallMemoryTool, ForgetMemoryTool, SummarizeSessionTool } from './memory_tools/index.js';

// Shared types + helpers.
export {
  type SanixTool,
  type ToolContext,
  type ToolResult,
  type ToolPermission,
  z,
  defineTool,
  estimateTokens,
  okResult,
  errResult,
  resolvePath,
} from './types.js';

// Filesystem.
export * as filesystem from './filesystem/index.js';
export {
  ReadFileTool,
  WriteFileTool,
  EditFileTool,
  SearchFilesTool,
  DirectoryTreeTool,
  WatchFilesTool,
} from './filesystem/index.js';

// Shell.
export * as shell from './shell/index.js';
export { BashTool, StartProcessTool, KillProcessTool, EnvManagerTool } from './shell/index.js';

// Code.
export * as code from './code/index.js';
export {
  ASTAnalyzerTool,
  LinterTool,
  TestRunnerTool,
  DependencyAnalyzerTool,
  CodeIndexerTool,
} from './code/index.js';

// Web.
export * as web from './web/index.js';
export { WebSearchTool, WebFetchTool, DocumentReaderTool } from './web/index.js';

// Memory.
export * as memoryTools from './memory_tools/index.js';
export {
  RememberFactTool,
  RecallMemoryTool,
  ForgetMemoryTool,
  SummarizeSessionTool,
} from './memory_tools/index.js';

// MCP.
export * as mcp from './mcp/index.js';
export { MCPClient, MCPToolBridge, MCPListServersTool } from './mcp/index.js';

/**
 * Return instances of every built-in tool, ready for registration with the
 * core `ToolRegistry`.
 *
 * NB: MCP tools are NOT included here — they are dynamic and must be
 * registered by the agent loop after `MCPClient.connect()` returns.
 *
 * @example
 * ```ts
 * import { allTools } from '@sanix/tools';
 * import { ToolRegistry } from '@sanix/core';
 *
 * const registry = new ToolRegistry();
 * for (const tool of allTools()) registry.register(tool);
 * ```
 */
export function allTools(): SanixTool<unknown, unknown>[] {
  return [
    new ReadFileTool(),
    new WriteFileTool(),
    new EditFileTool(),
    new SearchFilesTool(),
    new DirectoryTreeTool(),
    new WatchFilesTool(),
    new BashTool(),
    new StartProcessTool(),
    new KillProcessTool(),
    new EnvManagerTool(),
    new ASTAnalyzerTool(),
    new LinterTool(),
    new TestRunnerTool(),
    new DependencyAnalyzerTool(),
    new CodeIndexerTool(),
    new WebSearchTool(),
    new WebFetchTool(),
    new DocumentReaderTool(),
    new RememberFactTool(),
    new RecallMemoryTool(),
    new ForgetMemoryTool(),
    new SummarizeSessionTool(),
  ] as SanixTool<unknown, unknown>[];
}
