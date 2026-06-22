/**
 * @file AuditLogger.ts
 * @description Tamper-evident audit log backed by a SHA-256 hash chain.
 * Every appended {@link AuditEvent} is converted to an {@link AuditRecord}
 * whose `hash` field is the SHA-256 of (prevHash ‖ seq ‖ canonical(event)).
 * Removing or modifying any record breaks the chain, which is detectable
 * via {@link AuditLogger.verify}.
 *
 * The logger keeps an in-memory ring of records but also supports a
 * pluggable {@link AuditSink} for persistence (filesystem, database,
 * WORM storage). A sink that fails to persist raises an error and the
 * record is not appended to the in-memory ring (atomic append semantics).
 *
 * @packageDocumentation
 */

import EventEmitter from 'eventemitter3';
import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import type {
  AuditEvent,
  AuditLoggerEvents,
  AuditLoggerOptions,
  AuditRecord,
  VerificationResult,
} from './types.js';

/**
 * Persistence sink for {@link AuditLogger}. Implementations write records
 * to durable storage (filesystem, database, WORM). A sink that throws
 * prevents the record from being appended to the in-memory ring.
 */
export interface AuditSink {
  /** Persist a single record. Must be atomic and durable. */
  write(record: AuditRecord): Promise<void> | void;
  /** Read all records back in seq order. */
  read(): Promise<AuditRecord[]> | AuditRecord[];
}

/**
 * Tamper-evident audit log backed by a SHA-256 hash chain.
 *
 * ```ts
 * const logger = new AuditLogger();
 * await logger.append({ id: nanoid(), timestamp: Date.now(),
 *   action: 'auth.login', actorKind: 'user', actorId: 'u1',
 *   outcome: 'success' });
 * const ok = logger.verify();
 * ```
 */
export class AuditLogger extends EventEmitter<AuditLoggerEvents> {
  /** Ordered list of records (oldest first). */
  #records: AuditRecord[] = [];
  /** Last record's hash (or `'genesis'` for an empty chain). */
  #lastHash: string = 'genesis';
  /** Optional salt mixed into the hash input. */
  readonly #salt: string;
  /** Optional persistence sink. */
  readonly #sink?: AuditSink;

  /**
   * @param options - Logger configuration (see {@link AuditLoggerOptions}).
   * @param sink    - Optional persistence sink.
   */
  constructor(options: AuditLoggerOptions = {}, sink?: AuditSink) {
    super();
    this.#salt = options.salt ?? '';
    this.#sink = sink;
  }

  /**
   * Append an {@link AuditEvent} to the chain. The event is wrapped in an
   * {@link AuditRecord} with the next sequence number, the previous
   * record's hash, and a freshly computed hash. If a sink is configured,
   * it is written *before* the in-memory ring is updated so a sink
   * failure leaves the chain untouched.
   *
   * @param event - The event to append.
   * @returns The persisted {@link AuditRecord}.
   */
  async append(event: AuditEvent): Promise<AuditRecord> {
    const seq = this.#records.length;
    const prevHash = this.#lastHash;
    const hash = this.#computeHash(seq, prevHash, event);
    const record: AuditRecord = { ...event, seq, prevHash, hash };
    if (this.#sink) {
      await this.#sink.write(record);
    }
    this.#records.push(record);
    this.#lastHash = hash;
    this.emit('record', record);
    return record;
  }

  /**
   * Verify the integrity of the chain by recomputing every hash and
   * checking it matches the stored value, and that `prevHash` of record
   * `n` equals `hash` of record `n-1`. Any mismatch short-circuits and
   * returns a {@link VerificationResult} with `valid: false`.
   *
   * @returns The verification result.
   */
  verify(): VerificationResult {
    let prevHash = 'genesis';
    for (let i = 0; i < this.#records.length; i++) {
      const rec = this.#records[i];
      if (rec.prevHash !== prevHash) {
        const result: VerificationResult = {
          valid: false,
          count: i,
          firstBrokenIndex: i,
          reason: `prevHash mismatch at seq ${rec.seq}: expected ${prevHash}, got ${rec.prevHash}`,
        };
        this.emit('tamper', result);
        return result;
      }
      const recomputed = this.#computeHash(rec.seq, rec.prevHash, rec);
      if (recomputed !== rec.hash) {
        const result: VerificationResult = {
          valid: false,
          count: i,
          firstBrokenIndex: i,
          reason: `hash mismatch at seq ${rec.seq}: expected ${rec.hash}, got ${recomputed}`,
        };
        this.emit('tamper', result);
        return result;
      }
      prevHash = rec.hash;
    }
    return { valid: true, count: this.#records.length };
  }

  /**
   * Hydrate the in-memory ring from the configured sink. Throws if no
   * sink was supplied. After hydration the chain is verified; if
   * verification fails the in-memory state is left untouched and the
   * {@link VerificationResult} is returned via rejection.
   */
  async hydrate(): Promise<VerificationResult> {
    if (!this.#sink) throw new Error('No sink configured');
    const records = await this.#sink.read();
    this.#records = records;
    this.#lastHash = records.length > 0 ? records[records.length - 1].hash : 'genesis';
    return this.verify();
  }

  /** Return a defensive copy of all records. */
  records(): AuditRecord[] {
    return [...this.#records];
  }

  /** Number of records currently in the chain. */
  get length(): number {
    return this.#records.length;
  }

  /**
   * Compute the SHA-256 hash for a record. The hash input is the
   * canonical JSON serialization of `[seq, prevHash, salt, event]` where
   * `event` is the {@link AuditEvent} portion (without the bookkeeping
   * fields). Using a tuple prevents field reordering from changing the
   * hash.
   */
  #computeHash(seq: number, prevHash: string, event: AuditEvent): string {
    // Project the AuditEvent fields into a fresh object so we never
    // mutate the (read-only) input. Bookkeeping fields (`seq`, `prevHash`,
    // `hash`) are intentionally excluded from the hash input.
    const eventOnly: Omit<AuditEvent, 'id' | 'timestamp'> & {
      id: string;
      timestamp: number;
    } = {
      id: event.id,
      timestamp: event.timestamp,
      action: event.action,
      actorKind: event.actorKind,
      actorId: event.actorId,
      target: event.target,
      payload: event.payload,
      outcome: event.outcome,
      reason: event.reason,
      severity: event.severity,
    };
    const canonical = JSON.stringify([seq, prevHash, this.#salt, eventOnly]);
    return createHash('sha256').update(canonical).digest('hex');
  }
}

/**
 * Convenience factory for a fresh {@link AuditEvent} with sensible
 * defaults (nanoid, current timestamp, `outcome: 'success'`).
 *
 * @param partial - Partial event to merge with defaults.
 * @returns A complete {@link AuditEvent}.
 */
export function createAuditEvent(partial: Partial<AuditEvent> & Pick<AuditEvent, 'action' | 'actorKind' | 'actorId'>): AuditEvent {
  return {
    id: partial.id ?? nanoid(),
    timestamp: partial.timestamp ?? Date.now(),
    action: partial.action,
    actorKind: partial.actorKind,
    actorId: partial.actorId,
    target: partial.target,
    payload: partial.payload,
    outcome: partial.outcome ?? 'success',
    reason: partial.reason,
    severity: partial.severity,
  };
}
