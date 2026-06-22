/**
 * @file CompletionGenerator.ts
 * @description Shell-completion spec model + per-shell renderer.
 *
 * Defines a shell-agnostic `CompletionSpec` that describes a CLI's
 * commands, options, and positional arguments, then renders it into
 * the native completion script for bash, zsh, fish, PowerShell, or
 * elvish via the per-shell templates in `src/templates/`.
 *
 * The spec model is intentionally simple — it covers the constructs
 * the SANIX CLI needs (subcommands, flags with values, enums,
 * file-path completion, dynamic completion functions) without
 * trying to be a full argparsing DSL.
 */

import type { ShellKind } from './templates/index.js';
import { renderBash } from './templates/bash.js';
import { renderZsh } from './templates/zsh.js';
import { renderFish } from './templates/fish.js';
import { renderPowerShell } from './templates/powershell.js';
import { renderElvish } from './templates/elvish.js';

/**
 * A completion value source — either a static list or a dynamic
 * function name (resolved by the shell at completion time).
 */
export interface CompletionValues {
  /** Static enum values. */
  static?: string[];
  /** Dynamic completion function name (shell-specific). */
  dynamic?: string;
  /** Hint — file paths, directories, hostnames, etc. */
  hint?: 'file' | 'directory' | 'hostname' | 'user' | 'pid' | 'url';
}

/** A flag/option definition. */
export interface CompletionFlag {
  /** Long form, e.g. `--output`. */
  long?: string;
  /** Short form, e.g. `-o`. */
  short?: string;
  /** Aliases (alternative long names). */
  aliases?: string[];
  /** Human-readable description. */
  description: string;
  /** Does the flag take a value? */
  takesValue: boolean;
  /** Value label in help (e.g. `FORMAT`, `FILE`). */
  valueLabel?: string;
  /** Completion values for the flag's argument. */
  values?: CompletionValues;
  /** Is the flag required? */
  required?: boolean;
  /** Can the flag appear multiple times? */
  multiple?: boolean;
  /** Conflicting flags. */
  conflictsWith?: string[];
}

/** A positional argument. */
export interface CompletionArg {
  /** Argument name (for display). */
  name: string;
  /** Description. */
  description: string;
  /** Completion values. */
  values?: CompletionValues;
  /** Is this arg required? */
  required?: boolean;
  /** Can this arg repeat (variadic)? */
  variadic?: boolean;
}

/** A subcommand definition. */
export interface CompletionCommand {
  /** Command name (e.g. `build`). */
  name: string;
  /** Aliases. */
  aliases?: string[];
  /** Short description (shown in completion menu). */
  description: string;
  /** Long description. */
  longDescription?: string;
  /** Sub-subcommands. */
  subcommands?: CompletionCommand[];
  /** Flags / options for this command. */
  flags?: CompletionFlag[];
  /** Positional arguments. */
  args?: CompletionArg[];
  /** Hidden from completion? */
  hidden?: boolean;
}

/** The top-level completion spec for a CLI. */
export interface CompletionSpec {
  /** CLI binary name (e.g. `sanix`). */
  name: string;
  /** Short description. */
  description: string;
  /** Top-level flags (apply to all subcommands). */
  globalFlags?: CompletionFlag[];
  /** Subcommands. */
  subcommands?: CompletionCommand[];
  /** File extension for the generated script. */
  extraPaths?: string[];
}

/** Options for the generator. */
export interface GenerateOptions {
  /** Target shell. */
  shell: ShellKind;
  /** Path to the CLI binary (for `complete -C` style completion). */
  binaryPath?: string;
  /** Indentation string. Default `  ` (2 spaces). */
  indent?: string;
}

/**
 * Generates shell completion scripts.
 *
 * @example
 * ```ts
 * const gen = new CompletionGenerator();
 * const script = gen.generate(spec, { shell: 'bash' });
 * ```
 */
export class CompletionGenerator {
  /**
   * Generate a completion script for the given shell.
   */
  public generate(spec: CompletionSpec, opts: GenerateOptions): string {
    switch (opts.shell) {
      case 'bash': return renderBash(spec, opts);
      case 'zsh': return renderZsh(spec, opts);
      case 'fish': return renderFish(spec, opts);
      case 'powershell': return renderPowerShell(spec, opts);
      case 'elvish': return renderElvish(spec, opts);
    }
  }

  /**
   * Generate completion scripts for all supported shells.
   */
  public generateAll(spec: CompletionSpec, binaryPath?: string): Record<ShellKind, string> {
    return {
      bash: this.generate(spec, { shell: 'bash', binaryPath }),
      zsh: this.generate(spec, { shell: 'zsh', binaryPath }),
      fish: this.generate(spec, { shell: 'fish', binaryPath }),
      powershell: this.generate(spec, { shell: 'powershell', binaryPath }),
      elvish: this.generate(spec, { shell: 'elvish', binaryPath }),
    };
  }

  /**
   * List supported shells.
   */
  public supportedShells(): ShellKind[] {
    return ['bash', 'zsh', 'fish', 'powershell', 'elvish'];
  }

  /**
   * Collect all flag long-names from a spec (for validation).
   */
  public collectFlags(spec: CompletionSpec): Array<{ command: string; flag: CompletionFlag }> {
    const out: Array<{ command: string; flag: CompletionFlag }> = [];
    for (const f of spec.globalFlags ?? []) out.push({ command: spec.name, flag: f });
    const walk = (cmd: CompletionCommand, prefix: string) => {
      const path = prefix ? `${prefix} ${cmd.name}` : cmd.name;
      for (const f of cmd.flags ?? []) out.push({ command: path, flag: f });
      for (const sub of cmd.subcommands ?? []) walk(sub, path);
    };
    for (const sub of spec.subcommands ?? []) walk(sub, '');
    return out;
  }

  /**
   * Validate a spec — returns warnings (empty array = OK).
   */
  public validate(spec: CompletionSpec): string[] {
    const warnings: string[] = [];
    if (!spec.name) warnings.push('Spec name is empty');
    for (const f of spec.globalFlags ?? []) {
      if (!f.long && !f.short) warnings.push(`Global flag has no long or short form`);
    }
    const seen = new Map<string, string[]>();
    for (const { command, flag } of this.collectFlags(spec)) {
      const names = [flag.long, flag.short, ...(flag.aliases ?? [])].filter(Boolean) as string[];
      for (const n of names) {
        const existing = seen.get(n);
        if (existing) warnings.push(`Flag "${n}" used by both ${existing.join(', ')} and ${command}`);
        seen.set(n, [...(existing ?? []), command]);
      }
    }
    return warnings;
  }
}
