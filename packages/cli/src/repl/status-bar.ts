import chalk from 'chalk';
import { execSync } from 'node:child_process';
import { blackWrap, BG_BLACK, RST } from './welcome.js';

export interface StatusBarData {
  provider: string;
  messageCount: number;
  cost?: number;
}

const DIM = chalk.dim;
const GRAY = chalk.hex('#6b7280');

function getCwdShort(): string {
  const cwd = process.cwd();
  const home = process.env.HOME || '';
  const display = cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
  return display;
}

function getGitBranch(): string | null {
  try {
    const out = execSync('git rev-parse --abbrev-ref HEAD 2>/dev/null', { timeout: 1000, encoding: 'utf8' }).trim();
    return out || null;
  } catch {
    return null;
  }
}

export function renderStatusBar(data: StatusBarData): string {
  const W = process.stdout.columns || 100;
  const cwd = getCwdShort();
  const branch = getGitBranch();
  const branchPart = branch ? `:${branch}` : '';

  const left = ` ${DIM(cwd)}${DIM(branchPart)} ${GRAY('\u00b7')} ${DIM(data.provider)} ${DIM('/help for commands')} `;
  const right = ` ${DIM('v1.0.0')} `;

  const padLen = Math.max(1, W - left.length - right.length);
  const raw = `${DIM('\u2500'.repeat(W))}\n${left}${' '.repeat(padLen)}${right}\n`;
  return blackWrap(raw, W);
}
