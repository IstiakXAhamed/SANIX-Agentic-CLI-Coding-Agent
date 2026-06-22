/**
 * @file runtimes/PythonRuntime.ts
 * @description Runtime adapter for Python 3.
 *
 * @packageDocumentation
 */

import type {
  RuntimeAdapter,
  RuntimeCommand,
  SandboxOptions,
} from '../types.js';

export const PY_STATE_MARKER = '__SANIX_STATE_BEGIN__';
export const PY_STATE_END = '__SANIX_STATE_END__';

/**
 * Runtime adapter for Python 3. Executes via `python3 -c <code>` (one-shot)
 * or `python3 -c <wrapped>` (REPL state preservation).
 */
export class PythonRuntime implements RuntimeAdapter {
  readonly runtime = 'python' as const;
  readonly defaultImage = 'python:3.12-slim';

  /**
   * @example
   * ```ts
   * const r = new PythonRuntime();
   * const cmd = r.buildExecCommand('print(1+1)', opts);
   * // → { command: ['python3', '-c', 'print(1+1)'] }
   * ```
   */
  buildExecCommand(code: string, _opts: SandboxOptions): RuntimeCommand {
    return { command: ['python3', '-c', code] };
  }

  buildSessionStartCommand(opts: SandboxOptions): RuntimeCommand {
    if (opts.isolation === 'docker') {
      return { command: ['tail', '-f', '/dev/null'] };
    }
    return { command: ['python3', '-c', 'import sys; sys.exit(0)'] };
  }

  buildSessionExecCommand(code: string, opts: SandboxOptions): RuntimeCommand {
    return this.buildExecCommand(code, opts);
  }

  wrapWithStateExtraction(code: string, _opts: SandboxOptions): string {
    // After user code, walk `dir()` and dump non-dunder, non-underscore globals
    // (excluding builtins) as JSON to stderr.
    const wrapped = `
${code}

import sys, json, builtins
__sanix_out = {}
__sanix_skip = set(dir(builtins))
try:
    for __k in dir():
        if __k.startswith('__') or __k in __sanix_skip or __k.startswith('_sanix') or __k.startswith('__sanix'):
            continue
        try:
            __v = locals()[__k]
            # Best-effort: only serializable values survive JSON.
            json.dumps(__v)
            __sanix_out[__k] = __v
        except Exception:
            __sanix_out[__k] = repr(__v)
except Exception as __e:
    __sanix_out = {"__error": str(__e)}
sys.stderr.write(${JSON.stringify(PY_STATE_MARKER)} + json.dumps(__sanix_out, default=repr) + ${JSON.stringify(PY_STATE_END)})
`;
    return wrapped;
  }

  buildStateRestoreCode(state: Record<string, unknown>, _opts: SandboxOptions): string {
    const entries = Object.entries(state);
    if (entries.length === 0) return '';
    // Restore each value. Use repr() so strings get quotes; numbers are bare.
    const lines = entries.map(([k, v]) => {
      const safe = k.replace(/[^A-Za-z0-9_]/g, '_');
      let lit: string;
      if (v === null || v === undefined) lit = 'None';
      else if (typeof v === 'string') lit = JSON.stringify(v);
      else if (typeof v === 'number') lit = String(v);
      else if (typeof v === 'boolean') lit = v ? 'True' : 'False';
      else lit = JSON.stringify(v); // objects/arrays — JSON is valid Python for nested dicts/lists
      return `try:\n    ${safe} = ${lit}\nexcept Exception:\n    pass`;
    });
    return lines.join('\n') + '\n';
  }

  extractState(stdout: string): Record<string, unknown> {
    const start = stdout.lastIndexOf(PY_STATE_MARKER);
    if (start < 0) return {};
    const end = stdout.indexOf(PY_STATE_END, start);
    if (end < 0) return {};
    const json = stdout.slice(start + PY_STATE_MARKER.length, end);
    try {
      return JSON.parse(json) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}
