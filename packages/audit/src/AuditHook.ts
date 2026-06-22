/**
 * @file AuditHook.ts
 * @description Adapts the SANIX core {@link HookManager} event stream into
 * an {@link AuditLogger} so agent runs can be audited with zero changes
 * to the agent itself.
 *
 * The hook listens to a configurable subset of well-known hook events
 * (`'tool:before'`, `'tool:after'`, `'llm:before'`, `'llm:after'`,
 * `'iteration:before'`, `'iteration:after'`, `'error'`) and translates
 * each into an {@link AuditEvent} appended to the logger. The mapping
 * from hook context → audit event is pluggable via a
 * {@link AuditEventExtractor} so callers can mask secrets, attach
 * metadata, or filter out events they don't want audited.
 *
 * @packageDocumentation
 */

import { AuditLogger as AuditLoggerClass } from './AuditLogger.js';
import type { AuditEvent, AuditSeverity } from './types.js';

// Re-export the class type so consumers can do
//   `import type { AuditLogger } from '@sanix/audit'`.
export type { AuditLogger as AuditLoggerClass } from './AuditLogger.js';

/**
 * Minimal structural interface that any SANIX hook manager must satisfy
 * for {@link AuditHook} to subscribe to it. Kept structural so this
 * package has no hard dependency on `@sanix/core`.
 */
export interface HookManagerLike {
  /** Register a handler for a named hook event. Returns an unsubscribe function. */
  on(event: string, handler: (ctx: unknown) => unknown): () => void;
}

/**
 * Function that maps a hook context to an {@link AuditEvent} (or
 * `undefined` to skip auditing). The default extractor produces a
 * minimal event with `action` = hook event name, `actorKind: 'agent'`,
 * and a generated actor id. Callers typically supply a custom extractor
 * to populate `actorId`, `target`, `payload`, etc. from the context.
 */
export type AuditEventExtractor = (
  ctx: unknown,
  event: string,
) => AuditEvent | undefined;

/** Options accepted by {@link AuditHook.install}. */
export interface AuditHookOptions {
  /** Hook events to audit. Defaults to the well-known lifecycle events. */
  readonly events?: readonly string[];
  /** Event extractor (see {@link AuditEventExtractor}). */
  readonly extract?: AuditEventExtractor;
  /** Severity to assign when the extractor does not provide one. Default `'low'`. */
  readonly defaultSeverity?: AuditSeverity;
}

/** Default events audited by {@link AuditHook}. */
export const DEFAULT_AUDIT_EVENTS: readonly string[] = [
  'tool:before',
  'tool:after',
  'llm:before',
  'llm:after',
  'iteration:before',
  'iteration:after',
  'error',
];

/** Internal monotonic counter for fallback ids when no extractor is set. */
let _idCounter = 0;
function fallbackId(): string {
  _idCounter += 1;
  return `audit-${Date.now().toString(36)}-${_idCounter.toString(36)}`;
}

/**
 * Hook adapter that records agent activity into an {@link AuditLoggerClass}.
 *
 * ```ts
 * const logger = new AuditLoggerClass();
 * const hook = new AuditHook(logger);
 * await hook.install(hookManager, {
 *   extract: (ctx, event) => ({
 *     id: fallbackId(),
 *     timestamp: Date.now(),
 *     action: event,
 *     actorKind: 'agent',
 *     actorId: (ctx as { agentId?: string })?.agentId ?? 'unknown',
 *     outcome: 'success',
 *   }),
 * });
 * // … agent runs …
 * hook.uninstall();
 * ```
 */
export class AuditHook {
  /** The logger this hook feeds. */
  readonly logger: AuditLoggerClass;
  /** Resolved options. */
  #options: Required<AuditHookOptions> = {
    events: DEFAULT_AUDIT_EVENTS,
    extract: (ctx, event) => ({
      id: fallbackId(),
      timestamp: Date.now(),
      action: event,
      actorKind: 'agent',
      actorId: 'unknown',
      outcome: 'success',
      severity: 'low',
      payload: ctx,
    }),
    defaultSeverity: 'low',
  };
  /** Active unsubscribe callbacks. */
  #unsubs: Array<() => void> = [];

  /**
   * @param logger - The audit logger to feed.
   */
  constructor(logger: AuditLoggerClass) {
    this.logger = logger;
  }

  /**
   * Subscribe to the hook manager and begin auditing. Each subscribed
   * event gets a handler that calls the configured extractor and, if it
   * returns an event, appends it to the logger. Hook handler errors are
   * swallowed so a misbehaving extractor cannot break the agent.
   *
   * @param hookManager - The hook manager to subscribe to.
   * @param options     - Hook configuration (see {@link AuditHookOptions}).
   */
  async install(hookManager: HookManagerLike, options: AuditHookOptions = {}): Promise<void> {
    this.uninstall();
    const userExtract = options.extract;
    this.#options = {
      events: options.events ?? DEFAULT_AUDIT_EVENTS,
      extract: userExtract ?? this.#options.extract,
      defaultSeverity: options.defaultSeverity ?? 'low',
    };
    for (const event of this.#options.events) {
      const unsub = hookManager.on(event, (ctx) => {
        try {
          const auditEvent = this.#options.extract(ctx, event);
          if (auditEvent) {
            // Fire and forget — the logger's sink (if any) handles persistence.
            void this.logger.append(auditEvent);
          }
        } catch {
          // Audit hook errors must never break the agent — swallow.
        }
      });
      this.#unsubs.push(unsub);
    }
  }

  /**
   * Unsubscribe from the hook manager. Safe to call multiple times.
   */
  uninstall(): void {
    for (const unsub of this.#unsubs) {
      try {
        unsub();
      } catch {
        // ignore
      }
    }
    this.#unsubs = [];
  }

  /** Convenience accessor for the events currently being audited. */
  get events(): readonly string[] {
    return this.#options.events;
  }
}
