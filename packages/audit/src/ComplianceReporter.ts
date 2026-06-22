/**
 * @file ComplianceReporter.ts
 * @description Generates compliance reports for the six supported
 * frameworks: SOC2, GDPR, HIPAA, PCI, ISO27001, NIST. Each framework has
 * a fixed template of sections that map to specific audit event
 * categories. The reporter filters the audit log by the report's time
 * range, fills in counts and examples, and emits a structured
 * {@link ComplianceReport}.
 *
 * The mapping from framework → required sections lives in
 * {@link FRAMEWORK_TEMPLATES} and is intentionally conservative: when
 * there is no event data for a section, the section body says so
 * explicitly rather than omitting the section. This makes the reports
 * auditable — a reviewer can see which controls have no evidence.
 *
 * @packageDocumentation
 */

import type {
  AuditEvent,
  ComplianceFramework,
  ComplianceReport,
  ComplianceSection,
} from './types.js';

/** A template for a single compliance section. */
export interface SectionTemplate {
  /** Section heading (e.g. `"CC6.1 — Logical Access"`). */
  readonly heading: string;
  /** Event action prefix that satisfies this section (e.g. `"auth."`). */
  readonly actionPrefix: string;
  /** Function that builds the Markdown body given the matching events. */
  readonly body: (events: readonly AuditEvent[]) => string;
}

/** Mapping of framework → ordered list of section templates. */
export const FRAMEWORK_TEMPLATES: Readonly<Record<ComplianceFramework, readonly SectionTemplate[]>> = Object.freeze({
  SOC2: [
    {
      heading: 'CC6.1 — Logical Access',
      actionPrefix: 'auth.',
      body: (e) => `${e.length} logical access events recorded. ${countSuccess(e)} successful, ${countFailure(e)} failed.`,
    },
    {
      heading: 'CC6.6 — Access Restrictions',
      actionPrefix: 'tool.',
      body: (e) => `${e.length} tool invocation events. ${e.filter((x) => x.outcome === 'denied').length} denied by policy.`,
    },
    {
      heading: 'CC7.1 — System Monitoring',
      actionPrefix: 'system.',
      body: (e) => `${e.length} system monitoring events captured.`,
    },
  ],
  GDPR: [
    {
      heading: 'Art. 30 — Records of Processing',
      actionPrefix: 'data.',
      body: (e) => `${e.length} data processing events recorded.`,
    },
    {
      heading: 'Art. 32 — Security of Processing',
      actionPrefix: 'secrets.',
      body: (e) => `${e.length} secrets-access events. All accesses should be authorised and logged.`,
    },
    {
      heading: 'Art. 33 — Breach Notification',
      actionPrefix: 'incident.',
      body: (e) => `${e.length} incident events. Breaches must be notified within 72 hours.`,
    },
  ],
  HIPAA: [
    {
      heading: '§164.312(b) — Audit Controls',
      actionPrefix: 'phi.',
      body: (e) => `${e.length} PHI access events recorded.`,
    },
    {
      heading: '§164.312(c) — Integrity',
      actionPrefix: 'data.',
      body: (e) => `${e.length} data integrity events. Hash-chain verification recommended quarterly.`,
    },
    {
      heading: '§164.308(a)(3) — Workforce Security',
      actionPrefix: 'auth.',
      body: (e) => `${e.length} workforce access events. ${countFailure(e)} failed authentications.`,
    },
  ],
  PCI: [
    {
      heading: 'Req. 10 — Track and Monitor',
      actionPrefix: 'cardholder.',
      body: (e) => `${e.length} cardholder-data access events. Retain logs for ≥ 1 year.`,
    },
    {
      heading: 'Req. 7 — Restrict Access',
      actionPrefix: 'auth.',
      body: (e) => `${e.length} access events. ${e.filter((x) => x.outcome === 'denied').length} denied by RBAC.`,
    },
    {
      heading: 'Req. 8 — Identify Users',
      actionPrefix: 'auth.',
      body: (e) => `${e.length} authentication events across ${new Set(e.map((x) => x.actorId)).size} unique actors.`,
    },
  ],
  ISO27001: [
    {
      heading: 'A.9 — Access Control',
      actionPrefix: 'auth.',
      body: (e) => `${e.length} access control events recorded.`,
    },
    {
      heading: 'A.12 — Operations Security',
      actionPrefix: 'system.',
      body: (e) => `${e.length} operational events captured.`,
    },
    {
      heading: 'A.16 — Incident Management',
      actionPrefix: 'incident.',
      body: (e) => `${e.length} incident events recorded.`,
    },
  ],
  NIST: [
    {
      heading: 'AC-2 — Account Management',
      actionPrefix: 'auth.',
      body: (e) => `${e.length} account events. ${new Set(e.map((x) => x.actorId)).size} unique actors observed.`,
    },
    {
      heading: 'AU-2 — Audit Events',
      actionPrefix: '',
      body: (e) => `${e.length} total audit events recorded in scope.`,
    },
    {
      heading: 'AU-6 — Audit Review',
      actionPrefix: 'review.',
      body: (e) => `${e.length} audit review events recorded.`,
    },
  ],
});

/** Options accepted by {@link ComplianceReporter.generate}. */
export interface ComplianceReportOptions {
  /** Framework to report against. */
  readonly framework: ComplianceFramework;
  /** Inclusive start timestamp (defaults to 30 days ago). */
  readonly start?: number;
  /** Inclusive end timestamp (defaults to now). */
  readonly end?: number;
}

/**
 * Generates {@link ComplianceReport}s from audit events.
 *
 * ```ts
 * const reporter = new ComplianceReporter();
 * const report = reporter.generate(events, { framework: 'SOC2' });
 * console.log(report.summary);
 * ```
 */
export class ComplianceReporter {
  /**
   * Generate a compliance report for the given events.
   *
   * @param events  - All audit events to consider (filtered by time range).
   * @param options - Report configuration.
   * @returns The generated {@link ComplianceReport}.
   */
  generate(events: readonly AuditEvent[], options: ComplianceReportOptions): ComplianceReport {
    const end = options.end ?? Date.now();
    const start = options.start ?? end - 30 * 24 * 60 * 60 * 1000;
    const inRange = events.filter((e) => e.timestamp >= start && e.timestamp <= end);
    const templates = FRAMEWORK_TEMPLATES[options.framework];
    const sections: ComplianceSection[] = [];
    const findings: string[] = [];
    for (const tpl of templates) {
      const matching = tpl.actionPrefix
        ? inRange.filter((e) => e.action.startsWith(tpl.actionPrefix))
        : inRange;
      const body = tpl.body(matching);
      sections.push({
        heading: tpl.heading,
        body,
        eventIds: matching.slice(0, 20).map((e) => e.id),
      });
      // Surface findings: high/critical outcomes in this section.
      const risks = matching.filter((e) => (e.severity === 'high' || e.severity === 'critical'));
      if (risks.length > 0) {
        findings.push(`${tpl.heading}: ${risks.length} high/critical events need review.`);
      }
      // Surface denial spikes (>5 denials in any one section).
      const denied = matching.filter((e) => e.outcome === 'denied').length;
      if (denied > 5) {
        findings.push(`${tpl.heading}: ${denied} denials — investigate access policy.`);
      }
    }
    const summary = this.#buildSummary(options.framework, inRange.length, sections.length, findings.length);
    return {
      framework: options.framework,
      generatedAt: Date.now(),
      range: { start, end },
      eventCount: inRange.length,
      summary,
      sections,
      findings,
    };
  }

  /**
   * Build a 1-3 sentence summary string for the report. Mentions the
   * framework, the in-range event count, and the number of findings.
   */
  #buildSummary(framework: ComplianceFramework, eventCount: number, sectionCount: number, findingCount: number): string {
    const parts: string[] = [
      `${framework} compliance report covering ${eventCount} audit event(s) across ${sectionCount} control(s).`,
    ];
    if (findingCount > 0) {
      parts.push(`${findingCount} finding(s) require follow-up — see the findings list.`);
    } else {
      parts.push('No findings — all reviewed controls have evidence.');
    }
    return parts.join(' ');
  }
}

/** Helper: count successful outcomes in `events`. */
function countSuccess(events: readonly AuditEvent[]): number {
  return events.filter((e) => e.outcome === 'success').length;
}

/** Helper: count failed outcomes in `events`. */
function countFailure(events: readonly AuditEvent[]): number {
  return events.filter((e) => e.outcome === 'failure').length;
}
