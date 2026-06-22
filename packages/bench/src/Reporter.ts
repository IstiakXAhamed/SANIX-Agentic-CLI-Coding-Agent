/**
 * @file Reporter.ts
 * @description Pretty-prints benchmark results in three formats: ASCII
 * table (for terminal output), JSON (for CI ingestion), and Markdown
 * (for PR comments). Also provides a `compare()` function that diffs
 * two runs and reports regressions / improvements.
 *
 * @packageDocumentation
 */

import type { BenchmarkResult } from './types.js';

/**
 * Format benchmark results as an ASCII table.
 *
 * @example
 * ```text
 * BENCHMARK          PROMPTS  PASS  FAIL  RATE    AVG COST   AVG DUR
 * basic-reasoning          10     9     1   90%   $0.0012     342ms
 * basic-coding             10     7     3   70%   $0.0045    1280ms
 * ...
 * ```
 */
export function formatReport(results: BenchmarkResult[]): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(
    pad('BENCHMARK', 22) +
      pad('PROMPTS', 8) +
      pad('PASS', 6) +
      pad('FAIL', 6) +
      pad('RATE', 6) +
      pad('AVG COST', 12) +
      pad('AVG DUR', 10),
  );
  lines.push('-'.repeat(70));
  for (const r of results) {
    const total = r.summary.passed + r.summary.failed;
    const rate = (r.summary.passRate * 100).toFixed(0) + '%';
    const cost = r.summary.avgCostUsd > 0 ? `$${r.summary.avgCostUsd.toFixed(4)}` : '-';
    const dur = formatDuration(r.summary.avgDurationMs);
    lines.push(
      pad(r.benchmarkId, 22) +
        pad(String(total), 8) +
        pad(String(r.summary.passed), 6) +
        pad(String(r.summary.failed), 6) +
        pad(rate, 6) +
        pad(cost, 12) +
        pad(dur, 10),
    );
  }
  // Totals row.
  const totalPrompts = results.reduce(
    (s, r) => s + r.summary.passed + r.summary.failed,
    0,
  );
  const totalPass = results.reduce((s, r) => s + r.summary.passed, 0);
  const totalFail = results.reduce((s, r) => s + r.summary.failed, 0);
  const totalCost = results.reduce((s, r) => s + r.totalCostUsd, 0);
  const totalDur = results.reduce((s, r) => s + r.durationMs, 0);
  const overallRate = totalPrompts > 0 ? ((totalPass / totalPrompts) * 100).toFixed(0) + '%' : '-';
  lines.push('-'.repeat(70));
  lines.push(
    pad('TOTAL', 22) +
      pad(String(totalPrompts), 8) +
      pad(String(totalPass), 6) +
      pad(String(totalFail), 6) +
      pad(overallRate, 6) +
      pad(totalCost > 0 ? `$${totalCost.toFixed(4)}` : '-', 12) +
      pad(formatDuration(totalDur), 10),
  );
  lines.push('');
  return lines.join('\n');
}

/**
 * Format benchmark results as a JSON string.
 */
export function formatJSON(results: BenchmarkResult[]): string {
  return JSON.stringify(results, null, 2);
}

/**
 * Format benchmark results as a Markdown table — suitable for posting
 * as a PR comment.
 *
 * @example
 * ```markdown
 * | Benchmark | Prompts | Pass | Fail | Rate | Avg Cost | Avg Dur |
 * |---|---:|---:|---:|---:|---:|---:|
 * | basic-reasoning | 10 | 9 | 1 | 90% | $0.0012 | 342ms |
 * ```
 */
export function formatMarkdown(results: BenchmarkResult[]): string {
  const lines: string[] = [];
  lines.push('| Benchmark | Prompts | Pass | Fail | Rate | Avg Cost | Avg Dur |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|');
  for (const r of results) {
    const total = r.summary.passed + r.summary.failed;
    const rate = (r.summary.passRate * 100).toFixed(0) + '%';
    const cost = r.summary.avgCostUsd > 0 ? `$${r.summary.avgCostUsd.toFixed(4)}` : '-';
    const dur = formatDuration(r.summary.avgDurationMs);
    lines.push(
      `| ${r.benchmarkId} | ${total} | ${r.summary.passed} | ${r.summary.failed} | ${rate} | ${cost} | ${dur} |`,
    );
  }
  return lines.join('\n');
}

/**
 * Compare two runs (baseline vs current) and report regressions and
 * improvements. A benchmark is considered:
 *   - **Improved** if its pass-rate went up by >= 5pp.
 *   - **Regressed** if its pass-rate went down by >= 5pp.
 *   - Otherwise unchanged.
 *
 * @returns A multi-line ASCII string summarizing the diff.
 */
export function compare(
  baseline: BenchmarkResult[],
  current: BenchmarkResult[],
): string {
  const baseMap = new Map(baseline.map((r) => [r.benchmarkId, r]));
  const curMap = new Map(current.map((r) => [r.benchmarkId, r]));
  const allIds = new Set([...baseMap.keys(), ...curMap.keys()]);

  const lines: string[] = [];
  lines.push('');
  lines.push('Benchmark comparison (baseline → current):');
  lines.push('-'.repeat(70));
  lines.push(
    pad('BENCHMARK', 22) +
      pad('BASE', 8) +
      pad('CUR', 8) +
      pad('DELTA', 10) +
      pad('STATUS', 12),
  );
  lines.push('-'.repeat(70));

  let improved = 0;
  let regressed = 0;
  let unchanged = 0;

  for (const id of allIds) {
    const b = baseMap.get(id);
    const c = curMap.get(id);
    const baseRate = b ? b.summary.passRate : 0;
    const curRate = c ? c.summary.passRate : 0;
    const deltaPct = (curRate - baseRate) * 100;
    let status: string;
    if (deltaPct >= 5) {
      status = '↑ improved';
      improved++;
    } else if (deltaPct <= -5) {
      status = '↓ regressed';
      regressed++;
    } else {
      status = '= unchanged';
      unchanged++;
    }
    lines.push(
      pad(id, 22) +
        pad(`${(baseRate * 100).toFixed(0)}%`, 8) +
        pad(`${(curRate * 100).toFixed(0)}%`, 8) +
        pad(`${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(0)}pp`, 10) +
        pad(status, 12),
    );
  }
  lines.push('-'.repeat(70));
  lines.push(
    `Summary: ${improved} improved, ${regressed} regressed, ${unchanged} unchanged.`,
  );
  lines.push('');
  return lines.join('\n');
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Pad / truncate a string to a fixed width (left-aligned).
 */
function pad(s: string, width: number): string {
  if (s.length > width) return s.slice(0, width - 1) + '…';
  return s + ' '.repeat(width - s.length);
}

/**
 * Format a duration in ms as a human-readable string.
 */
function formatDuration(ms: number): string {
  if (ms < 1) return `${ms.toFixed(2)}ms`;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
