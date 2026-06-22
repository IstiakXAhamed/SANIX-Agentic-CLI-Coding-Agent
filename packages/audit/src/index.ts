/**
 * @file index.ts
 * @description Public entry point for `@sanix/audit`. Re-exports the
 * logger, risk assessor, compliance reporter, anomaly detector, hook
 * adapter, and all shared types.
 *
 * Importing paths:
 * ```ts
 * import {
 *   AuditLogger,
 *   RiskAssessor,
 *   ComplianceReporter,
 *   AnomalyDetector,
 *   AuditHook,
 *   createAuditEvent,
 * } from '@sanix/audit';
 * import type { AuditEvent, AuditRecord, RiskScore, ComplianceReport } from '@sanix/audit';
 * ```
 *
 * @packageDocumentation
 */

export { AuditLogger, createAuditEvent, type AuditSink } from './AuditLogger.js';
export { RiskAssessor, type RiskAssessorOptions } from './RiskAssessor.js';
export {
  ComplianceReporter,
  FRAMEWORK_TEMPLATES,
  type SectionTemplate,
  type ComplianceReportOptions,
} from './ComplianceReporter.js';
export { AnomalyDetector, type AnomalyDetectorOptions } from './AnomalyDetector.js';
export {
  AuditHook,
  DEFAULT_AUDIT_EVENTS,
  type HookManagerLike,
  type AuditEventExtractor,
  type AuditHookOptions,
} from './AuditHook.js';

export type {
  AuditActorKind,
  AuditSeverity,
  ComplianceFramework,
  AuditEvent,
  AuditRecord,
  VerificationResult,
  RiskScore,
  Anomaly,
  AnomalyKind,
  ComplianceSection,
  ComplianceReport,
  AuditLoggerOptions,
  AuditLoggerEvents,
} from './types.js';

export { SEVERITY_WEIGHTS } from './types.js';
