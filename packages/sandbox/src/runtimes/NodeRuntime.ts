/**
 * @file runtimes/NodeRuntime.ts
 * @description Runtime adapter for Node.js (JavaScript / TypeScript via `tsx`).
 *
 * @packageDocumentation
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type {
  RuntimeAdapter,
  RuntimeCommand,
  SandboxOptions,
} from '../types.js';

/**
 * Marker the runtime prints (via `console.error`) right before the
 * JSON-serialized state snapshot. The marker is unique enough that it will
 * not appear in user output by accident.
 */
export const NODE_STATE_MARKER = '__SANIX_STATE_BEGIN__';
/** Marker placed after the JSON state blob. */
export const NODE_STATE_END = '__SANIX_STATE_END__';

/**
 * Runtime adapter for Node.js. Executes JS directly via `node --eval`; for
 * TypeScript source, attempts to use `tsx` (if installed) — otherwise falls
 * back to stripping types with a regex.
 */
export class NodeRuntime implements RuntimeAdapter {
  readonly runtime = 'node' as const;
  readonly defaultImage = 'node:20-slim';

  /**
   * @example
   * ```ts
   * const r = new NodeRuntime();
   * const cmd = r.buildExecCommand('console.log(1+1)', opts);
   * // → { command: ['node', '--eval', 'console.log(1+1)'] }
   * ```
   */
  buildExecCommand(code: string, opts: SandboxOptions): RuntimeCommand {
    const isTs = /\.(ts|mts|cts|tsx)$/.test(opts.workDir ?? '') || /\b(import|export)\b/.test(code);
    if (isTs) {
      // Try tsx if available; fall back to node with --experimental-strip-types (Node 22+).
      const bin = this.findTsx() ?? 'node';
      if (bin === 'tsx') {
        return { command: ['tsx', '--eval', code] };
      }
      return { command: ['node', '--experimental-strip-types', '--eval', code] };
    }
    return { command: ['node', '--eval', code] };
  }

  buildSessionStartCommand(opts: SandboxOptions): RuntimeCommand {
    // For docker: keep a container alive running `tail -f /dev/null` so
    // we can `docker exec` into it later.
    if (opts.isolation === 'docker') {
      return { command: ['tail', '-f', '/dev/null'] };
    }
    // For process isolation: we don't keep a real Node REPL alive (parsing
    // its REPL output is fragile). Instead we re-execute from scratch each
    // time, with state restoration prepended. The "session start" is a no-op
    // — we return a trivial command that exits immediately.
    return { command: ['node', '--eval', 'process.exit(0)'] };
  }

  buildSessionExecCommand(code: string, opts: SandboxOptions): RuntimeCommand {
    // For docker: `docker exec <container> node --eval <code>`.
    // For process: same as one-shot — SandboxManager handles state.
    return this.buildExecCommand(code, opts);
  }

  wrapWithStateExtraction(code: string, _opts: SandboxOptions): string {
    // After user code runs, walk `globalThis` and serialize any non-built-in
    // enumerable props. Avoids importing anything (works in bare node).
    return `${code}
;(function () {
  try {
    var builtin = new Set(Object.getOwnPropertyNames(globalThis));
    var out = {};
    for (var k of Object.keys(globalThis)) {
      if (builtin.has(k)) continue;
      try {
        out[k] = globalThis[k];
      } catch (_) { /* skip unreadable */ }
    }
    process.stderr.write(${JSON.stringify(NODE_STATE_MARKER)} + JSON.stringify(out) + ${JSON.stringify(NODE_STATE_END)});
  } catch (e) {
    process.stderr.write(${JSON.stringify(NODE_STATE_MARKER)} + '{"__error":"' + (e && e.message) + '"}' + ${JSON.stringify(NODE_STATE_END)});
  }
})();
`;
  }

  buildStateRestoreCode(state: Record<string, unknown>, _opts: SandboxOptions): string {
    const entries = Object.entries(state);
    if (entries.length === 0) return '';
    const lines = entries.map(([k, v]) => {
      const safe = k.replace(/[^A-Za-z0-9_$]/g, '_');
      return `try { globalThis[${JSON.stringify(k)}] = ${JSON.stringify(v)}; } catch(_) {} var ${safe} = globalThis[${JSON.stringify(k)}];`;
    });
    return lines.join('\n') + '\n';
  }

  extractState(stdout: string): Record<string, unknown> {
    const start = stdout.lastIndexOf(NODE_STATE_MARKER);
    if (start < 0) return {};
    const end = stdout.indexOf(NODE_STATE_END, start);
    if (end < 0) return {};
    const json = stdout.slice(start + NODE_STATE_MARKER.length, end);
    try {
      const parsed = JSON.parse(json) as Record<string, unknown>;
      return parsed;
    } catch {
      return {};
    }
  }

  private findTsx(): string | null {
    // Check if tsx is resolvable from the host. Cheap & sync.
    try {
      // Prefer tsx for TS code; only set when not in docker (the docker image
      // won't have tsx installed unless explicitly added).
      const candidates = [
        path.join(process.cwd(), 'node_modules', '.bin', 'tsx'),
        path.join(os.homedir(), '.npm-global', 'bin', 'tsx'),
      ];
      for (const c of candidates) {
        if (fs.existsSync(c)) return 'tsx';
      }
      return null;
    } catch {
      return null;
    }
  }
}
