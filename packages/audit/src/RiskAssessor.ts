/**
 * @file RiskAssessor.ts
 * @description Scores {@link AuditEvent}s on a 0–100 risk scale. The score
 * is a weighted sum of orthogonal risk factors:
 *
 *   - **Base severity** — the event's declared severity mapped to a
 *     weight via {@link SEVERITY_WEIGHTS}.
 *   - **Outcome** — `failure` and `denied` outcomes add fixed penalties.
 *   - **Privileged action** — actions matching a configurable regex
 *     (default: `^(admin\.|auth\.|secrets\.|tool\.delete|tool\.execute)`)
 *     add a privilege penalty.
 *   - **After-hours** — events whose timestamp falls outside a
 *     configurable working-hours window add an after-hours penalty.
 *   - **Sensitive target** — targets matching a configurable regex
 *     (default: secrets/keys/tokens) add a sensitivity penalty.
 *   - **Actor trust** — actors not on a configurable allowlist add a
 *     trust penalty.
 *
 * The final score is clamped to `[0, 100]` and bucketed back into an
 * {@link AuditSeverity} for downstream filtering.
 *
 * @packageDocumentation
 */

import type { AuditEvent, AuditSeverity, RiskScore } from './types.js';
import { SEVERITY_WEIGHTS } from './types.js';

/** Configuration accepted by {@link RiskAssessor}. */
export interface RiskAssessorOptions {
  /** Working-hours window in 24h local time `[start, end]`. Default `[8, 18]`. */
  readonly workingHours?: readonly [number, number];
  /** Regex (as source string) matching privileged actions. */
  readonly privilegedPattern?: string;
  /** Regex (as source string) matching sensitive targets. */
  readonly sensitiveTargetPattern?: string;
  /** Set of actor ids considered trusted (no trust penalty). */
  readonly trustedActors?: readonly string[];
  /** Penalty added for `failure` outcome. Default `15`. */
  readonly failurePenalty?: number;
  /** Penalty added for `denied` outcome. Default `25`. */
  readonly deniedPenalty?: number;
  /** Penalty added for privileged actions. Default `20`. */
  readonly privilegedPenalty?: number;
  /** Penalty added for after-hours events. Default `10`. */
  readonly afterHoursPenalty?: number;
  /** Penalty added for sensitive targets. Default `15`. */
  readonly sensitiveTargetPenalty?: number;
  /** Penalty added for untrusted actors. Default `10`. */
  readonly untrustedActorPenalty?: number;
}

/**
 * Scores audit events for risk.
 *
 * ```ts
 * const assessor = new RiskAssessor({ trustedActors: ['agent-1'] });
 * const score = assessor.score(event);
 * if (score.severity === 'critical') pageOnCall();
 * ```
 */
export class RiskAssessor {
  /** Internal resolved options — `trustedActors` is converted to a Set for O(1) lookup. */
  readonly #options: Omit<Required<RiskAssessorOptions>, 'trustedActors'> & {
    trustedActors: Set<string>;
  };
  /** Compiled privileged-action regex. */
  readonly #privileged: RegExp;
  /** Compiled sensitive-target regex. */
  readonly #sensitive: RegExp;

  /**
   * @param options - Assessor configuration (see {@link RiskAssessorOptions}).
   */
  constructor(options: RiskAssessorOptions = {}) {
    this.#options = {
      workingHours: options.workingHours ?? [8, 18],
      privilegedPattern: options.privilegedPattern ?? '^(admin\\.|auth\\.|secrets\\.|tool\\.delete|tool\\.execute)',
      sensitiveTargetPattern: options.sensitiveTargetPattern ?? '(secret|key|token|password|credential)',
      trustedActors: new Set(options.trustedActors ?? []),
      failurePenalty: options.failurePenalty ?? 15,
      deniedPenalty: options.deniedPenalty ?? 25,
      privilegedPenalty: options.privilegedPenalty ?? 20,
      afterHoursPenalty: options.afterHoursPenalty ?? 10,
      sensitiveTargetPenalty: options.sensitiveTargetPenalty ?? 15,
      untrustedActorPenalty: options.untrustedActorPenalty ?? 10,
    };
    this.#privileged = new RegExp(this.#options.privilegedPattern);
    this.#sensitive = new RegExp(this.#options.sensitiveTargetPattern, 'i');
  }

  /**
   * Score a single event. The score is a weighted sum of triggered
   * factors, clamped to `[0, 100]`.
   *
   * @param event - The event to score.
   * @returns A {@link RiskScore} describing the result.
   */
  score(event: AuditEvent): RiskScore {
    const reasons: string[] = [];
    const factors: string[] = [];
    const base = SEVERITY_WEIGHTS[event.severity ?? 'low'];
    let score = base;
    reasons.push(`base severity ${event.severity ?? 'low'} → ${base}`);

    if (event.outcome === 'failure') {
      score += this.#options.failurePenalty;
      reasons.push(`outcome=failure (+${this.#options.failurePenalty})`);
      factors.push('outcome-failure');
    } else if (event.outcome === 'denied') {
      score += this.#options.deniedPenalty;
      reasons.push(`outcome=denied (+${this.#options.deniedPenalty})`);
      factors.push('outcome-denied');
    }

    if (this.#privileged.test(event.action)) {
      score += this.#options.privilegedPenalty;
      reasons.push(`privileged action "${event.action}" (+${this.#options.privilegedPenalty})`);
      factors.push('privileged-action');
    }

    if (this.#isAfterHours(event.timestamp)) {
      score += this.#options.afterHoursPenalty;
      reasons.push(`after-hours (+${this.#options.afterHoursPenalty})`);
      factors.push('after-hours');
    }

    if (event.target && this.#sensitive.test(event.target)) {
      score += this.#options.sensitiveTargetPenalty;
      reasons.push(`sensitive target "${event.target}" (+${this.#options.sensitiveTargetPenalty})`);
      factors.push('sensitive-target');
    }

    if (!this.#options.trustedActors.has(event.actorId)) {
      score += this.#options.untrustedActorPenalty;
      reasons.push(`untrusted actor "${event.actorId}" (+${this.#options.untrustedActorPenalty})`);
      factors.push('untrusted-actor');
    }

    score = Math.max(0, Math.min(100, Math.round(score)));
    return {
      eventId: event.id,
      score,
      severity: this.#bucket(score),
      reasons,
      factors,
    };
  }

  /**
   * Score a batch of events and return the results keyed by event id.
   *
   * @param events - Events to score.
   * @returns Map of event id → {@link RiskScore}.
   */
  scoreAll(events: readonly AuditEvent[]): Map<string, RiskScore> {
    const out = new Map<string, RiskScore>();
    for (const e of events) out.set(e.id, this.score(e));
    return out;
  }

  /**
   * Bucket a numeric score into an {@link AuditSeverity}. The thresholds
   * are: `< 15` info, `< 35` low, `< 60` medium, `< 85` high, else critical.
   */
  #bucket(score: number): AuditSeverity {
    if (score < 15) return 'info';
    if (score < 35) return 'low';
    if (score < 60) return 'medium';
    if (score < 85) return 'high';
    return 'critical';
  }

  /** Returns `true` when `ts` falls outside the configured working hours. */
  #isAfterHours(ts: number): boolean {
    const [start, end] = this.#options.workingHours;
    const hour = new Date(ts).getHours();
    return hour < start || hour >= end;
  }
}
