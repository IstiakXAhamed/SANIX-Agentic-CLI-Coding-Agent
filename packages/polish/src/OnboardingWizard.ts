/**
 * @file OnboardingWizard.ts
 * @description A 10-step interactive onboarding wizard. Each step is a
 * function that receives the wizard's prompt helper and returns the
 * collected value. The wizard renders the SANIX logo + step indicator,
 * then runs steps sequentially, accumulating answers into a final
 * `WizardResult` object.
 *
 * The default 10 steps cover the typical SANIX first-run flow:
 *
 *   1. welcome
 *   2. provider selection (anthropic / openai / ...)
 *   3. API key entry
 *   4. default model selection
 *   5. memory tier (in-memory / sqlite / lancedb)
 *   6. tool permissions
 *   7. theme (dark / light)
 *   8. telemetry opt-in
 *   9. auto-update opt-in
 *  10. summary + confirm
 *
 * @packageDocumentation
 */

import { SANIX_LOGO, SANIX_VERSION_LINE, SANIX_PALETTE } from './brand.js';
import { rgb, bold, gradient } from './ansi.js';

/** A prompt function provided to each step. */
export type WizardPrompt = (question: string) => Promise<string>;

/** A single wizard step. */
export interface WizardStep {
  /** Step id (kebab-case). */
  id: string;
  /** Step title. */
  title: string;
  /**
   * The step's logic. Receives a `prompt` helper and the answers so far;
   * returns the answer for this step.
   */
  run: (prompt: WizardPrompt, answers: WizardAnswers) => Promise<unknown>;
}

/** The accumulated answers (keyed by step id). */
export type WizardAnswers = Record<string, unknown>;

/** Result of {@link OnboardingWizard.run}. */
export interface WizardResult {
  /** Whether the user confirmed at the summary step. */
  confirmed: boolean;
  /** The collected answers. */
  answers: WizardAnswers;
}

/** Options for {@link OnboardingWizard}. */
export interface OnboardingWizardOptions {
  /** SANIX version (shown in the header). */
  version: string;
  /** Output stream (default `process.stdout`). */
  out?: { write: (s: string) => void };
  /** Input stream (default `process.stdin`). */
  in?: NodeJS.ReadableStream;
  /** Custom steps (replaces the default 10). */
  steps?: WizardStep[];
}

/**
 * The 10-step SANIX onboarding wizard.
 *
 * @example
 * ```ts
 * const w = new OnboardingWizard({ version: '1.0.0' });
 * const r = await w.run();
 * if (r.confirmed) saveConfig(r.answers);
 * ```
 */
export class OnboardingWizard {
  private readonly version: string;
  private readonly out: { write: (s: string) => void };
  private readonly in: NodeJS.ReadableStream;
  private readonly steps: WizardStep[];

  constructor(opts: OnboardingWizardOptions) {
    this.version = opts.version;
    this.out = opts.out ?? process.stdout;
    this.in = opts.in ?? process.stdin;
    this.steps = opts.steps ?? defaultSteps();
  }

  /**
   * Run the wizard.
   *
   * @returns A {@link WizardResult}.
   */
  async run(): Promise<WizardResult> {
    this.renderHeader();
    const answers: WizardAnswers = {};
    const prompt = (q: string): Promise<string> => this.prompt(q);
    for (let i = 0; i < this.steps.length; i++) {
      const step = this.steps[i]!;
      this.out.write(`\n${rgb(`Step ${i + 1}/${this.steps.length}`, SANIX_PALETTE.teal)} ${bold(step.title)}\n`);
      const answer = await step.run(prompt, answers);
      answers[step.id] = answer;
    }
    this.renderSummary(answers);
    const confirm = await this.prompt('Confirm and save? [y/N] ');
    return { confirmed: confirm.trim().toLowerCase() === 'y', answers };
  }

  /** Render the SANIX logo + version line header. */
  private renderHeader(): void {
    for (const line of SANIX_LOGO) {
      this.out.write(gradient(line, SANIX_PALETTE.teal, SANIX_PALETTE.violet) + '\n');
    }
    this.out.write('\n' + SANIX_VERSION_LINE(this.version) + '\n');
  }

  /** Render the summary of collected answers. */
  private renderSummary(answers: WizardAnswers): void {
    this.out.write(`\n${bold('Summary')}\n`);
    for (const step of this.steps) {
      const v = answers[step.id];
      this.out.write(`  ${rgb('•', SANIX_PALETTE.amber)} ${step.title}: ${String(v)}\n`);
    }
  }

  /**
   * Prompt the user for a line of input. Uses raw stdin readline.
   *
   * @param question The prompt text.
   */
  private prompt(question: string): Promise<string> {
    return new Promise((resolve) => {
      this.out.write(`${question} `);
      const onData = (chunk: Buffer): void => {
        const line = chunk.toString('utf8').replace(/\r?\n$/, '');
        this.in.off('data', onData);
        resolve(line);
      };
      this.in.once('data', onData);
    });
  }
}

/** The default 10 steps. */
function defaultSteps(): WizardStep[] {
  return [
    { id: 'welcome', title: 'Welcome', run: async (_p) => 'ok' },
    {
      id: 'provider',
      title: 'Choose your LLM provider',
      run: async (p) => {
        const a = await p('[anthropic/openai/google/mistral/local] (anthropic):');
        return a.trim() || 'anthropic';
      },
    },
    {
      id: 'apiKey',
      title: 'Enter your API key',
      run: async (p) => {
        const a = await p('(stored locally, never sent anywhere else):');
        return a.trim();
      },
    },
    {
      id: 'model',
      title: 'Pick a default model',
      run: async (p) => {
        const a = await p('(claude-sonnet-4):');
        return a.trim() || 'claude-sonnet-4';
      },
    },
    {
      id: 'memory',
      title: 'Choose a memory tier',
      run: async (p) => {
        const a = await p('[in-memory/sqlite/lancedb] (sqlite):');
        return a.trim() || 'sqlite';
      },
    },
    {
      id: 'tools',
      title: 'Default tool permission',
      run: async (p) => {
        const a = await p('[allow-all/ask/deny-all] (ask):');
        return a.trim() || 'ask';
      },
    },
    {
      id: 'theme',
      title: 'Choose a theme',
      run: async (p) => {
        const a = await p('[dark/light] (dark):');
        return a.trim() || 'dark';
      },
    },
    {
      id: 'telemetry',
      title: 'Enable telemetry?',
      run: async (p) => {
        const a = await p('[y/N] (N):');
        return a.trim().toLowerCase() === 'y';
      },
    },
    {
      id: 'autoupdate',
      title: 'Enable auto-updates?',
      run: async (p) => {
        const a = await p('[Y/n] (Y):');
        const v = a.trim().toLowerCase();
        return v !== 'n';
      },
    },
    { id: 'confirm', title: 'Confirm', run: async (_p) => 'review' },
  ];
}
