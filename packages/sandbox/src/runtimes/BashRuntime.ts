/**
 * @file runtimes/BashRuntime.ts
 * @description Runtime adapter for Bash.
 *
 * @packageDocumentation
 */

import type {
  RuntimeAdapter,
  RuntimeCommand,
  SandboxOptions,
} from '../types.js';

export const BASH_STATE_MARKER = '__SANIX_STATE_BEGIN__';
export const BASH_STATE_END = '__SANIX_STATE_END__';

/**
 * Runtime adapter for Bash. Executed via `bash -c <code>`. State
 * preservation captures shell variables (lowercase, non-readonly) defined
 * during the call.
 */
export class BashRuntime implements RuntimeAdapter {
  readonly runtime = 'bash' as const;
  readonly defaultImage = 'alpine:latest';

  /**
   * @example
   * ```ts
   * const r = new BashRuntime();
   * const cmd = r.buildExecCommand('echo hello', opts);
   * // → { command: ['bash','-c','echo hello'] }
   * ```
   */
  buildExecCommand(code: string, _opts: SandboxOptions): RuntimeCommand {
    return { command: ['bash', '-c', code] };
  }

  buildSessionStartCommand(opts: SandboxOptions): RuntimeCommand {
    if (opts.isolation === 'docker') {
      return { command: ['tail', '-f', '/dev/null'] };
    }
    return { command: ['bash', '-c', 'exit 0'] };
  }

  buildSessionExecCommand(code: string, opts: SandboxOptions): RuntimeCommand {
    return this.buildExecCommand(code, opts);
  }

  wrapWithStateExtraction(code: string, _opts: SandboxOptions): string {
    // After user code, dump shell variables (not env vars) as JSON to stderr.
    // NOTE: built with string concatenation (not template literals) so the
    // bash `${var}` syntax is NOT interpreted by JS.
    return code + '\n' +
'{\n' +
'  __out="{"\n' +
'  __first=1\n' +
'  for __v in $(compgen -v 2>/dev/null | grep -v "^_" | sort -u); do\n' +
'    if [ -n "${__v+x}" ]; then\n' +
'      eval "__val=\\"${$__v}\\"" 2>/dev/null || continue\n' +
'      case "$__v" in\n' +
'        PWD|SHLVL|OLDPWD|IFS|OPTIND|PS1|PS2|PS3|PS4|RANDOM|SECONDS|LINENO|BASHPID|BASH|BASH_VERSION|BASH_VERSINFO|UID|EUID|PPID|SHELL|HOME|PATH|TERM|HOSTNAME|HOSTTYPE|MACHTYPE|OSTYPE|_) continue ;;\n' +
'      esac\n' +
'      if [ $__first -eq 1 ]; then __first=0; else __out="$__out,"; fi\n' +
'      __esc=$(printf "%s" "$__val" | sed "s/\\\\\\\\/\\\\\\\\\\\\\\\\/g; s/\\"/\\\\\\\\\\"/g")\n' +
'      __out="$__out\\"$__v\\":\\"$__esc\\""\n' +
'    fi\n' +
'  done\n' +
'  __out="$__out}"\n' +
'  printf %s%s%s ' + JSON.stringify(BASH_STATE_MARKER) + ' "$__out" ' + JSON.stringify(BASH_STATE_END) + ' >&2\n' +
'} 2>/dev/null || true\n';
  }

  buildStateRestoreCode(state: Record<string, unknown>, _opts: SandboxOptions): string {
    const entries = Object.entries(state);
    if (entries.length === 0) return '';
    const lines = entries.map(([k, v]) => {
      const safe = k.replace(/[^A-Za-z0-9_]/g, '_');
      const lit = typeof v === 'string' ? v.replace(/'/g, "'\\''") : JSON.stringify(v);
      return `${safe}='${lit}'`;
    });
    return lines.join('\n') + '\n';
  }

  extractState(stdout: string): Record<string, unknown> {
    const start = stdout.lastIndexOf(BASH_STATE_MARKER);
    if (start < 0) return {};
    const end = stdout.indexOf(BASH_STATE_END, start);
    if (end < 0) return {};
    try {
      return JSON.parse(stdout.slice(start + BASH_STATE_MARKER.length, end)) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}
