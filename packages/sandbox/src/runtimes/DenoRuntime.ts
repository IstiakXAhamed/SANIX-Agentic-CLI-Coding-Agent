/**
 * @file runtimes/DenoRuntime.ts
 * @description Runtime adapter for Deno.
 *
 * @packageDocumentation
 */

import type {
  RuntimeAdapter,
  RuntimeCommand,
  SandboxOptions,
} from '../types.js';

export const DENO_STATE_MARKER = '__SANIX_STATE_BEGIN__';
export const DENO_STATE_END = '__SANIX_STATE_END__';

/**
 * Runtime adapter for Deno. Uses `deno eval` with `--allow-all` (sandbox
 * isolation provides the actual security boundary).
 */
export class DenoRuntime implements RuntimeAdapter {
  readonly runtime = 'deno' as const;
  readonly defaultImage = 'denoland/deno:latest';

  /**
   * @example
   * ```ts
   * const r = new DenoRuntime();
   * const cmd = r.buildExecCommand('console.log(1+1)', opts);
   * // → { command: ['deno', 'eval', 'console.log(1+1)'] }
   * ```
   */
  buildExecCommand(code: string, _opts: SandboxOptions): RuntimeCommand {
    return { command: ['deno', 'eval', code] };
  }

  buildSessionStartCommand(opts: SandboxOptions): RuntimeCommand {
    if (opts.isolation === 'docker') {
      return { command: ['tail', '-f', '/dev/null'] };
    }
    return { command: ['deno', 'eval', 'Deno.exit(0)'] };
  }

  buildSessionExecCommand(code: string, opts: SandboxOptions): RuntimeCommand {
    return this.buildExecCommand(code, opts);
  }

  wrapWithStateExtraction(code: string, _opts: SandboxOptions): string {
    return `${code}
try {
  const __skip = new Set(Object.getOwnPropertyNames(globalThis));
  const __out = {};
  for (const __k of Object.keys(globalThis)) {
    if (__skip.has(__k)) continue;
    try { __out[__k] = globalThis[__k]; } catch (_) {}
  }
  const __enc = new TextEncoder();
  Deno.stderr.writeSync(__enc.encode(${JSON.stringify(DENO_STATE_MARKER)} + JSON.stringify(__out) + ${JSON.stringify(DENO_STATE_END)}));
} catch (__e) {
  Deno.stderr.writeSync(new TextEncoder().encode(${JSON.stringify(DENO_STATE_MARKER)} + '{"__error":"' + String(__e && __e.message) + '"}' + ${JSON.stringify(DENO_STATE_END)}));
}
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
    const start = stdout.lastIndexOf(DENO_STATE_MARKER);
    if (start < 0) return {};
    const end = stdout.indexOf(DENO_STATE_END, start);
    if (end < 0) return {};
    try {
      return JSON.parse(stdout.slice(start + DENO_STATE_MARKER.length, end)) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}
