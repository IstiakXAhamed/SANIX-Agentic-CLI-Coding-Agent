/**
 * @file runtimes/GoRuntime.ts
 * @description Runtime adapter for Go. Writes `main.go` to a temp file and
 * invokes `go run main.go`.
 *
 * @packageDocumentation
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  RuntimeAdapter,
  RuntimeCommand,
  SandboxOptions,
} from '../types.js';

export const GO_STATE_MARKER = '__SANIX_STATE_BEGIN__';
export const GO_STATE_END = '__SANIX_STATE_END__';

/**
 * Runtime adapter for Go. State preservation across REPL calls is best-effort
 * (Go has no global interpreter state — each `go run` is a fresh process);
 * we still implement state extraction so callers can inspect last-run output.
 */
export class GoRuntime implements RuntimeAdapter {
  readonly runtime = 'go' as const;
  readonly defaultImage = 'golang:1.22-alpine';

  /**
   * @example
   * ```ts
   * const r = new GoRuntime();
   * const cmd = r.buildExecCommand('package main\nimport "fmt"\nfunc main(){fmt.Println(1+1)}', opts);
   * // → writes /tmp/sanix-xxx/main.go, returns { command: ['go', 'run', '/tmp/.../main.go'], tmpFiles: [...] }
   * ```
   */
  buildExecCommand(code: string, opts: SandboxOptions): RuntimeCommand {
    const dir = opts.workDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sanix-go-'));
    const file = path.join(dir, 'main.go');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, code, 'utf8');
    return { command: ['go', 'run', file], tmpFiles: opts.workDir ? [] : [file] };
  }

  buildSessionStartCommand(opts: SandboxOptions): RuntimeCommand {
    if (opts.isolation === 'docker') {
      return { command: ['tail', '-f', '/dev/null'] };
    }
    return { command: ['go', 'version'] };
  }

  buildSessionExecCommand(code: string, opts: SandboxOptions): RuntimeCommand {
    return this.buildExecCommand(code, opts);
  }

  wrapWithStateExtraction(code: string, _opts: SandboxOptions): string {
    // For Go, there is no persistent process state. We just append a marker
    // to the code's main function output. (Caller is responsible for adding
    // fmt.Print(...) of any desired state.)
    if (!/func main\(\)/.test(code)) return code;
    return code.replace(
      /func main\(\) \{/,
      `func main() {
  defer func() {
    fmt.Println(${JSON.stringify(GO_STATE_MARKER)} + "{}" + ${JSON.stringify(GO_STATE_END)})
  }()`,
    );
  }

  buildStateRestoreCode(_state: Record<string, unknown>, _opts: SandboxOptions): string {
    // Go has no live interpreter state — state restoration is a no-op.
    return '';
  }

  extractState(stdout: string): Record<string, unknown> {
    const start = stdout.lastIndexOf(GO_STATE_MARKER);
    if (start < 0) return {};
    const end = stdout.indexOf(GO_STATE_END, start);
    if (end < 0) return {};
    try {
      return JSON.parse(stdout.slice(start + GO_STATE_MARKER.length, end)) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}
