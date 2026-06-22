/**
 * @file templates/index.ts
 * @description Shared shell-template types.
 *
 * @packageDocumentation
 */

/** Supported shells. */
export type ShellKind = 'bash' | 'zsh' | 'fish' | 'powershell' | 'elvish';

/** Render options shared across templates. */
export interface RenderOptions {
  binaryPath?: string;
  indent?: string;
}

/** File extension + rc-file convention per shell. */
export interface ShellInfo {
  /** Shell id. */
  shell: ShellKind;
  /** Display name. */
  displayName: string;
  /** Script file extension (e.g. `.sh`, `.ps1`). */
  extension: string;
  /** Default install directory (relative to $HOME). */
  defaultDir: string;
  /** Default filename (without directory). */
  defaultFile: string;
  /** rc file(s) that must source the script. */
  rcFiles: string[];
  /** Line added to rc file to source the completion script. */
  sourceLine: (filePath: string) => string;
}

/** Per-shell metadata. */
export const SHELL_INFO: Record<ShellKind, ShellInfo> = {
  bash: {
    shell: 'bash',
    displayName: 'Bash',
    extension: '.sh',
    defaultDir: '.bash_completion.d',
    defaultFile: 'sanix',
    rcFiles: ['.bashrc', '.bash_profile'],
    sourceLine: (f) => `source ${f}`,
  },
  zsh: {
    shell: 'zsh',
    displayName: 'Zsh',
    extension: '.zsh',
    defaultDir: '.zsh/completions',
    defaultFile: '_sanix',
    rcFiles: ['.zshrc'],
    sourceLine: (f) => `fpath=(${f} $fpath)`,
  },
  fish: {
    shell: 'fish',
    displayName: 'Fish',
    extension: '.fish',
    defaultDir: '.config/fish/completions',
    defaultFile: 'sanix.fish',
    rcFiles: [],
    sourceLine: () => `# fish auto-loads completions from ~/.config/fish/completions/`,
  },
  powershell: {
    shell: 'powershell',
    displayName: 'PowerShell',
    extension: '.ps1',
    defaultDir: 'Documents/PowerShell/Modules/sanix-completion',
    defaultFile: 'sanix-completion.psm1',
    rcFiles: ['Documents/PowerShell/Microsoft.PowerShell_profile.ps1', 'Documents/WindowsPowerShell/Microsoft.PowerShell_profile.ps1'],
    sourceLine: (f) => `Import-Module ${f}`,
  },
  elvish: {
    shell: 'elvish',
    displayName: 'Elvish',
    extension: '.elv',
    defaultDir: '.config/elvish/lib',
    defaultFile: 'sanix-completion.elv',
    rcFiles: ['.config/elvish/rc.elv'],
    sourceLine: (f) => `use ${f}`,
  },
};
