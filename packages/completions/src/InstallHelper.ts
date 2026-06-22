/**
 * @file InstallHelper.ts
 * @description Detects the user's shell + writes the generated
 * completion script to the right location + patches the rc file.
 *
 * Detection:
 *   - `$SHELL` env var → shell kind.
 *   - Fallback: probe for config files (`~/.zshrc`, `~/.bashrc`, …).
 *
 * Install steps:
 *   1. Compute the target directory (per-shell convention).
 *   2. Create it if missing.
 *   3. Write the generated script.
 *   4. Append a `source` / `fpath` / `Import-Module` line to the rc
 *      file (idempotent — skip if already present).
 *   5. Print next-step instructions.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, platform } from 'node:os';
import { join, dirname } from 'node:path';
import { SHELL_INFO, type ShellKind } from './templates/index.js';

/** Result of an install operation. */
export interface InstallResult {
  shell: ShellKind;
  scriptPath: string;
  rcFile: string | null;
  rcUpdated: boolean;
  instructions: string[];
}

/** Options for `InstallHelper.install`. */
export interface InstallOptions {
  /** Override the detected shell. */
  shell?: ShellKind;
  /** Override the install directory. */
  dir?: string;
  /** Override the rc file. */
  rcFile?: string;
  /** Dry-run — return what would happen without writing. */
  dryRun?: boolean;
  /** Binary name (defaults to the spec's name). */
  binaryName: string;
  /** Generated script contents. */
  script: string;
}

/**
 * Detects the user's shell and installs completion scripts.
 *
 * @example
 * ```ts
 * const helper = new InstallHelper();
 * const shell = helper.detectShell();
 * const result = helper.install({ binaryName: 'sanix', script, shell });
 * ```
 */
export class InstallHelper {
  /**
   * Detect the current shell from `$SHELL` or config-file presence.
   */
  public detectShell(): ShellKind | null {
    const shellEnv = process.env.SHELL ?? '';
    if (shellEnv.includes('zsh')) return 'zsh';
    if (shellEnv.includes('bash')) return 'bash';
    if (shellEnv.includes('fish')) return 'fish';
    if (shellEnv.includes('elvish')) return 'elvish';
    if (process.env.PSModulePath || platform() === 'win32') {
      if (process.env.PSModulePath) return 'powershell';
    }
    const home = homedir();
    if (existsSync(join(home, '.zshrc'))) return 'zsh';
    if (existsSync(join(home, '.bashrc'))) return 'bash';
    if (existsSync(join(home, '.config', 'fish', 'config.fish'))) return 'fish';
    if (existsSync(join(home, '.config', 'elvish', 'rc.elv'))) return 'elvish';
    if (platform() === 'win32') return 'powershell';
    return null;
  }

  /**
   * Install a completion script.
   */
  public install(opts: InstallOptions): InstallResult {
    const shell = opts.shell ?? this.detectShell();
    if (!shell) {
      throw new Error('Could not detect shell — set opts.shell explicitly');
    }
    const info = SHELL_INFO[shell];
    const home = homedir();
    const dir = opts.dir ?? join(home, info.defaultDir);
    const fileName = opts.binaryName + (shell === 'zsh' ? '' : info.extension);
    const scriptPath = join(dir, fileName);
    const rcFile = opts.rcFile ?? (info.rcFiles.length > 0 ? join(home, info.rcFiles[0]) : null);
    const instructions: string[] = [];

    if (opts.dryRun) {
      return {
        shell,
        scriptPath,
        rcFile,
        rcUpdated: false,
        instructions: [`(dry-run) would write ${scriptPath}`, rcFile ? `(dry-run) would patch ${rcFile}` : '(no rc file needed)'],
      };
    }

    // 1. Create directory.
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    // 2. Write script.
    writeFileSync(scriptPath, opts.script, 'utf8');

    // 3. Patch rc file (idempotent).
    let rcUpdated = false;
    if (rcFile) {
      const rcDir = dirname(rcFile);
      if (!existsSync(rcDir)) mkdirSync(rcDir, { recursive: true });
      const sourceLine = info.sourceLine(scriptPath);
      let existing = '';
      try {
        existing = readFileSync(rcFile, 'utf8');
      } catch {
        existing = '';
      }
      if (!existing.includes(sourceLine) && !existing.includes(`# ${opts.binaryName} completions`)) {
        const block = `\n# ${opts.binaryName} completions\n${sourceLine}\n`;
        if (existsSync(rcFile)) {
          appendFileSync(rcFile, block, 'utf8');
        } else {
          writeFileSync(rcFile, block.slice(1), 'utf8');
        }
        rcUpdated = true;
        instructions.push(`Added source line to ${rcFile}`);
      } else {
        instructions.push(`${rcFile} already sources the completion — no change`);
      }
    } else {
      instructions.push(`No rc file needed for ${info.displayName} — restart your shell to pick up ${scriptPath}`);
    }

    instructions.push(`Restart your shell or run: ${this.reloadCommand(shell)}`);
    return { shell, scriptPath, rcFile, rcUpdated, instructions };
  }

  /**
   * Uninstall a completion script.
   */
  public uninstall(opts: { shell?: ShellKind; binaryName: string; dir?: string; rcFile?: string }): { removed: boolean; rcCleaned: boolean } {
    const shell = opts.shell ?? this.detectShell();
    if (!shell) return { removed: false, rcCleaned: false };
    const info = SHELL_INFO[shell];
    const home = homedir();
    const dir = opts.dir ?? join(home, info.defaultDir);
    const fileName = opts.binaryName + (shell === 'zsh' ? '' : info.extension);
    const scriptPath = join(dir, fileName);
    const rcFile = opts.rcFile ?? (info.rcFiles.length > 0 ? join(home, info.rcFiles[0]) : null);
    let removed = false;
    let rcCleaned = false;
    try {
      if (existsSync(scriptPath)) { unlinkSync(scriptPath); removed = true; }
    } catch { /* ignore */ }
    if (rcFile && existsSync(rcFile)) {
      try {
        const existing = readFileSync(rcFile, 'utf8');
        const blockRe = new RegExp(`\\n?# ${opts.binaryName} completions\\n.*?\\n`, 'g');
        const cleaned = existing.replace(blockRe, '');
        if (cleaned !== existing) {
          writeFileSync(rcFile, cleaned, 'utf8');
          rcCleaned = true;
        }
      } catch { /* ignore */ }
    }
    return { removed, rcCleaned };
  }

  /**
   * Return the shell-specific reload command.
   */
  public reloadCommand(shell: ShellKind): string {
    switch (shell) {
      case 'bash': return 'exec bash';
      case 'zsh': return 'exec zsh';
      case 'fish': return 'exec fish';
      case 'elvish': return 'exec elvish';
      case 'powershell': return '. $PROFILE';
    }
  }

  /**
   * Return metadata for a shell.
   */
  public shellInfo(shell: ShellKind) {
    return SHELL_INFO[shell];
  }

  /**
   * List all installable shells + their default paths.
   */
  public listShells(): Array<{ shell: ShellKind; dir: string; file: string; rc: string | null }> {
    const home = homedir();
    return (Object.keys(SHELL_INFO) as ShellKind[]).map((shell) => {
      const info = SHELL_INFO[shell];
      const fileName = 'BINARY' + (shell === 'zsh' ? '' : info.extension);
      return {
        shell,
        dir: join(home, info.defaultDir),
        file: fileName,
        rc: info.rcFiles.length > 0 ? join(home, info.rcFiles[0]) : null,
      };
    });
  }

  /**
   * Check whether a shell is installed on the system.
   */
  public isShellInstalled(shell: ShellKind): boolean {
    if (shell === 'powershell') return platform() === 'win32' || !!process.env.PSModulePath;
    const binNames: Record<ShellKind, string[]> = {
      bash: ['bash'],
      zsh: ['zsh'],
      fish: ['fish'],
      powershell: ['pwsh', 'powershell'],
      elvish: ['elvish'],
    };
    for (const bin of binNames[shell]) {
      try {
        const p = execFileSync('sh', ['-c', `command -v ${bin} 2>/dev/null`], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
        if (p && existsSync(p)) return true;
      } catch { /* not found */ }
    }
    const home = homedir();
    if (shell === 'zsh' && existsSync(join(home, '.zshrc'))) return true;
    if (shell === 'bash' && existsSync(join(home, '.bashrc'))) return true;
    if (shell === 'fish' && existsSync(join(home, '.config', 'fish', 'config.fish'))) return true;
    if (shell === 'elvish' && existsSync(join(home, '.config', 'elvish', 'rc.elv'))) return true;
    return false;
  }
}
