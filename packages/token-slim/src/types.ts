/**
 * @file types.ts
 * @description Shared type declarations for `@sanix/token-slim`. Defines the
 * provider-agnostic tokenizer contract, message shapes, compression options,
 * and savings-report shapes used across the 7-stage pipeline.
 *
 * @packageDocumentation
 */

/**
 * The provider whose tokenizer rules we should approximate. Each maps to a
 * different heuristic in {@link ProviderTokenizer}:
 *
 * - `openai` — GPT BPE approximation (~4 chars / token for English).
 * - `anthropic` — Claude tokenizer (~3.5 chars / token).
 * - `google` — Gemini SentencePiece (~4 chars / token).
 * - `mistral` — Mistral Tiktoken (~4 chars / token).
 * - `cohere` — Cohere BPE (~4 chars / token).
 * - `meta` — Llama-3 tokenizer (~3.8 chars / token).
 * - `deepseek` — Deepseek BPE (~3.7 chars / token).
 * - `local` — Generic fallback (~4 chars / token).
 */
export type TokenProvider =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'mistral'
  | 'cohere'
  | 'meta'
  | 'deepseek'
  | 'local';

/**
 * A single chat message, structurally compatible with
 * `@sanix/providers`' `LLMMessage` so callers can pass their existing
 * message objects directly.
 */
export interface SlimMessage {
  /** Role: `system` | `user` | `assistant` | `tool`. */
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** The textual content of the message. */
  content: string;
  /** Optional name (for tool / function calls). */
  name?: string;
}

/**
 * Result of counting tokens for a single message via
 * {@link ProviderTokenizer.countMessage}.
 */
export interface MessageTokenCount {
  /** The message that was counted. */
  message: SlimMessage;
  /** Tokens attributed to the content. */
  contentTokens: number;
  /** Tokens attributed to role / formatting overhead. */
  overheadTokens: number;
  /** Total tokens for this message. */
  total: number;
}

/**
 * Options for the {@link TokenSlimManager} pipeline.
 */
export interface TokenSlimOptions {
  /** The provider whose tokenizer to use. Default `openai`. */
  provider?: TokenProvider;
  /** Hard cap on total prompt tokens. Default 8000. */
  maxTokens?: number;
  /** Target compression ratio (0..1] for LLMlingua stage. Default 0.6. */
  compressionRatio?: number;
  /** Whether to drop semantically duplicate messages. Default true. */
  deduplicateMessages?: boolean;
  /** Whether to minify whitespace / comments / common phrases. Default true. */
  minify?: boolean;
  /** Whether to compress tool descriptions. Default true. */
  compressTools?: boolean;
  /** Jaccard similarity threshold above which two messages are duplicates. Default 0.85. */
  dedupSimilarity?: number;
}

/**
 * A tool description as consumed by {@link ToolDescriptionCompressor}.
 */
export interface ToolDescription {
  /** Tool name (e.g. `read_file`). */
  name: string;
  /** Full human-readable description. */
  description: string;
  /** JSON schema for the tool's parameters (optional). */
  parametersSchema?: Record<string, unknown>;
}

/**
 * Savings report produced by {@link TokenSavingsReporter}.
 */
export interface TokenSavingsReport {
  /** Original token count before the pipeline ran. */
  originalTokens: number;
  /** Final token count after the pipeline ran. */
  finalTokens: number;
  /** Absolute tokens saved. */
  tokensSaved: number;
  /** Percentage savings (0..100). */
  percentSaved: number;
  /** Per-stage token counts (keyed by stage name). */
  perStage: Record<string, { before: number; after: number }>;
  /** Total wall-clock time spent in the pipeline, in ms. */
  elapsedMs: number;
}

/**
 * Output of a single pipeline stage. Used internally by
 * {@link TokenSlimManager} to build up the savings report.
 */
export interface StageResult {
  /** Stage name (e.g. `minify`, `dedup`). */
  name: string;
  /** Tokens before this stage ran. */
  before: number;
  /** Tokens after this stage ran. */
  after: number;
  /** Wall-clock time spent in this stage, in ms. */
  elapsedMs: number;
}
