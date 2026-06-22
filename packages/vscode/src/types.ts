/**
 * @fileoverview Shared types for the SANIX VSCode extension.
 * @module sanix.vscode/types
 */

/**
 * The role of a chat message exchanged with the SANIX CLI.
 */
export type ChatRole = "user" | "assistant" | "system" | "error";

/**
 * A single chat message rendered in the webview and persisted across reloads.
 */
export interface ChatMessage {
  /** Unique id (UUID-ish) used as a React key by the webview. */
  id: string;
  /** Role of the message author. */
  role: ChatRole;
  /** The text content (may include ```diff fenced blocks). */
  content: string;
  /** Epoch ms when the message was created. */
  ts: number;
  /** True while the assistant is still streaming tokens. */
  streaming?: boolean;
  /** Optional model string (e.g. `anthropic:claude-sonnet-4`). */
  model?: string;
  /** Optional cost (USD) attributed to this message. */
  costUsd?: number;
}

/**
 * The state of the SANIX backend at any given moment.
 * Drives the status-bar icon + color.
 */
export type BackendState =
  | "idle"
  | "running"
  | "streaming"
  | "cost-warning"
  | "cost-critical"
  | "error";

/**
 * Summary of a SANIX session — mirrors `~/.sanix/sessions/<id>.json`.
 */
export interface SanixSession {
  /** Session id (short uuid). */
  id: string;
  /** Human-friendly name. */
  name: string;
  /** ISO timestamp of creation. */
  createdAt: string;
  /** ISO timestamp of last update. */
  updatedAt: string;
  /** True if this is the active session. */
  active: boolean;
  /** Number of messages in the session. */
  messageCount: number;
}

/**
 * Result of a successful `sanix` CLI invocation.
 */
export interface SanixCliResult {
  /** Stdout (trimmed). */
  stdout: string;
  /** Stderr (trimmed). */
  stderr: string;
  /** Exit code (0 = success). */
  code: number;
  /** Wall-clock duration in ms. */
  durationMs: number;
}

/**
 * Public programmatic API surface exported to other VSCode extensions via
 * `vscode.l10n` / `extensions.getExtension('istiak-ahamed.sanix').exports`.
 */
export interface SanixPublicApi {
  /** Run a one-shot prompt against the configured SANIX CLI. */
  ask(prompt: string, opts?: { model?: string; cwd?: string }): Promise<string>;
  /** Run a named SANIX agent on a prompt (e.g. `coder`, `reviewer`, `ultra-worker`). */
  runAgent(agent: string, prompt: string, opts?: { cwd?: string }): Promise<string>;
  /** Run the UltraWorker orchestrator on a goal. */
  runUltraWorker(goal: string, opts?: { cwd?: string }): Promise<string>;
  /** Run a vision (image) query against a multimodal provider. */
  vision(imagePath: string, prompt: string, opts?: { model?: string }): Promise<string>;
  /** Run the V16 10-step intelligence pipeline on a task. */
  runIntelligencePipeline(task: string, opts?: { cwd?: string }): Promise<string>;
  /** Return the total cost (USD) accrued today. */
  getCostToday(): Promise<number>;
  /** Return the active SANIX session (if any). */
  getActiveSession(): Promise<SanixSession | null>;
  /** Switch the active session by id (or list+pick if no id given). */
  switchSession(sessionId?: string): Promise<SanixSession | null>;
}
