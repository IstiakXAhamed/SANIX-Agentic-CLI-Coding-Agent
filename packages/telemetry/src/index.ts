/**
 * @file index.ts
 * @description Barrel export for `@sanix/telemetry`.
 *
 * @packageDocumentation
 */

export * from './types.js';
export { Breadcrumbs } from './Breadcrumbs.js';
export type { BreadcrumbsOptions } from './Breadcrumbs.js';
export { ErrorMonitor } from './ErrorMonitor.js';
export type { ErrorMonitorOptions } from './ErrorMonitor.js';
export { CrashReporter } from './CrashReporter.js';
export type { CrashReporterOptions } from './CrashReporter.js';
export { createTransport } from './Transport.js';
export { AutoUpdater, compareSemver } from './AutoUpdater.js';
export { HealthCheck } from './HealthCheck.js';
export { TelemetryManager } from './TelemetryManager.js';
export type { TelemetryManagerOptions } from './TelemetryManager.js';
