/**
 * @file BashTool — sandboxed bash execution with timeout + output capture.
 *
 * Hard-blocks dangerous command patterns (`rm -rf /`, `sudo rm`, etc.)
 * before spawning. Streams stdout/stderr via the ToolContext `emit` hook.
 */
import { spawn } from 'node:child_process';
import {
  type SanixTool,
  type ToolContext,
  type ToolResult,
  type ToolPermission,
  z,
  resolvePath,
  okResult,
  errResult,
} from '../types.js';

/** Input schema for the `bash` tool. */
export const BashInputSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().optional().describe('Working directory (defaults to ctx.cwd).'),
  timeoutMs: z.number().int().positive().max(300_000).default(30_000),
  env: z
    .record(z.string(), z.string())
    .optional()
    .describe('Additional env vars to merge into the child process.'),
});

/** Output schema for the `bash` tool. */
export const BashOutputSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int(),
  signal: z.string().optional(),
  durationMs: z.number().int(),
});

export type BashInput = z.infer<typeof BashInputSchema>;
export type BashOutput = z.infer<typeof BashOutputSchema>;

/**
 * Patterns that are always blocked — even if quoted/escaped loosely.
 * These are intentionally conservative; the agent can rewrite around them.
 */
const BLOCKED_PATTERNS: Array<{ regex: RegExp; reason: string }> = [
  { regex: /\brm\s+-[rfRF]+\s+\/(?:\s|$)/, reason: 'rm -rf / is blocked' },
  { regex: /\brm\s+-[rfRF]+\s+\/\*/, reason: 'rm -rf /* is blocked' },
  { regex: /\bsudo\s+rm\b/, reason: 'sudo rm is blocked' },
  { regex: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/, reason: 'fork bomb is blocked' },
  { regex: /\bmkfs(\.\w+)?\s+\//, reason: 'mkfs on a device is blocked' },
  { regex: /\bdd\s+.*of=\/dev\/(?!null)/, reason: 'dd to a block device is blocked' },
  { regex: /\b>\s*\/dev\/sd[a-z]/, reason: 'writing to /dev/sd* is blocked' },
  { regex: /\bchmod\s+-R\s+777\s+\/(?:\s|$)/, reason: 'chmod -R 777 / is blocked' },
];

/** Check a command against the blocklist; returns the first match or null. */
function findBlocked(command: string): { reason: string } | null {
  for (const rule of BLOCKED_PATTERNS) {
    if (rule.regex.test(command)) return { reason: rule.reason };
  }
  return null;
}

/**
 * BashTool — run a bash command with timeout + stdout/stderr capture.
 *
 * @example
 * ```ts
 * const res = await new BashTool().execute(
 *   { command: 'ls -la', timeoutMs: 5000 },
 *   ctx,
 * );
 * ```
 */
export class BashTool implements SanixTool<BashInput, BashOutput> {
  readonly name = 'bash';
  readonly description =
    'Execute a bash command with a timeout. Sandboxed: blocks rm -rf /, sudo rm, fork bombs, mkfs, dd to devices. Streams stdout/stderr via context.emit.';
  readonly inputSchema = BashInputSchema;
  readonly outputSchema = BashOutputSchema;
  readonly permissions: ToolPermission[] = ['shell:exec'];
  readonly maxTokensInput = 4_000;
  readonly maxTokensOutput = 32_000;

  async execute(
    input: BashInput,
    context: ToolContext,
  ): Promise<ToolResult<BashOutput>> {
    const start = Date.now();

    const blocked = findBlocked(input.command);
    if (blocked) {
      return errResult<BashOutput>(
        `bash: command blocked — ${blocked.reason}`,
        Date.now() - start,
      );
    }

    const cwd = input.cwd ? resolvePath(input.cwd, context.cwd) : context.cwd;
    const env = { ...process.env, ...input.env };

    return await new Promise<ToolResult<BashOutput>>((resolve) => {
      const child = spawn('bash', ['-c', input.command], {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let settled = false;
      let timeoutHandle: NodeJS.Timeout | undefined;
      const MAX_STREAM_BYTES = 2 * 1024 * 1024; // 2MB per stream

      const finish = (out: ToolResult<BashOutput>) => {
        if (settled) return;
        settled = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (context.signal) context.signal.removeEventListener('abort', onAbort);
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        resolve(out);
      };

      timeoutHandle = setTimeout(() => {
        const partial: BashOutput = {
          stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
          stderr: Buffer.concat(stderrChunks).toString('utf-8') +
            '\n[timeout: process killed after ' + input.timeoutMs + 'ms]',
          exitCode: -1,
          signal: 'SIGKILL',
          durationMs: Date.now() - start,
        };
        finish(errResult<BashOutput>('bash: timeout exceeded', Date.now() - start, partial));
      }, input.timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => {
        const remaining = MAX_STREAM_BYTES - stdoutChunks.reduce((a, c) => a + c.length, 0);
        if (remaining > 0) stdoutChunks.push(chunk.subarray(0, remaining));
        context.emit?.('bash:stdout', { chunk: chunk.toString('utf-8') });
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        const remaining = MAX_STREAM_BYTES - stderrChunks.reduce((a, c) => a + c.length, 0);
        if (remaining > 0) stderrChunks.push(chunk.subarray(0, remaining));
        context.emit?.('bash:stderr', { chunk: chunk.toString('utf-8') });
      });

      // Propagate caller abort.
      const onAbort = () => {
        const partial: BashOutput = {
          stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
          stderr: Buffer.concat(stderrChunks).toString('utf-8') + '\n[aborted by caller]',
          exitCode: -1,
          signal: 'SIGTERM',
          durationMs: Date.now() - start,
        };
        finish(errResult<BashOutput>('bash: aborted', Date.now() - start, partial));
      };
      if (context.signal) {
        if (context.signal.aborted) onAbort();
        else context.signal.addEventListener('abort', onAbort, { once: true });
      }

      child.on('error', (err) => {
        finish(
          errResult<BashOutput>(
            `bash: spawn error — ${err.message}`,
            Date.now() - start,
            {
              stdout: '',
              stderr: err.message,
              exitCode: -1,
              durationMs: Date.now() - start,
            },
          ),
        );
      });

      child.on('close', (code, signal) => {
        const out: BashOutput = {
          stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
          stderr: Buffer.concat(stderrChunks).toString('utf-8'),
          exitCode: code ?? -1,
          signal: signal ?? undefined,
          durationMs: Date.now() - start,
        };
        if (code === 0) {
          finish(okResult(out, Date.now() - start));
        } else {
          finish(
            errResult<BashOutput>(
              `bash: non-zero exit code ${code ?? '?'}${signal ? ` (signal ${signal})` : ''}`,
              Date.now() - start,
              out,
            ),
          );
        }
      });
    });
  }

  formatForContext(result: BashOutput): string {
    const stdout = trimForContext(result.stdout, 4000);
    const stderr = trimForContext(result.stderr, 2000);
    const sig = result.signal ? ` signal=${result.signal}` : '';
    return `exit=${result.exitCode}${sig} (${result.durationMs}ms)\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`;
  }
}

function trimForContext(s: string, max: number): string {
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return `${s.slice(0, half)}\n…[truncated ${s.length - max} bytes]…\n${s.slice(-half)}`;
}
