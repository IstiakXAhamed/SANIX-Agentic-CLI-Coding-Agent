/**
 * @file lib/types.ts — Typed responses for the SANIX REST API.
 *
 * These mirror the shapes returned by @sanix/server (see
 * packages/server/src/Server.ts + run/RunManager.ts).
 */

/* ---- /health ---- */
export interface HealthResponse {
  status: string;
  version: string;
  uptime: number;
}

/* ---- /v1/chat ---- */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Array<Record<string, unknown>>;
  name?: string;
  tool_call_id?: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  provider?: string;
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
}

export interface ChatTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
}

export interface ChatResponse {
  response: {
    content?: string;
    role?: string;
    model?: string;
    provider?: string;
    usage?: ChatTokenUsage;
    toolCalls?: Array<Record<string, unknown>>;
    finishReason?: string;
    [k: string]: unknown;
  };
}

/* ---- /v1/run + /v1/runs ---- */
export interface RunState {
  id: string;
  goal: string;
  status: 'starting' | 'running' | 'completed' | 'failed' | 'aborted';
  startedAt: number;
  endedAt?: number;
  iteration: number;
  totalCostUsd: number;
  totalTokensIn: number;
  totalTokensOut: number;
  lastEvent?: string;
  error?: string;
  result?: unknown;
}

export interface StartRunRequest {
  goal: string;
  options?: Record<string, unknown>;
}

export interface StartRunResponse {
  runId: string;
  status: string;
}

export interface GetRunResponse {
  run: RunState;
}

export type RunEventType =
  | 'plan:created'
  | 'task:started'
  | 'task:completed'
  | 'task:failed'
  | 'iteration:before'
  | 'iteration:after'
  | 'tool:before'
  | 'tool:after'
  | 'llm:before'
  | 'llm:after'
  | 'cost:recorded'
  | 'subagent:spawn'
  | 'subagent:complete'
  | 'error'
  | 'progress'
  | 'status'
  | 'complete'
  | 'aborted'
  | 'ready'
  | 'done';

export interface RunEvent {
  runId: string;
  type: RunEventType;
  timestamp: number;
  data: Record<string, unknown>;
}

/* ---- /v1/memory ---- */
export interface MemoryItem {
  id?: string;
  tier?: 'working' | 'episodic' | 'semantic' | 'procedural';
  content?: string;
  text?: string;
  query?: string;
  score?: number;
  importance?: number;
  createdAt?: number;
  tags?: string[];
  metadata?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface MemoryListResponse {
  memories: MemoryItem[];
}

export interface MemoryStoreRequest {
  content: string;
  tier?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  [k: string]: unknown;
}

/* ---- /v1/tools ---- */
export interface ToolDef {
  name: string;
  description: string;
  permissions?: string[];
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface ToolListResponse {
  tools: ToolDef[];
}

export interface ToolExecuteRequest {
  input: Record<string, unknown>;
}

export interface ToolExecuteResponse {
  result: unknown;
}

/* ---- /v1/providers ---- */
export interface ProviderInfo {
  id: string;
  name?: string;
  type?: string;
  isLocal?: boolean;
  isAvailable?: boolean;
  model?: string;
  priority?: number;
  weight?: number;
  [k: string]: unknown;
}

export interface ProviderListResponse {
  providers: ProviderInfo[];
}

export interface ProviderStatusResponse {
  provider: string;
  status: unknown;
}

/* ---- /v1/cost ---- */
export interface CostBreakdown {
  byProvider?: Array<{ provider: string; costUsd: number; tokensIn: number; tokensOut: number; calls: number }>;
  byModel?: Array<{ provider: string; model: string; costUsd: number; tokensIn: number; tokensOut: number; calls: number }>;
  daily?: Array<{ date: string; costUsd: number; tokensIn: number; tokensOut: number; calls: number; cacheHits?: number; cacheMisses?: number }>;
  totals?: {
    totalCostUsd: number;
    totalTokensIn: number;
    totalTokensOut: number;
    totalCalls: number;
    cacheHitRate?: number;
  };
  [k: string]: unknown;
}

export interface CostResponse {
  summary: CostBreakdown;
}

/* ---- /v1/config ---- */
export interface ConfigResponse {
  config: Record<string, unknown>;
}

/* ---- /v1/share ---- */
export interface ShareRequest {
  filePath?: string;
  content?: string;
  provider?: string;
  expiresIn?: number;
  password?: string;
  [k: string]: unknown;
}

export interface ShareResponse {
  share: {
    url?: string;
    id?: string;
    provider?: string;
    expiresAt?: number;
    [k: string]: unknown;
  };
}

/* ---- /v1/auth/status ---- */
export interface AuthStatus {
  provider: string;
  status: 'active' | 'expired' | 'unauthorized' | 'idle' | string;
  expiresAt?: number;
  scopes?: string[];
  user?: string;
  [k: string]: unknown;
}

export interface AuthStatusResponse {
  providers: AuthStatus[];
}

/* ---- Errors ---- */
export interface ApiErrorBody {
  error: string;
  path?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}
