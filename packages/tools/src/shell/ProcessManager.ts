/**
 * @file ProcessManager — long-running process management.
 *
 * Exposes two tools:
 *   - `start_process` — spawn a detached process, register it, return pid.
 *   - `kill_process`  — terminate a previously-started process by pid.
 *
 * The process registry is a module-level singleton so both tools share it
 * (and so the agent loop can introspect it later).
 */
import { spawn, type ChildProcess } from 'node:child_process';
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

/** A tracked long-running process. */
export interface TrackedProcess {
  pid: number;
  handle: string;
  command: string;
  startedAt: number;
  child: ChildProcess;
}

/** Module-level registry shared by StartProcessTool and KillProcessTool. */
class ProcessRegistry {
  private byPid = new Map<number, TrackedProcess>();
  private byHandle = new Map<string, TrackedProcess>();

  register(proc: TrackedProcess): void {
    this.byPid.set(proc.pid, proc);
    this.byHandle.set(proc.handle, proc);
    // Auto-remove when the process exits.
    proc.child.on('exit', () => {
      this.byPid.delete(proc.pid);
      this.byHandle.delete(proc.handle);
    });
  }

  getByPid(pid: number): TrackedProcess | undefined {
    return this.byPid.get(pid);
  }

  getByHandle(handle: string): TrackedProcess | undefined {
    return this.byHandle.get(handle);
  }

  list(): TrackedProcess[] {
    return [...this.byPid.values()];
  }

  remove(pid: number): void {
    const p = this.byPid.get(pid);
    if (!p) return;
    this.byPid.delete(pid);
    this.byHandle.delete(p.handle);
  }
}

/** The singleton registry. */
export const processRegistry = new ProcessRegistry();

// ---------- start_process ----------

/** Input schema for `start_process`. */
export const StartProcessInputSchema = z.object({
  command: z.string().min(1).describe('Executable to run.'),
  args: z.array(z.string()).default([]).describe('Arguments to pass.'),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  detached: z.boolean().default(false),
});

/** Output schema for `start_process`. */
export const StartProcessOutputSchema = z.object({
  pid: z.number().int(),
  handle: z.string(),
  command: z.string(),
  startedAt: z.number().int(),
});

export type StartProcessInput = z.infer<typeof StartProcessInputSchema>;
export type StartProcessOutput = z.infer<typeof StartProcessOutputSchema>;

/**
 * StartProcessTool — spawn a long-running process and register it.
 *
 * @example
 * ```ts
 * const res = await new StartProcessTool().execute(
 *   { command: 'npm', args: ['run', 'dev'] },
 *   ctx,
 * );
 * ```
 */
export class StartProcessTool
  implements SanixTool<StartProcessInput, StartProcessOutput>
{
  readonly name = 'start_process';
  readonly description =
    'Spawn a long-running child process and register it for later management. Returns pid + handle.';
  readonly inputSchema = StartProcessInputSchema;
  readonly outputSchema = StartProcessOutputSchema;
  readonly permissions: ToolPermission[] = ['shell:exec'];
  readonly maxTokensInput = 1_000;
  readonly maxTokensOutput = 256;

  async execute(
    input: StartProcessInput,
    context: ToolContext,
  ): Promise<ToolResult<StartProcessOutput>> {
    const start = Date.now();
    const cwd = input.cwd ? resolvePath(input.cwd, context.cwd) : context.cwd;
    const env = { ...process.env, ...input.env };
    try {
      const child = spawn(input.command, input.args, {
        cwd,
        env,
        detached: input.detached,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (typeof child.pid !== 'number') {
        return errResult<StartProcessOutput>(
          'start_process: child did not get a pid',
          Date.now() - start,
        );
      }
      // Forward output streams via context events.
      child.stdout?.on('data', (chunk: Buffer) => {
        context.emit?.('process:stdout', {
          pid: child.pid,
          chunk: chunk.toString('utf-8'),
        });
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        context.emit?.('process:stderr', {
          pid: child.pid,
          chunk: chunk.toString('utf-8'),
        });
      });

      const handle = `proc_${child.pid}_${Date.now().toString(36)}`;
      const tracked: TrackedProcess = {
        pid: child.pid,
        handle,
        command: [input.command, ...input.args].join(' '),
        startedAt: Date.now(),
        child,
      };
      processRegistry.register(tracked);

      if (input.detached) {
        try {
          child.unref();
        } catch {
          /* ignore */
        }
      }

      return okResult<StartProcessOutput>(
        {
          pid: child.pid,
          handle,
          command: tracked.command,
          startedAt: tracked.startedAt,
        },
        Date.now() - start,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errResult<StartProcessOutput>(
        `start_process failed: ${msg}`,
        Date.now() - start,
      );
    }
  }

  formatForContext(result: StartProcessOutput): string {
    return `started pid=${result.pid} (${result.command}) handle=${result.handle}`;
  }
}

// ---------- kill_process ----------

/** Input schema for `kill_process`. */
export const KillProcessInputSchema = z
  .object({
    pid: z.number().int().positive().optional(),
    handle: z.string().optional(),
    signal: z.string().default('SIGTERM'),
    waitMs: z.number().int().positive().default(2_000),
  })
  .refine((v) => v.pid !== undefined || v.handle !== undefined, {
    message: 'either pid or handle is required',
  });

/** Output schema for `kill_process`. */
export const KillProcessOutputSchema = z.object({
  killed: z.boolean(),
  pid: z.number().int().optional(),
  method: z.string(),
});

export type KillProcessInput = z.infer<typeof KillProcessInputSchema>;
export type KillProcessOutput = z.infer<typeof KillProcessOutputSchema>;

/**
 * KillProcessTool — terminate a previously-spawned process.
 *
 * @example
 * ```ts
 * await new KillProcessTool().execute({ pid: 12345 }, ctx);
 * ```
 */
export class KillProcessTool
  implements SanixTool<KillProcessInput, KillProcessOutput>
{
  readonly name = 'kill_process';
  readonly description =
    'Terminate a previously-started long-running process by pid or handle. Sends SIGTERM by default and escalates to SIGKILL after waitMs.';
  readonly inputSchema = KillProcessInputSchema;
  readonly outputSchema = KillProcessOutputSchema;
  readonly permissions: ToolPermission[] = ['shell:exec'];
  readonly maxTokensInput = 256;
  readonly maxTokensOutput = 128;

  async execute(
    input: KillProcessInput,
    _context: ToolContext,
  ): Promise<ToolResult<KillProcessOutput>> {
    const start = Date.now();
    const tracked = input.pid
      ? processRegistry.getByPid(input.pid)
      : input.handle
        ? processRegistry.getByHandle(input.handle)
        : undefined;

    if (!tracked) {
      return errResult<KillProcessOutput>(
        `kill_process: no registered process for ${input.pid ? `pid=${input.pid}` : `handle=${input.handle}`}`,
        Date.now() - start,
      );
    }

    try {
      tracked.child.kill(input.signal as NodeJS.Signals);
      const exited = await Promise.race([
        new Promise<boolean>((resolve) => {
          tracked.child.once('exit', () => resolve(true));
        }),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), input.waitMs),
        ),
      ]);
      if (!exited) {
        try {
          tracked.child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        processRegistry.remove(tracked.pid);
        return okResult<KillProcessOutput>(
          { killed: true, pid: tracked.pid, method: 'SIGKILL (escalated)' },
          Date.now() - start,
        );
      }
      processRegistry.remove(tracked.pid);
      return okResult<KillProcessOutput>(
        { killed: true, pid: tracked.pid, method: input.signal },
        Date.now() - start,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errResult<KillProcessOutput>(
        `kill_process failed: ${msg}`,
        Date.now() - start,
      );
    }
  }

  formatForContext(result: KillProcessOutput): string {
    return result.killed
      ? `killed pid=${result.pid} via ${result.method}`
      : `failed to kill pid=${result.pid ?? '?'}`;
  }
}
