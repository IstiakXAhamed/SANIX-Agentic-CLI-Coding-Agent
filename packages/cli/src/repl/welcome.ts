import chalk from 'chalk';
import type { SanixConfig } from '@sanix/config';
import { SANIX_LOGO, SANIX_TAGLINE, SANIX_BYLINE } from '../logo.js';
import { ansi } from '@sanix/polish';

const DIM = chalk.dim;
const BOLD = chalk.bold;
const TEAL = chalk.hex('#2dd4bf');

const HR = DIM('\u2500'.repeat(58));

/**
 * Render the full branded welcome screen.
 */
export function renderWelcome(config: SanixConfig, line?: string): string {
  const parts: string[] = [];

  // ── Logo gradient (teal → violet) ─────────────────────
  parts.push('');
  for (const logoLine of SANIX_LOGO) {
    parts.push('  ' + gradientChalk(logoLine));
  }
  parts.push('');
  parts.push(chalk.hex('#fbbf24').bold(`  ${SANIX_TAGLINE}`));
  parts.push(DIM(`  ${SANIX_BYLINE}`));
  parts.push('');

  // ── Status panel (two-column) ─────────────────────────
  const provider = config.providers.default || DIM('—');
  const routing = config.providers.routing || 'auto';
  const theme = config.tui?.theme || 'sanix';
  const stream = config.tui?.streamOutput ? chalk.green('\u2713 yes') : DIM('\u2717 no');

  parts.push(HR);
  parts.push(`  ${BOLD('Provider')}  ${TEAL(provider.padEnd(16))}${BOLD('Routing')}  ${DIM(routing)}`);
  parts.push(`  ${BOLD('Theme')}    ${TEAL(theme.padEnd(16))}${BOLD('Stream')}  ${stream}`);
  parts.push(HR);

  if (line) {
    parts.push(`  ${DIM(line)}`);
    parts.push(HR);
  }

  // ── Tips ──────────────────────────────────────────────
  parts.push('');
  parts.push(`  ${TEAL('\u25b6')} ${BOLD('Getting started')}`);
  parts.push('');
  parts.push(`   ${DIM('\u203a')} Type a message and press ${BOLD('Enter')} to chat with SANIX`);
  parts.push(`   ${DIM('\u203a')} Type ${TEAL('/help')} to see all commands`);
  parts.push(`   ${DIM('\u203a')} Type ${TEAL('/provider <name>')} to switch AI provider`);
  parts.push(`   ${DIM('\u203a')} Type ${TEAL('/budget <n>')} to set token budget`);
  parts.push(`   ${DIM('\u203a')} Type ${TEAL('/exit')} or press ${BOLD('Ctrl+C')} to quit`);
  parts.push('');

  return parts.join('\n');
}

/**
 * Compact one-line status (for mid-session display).
 */
export function renderStatusLine(config: SanixConfig): string {
  const provider = config.providers.default || '—';
  const routing = config.providers.routing || 'auto';
  return DIM('SANIX') + TEAL(` ${provider}`) + DIM(` \u00b7 ${routing} \u00b7 `) + TEAL('v1.0.0');
}

/**
 * Boxed help table — rounded corners with teal + dim lines.
 */
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

  const cmdW = Math.max(...rows.map(r => r[0].length)) + 2;
  const descW = Math.max(...rows.map(r => r[1].length)) + 2;
  const totalW = cmdW + descW + 3; // columns + 3 separators

  const t = TEAL('\u250c') + DIM('\u2500'.repeat(totalW)) + TEAL('\u2510');
  const b = TEAL('\u2514') + DIM('\u2500'.repeat(totalW)) + TEAL('\u2518');

  const out: string[] = ['', t];
  for (const [cmd, desc] of rows) {
    out.push(
      DIM('\u2502 ') +
      TEAL(cmd.padEnd(cmdW)) +
      DIM('\u2502 ') +
      DIM(desc.padEnd(descW)) +
      DIM('\u2502'),
    );
  }
  out.push(b, '');
  return out.join('\n');
}

/** Apply the SANIX brand gradient (teal → violet) to a string. */
function gradientChalk(s: string): string {
  return ansi.gradient(s, { r: 45, g: 212, b: 191 }, { r: 167, g: 139, b: 250 });
}
