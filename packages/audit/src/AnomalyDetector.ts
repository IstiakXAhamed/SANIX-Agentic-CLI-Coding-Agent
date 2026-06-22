/**
 * @file AnomalyDetector.ts
 * @description Detects anomalies in a stream of {@link AuditEvent}s. The
 * detector maintains rolling statistics (event counts per actor, denial
 * rates, target frequency) and surfaces {@link Anomaly} records when an
 * event or sequence of events deviates from the established baseline.
 *
 * The detector supports six anomaly kinds:
 *
 *   - **burst**            — many events from one actor in a short window
 *   - **after-hours**      — privileged actions outside working hours
 *   - **privilege-escalation** — actor accesses new privileged action
 *   - **denial-spike**     — denial rate exceeds baseline by >50%
 *   - **unusual-target**   — actor accesses a never-before-seen target
 *   - **new-actor**        — actor id not seen in the warmup window
 *   - **volume-deviation** — total event volume >2σ from rolling mean
 *
 * The detector is stateful: call {@link feed} for each new event and
 * collect the returned anomalies.
 *
 * @packageDocumentation
 */

import { nanoid } from 'nanoid';
import type { Anomaly, AnomalyKind, AuditEvent, AuditSeverity } from './types.js';

/** Configuration accepted by {@link AnomalyDetector}. */
export interface AnomalyDetectorOptions {
  /** Number of events used as warmup before anomalies are emitted. Default `50`. */
  readonly warmup?: number;
  /** Burst window in milliseconds. Default `60_000` (1 minute). */
  readonly burstWindowMs?: number;
  /** Burst threshold (events per window). Default `20`. */
  readonly burstThreshold?: number;
  /** Working-hours window in 24h local time. Default `[8, 18]`. */
  readonly workingHours?: readonly [number, number];
  /** Actions treated as privileged. Pattern source. Default `'^(admin\\.|auth\\.|secrets\\.)'`. */
  readonly privilegedPattern?: string;
  /** Rolling window size (number of events) for volume stats. Default `100`. */
  readonly volumeWindow?: number;
  /** Standard deviations above mean that count as a volume deviation. Default `2`. */
  readonly volumeSigma?: number;
}

/**
 * Detects anomalies in audit event streams.
 *
 * ```ts
 * const detector = new AnomalyDetector();
 * for (const event of events) {
 *   const anomalies = detector.feed(event);
 *   for (const a of anomalies) console.warn(a.kind, a.description);
 * }
 * ```
 */
export class AnomalyDetector {
  /** Resolved options. */
  readonly #options: Required<AnomalyDetectorOptions>;
  /** Total events seen so far. */
  #count = 0;
  /** Events per actor in the current burst window. */
  readonly #burstCounts: Map<string, { count: number; firstTs: number }> = new Map();
  /** All actions seen per actor (for privilege-escalation detection). */
  readonly #actorActions: Map<string, Set<string>> = new Map();
  /** All targets seen per actor (for unusual-target detection). */
  readonly #actorTargets: Map<string, Set<string>> = new Map();
  /** Set of actors seen during warmup (for new-actor detection). */
  readonly #knownActors: Set<string> = new Set();
  /** Rolling denial counts (for denial-spike detection). */
  readonly #denialBuckets: number[] = [];
  /** Rolling volume window (timestamps). */
  readonly #volumeTs: number[] = [];
  /** Compiled privileged-action regex. */
  readonly #privileged: RegExp;

  /**
   * @param options - Detector configuration (see {@link AnomalyDetectorOptions}).
   */
  constructor(options: AnomalyDetectorOptions = {}) {
    this.#options = {
      warmup: options.warmup ?? 50,
      burstWindowMs: options.burstWindowMs ?? 60_000,
      burstThreshold: options.burstThreshold ?? 20,
      workingHours: options.workingHours ?? [8, 18],
      privilegedPattern: options.privilegedPattern ?? '^(admin\\.|auth\\.|secrets\\.)',
      volumeWindow: options.volumeWindow ?? 100,
      volumeSigma: options.volumeSigma ?? 2,
    };
    this.#privileged = new RegExp(this.#options.privilegedPattern);
  }

  /**
   * Feed a single event to the detector. Returns any anomalies triggered
   * by this event (possibly more than one). The detector's internal
   * state is updated regardless of whether anomalies are returned.
   *
   * @param event - The event to feed.
   * @returns An array of {@link Anomaly} records (possibly empty).
   */
  feed(event: AuditEvent): Anomaly[] {
    const out: Anomaly[] = [];
    const inWarmup = this.#count < this.#options.warmup;

    // Track known actors during warmup for new-actor detection later.
    if (inWarmup) this.#knownActors.add(event.actorId);
    else if (!this.#knownActors.has(event.actorId)) {
      out.push(this.#makeAnomaly('new-actor', `Actor "${event.actorId}" not seen during warmup`, [event.id], 'medium', 50));
    }

    // Burst detection.
    out.push(...this.#checkBurst(event));

    // After-hours + privileged.
    if (this.#isAfterHours(event.timestamp) && this.#privileged.test(event.action)) {
      out.push(this.#makeAnomaly('after-hours', `Privileged action "${event.action}" by "${event.actorId}" at ${new Date(event.timestamp).toISOString()}`, [event.id], 'high', 70));
    }

    // Privilege escalation: new privileged action for an existing actor.
    const knownActions = this.#actorActions.get(event.actorId) ?? new Set<string>();
    if (this.#privileged.test(event.action) && !knownActions.has(event.action) && !inWarmup) {
      out.push(this.#makeAnomaly('privilege-escalation', `Actor "${event.actorId}" performed new privileged action "${event.action}"`, [event.id], 'high', 75));
    }
    knownActions.add(event.action);
    this.#actorActions.set(event.actorId, knownActions);

    // Unusual target: actor accesses a target they've never accessed.
    if (event.target) {
      const knownTargets = this.#actorTargets.get(event.actorId) ?? new Set<string>();
      if (!knownTargets.has(event.target) && !inWarmup) {
        out.push(this.#makeAnomaly('unusual-target', `Actor "${event.actorId}" accessed new target "${event.target}"`, [event.id], 'low', 30));
      }
      knownTargets.add(event.target);
      this.#actorTargets.set(event.actorId, knownTargets);
    }

    // Denial spike: track denials in a rolling window of 100 events.
    out.push(...this.#checkDenialSpike(event));

    // Volume deviation: rolling window of event timestamps.
    out.push(...this.#checkVolumeDeviation(event));

    this.#count += 1;
    return out;
  }

  /** Total number of events fed so far. */
  get count(): number {
    return this.#count;
  }

  /** Reset all internal state. Useful when restarting a session. */
  reset(): void {
    this.#count = 0;
    this.#burstCounts.clear();
    this.#actorActions.clear();
    this.#actorTargets.clear();
    this.#knownActors.clear();
    this.#denialBuckets.length = 0;
    this.#volumeTs.length = 0;
  }

  /**
   * Burst detection. Maintains a per-actor count of events within a
   * sliding window. When the count crosses the configured threshold, an
   * anomaly is emitted and the counter resets.
   */
  #checkBurst(event: AuditEvent): Anomaly[] {
    const now = event.timestamp;
    const entry = this.#burstCounts.get(event.actorId);
    if (!entry || now - entry.firstTs > this.#options.burstWindowMs) {
      this.#burstCounts.set(event.actorId, { count: 1, firstTs: now });
      return [];
    }
    entry.count += 1;
    if (entry.count >= this.#options.burstThreshold) {
      const anomaly = this.#makeAnomaly('burst', `Actor "${event.actorId}" emitted ${entry.count} events in ${this.#options.burstWindowMs}ms`, [event.id], 'high', 80);
      this.#burstCounts.delete(event.actorId);
      return [anomaly];
    }
    return [];
  }

  /**
   * Denial spike detection. Keeps a rolling window of 100 event outcomes
   * (1 for denied, 0 otherwise) and emits when the rolling denial rate
   * exceeds 0.5 (i.e. >50% denials) AND there are at least 10 events.
   */
  #checkDenialSpike(event: AuditEvent): Anomaly[] {
    this.#denialBuckets.push(event.outcome === 'denied' ? 1 : 0);
    if (this.#denialBuckets.length > 100) this.#denialBuckets.shift();
    if (this.#denialBuckets.length < 10) return [];
    const sum = this.#denialBuckets.reduce((a, b) => a + b, 0);
    const rate = sum / this.#denialBuckets.length;
    if (rate > 0.5) {
      return [this.#makeAnomaly('denial-spike', `Denial rate ${(rate * 100).toFixed(1)}% over last ${this.#denialBuckets.length} events`, [event.id], 'high', 70)];
    }
    return [];
  }

  /**
   * Volume deviation detection. Keeps a rolling window of event
   * timestamps and emits when the count in the most recent minute
   * exceeds the rolling mean by `volumeSigma` standard deviations.
   */
  #checkVolumeDeviation(event: AuditEvent): Anomaly[] {
    this.#volumeTs.push(event.timestamp);
    if (this.#volumeTs.length > this.#options.volumeWindow) this.#volumeTs.shift();
    if (this.#volumeTs.length < this.#options.volumeWindow) return [];
    // Bucket timestamps into 1-minute windows and count.
    const buckets: number[] = [];
    let bucketStart = this.#volumeTs[0];
    let bucketCount = 0;
    for (const ts of this.#volumeTs) {
      if (ts - bucketStart >= 60_000) {
        buckets.push(bucketCount);
        bucketStart = ts;
        bucketCount = 0;
      }
      bucketCount += 1;
    }
    buckets.push(bucketCount);
    if (buckets.length < 5) return [];
    const mean = buckets.reduce((a, b) => a + b, 0) / buckets.length;
    const variance = buckets.reduce((a, b) => a + (b - mean) ** 2, 0) / buckets.length;
    const stddev = Math.sqrt(variance);
    const last = buckets[buckets.length - 1];
    if (stddev > 0 && last - mean > this.#options.volumeSigma * stddev) {
      return [this.#makeAnomaly('volume-deviation', `Volume ${last} in last minute vs mean ${mean.toFixed(1)} (σ=${stddev.toFixed(1)})`, [event.id], 'medium', 55)];
    }
    return [];
  }

  /** Returns `true` when `ts` falls outside the configured working hours. */
  #isAfterHours(ts: number): boolean {
    const [start, end] = this.#options.workingHours;
    const hour = new Date(ts).getHours();
    return hour < start || hour >= end;
  }

  /** Helper to construct an {@link Anomaly} with sensible defaults. */
  #makeAnomaly(kind: AnomalyKind, description: string, eventIds: readonly string[], severity: AuditSeverity, score: number): Anomaly {
    return { id: nanoid(), kind, description, eventIds, severity, score };
  }
}
