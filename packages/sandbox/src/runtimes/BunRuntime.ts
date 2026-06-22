/**
 * @file runtimes/BunRuntime.ts
 * @description Runtime adapter for Bun.
 *
 * @packageDocumentation
 */

import type {
  RuntimeAdapter,
  RuntimeCommand,
  SandboxOptions,
} from '../types.js';

export const BUN_STATE_MARKER = '__SANIX_STATE_BEGIN__';
export const BUN_STATE_END = '__SANIX_STATE_END__';

/**
 * Runtime adapter for Bun. Uses `bun eval` (Bun ≥ 1.1) or `bun --eval`.
 */
export class BunRuntime implements RuntimeAdapter {
  readonly runtime = 'bun' as const;
  readonly defaultImage = 'oven/bun:latest';

  /**
   * @example
   * ```ts
   * const r = new BunRuntime();
   * const cmd = r.buildExecCommand('console.log(1+1)', opts);
   * // → { command: ['bun', 'eval', 'console.log(1+1)'] }
   * ```
   */
  buildExecCommand(code: string, _opts: SandboxOptions): RuntimeCommand {
    return { command: ['bun', 'eval', code] };
  }

  buildSessionStartCommand(opts: SandboxOptions): RuntimeCommand {
    if (opts.isolation === 'docker') {
      return { command: ['tail', '-f', '/dev/null'] };
    }
    return { command: ['bun', 'eval', 'process.exit(0)'] };
  }

  buildSessionExecCommand(code: string, opts: SandboxOptions): RuntimeCommand {
    return this.buildExecCommand(code, opts);
  }

  wrapWithStateExtraction(code: string, _opts: SandboxOptions): string {
    // Bun supports the same `globalThis` API as Node.
    return `${code}
;(function () {
  try {
    var builtin = new Set(Object.getOwnPropertyNames(globalThis));
    var out = {};
    for (var k of Object.keys(globalThis)) {
      if (builtin.has(k)) continue;
      try { out[k] = globalThis[k]; } catch (_) {}
    }
    process.stderr.write(${JSON.stringify(BUN_STATE_MARKER)} + JSON.stringify(out) + ${JSON.stringify(BUN_STATE_END)});
  } catch (e) {
    process.stderr.write(${JSON.stringify(BUN_STATE_MARKER)} + '{"__error":"' + (e && e.message) + '"}' + ${JSON.stringify(BUN_STATE_END)});
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
    const start = stdout.lastIndexOf(BUN_STATE_MARKER);
    if (start < 0) return {};
    const end = stdout.indexOf(BUN_STATE_END, start);
    if (end < 0) return {};
    try {
      return JSON.parse(stdout.slice(start + BUN_STATE_MARKER.length, end)) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}
