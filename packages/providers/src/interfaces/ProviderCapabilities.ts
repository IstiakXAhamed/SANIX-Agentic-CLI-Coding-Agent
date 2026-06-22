/**
 * @file ProviderCapabilities.ts
 * @description Static capability matrix for every model SANIX can route to.
 *
 * This is the single source of truth for the router's cost/latency/context
 * heuristics. Numbers are blended approximations compiled from public pricing
 * pages and benchmark reports as of 2025-Q2; they are intentionally fuzzy —
 * the router only needs relative ordering, not exact figures.
 *
 * Each entry maps a stable `modelId` alias (used inside LLMRequest.taskType
 * routing decisions and inside `sanix providers list`) to the four numeric
 * fields the IProvider interface exposes plus the isLocal flag.
 */

/**
 * Per-model capability descriptor. Mirrors the four numeric readonly fields
 * on {@link IProvider} so adapters can construct themselves directly from
 * this table.
 */
export interface ProviderCapability {
  /** Strength tags used by the router's task-type affinity scoring. */
  strengths: string[];
  /** Typical p50 latency in ms (cold-start excluded). */
  latencyMs: number;
  /** Blended USD cost per 1M tokens (input+output averaged). */
  costPerMillionTokens: number;
  /** Maximum context window in tokens. */
  maxContextTokens: number;
  /** True for local-only providers (Ollama, LM Studio). */
  isLocal: boolean;
}

/**
 * The master capability matrix. Keys are stable model aliases that appear
 * verbatim in adapter constructors; values drive both the router scoring
 * and the `sanix providers list` TUI table.
 *
 * Maintainers: when a new model lands, add an entry here AND wire it into
 * the appropriate adapter (e.g. AnthropicAdapter for new Claude variants).
 */
export const PROVIDER_CAPABILITIES: Record<string, ProviderCapability> = {
  // ── Anthropic Claude family ────────────────────────────────────────────
  'claude-opus-4': {
    strengths: ['reasoning', 'code', 'general'],
    latencyMs: 2200,
    costPerMillionTokens: 37.5,
    maxContextTokens: 200_000,
    isLocal: false,
  },
  'claude-sonnet-4': {
    strengths: ['code', 'reasoning', 'general'],
    latencyMs: 1100,
    costPerMillionTokens: 9.0,
    maxContextTokens: 200_000,
    isLocal: false,
  },
  'claude-haiku': {
    strengths: ['fast_lookup', 'general'],
    latencyMs: 450,
    costPerMillionTokens: 0.5,
    maxContextTokens: 200_000,
    isLocal: false,
  },

  // ── OpenAI family ──────────────────────────────────────────────────────
  'gpt-4o': {
    strengths: ['code', 'reasoning', 'general'],
    latencyMs: 1300,
    costPerMillionTokens: 5.0,
    maxContextTokens: 128_000,
    isLocal: false,
  },
  'o1': {
    strengths: ['reasoning', 'code'],
    latencyMs: 8000,
    costPerMillionTokens: 32.5,
    maxContextTokens: 200_000,
    isLocal: false,
  },
  'o3': {
    strengths: ['reasoning', 'code'],
    latencyMs: 6000,
    costPerMillionTokens: 25.0,
    maxContextTokens: 200_000,
    isLocal: false,
  },
  'gpt-4.1': {
    strengths: ['code', 'general'],
    latencyMs: 1200,
    costPerMillionTokens: 3.0,
    maxContextTokens: 1_000_000,
    isLocal: false,
  },

  // ── Google Gemini family ───────────────────────────────────────────────
  'gemini-2.5-pro': {
    strengths: ['reasoning', 'code', 'general'],
    latencyMs: 1800,
    costPerMillionTokens: 3.5,
    maxContextTokens: 2_000_000,
    isLocal: false,
  },
  'gemini-2.0-flash': {
    strengths: ['fast_lookup', 'general'],
    latencyMs: 500,
    costPerMillionTokens: 0.35,
    maxContextTokens: 1_000_000,
    isLocal: false,
  },

  // ── Mistral family ─────────────────────────────────────────────────────
  'mistral-large': {
    strengths: ['code', 'reasoning', 'general'],
    latencyMs: 1100,
    costPerMillionTokens: 4.0,
    maxContextTokens: 128_000,
    isLocal: false,
  },
  'codestral': {
    strengths: ['code'],
    latencyMs: 700,
    costPerMillionTokens: 1.0,
    maxContextTokens: 32_000,
    isLocal: false,
  },

  // ── DeepSeek family ────────────────────────────────────────────────────
  'deepseek-v3': {
    strengths: ['code', 'general'],
    latencyMs: 1500,
    costPerMillionTokens: 0.5,
    maxContextTokens: 64_000,
    isLocal: false,
  },
  'deepseek-r1': {
    strengths: ['reasoning', 'code'],
    latencyMs: 5000,
    costPerMillionTokens: 1.1,
    maxContextTokens: 64_000,
    isLocal: false,
  },

  // ── Groq (ultra-fast inference) ────────────────────────────────────────
  'llama-3.3-70b': {
    strengths: ['fast_lookup', 'general', 'code'],
    latencyMs: 220,
    costPerMillionTokens: 0.6,
    maxContextTokens: 128_000,
    isLocal: false,
  },
  'qwen-2.5-72b': {
    strengths: ['code', 'general'],
    latencyMs: 260,
    costPerMillionTokens: 0.8,
    maxContextTokens: 32_000,
    isLocal: false,
  },

  // ── Local providers ────────────────────────────────────────────────────
  'ollama-default': {
    strengths: ['general', 'code'],
    latencyMs: 800,
    costPerMillionTokens: 0,
    maxContextTokens: 32_000,
    isLocal: true,
  },
  'lmstudio-default': {
    strengths: ['general', 'code'],
    latencyMs: 600,
    costPerMillionTokens: 0,
    maxContextTokens: 32_000,
    isLocal: true,
  },
};

/**
 * Look up a capability entry by model id, returning a safe default
 * (zeroed cost, neutral latency) when the alias is unknown so the router
 * never crashes on an unrecognized model string.
 */
export function getCapability(modelId: string): ProviderCapability {
  return (
    PROVIDER_CAPABILITIES[modelId] ?? {
      strengths: ['general'],
      latencyMs: 1500,
      costPerMillionTokens: 1.0,
      maxContextTokens: 32_000,
      isLocal: false,
    }
  );
}
