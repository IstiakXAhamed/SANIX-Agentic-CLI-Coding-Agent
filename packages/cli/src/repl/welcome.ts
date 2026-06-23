import chalk from 'chalk';
import { basename } from 'node:path';
import type { SanixConfig } from '@sanix/config';

const DIM = chalk.dim;
const BOLD = chalk.bold;
const TEAL = chalk.hex('#00D4FF');
const AMBER = chalk.hex('#FFB347');
const GRAY = chalk.hex('#6b7280');

const LOGO = [
  ' ███████╗ █████╗ ███╗   ██╗██╗██╗  ██╗',
  ' ██╔════╝██╔══██╗████╗  ██║██║╚██╗██╔╝',
  ' ███████╗███████║██╔██╗ ██║██║ ╚███╔╝ ',
  ' ╚════██║██╔══██║██║╚██╗██║██║ ██╔██╗ ',
  ' ███████║██║  ██║██║ ╚████║██║██╔╝ ██╗',
  ' ╚══════╝╚═╝  ╚═╝╚═╝  ╚═══╝╚═╝╚═╝  ╚═╝',
];

interface RGB { r: number; g: number; b: number }
const CYAN: RGB = { r: 0, g: 212, b: 255 };
const VIOLET: RGB = { r: 167, g: 139, b: 250 };

function gradientString(text: string, from: RGB, to: RGB): string {
  const len = text.length;
  if (len <= 1) return `\x1b[38;2;${from.r};${from.g};${from.b}m${text}\x1b[0m`;
  const parts: string[] = [];
  for (let i = 0; i < len; i++) {
    const t = i / (len - 1);
    const r = Math.round(from.r + (to.r - from.r) * t);
    const g = Math.round(from.g + (to.g - from.g) * t);
    const b = Math.round(from.b + (to.b - from.b) * t);
    if (text[i] === ' ') {
      parts.push(' ');
    } else {
      parts.push(`\x1b[38;2;${r};${g};${b}m${text[i]}\x1b[0m`);
    }
  }
  return parts.join('');
}

function renderLogo(): string {
  return gradientString(LOGO.join('\n'), CYAN, VIOLET);
}

function tw(): number {
  return process.stdout.columns || 100;
}

function th(): number {
  return process.stdout.rows || 30;
}

function center(text: string, width: number): string {
  const clean = text.replace(/\x1b\[\d+(;\d+)*m/g, '');
  const pad = Math.max(0, Math.floor((width - clean.length) / 2));
  return ' '.repeat(pad) + text;
}

function getCwdShort(): string {
  const cwd = process.cwd();
  const home = process.env.HOME ?? '';
  if (home && cwd.startsWith(home)) {
    return '~' + cwd.slice(home.length);
  }
  return cwd;
}

function getGitBranch(): string {
  try {
    const { execSync } = require('node:child_process');
    return execSync('git branch --show-current', { timeout: 1000, stdio: 'pipe' }).toString().trim();
  } catch {
    return '';
  }
}

export function renderWelcome(config: SanixConfig): string {
  const W = tw();
  const H = th();
  const provider = config.providers.default || '\u2014';

  const lines: string[] = [];
  const logoLines = renderLogo().split('\n');

  // Calculate total content height for vertical centering:
  // logo (6 lines) + gap (1) + input box (4 lines) + gap (2) + hints (1) + gap (1) + tip (1) + gap (2)
  const contentHeight = logoLines.length + 1 + 4 + 2 + 1 + 1 + 1 + 2;
  const topPad = Math.max(0, Math.floor((H - contentHeight - 3) / 2));

  // Top padding for vertical centering
  for (let i = 0; i < topPad; i++) lines.push('');

  // Logo (centered horizontally)
  for (const l of logoLines) {
    lines.push(center(l, W));
  }

  // Gap after logo
  lines.push('');

  // Input box with ┃ left border (matching OpenCode's SplitBorder)
  const boxW = Math.min(56, W - 4);
  const boxLeft = Math.floor((W - boxW) / 2);
  const boxPad = ' '.repeat(boxLeft);

  const sparkle = TEAL('\u2728');
  const placeholder = `${sparkle} ${DIM('Ask anything...')} ${DIM('"Fix anything"')}`;
  const info = `SANIX v1.0.0 ${DIM('\u00b7')} ${DIM(provider)}`;
  const innerW = boxW - 2; // Account for ┃ border

  // ┃ left border + content + ┃ right border
  const pClean = placeholder.replace(/\x1b\[\d+(;\d+)*m/g, '');
  const pPad = Math.max(0, Math.floor((innerW - pClean.length) / 2));
  const iClean = info.replace(/\x1b\[\d+(;\d+)*m/g, '');
  const iPad = Math.max(0, Math.floor((innerW - iClean.length) / 2));

  // Box top: ┌──────┐
  lines.push(`${boxPad}${DIM('\u250c')}${DIM('\u2500'.repeat(innerW))}${DIM('\u2510')}`);

  // Box content: ┃ placeholder ┃
  lines.push(`${boxPad}${DIM('\u2502')}${' '.repeat(pPad)}${placeholder}${' '.repeat(Math.max(0, innerW - pPad - pClean.length))}${DIM('\u2502')}`);

  // Box info: ┃ SANIX v1.0.0 · provider ┃
  lines.push(`${boxPad}${DIM('\u2502')}${' '.repeat(iPad)}${info}${' '.repeat(Math.max(0, innerW - iPad - iClean.length))}${DIM('\u2502')}`);

  // Box bottom: └──────┘
  lines.push(`${boxPad}${DIM('\u2514')}${DIM('\u2500'.repeat(innerW))}${DIM('\u2518')}`);

  // Gap after input box
  lines.push('');

  // Keyboard hints (centered)
  const hints = `${DIM('tab')} ${DIM('agents')}    ${DIM('ctrl+p')} ${DIM('commands')}`;
  lines.push(center(hints, W));

  // Gap
  lines.push('');

  // Tip line (centered)
  const tip = `${AMBER('\u25cf')} ${DIM('Tip')} ${DIM('Type')} ${TEAL('/help')} ${DIM('to see all commands')}`;
  lines.push(center(tip, W));

  // Fill remaining space to bottom
  lines.push('');

  // Bottom status bar (matching OpenCode footer format)
  const cwdShort = getCwdShort();
  const branch = getGitBranch();
  const branchPart = branch ? `:${branch}` : '';
  const leftBar = ` ${DIM(cwdShort)}${DIM(branchPart)} ${GRAY('\u00b7')} ${DIM(provider)} ${DIM('/help for commands')} `;
  const rightBar = ` ${DIM('v1.0.0')} `;
  const padLen = Math.max(1, W - leftBar.length - rightBar.length);

  lines.push(`${DIM('\u2500'.repeat(W))}`);
  lines.push(`${leftBar}${' '.repeat(padLen)}${rightBar}`);

  return lines.join('\n');
}

export function renderStatusBar(data: { provider: string; messageCount: number; cost?: number }): string {
  const W = tw();
  const left = ` ${DIM(data.provider)} ${GRAY('\u00b7')} ${DIM(`${data.messageCount} message${data.messageCount !== 1 ? 's' : ''}`)} ${DIM('/help for commands')} `;
  const right = ` ${DIM('v1.0.0')} `;

  const padLen = Math.max(1, W - left.length - right.length);
  return `\n${DIM('\u2500'.repeat(W))}\n${left}${' '.repeat(padLen)}${right}\n`;
}

export function renderHelpTable(): string {
  const rows: Array<[string, string]> = [
    ['/help',            'Show this help message'],
    ['/clear',           'Clear working + conversation memory'],
    ['/memory [search]', 'Show memory stats or search'],
    ['/provider <name>', 'Switch active provider'],
    ['/budget <n>',      'Set token budget per turn'],
    ['/save <path>',     'Save conversation to JSON'],
    ['/load <path>',     'Load conversation from JSON'],
    ['/fork [label]',    'Fork conversation at current point'],
    ['/branch',          'List all branches'],
    ['/switch <id>',     'Switch to a branch'],
    ['/diff <a> <b>',    'Diff two branches'],
    ['/checkpoint',      'Manually save a checkpoint'],
    ['/resume <id>',     'Resume from a checkpoint'],
    ['/cost',            'Show cost summary'],
    ['/hooks',           'List registered hooks'],
    ['/auth <provider>', 'Start OAuth login'],
    ['/plan',            'Show current plan'],
    ['/edit-plan',       'Edit plan in $EDITOR'],
    ['/undo',            'Undo last action'],
    ['/redo',            'Redo last undone action'],
    ['/sessions',        'List all sessions'],
    ['/session new',     'Create new session'],
    ['/session switch',  'Switch to a session'],
    ['/session fork',    'Fork current session'],
    ['/session export',  'Export session as markdown'],
    ['/session delete',  'Delete a session'],
    ['/exit',            'Exit (Ctrl+C or Ctrl+D)'],
  ];

  const W = tw();
  const cmdW = Math.max(...rows.map(r => r[0].length)) + 2;

  const parts: string[] = [];
  const topLine = DIM('\u250c' + '\u2500'.repeat(W - 2) + '\u2510');
  const botLine = DIM('\u2514' + '\u2500'.repeat(W - 2) + '\u2518');

  parts.push('');
  parts.push(topLine);

  for (const [cmd, desc] of rows) {
    const l = ` ${TEAL(cmd.padEnd(cmdW))}${GRAY('\u2502')} ${DIM(desc)}`;
    const padding = W - 2 - l.length;
    parts.push(`${DIM('\u2502')}${l}${' '.repeat(Math.max(0, padding))}${DIM('\u2502')}`);
  }

  parts.push(botLine);
  return parts.join('\n');
}

export function renderStatusLine(config: SanixConfig): string {
  const provider = config.providers.default || '\u2014';
  const routing = config.providers.routing || 'auto';
  return `${TEAL('\u25cf')} ${BOLD('SANIX')} ${DIM(provider)} ${GRAY('\u00b7')} ${DIM(routing)}`;
}
