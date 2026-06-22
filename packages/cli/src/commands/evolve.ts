/**
 * @file commands/evolve.ts
 * @description `sanix evolve <sub>` — self-improvement subcommands.
 *
 *   sanix evolve run "<seed-prompt>"        Run evolutionary optimization.
 *   sanix evolve ab-test                    A/B test prompt variants.
 *   sanix evolve show <id>                  Show evolution run results.
 *   sanix evolve history                    List past evolution runs.
 *   sanix evolve best                       Show current best prompt.
 *   sanix evolve lineage <id>               Show variant lineage.
 *
 * Delegates to {@link SelfImprovementManager} from `@sanix/self-improve`.
 * The manager is wired with the first available {@link IProvider} and
 * the SANIX benchmark suite (`@sanix/bench`).
 *
 * @packageDocumentation
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { readFile } from 'node:fs/promises';
import type { SanixContext } from '../bootstrap.js';

/** Selection algorithm options. */
export type SelectionMethod = 'tournament' | 'roulette' | 'rank' | 'elite';

/** Parsed options for `sanix evolve run`. */
export interface EvolveRunOptions {
  generations?: number;
  population?: number;
  mutationRate?: number;
  crossoverRate?: number;
  benchmark?: string;
  samples?: number;
  selection?: SelectionMethod;
  json?: boolean;
}

/** Parsed options for `sanix evolve ab-test`. */
export interface EvolveAbTestOptions {
  variants?: string;
  benchmark?: string;
  samples?: number;
  metric?: 'pass_rate' | 'avg_cost' | 'avg_duration';
  json?: boolean;
}

/** Lazy handle to the `@sanix/self-improve` module. */
interface SelfImproveModule {
  SelfImprovementManager: new (opts: {
    provider: unknown;
    benchmarkSuite: unknown;
    dbPath?: string;
  }) => SelfImprovementManagerLike;
}

interface SelfImprovementManagerLike {
  evolve: (
    seedPrompt: string,
    config?: Partial<EvolveConfigLike>,
  ) => Promise<EvolutionResultLike>;
  abTest: (
    variants: VariantLike[],
    opts: { benchmarkId: string; metric: string; samplesPerVariant: number },
  ) => Promise<AbTestResultLike>;
  getBestPrompt: () => VariantLike | null;
  getHistory: () => GenerationResultLike[][];
  close: () => void;
}

interface EvolveConfigLike {
  populationSize: number;
  generations: number;
  mutationRate: number;
  crossoverRate: number;
  eliteFraction: number;
  benchmarkId: string;
  samplesPerVariant: number;
  selectionMethod: SelectionMethod;
  tournamentSize?: number;
  seed?: number;
}

interface VariantLike {
  id: string;
  name: string;
  systemPrompt: string;
  description: string;
  createdAt: number;
  parent?: string;
  generation: number;
  mutationType?: string;
  fitness?: number;
  samples: number;
}

interface EvolutionResultLike {
  bestVariant: VariantLike;
  finalPopulation: VariantLike[];
  history: GenerationResultLike[];
  totalEvaluations: number;
  totalCostUsd: number;
  durationMs: number;
}

interface GenerationResultLike {
  generation: number;
  population: VariantLike[];
  bestFitness: number;
  avgFitness: number;
  worstFitness: number;
  diversity: number;
}

interface AbTestResultLike {
  winnerId: string;
  variantResults: Array<{
    variantId: string;
    metricValue: number;
    samples: number;
    confidence: number;
  }>;
  statisticalSignificance: number;
  improvement: number;
}

/** Lazy handle to the `@sanix/bench` module. */
interface BenchModule {
  BenchmarkSuite: new (opts: { provider?: unknown }) => BenchSuiteLike;
  BUILTIN_BENCHMARKS: BenchLike[];
}

interface BenchSuiteLike {
  register: (b: BenchLike) => void;
  list: () => BenchLike[];
}

interface BenchLike {
  id: string;
  prompts: unknown[];
}

/** Cached dynamic-imports. */
let siPromise: Promise<SelfImproveModule> | null = null;
let benchPromise: Promise<BenchModule> | null = null;
let siManager: SelfImprovementManagerLike | null = null;
/** History of evolution run results (in-process). */
const runHistory: EvolutionResultLike[] = [];

/**
 * Lazily dynamic-import `@sanix/self-improve`. Cached. Throws a
 * friendly error if the package is missing.
 */
async function loadSelfImprove(): Promise<SelfImproveModule> {
  if (!siPromise) {
    siPromise = (async () => {
      try {
        // Variable specifier → TypeScript skips static module resolution.
        const spec = '@sanix/self-improve';
        return (await import(spec)) as unknown as SelfImproveModule;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `@sanix/self-improve is not available (${msg}). Install it to use \`sanix evolve\`.`,
        );
      }
    })();
  }
  return siPromise;
}

/**
 * Lazily dynamic-import `@sanix/bench`. Cached. Throws a friendly
 * error if the package is missing.
 */
async function loadBench(): Promise<BenchModule> {
  if (!benchPromise) {
    benchPromise = (async () => {
      try {
        // Variable specifier → TypeScript skips static module resolution.
        const spec = '@sanix/bench';
        return (await import(spec)) as unknown as BenchModule;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `@sanix/bench is not available (${msg}). Install it to use \`sanix evolve\`.`,
        );
      }
    })();
  }
  return benchPromise;
}

/**
 * Build (or return the cached) `SelfImprovementManager` wired to the
 * SANIX ProviderRouter + the built-in benchmark suite.
 */
async function getManager(
  ctx: SanixContext,
): Promise<SelfImprovementManagerLike> {
  if (siManager) return siManager;
  const [mod, benchMod] = await Promise.all([loadSelfImprove(), loadBench()]);

  const providers = ctx.router.list();
  const provider = providers[0] as unknown;
  if (!provider) {
    throw new Error(
      'No LLM provider configured. Run `sanix providers add` first.',
    );
  }

  const suite = new benchMod.BenchmarkSuite({ provider });
  for (const b of benchMod.BUILTIN_BENCHMARKS) suite.register(b);

  siManager = new mod.SelfImprovementManager({
    provider,
    benchmarkSuite: suite,
  });
  return siManager;
}

/**
 * Register the `sanix evolve` command tree.
 *
 * @param program       - The Commander root program.
 * @param ctxProvider   - Lazy context provider (called on first action).
 */
export function registerEvolveCommand(
  program: Command,
  ctxProvider: () => Promise<SanixContext>,
): void {
  const evolve = program
    .command('evolve')
    .description('Self-improvement: evolve / A/B test prompts against benchmarks.');

  evolve
    .command('run <seedPrompt>')
    .description('Run an evolutionary search starting from a seed prompt.')
    .option('--generations <n>', 'Number of generations (default 5).', (v: string) => Number(v), 5)
    .option('--population <n>', 'Population size (default 8).', (v: string) => Number(v), 8)
    .option('--mutation-rate <r>', 'Mutation probability (default 0.3).', parseFloat, 0.3)
    .option('--crossover-rate <r>', 'Crossover probability (default 0.2).', parseFloat, 0.2)
    .option('--benchmark <id>', 'Benchmark id (default coding).', 'coding')
    .option('--samples <n>', 'Samples per variant (default 5).', (v: string) => Number(v), 5)
    .option(
      '--selection <m>',
      'Selection: tournament | roulette | rank | elite (default tournament).',
      'tournament',
    )
    .option('--json', 'Emit machine-readable JSON.')
    .action(async (seedPrompt: string, opts: EvolveRunOptions) => {
      try {
        const ctx = await ctxProvider();
        await evolveRun(ctx, seedPrompt, opts);
      } catch (err) {
        fail('evolve run', err);
      }
    });

  evolve
    .command('ab-test')
    .description('A/B test prompt variants from a JSON file (--variants).')
    .option('--variants <file>', 'JSON file with an array of variant prompts.')
    .option('--benchmark <id>', 'Benchmark id (default coding).', 'coding')
    .option('--samples <n>', 'Samples per variant (default 5).', (v: string) => Number(v), 5)
    .option(
      '--metric <m>',
      'Metric: pass_rate | avg_cost | avg_duration (default pass_rate).',
      'pass_rate',
    )
    .option('--json', 'Emit machine-readable JSON.')
    .action(async (opts: EvolveAbTestOptions) => {
      try {
        const ctx = await ctxProvider();
        await evolveAbTest(ctx, opts);
      } catch (err) {
        fail('evolve ab-test', err);
      }
    });

  evolve
    .command('show <id>')
    .description('Show the results of an evolution run (best variant + history).')
    .action(async (id: string) => {
      try {
        evolveShow(id);
      } catch (err) {
        fail('evolve show', err);
      }
    });

  evolve
    .command('history')
    .description('List past evolution runs (in this process).')
    .action(async () => {
      try {
        evolveHistory();
      } catch (err) {
        fail('evolve history', err);
      }
    });

  evolve
    .command('best')
    .description('Show the current best prompt from the registry.')
    .action(async () => {
      try {
        const ctx = await ctxProvider();
        await evolveBest(ctx);
      } catch (err) {
        fail('evolve best', err);
      }
    });

  evolve
    .command('lineage <id>')
    .description('Show the lineage of a variant (ancestor chain).')
    .action(async (id: string) => {
      try {
        const ctx = await ctxProvider();
        await evolveLineage(ctx, id);
      } catch (err) {
        fail('evolve lineage', err);
      }
    });
}

/** `sanix evolve run "<seed-prompt>"`. */
export async function evolveRun(
  ctx: SanixContext,
  seedPrompt: string,
  opts: EvolveRunOptions,
): Promise<void> {
  const mgr = await getManager(ctx);
  const result = await mgr.evolve(seedPrompt, {
    generations: opts.generations ?? 5,
    populationSize: opts.population ?? 8,
    mutationRate: opts.mutationRate ?? 0.3,
    crossoverRate: opts.crossoverRate ?? 0.2,
    benchmarkId: opts.benchmark ?? 'coding',
    samplesPerVariant: opts.samples ?? 5,
    selectionMethod: opts.selection ?? 'tournament',
  });
  runHistory.push(result);

  if (opts.json) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // eslint-disable-next-line no-console
  console.log(chalk.hex('#00D4FF')('\nEvolution complete.\n'));
  // eslint-disable-next-line no-console
  console.log(`  Best variant     : ${chalk.cyan(result.bestVariant.name)}`);
  // eslint-disable-next-line no-console
  console.log(`  Best fitness     : ${chalk.green((result.bestVariant.fitness ?? 0).toFixed(4))}`);
  // eslint-disable-next-line no-console
  console.log(`  Generations      : ${chalk.dim(String(result.history.length))}`);
  // eslint-disable-next-line no-console
  console.log(`  Total evaluations: ${chalk.dim(String(result.totalEvaluations))}`);
  // eslint-disable-next-line no-console
  console.log(`  Total cost       : ${chalk.dim(`$${result.totalCostUsd.toFixed(4)}`)}`);
  // eslint-disable-next-line no-console
  console.log(`  Duration         : ${chalk.dim(`${result.durationMs}ms`)}`);
  // eslint-disable-next-line no-console
  console.log(chalk.hex('#FFB347')('\nBest system prompt:\n'));
  // eslint-disable-next-line no-console
  console.log(result.bestVariant.systemPrompt);
}

/** `sanix evolve ab-test`. */
export async function evolveAbTest(
  ctx: SanixContext,
  opts: EvolveAbTestOptions,
): Promise<void> {
  if (!opts.variants) {
    throw new Error('`--variants <file>` is required. Provide a JSON file with an array of variant objects.');
  }
  const raw = await readFile(opts.variants, 'utf-8');
  const parsed = JSON.parse(raw) as VariantLike[];
  if (!Array.isArray(parsed) || parsed.length < 2) {
    throw new Error('Variants file must contain an array of at least 2 variant objects.');
  }

  const mgr = await getManager(ctx);
  const result = await mgr.abTest(parsed, {
    benchmarkId: opts.benchmark ?? 'coding',
    metric: opts.metric ?? 'pass_rate',
    samplesPerVariant: opts.samples ?? 5,
  });

  if (opts.json) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // eslint-disable-next-line no-console
  console.log(chalk.hex('#00D4FF')('\nA/B test complete.\n'));
  // eslint-disable-next-line no-console
  console.log(`  Winner           : ${chalk.cyan(result.winnerId)}`);
  // eslint-disable-next-line no-console
  console.log(`  Improvement      : ${chalk.green((result.improvement * 100).toFixed(2))}%`);
  // eslint-disable-next-line no-console
  console.log(`  Significance (p) : ${chalk.dim(result.statisticalSignificance.toFixed(4))}`);
  // eslint-disable-next-line no-console
  console.log(chalk.hex('#FFB347')('\nPer-variant:'));
  for (const vr of result.variantResults) {
    const winner = vr.variantId === result.winnerId ? chalk.green(' ★') : '';
    // eslint-disable-next-line no-console
    console.log(
      `  ${chalk.cyan(vr.variantId)} ${vr.metricValue.toFixed(4)} (samples=${vr.samples}, conf=${vr.confidence.toFixed(2)})${winner}`,
    );
  }
}

/** `sanix evolve show <id>`. */
export function evolveShow(id: string): void {
  const r = runHistory[Number(id)];
  if (!r) {
    throw new Error(`No evolution run with index ${id}. Run \`sanix evolve history\` to list.`);
  }
  // eslint-disable-next-line no-console
  console.log(chalk.hex('#00D4FF')(`\nEvolution run #${id}:\n`));
  // eslint-disable-next-line no-console
  console.log(`  Best variant : ${chalk.cyan(r.bestVariant.name)}`);
  // eslint-disable-next-line no-console
  console.log(`  Best fitness : ${chalk.green((r.bestVariant.fitness ?? 0).toFixed(4))}`);
  // eslint-disable-next-line no-console
  console.log(`  Cost         : ${chalk.dim(`$${r.totalCostUsd.toFixed(4)}`)}`);
  // eslint-disable-next-line no-console
  console.log(`  Evaluations  : ${chalk.dim(String(r.totalEvaluations))}`);
  // eslint-disable-next-line no-console
  console.log(chalk.hex('#FFB347')('\nGeneration history:'));
  for (const g of r.history) {
    // eslint-disable-next-line no-console
    console.log(
      `  gen ${g.generation}: best=${g.bestFitness.toFixed(4)} avg=${g.avgFitness.toFixed(4)} diversity=${g.diversity.toFixed(3)}`,
    );
  }
}

/** `sanix evolve history`. */
export function evolveHistory(): void {
  if (runHistory.length === 0) {
    // eslint-disable-next-line no-console
    console.log(chalk.dim('No evolution runs in this process yet.'));
    return;
  }
  // eslint-disable-next-line no-console
  console.log(chalk.hex('#00D4FF')(`Evolution runs (${runHistory.length}):\n`));
  runHistory.forEach((r, i) => {
    // eslint-disable-next-line no-console
    console.log(
      `  #${i}  ${chalk.cyan(r.bestVariant.name)}  fitness=${(r.bestVariant.fitness ?? 0).toFixed(4)}  cost=$${r.totalCostUsd.toFixed(4)}  dur=${r.durationMs}ms`,
    );
  });
}

/** `sanix evolve best`. */
export async function evolveBest(ctx: SanixContext): Promise<void> {
  const mgr = await getManager(ctx);
  const best = mgr.getBestPrompt();
  if (!best) {
    // eslint-disable-next-line no-console
    console.log(chalk.dim('No prompts have been evaluated yet.'));
    return;
  }
  // eslint-disable-next-line no-console
  console.log(chalk.hex('#00D4FF')('\nBest prompt:\n'));
  // eslint-disable-next-line no-console
  console.log(`  Name        : ${chalk.cyan(best.name)}`);
  // eslint-disable-next-line no-console
  console.log(`  Fitness     : ${chalk.green((best.fitness ?? 0).toFixed(4))}`);
  // eslint-disable-next-line no-console
  console.log(`  Generation  : ${chalk.dim(String(best.generation))}`);
  // eslint-disable-next-line no-console
  console.log(`  Samples     : ${chalk.dim(String(best.samples))}`);
  // eslint-disable-next-line no-console
  console.log(chalk.hex('#FFB347')('\nSystem prompt:\n'));
  // eslint-disable-next-line no-console
  console.log(best.systemPrompt);
}

/** `sanix evolve lineage <id>`. */
export async function evolveLineage(
  ctx: SanixContext,
  id: string,
): Promise<void> {
  // The SelfImprovementManager doesn't expose lineage directly; we
  // search the in-process history + final populations for the variant
  // and walk its parent chain.
  const mgr = await getManager(ctx);
  void mgr;
  let found: VariantLike | undefined;
  for (const r of runHistory) {
    found = r.finalPopulation.find((v) => v.id === id) ??
      (r.bestVariant.id === id ? r.bestVariant : undefined);
    if (found) break;
  }
  if (!found) {
    // eslint-disable-next-line no-console
    console.log(chalk.dim(`No variant with id "${id}" found in run history.`));
    return;
  }
  // Walk the parent chain by searching the history's populations.
  const chain: VariantLike[] = [found];
  let cursor = found;
  while (cursor.parent) {
    let parent: VariantLike | undefined;
    for (const r of runHistory) {
      parent = r.finalPopulation.find((v) => v.id === cursor.parent) ??
        (r.bestVariant.id === cursor.parent ? r.bestVariant : undefined);
      if (parent) break;
    }
    if (!parent) break;
    chain.unshift(parent);
    cursor = parent;
  }
  // eslint-disable-next-line no-console
  console.log(chalk.hex('#00D4FF')(`\nLineage for ${id} (${chain.length} variants):\n`));
  chain.forEach((v, i) => {
    const fit = v.fitness !== undefined ? v.fitness.toFixed(4) : '?';
    // eslint-disable-next-line no-console
    console.log(
      `  gen ${v.generation}  ${chalk.cyan(v.id)}  fitness=${fit}  ${chalk.dim(v.mutationType ?? 'origin')}`,
    );
    // eslint-disable-next-line no-console
    console.log(chalk.dim(`    ${v.systemPrompt.slice(0, 100)}…`));
    void i;
  });
}

/** Print a red error and set exit code 1. */
function fail(cmd: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error(chalk.red(`\n✗ sanix ${cmd} failed: ${msg}\n`));
  process.exitCode = 1;
}
