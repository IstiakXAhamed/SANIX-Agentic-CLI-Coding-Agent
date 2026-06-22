/**
 * @file types.ts
 * @description Shared types for `@sanix/telemetry`.
 *
 * @packageDocumentation
 */

/** Severity of a telemetry event. */
export type Severity = 'debug' | 'info' | 'warning' | 'error' | 'fatal';

/**
 * A breadcrumb — a lightweight event captured before an error to provide
 * context (analogous to Sentry breadcrumbs).
 */
export interface Breadcrumb {
  /** Unix ms timestamp. */
  timestamp: number;
  /** Severity. */
  level: Severity;
  /** Category (e.g. `http`, `tool`, `ui`). */
  category: string;
  /** Human-readable message. */
  message: string;
  /** Optional structured data. */
  data?: Record<string, unknown>;
}

/**
 * A captured error event, ready for transport to a Sentry-compatible
 * backend.
 */
export interface ErrorEvent {
  /** Stable event id (uuid or nanoid). */
  id: string;
  /** Fingerprint hash used to group similar errors. */
  fingerprint: string;
  /** Error name (e.g. `TypeError`). */
  name: string;
  /** Error message. */
  message: string;
  /** Stack trace (if available). */
  stack?: string;
  /** Severity. */
  level: Severity;
  /** Unix ms timestamp. */
  timestamp: number;
  /** Release / version tag. */
  release?: string;
  /** Environment tag (e.g. `production`). */
  environment?: string;
  /** Arbitrary tags. */
  tags?: Record<string, string>;
  /** Arbitrary extra context. */
  extra?: Record<string, unknown>;
  /** Breadcrumbs captured immediately before this error. */
  breadcrumbs: Breadcrumb[];
}

/**
 * The transport contract — sinks that ship events out of the process.
 */
export interface Transport {
  /** Human-readable name (e.g. `console`, `http`, `jsonl`). */
  readonly name: string;
  /** Send an event. Should never throw — degrade to stderr on failure. */
  send: (event: ErrorEvent) => Promise<void>;
  /** Flush any buffered state. */
  flush: () => Promise<void>;
  /** Close the transport and release resources. */
  close: () => Promise<void>;
}

/** Constructor options for `createTransport('http', opts)`. */
export interface HTTPTransportOptions {
  /** Endpoint URL (Sentry-compatible envelope endpoint). */
  endpoint: string;
  /** Optional Authorization header value. */
  authHeader?: string;
  /** Batch size (default 10). */
  batchSize?: number;
  /** Flush interval ms (default 5000). */
  flushIntervalMs?: number;
}

/** Constructor options for `createTransport('jsonl', opts)`. */
export interface JSONLTransportOptions {
  /** Output file path. Default `~/.sanix/telemetry.jsonl`. */
  filePath?: string;
}

/** Constructor options for `createTransport('console', opts)`. */
export interface ConsoleTransportOptions {
  /** Output stream (default `process.stderr`). */
  stream?: { write: (s: string) => void };
  /** Minimum severity to emit. Default `warning`. */
  minLevel?: Severity;
}

/** A registered health check. */
export interface HealthCheck {
  /** Unique check name. */
  name: string;
  /** The check implementation. Returns `ok` or throws. */
  run: () => Promise<void> | void;
  /** Optional timeout ms (default 5000). */
  timeoutMs?: number;
}

/** Result of running a single health check. */
export interface HealthCheckResult {
  /** Check name. */
  name: string;
  /** Whether the check passed. */
  ok: boolean;
  /** Latency in ms. */
  durationMs: number;
  /** Error message (when `ok` is false). */
  error?: string;
}

/** Options for the {@link AutoUpdater}. */
export interface AutoUpdaterOptions {
  /** Current app version (semver). */
  currentVersion: string;
  /** GitHub owner/repo (e.g. `sanix-ahmed/sanix`) — enables the GitHub provider. */
  githubRepo?: string;
  /** Or: a generic update-feed URL returning `{ version, downloadUrl }` JSON. */
  feedUrl?: string;
  /** Optional download directory (default `os.tmpdir()`). */
  downloadDir?: string;
  /** Check interval ms (default 1 hour). */
  checkIntervalMs?: number;
  /** Optional fetch implementation (defaults to global `fetch`). */
  fetchImpl?: typeof fetch;
}

/** Result of an update check. */
export interface UpdateCheckResult {
  /** Whether an update is available. */
  updateAvailable: boolean;
  /** Latest version (if known). */
  latestVersion?: string;
  /** Release notes (if any). */
  releaseNotes?: string;
  /** Download URL for the latest asset (if any). */
  downloadUrl?: string;
}

/** Result of {@link AutoUpdater.download}. */
export interface DownloadResult {
  /** Path to the downloaded file. */
  path: string;
  /** Bytes downloaded. */
  bytes: number;
}
