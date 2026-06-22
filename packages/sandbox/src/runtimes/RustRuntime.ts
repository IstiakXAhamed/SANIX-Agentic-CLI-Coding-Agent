/**
 * @file runtimes/RustRuntime.ts
 * @description Runtime adapter for Rust. Writes `main.rs`, compiles with
 * `rustc`, then runs the resulting binary.
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

export const RUST_STATE_MARKER = '__SANIX_STATE_BEGIN__';
export const RUST_STATE_END = '__SANIX_STATE_END__';

/**
 * Runtime adapter for Rust. Each execution compiles a fresh binary — there is
 * no persistent interpreter state. State extraction is best-effort (returns
 * whatever the program printed between the markers).
 */
export class RustRuntime implements RuntimeAdapter {
  readonly runtime = 'rust' as const;
  readonly defaultImage = 'rust:1.78-slim';

  /**
   * @example
   * ```ts
   * const r = new RustRuntime();
   * const cmd = r.buildExecCommand('fn main(){ println!(1+1); }', opts);
   * // → writes /tmp/sanix-rust-xxx/main.rs, returns
   * //   { command: ['sh','-c','rustc main.rs -o main && ./main'], tmpFiles: [...] }
   * ```
   */
  buildExecCommand(code: string, opts: SandboxOptions): RuntimeCommand {
    const dir = opts.workDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sanix-rust-'));
    const file = path.join(dir, 'main.rs');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, code, 'utf8');
    // Compile + run in the workDir so relative `./main` resolves.
    return {
      command: ['sh', '-c', `cd "${dir}" && rustc main.rs -o main && ./main`],
      tmpFiles: opts.workDir ? [] : [file, path.join(dir, 'main')],
    };
  }

  buildSessionStartCommand(opts: SandboxOptions): RuntimeCommand {
    if (opts.isolation === 'docker') {
      return { command: ['tail', '-f', '/dev/null'] };
    }
    return { command: ['rustc', '--version'] };
  }

  buildSessionExecCommand(code: string, opts: SandboxOptions): RuntimeCommand {
    return this.buildExecCommand(code, opts);
  }

  wrapWithStateExtraction(code: string, _opts: SandboxOptions): string {
    if (!/fn main\(\)/.test(code)) return code;
    return code.replace(
      /fn main\(\) \{/,
      `fn main() {
    print!("${RUST_STATE_MARKER}{}${RUST_STATE_END}", "{}");`,
    );
  }

  buildStateRestoreCode(_state: Record<string, unknown>, _opts: SandboxOptions): string {
    return '';
  }

  extractState(stdout: string): Record<string, unknown> {
    const start = stdout.lastIndexOf(RUST_STATE_MARKER);
    if (start < 0) return {};
    const end = stdout.indexOf(RUST_STATE_END, start);
    if (end < 0) return {};
    try {
      return JSON.parse(stdout.slice(start + RUST_STATE_MARKER.length, end)) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}
