/**
 * @file index.ts
 * @description Public entry point for `@sanix/providers`. Re-exports the
 * unified IProvider contract, the capability matrix, the typed error
 * hierarchy, the ProviderRouter + CircuitBreaker, and every adapter.
 *
 * Importing paths:
 *   import { ProviderRouter, AnthropicAdapter } from '@sanix/providers';
 *   import { OpenAIAdapter, OllamaAdapter } from '@sanix/providers/adapters';
 */

// ── Public type surface ──────────────────────────────────────────────────
export type {
  IProvider,
  LLMMessage,
  LLMRequest,
  LLMResponse,
  ToolCall,
  ToolDef,
  TokenUsage,
  LLMUsage,
  TaskType,
  ContentBlock,
  MessageContent,
} from './interfaces/IProvider.js';

export {
  PROVIDER_CAPABILITIES,
  getCapability,
  type ProviderCapability,
} from './interfaces/ProviderCapabilities.js';

// ── Error hierarchy ──────────────────────────────────────────────────────
export {
  ProviderError,
  RateLimitError,
  ProviderServerError,
  ProviderRequestError,
  ProviderNetworkError,
  classifyHttpError,
} from './errors.js';

// ── Router + circuit breaker ─────────────────────────────────────────────
export {
  ProviderRouter,
  CircuitBreaker,
  type ProviderRouterOptions,
  type CircuitBreakerOptions,
  type RouterEvents,
} from './ProviderRouter.js';

// ── Adapters (also available via `@sanix/providers/adapters`) ────────────
export * from './adapters/index.js';
