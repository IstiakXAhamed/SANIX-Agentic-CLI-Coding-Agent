/**
 * @file runtimes/CustomRuntime.ts
 * @description Runtime adapter for arbitrary commands. Uses the
 * `customCommand` field from {@link SandboxOptions} — supports `{file}`
 * and `{code}` placeholders.
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

export const CUSTOM_STATE_MARKER = '__SANIX_STATE_BEGIN__';
export const CUSTOM_STATE_END = '__SANIX_STATE_END__';

/**
 * Runtime adapter for arbitrary commands. The `opts.customCommand` template
 * supports two placeholders:
 *   - `{file}` — replaced with a path to a temp file containing the code.
 *   - `{code}` — replaced with the (shell-escaped) code inline.
 *
 * If neither placeholder is present, the code is piped via stdin.
 *
 * @example
 * ```ts
 * const opts: SandboxOptions = {
 *   runtime: 'custom',
 *   isolation: 'process',
 *   timeoutMs: 5000,
 *   customCommand: 'ruby {file}',
 * };
 * ```
 */
export class CustomRuntime implements RuntimeAdapter {
  readonly runtime = 'custom' as const;
  readonly defaultImage = 'alpine:latest';

  buildExecCommand(code: string, opts: SandboxOptions): RuntimeCommand {
    const tmpl = opts.customCommand;
    if (!tmpl) {
      throw new Error("CustomRuntime: opts.customCommand is required when runtime='custom'");
    }
    if (tmpl.includes('{file}')) {
      const dir = opts.workDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sanix-custom-'));
      const file = path.join(dir, 'code.txt');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, code, 'utf8');
      const filled = tmpl.replace(/\{file\}/g, file);
      return {
        command: ['sh', '-c', filled],
        tmpFiles: opts.workDir ? [] : [file],
      };
    }
    if (tmpl.includes('{code}')) {
      // Pass code as a single shell arg.
      const filled = tmpl.replace(/\{code\}/g, `'${code.replace(/'/g, "'\\''")}'`);
      return { command: ['sh', '-c', filled] };
    }
    // No placeholder → pipe via stdin.
    return { command: ['sh', '-c', tmpl], stdin: code };
  }

  buildSessionStartCommand(opts: SandboxOptions): RuntimeCommand {
    if (opts.isolation === 'docker') {
      return { command: ['tail', '-f', '/dev/null'] };
    }
    if (!opts.customCommand) {
      throw new Error("CustomRuntime: opts.customCommand is required");
    }
    return { command: ['sh', '-c', opts.customCommand.split(' ')[0] + ' --version 2>&1 || true'] };
  }

  buildSessionExecCommand(code: string, opts: SandboxOptions): RuntimeCommand {
    return this.buildExecCommand(code, opts);
  }

  wrapWithStateExtraction(code: string, _opts: SandboxOptions): string {
    // No generic way to extract state from an arbitrary runtime — pass through.
    return code;
  }

  buildStateRestoreCode(_state: Record<string, unknown>, _opts: SandboxOptions): string {
    return '';
  }

  extractState(_stdout: string): Record<string, unknown> {
    return {};
  }
}
