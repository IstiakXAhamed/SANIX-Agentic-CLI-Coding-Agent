/**
 * @file execute.test.ts
 * @description Tests SandboxManager one-shot execution: Node, Python
 * (skipped if missing), Bash, timeout, exit code propagation, stderr.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { SandboxManager } from '@sanix/sandbox';

const hasPython3 = (() => {
  try {
    execSync('python3 --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

const hasBash = (() => {
  try {
    execSync('bash --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

describe('SandboxManager.execute', () => {
  let mgr: SandboxManager;

  beforeEach(() => {
    mgr = new SandboxManager({ defaultIsolation: 'process' });
  });

  afterEach(async () => {
    await mgr.stopAll();
  });

  describe('Node runtime', () => {
    it('captures stdout from console.log', async () => {
      const result = await mgr.execute("console.log('hello')", {
        runtime: 'node',
        isolation: 'process',
        timeoutMs: 5_000,
      });
      expect(result.stdout).toContain('hello');
      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
    });

    it('captures stderr from console.error', async () => {
      const result = await mgr.execute("console.error('boom')", {
        runtime: 'node',
        isolation: 'process',
        timeoutMs: 5_000,
      });
      expect(result.stderr).toContain('boom');
      expect(result.exitCode).toBe(0);
    });

    it('propagates the exit code on failure', async () => {
      const result = await mgr.execute('process.exit(7)', {
        runtime: 'node',
        isolation: 'process',
        timeoutMs: 5_000,
      });
      expect(result.exitCode).toBe(7);
    });

    it('computes arithmetic correctly', async () => {
      const result = await mgr.execute('console.log(2 + 3)', {
        runtime: 'node',
        isolation: 'process',
        timeoutMs: 5_000,
      });
      expect(result.stdout.trim()).toBe('5');
    });
  });

  describe('Python runtime', () => {
    it.skipIf(!hasPython3)('runs python3 code and captures stdout', async () => {
      const result = await mgr.execute("print('hello from python')", {
        runtime: 'python',
        isolation: 'process',
        timeoutMs: 5_000,
      });
      expect(result.stdout).toContain('hello from python');
      expect(result.exitCode).toBe(0);
    });

    it.skipIf(!hasPython3)('captures python traceback on stderr', async () => {
      const result = await mgr.execute('raise ValueError("nope")', {
        runtime: 'python',
        isolation: 'process',
        timeoutMs: 5_000,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.length).toBeGreaterThan(0);
    });
  });

  describe('Bash runtime', () => {
    it.skipIf(!hasBash)('echoes output', async () => {
      const result = await mgr.execute('echo hello', {
        runtime: 'bash',
        isolation: 'process',
        timeoutMs: 5_000,
      });
      expect(result.stdout).toContain('hello');
      expect(result.exitCode).toBe(0);
    });

    it.skipIf(!hasBash)('propagates non-zero exit codes', async () => {
      const result = await mgr.execute('exit 5', {
        runtime: 'bash',
        isolation: 'process',
        timeoutMs: 5_000,
      });
      expect(result.exitCode).toBe(5);
    });
  });

  describe('timeout', () => {
    it('sets timedOut=true when the timeout fires', async () => {
      // Sleep 10 seconds — but with a 1-second timeout.
      const result = await mgr.execute(
        'setTimeout(() => {}, 10000)',
        {
          runtime: 'node',
          isolation: 'process',
          timeoutMs: 1_000,
        },
      );
      expect(result.timedOut).toBe(true);
      // The execution should not have completed normally.
      expect(result.durationMs).toBeLessThan(5_000);
    }, 10_000);
  });

  describe('exit code propagation', () => {
    it('returns exit code 0 for successful execution', async () => {
      const result = await mgr.execute('console.log("ok")', {
        runtime: 'node',
        isolation: 'process',
        timeoutMs: 5_000,
      });
      expect(result.exitCode).toBe(0);
    });

    it('returns the supplied non-zero exit code', async () => {
      const result = await mgr.execute('process.exit(42)', {
        runtime: 'node',
        isolation: 'process',
        timeoutMs: 5_000,
      });
      expect(result.exitCode).toBe(42);
    });
  });

  describe('stderr capture', () => {
    it('captures stderr independently from stdout', async () => {
      const result = await mgr.execute(
        "console.log('out'); console.error('err');",
        {
          runtime: 'node',
          isolation: 'process',
          timeoutMs: 5_000,
        },
      );
      expect(result.stdout).toContain('out');
      expect(result.stderr).toContain('err');
      expect(result.stdout).not.toContain('err');
      expect(result.stderr).not.toContain('out');
    });
  });

  describe('createSandbox', () => {
    it('returns a sandbox whose execute runs code lazily', async () => {
      const sb = await mgr.createSandbox({
        runtime: 'node',
        isolation: 'process',
        timeoutMs: 5_000,
      });
      const result = await sb.execute("console.log('lazy')");
      expect(result.stdout).toContain('lazy');
      await sb.stop();
    });
  });

  describe('requires timeoutMs', () => {
    it('throws when timeoutMs is missing or zero', async () => {
      await expect(
        mgr.execute('console.log(1)', {
          runtime: 'node',
          isolation: 'process',
          timeoutMs: 0,
        }),
      ).rejects.toThrow();
    });
  });
});
