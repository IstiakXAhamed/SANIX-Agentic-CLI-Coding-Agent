/**
 * @file types.ts
 * @description Shared type definitions for `@sanix/audit`. Covers audit
 * events, hash chain records, risk assessments, compliance reports, and
 * anomaly detection results.
 *
 * @packageDocumentation
 */

/** The category of actor that performed the audited action. */
export type AuditActorKind =
  | 'user'
  | 'service'
  | 'agent'
  | 'system'
  | 'tool'
  | 'api';

/** The severity of an audit event used by {@link RiskAssessor}. */
export type AuditSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

/** The compliance frameworks supported by {@link ComplianceReporter}. */
export type ComplianceFramework =
  | 'SOC2'
  | 'GDPR'
  | 'HIPAA'
  | 'PCI'
  | 'ISO27001'
  | 'NIST';

/** A single auditable action performed by an actor. */
export interface AuditEvent {
  /** Stable unique id (nanoid). */
  readonly id: string;
  /** Wall-clock timestamp in milliseconds since the Unix epoch. */
  readonly timestamp: number;
  /** Free-form event type (e.g. `"tool.invoke"`, `"auth.login"`). */
  readonly action: string;
  /** Kind of actor that performed the action. */
  readonly actorKind: AuditActorKind;
  /** Stable identifier for the actor (user id, service name, agent id). */
  readonly actorId: string;
  /** Optional target resource identifier (e.g. file path, record id). */
  readonly target?: string;
  /** JSON-serializable event payload (request, response, metadata). */
  readonly payload?: unknown;
  /** Outcome of the action. */
  readonly outcome: 'success' | 'failure' | 'denied';
  /** Optional human-readable reason for the outcome. */
  readonly reason?: string;
  /** Initial severity assigned by the caller (refined by the risk assessor). */
  readonly severity?: AuditSeverity;
}

/**
 * An {@link AuditEvent} augmented with the bookkeeping fields needed to
 * form a tamper-evident hash chain. Each record stores the SHA-256 of the
 * previous record (`prevHash`), the SHA-256 of its own canonical
 * serialization (`hash`), and an incrementing sequence number.
 */
export interface AuditRecord extends AuditEvent {
  /** Monotonically increasing sequence number, starting at 0. */
  readonly seq: number;
  /** SHA-256 hex digest of the previous record's `hash`, or `'genesis'` for seq 0. */
  readonly prevHash: string;
  /** SHA-256 hex digest of this record's canonical serialization. */
  readonly hash: string;
}

/** The result of verifying a hash chain. */
export interface VerificationResult {
  /** `true` when every record's hash recomputes correctly and chain is unbroken. */
  readonly valid: boolean;
  /** Total number of records verified. */
  readonly count: number;
  /** Index of the first broken record, or `undefined` when `valid` is `true`. */
  readonly firstBrokenIndex?: number;
  /** Human-readable explanation of the failure (when `valid` is `false`). */
  readonly reason?: string;
}

/** A risk score for a single audit event, in `[0, 100]`. */
export interface RiskScore {
  /** The audited event id this score applies to. */
  readonly eventId: string;
  /** Numeric risk score, higher = riskier. */
  readonly score: number;
  /** Final severity bucket derived from the score. */
  readonly severity: AuditSeverity;
  /** Reasons contributing to the score, in priority order. */
  readonly reasons: readonly string[];
  /** Risk factors that triggered (e.g. `"after-hours"`, `"privileged-action"`). */
  readonly factors: readonly string[];
}

/** An anomaly detected by {@link AnomalyDetector}. */
export interface Anomaly {
  /** Stable unique id (nanoid). */
  readonly id: string;
  /** Type of anomaly detected. */
  readonly kind: AnomalyKind;
  /** Human-readable description. */
  readonly description: string;
  /** Event ids that contributed to the anomaly. */
  readonly eventIds: readonly string[];
  /** Severity of the anomaly. */
  readonly severity: AuditSeverity;
  /** Optional numeric score in `[0, 100]`. */
  readonly score?: number;
}

/** The kinds of anomalies the detector can surface. */
export type AnomalyKind =
  | 'burst'
  | 'after-hours'
  | 'privilege-escalation'
  | 'denial-spike'
  | 'unusual-target'
  | 'new-actor'
  | 'volume-deviation';

/** A section of a {@link ComplianceReport}. */
export interface ComplianceSection {
  /** Section heading (e.g. `"CC6.1 — Logical Access"`). */
  readonly heading: string;
  /** Free-form Markdown body. */
  readonly body: string;
  /** Optional list of event ids the section references. */
  readonly eventIds?: readonly string[];
}

/** A compliance report for a specific framework. */
export interface ComplianceReport {
  /** The framework this report is for. */
  readonly framework: ComplianceFramework;
  /** Report generation timestamp in milliseconds since the Unix epoch. */
  readonly generatedAt: number;
  /** Time range the report covers (inclusive). */
  readonly range: { readonly start: number; readonly end: number };
  /** Number of events the report is based on. */
  readonly eventCount: number;
  /** Top-level summary (1-3 sentences). */
  readonly summary: string;
  /** Ordered list of sections. */
  readonly sections: readonly ComplianceSection[];
  /** Optional list of findings (issues, recommendations). */
  readonly findings: readonly string[];
}

/** Options accepted by {@link AuditLogger.append}. */
export interface AuditLoggerOptions {
  /** Optional salt mixed into the hash to make brute-forcing harder. */
  readonly salt?: string;
}

/** Events emitted by {@link AuditLogger}. */
export interface AuditLoggerEvents {
  /** Fired when a new record is appended to the chain. */
  record: (record: AuditRecord) => void;
  /** Fired when verification fails. */
  tamper: (result: VerificationResult) => void;
}

/** Mapping of {@link AuditSeverity} to numeric weights used by the risk assessor. */
export const SEVERITY_WEIGHTS: Readonly<Record<AuditSeverity, number>> = Object.freeze({
  info: 5,
  low: 15,
  medium: 35,
  high: 65,
  critical: 95,
});
