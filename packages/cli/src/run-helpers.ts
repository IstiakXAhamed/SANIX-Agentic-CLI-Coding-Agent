/**
 * @file run-helpers.ts
 * @description High-level helpers that turn a {@link SanixContext} into a
 * running {@link AgentLoop} and orchestrate the TUI / non-TUI rendering,
 * checkpoint save/resume, and final result printing.
 *
 * Public surface:
 *   - {@link WireUpAgentOptions} — flags that influence how the loop is wired.
 *   - {@link wireUpAgent} — construct a fully-configured AgentLoop.
 *   - {@link ExecuteGoalOptions} — flags that influence goal execution.
 *   - {@link executeGoal} — wire + run + render, returning the final result.
 *   - {@link saveCheckpoint} / {@link loadCheckpoint} — JSON persistence.
 *   - {@link renderResult} — final summary printer (token usage, duration, ...).
 *   - {@link CheckpointData} — on-disk checkpoint shape.
 *
 * @packageDocumentation
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import chalk from 'chalk';
import ora, { type Ora } from 'ora';
import {
  AgentLoop,
  Planner,
  Executor,
  Reflector,
  SubAgentManager,
  type AgentResult,
  type AgentState,
  type Plan,
  type RunContext,
  type SubAgentResult,
  type SubTask,
  type TaskNode,
} from '@sanix/core';
import type { IProvider, LLMMessage } from '@sanix/providers';
import type { ToolPermission, ToolContext } from '@sanix/core';
import type { SanixContext } from './bootstrap.js';
import { newRunId } from './bootstrap.js';
import { runWithTui, tuiAvailable } from './tui-adapter.js';
import { AutoCommit } from './git/AutoCommit.js';
import {
  WorkspaceLoader,
  type WorkspaceContext,
} from './workspace/WorkspaceLoader.js';

/** Default checkpoint directory: `~/.sanix/checkpoints/`. */
export const DEFAULT_CHECKPOINT_DIR: string = join(
  homedir(),
  '.sanix',
  'checkpoints',
);

/** Flags accepted by {@link wireUpAgent}. */
export interface WireUpAgentOptions {
  /** Force a specific provider id (overrides the config default). */
  provider?: string;
  /** Force local-only providers (sets `preferLocal` on every request). */
  local?: boolean;
  /** Max concurrent sub-agents (overrides `config.agent.maxSubAgents`). */
  parallel?: number;
  /** Override the agent's max iterations. */
  maxIterations?: number;
  /** Override the system prompt. */
  systemPrompt?: string;
  /** Working directory for tool execution (defaults to `process.cwd()`). */
  cwd?: string;
  /** Project identifier for memory scoping. */
  project?: string;
}

/** Flags accepted by {@link executeGoal}. */
export interface ExecuteGoalOptions extends WireUpAgentOptions {
  /** Total token budget for the run. */
  budget?: number;
  /** Show the plan, don't execute (skips the agent loop entirely). */
  dryRun?: boolean;
  /** Pause for approval on each tool call (best-effort). */
  interactive?: boolean;
  /** Path to save/resume a checkpoint file. */
  checkpoint?: string;
  /** Disable the Ink TUI; use the plain-text renderer instead. */
  noTui?: boolean;
  /** Seed messages to prepend to the agent's conversation history. */
  seedMessages?: LLMMessage[];
  /**
   * Disable sub-agent spawning (force sequential). When `false` (the
   * default), `executeGoal` will spawn sub-agents for parallelizable
   * delegatable tasks per the plan (Task A4 / Part 1).
   */
  noSubAgents?: boolean;
  /**
   * Enable auto-commit git integration. When `true`, an {@link AutoCommit}
   * instance is wired into the loop's hooks: `agent:start` → startGoal,
   * `tool:after` → commitAction, `agent:complete` → completeGoal
   * (Task A4 / Part 3).
   */
  git?: boolean;
  /**
   * Enable workspace-context loading. When `true` (the default), the
   * workspace is detected and relevant files are injected into the
   * agent's initial context (Task A4 / Part 6).
   */
  workspace?: boolean;
}

/** On-disk checkpoint shape. */
export interface CheckpointData {
  /** Unique run id (nanoid). */
  id: string;
  /** The originating goal. */
  goal: string;
  /** ISO timestamp the checkpoint was created. */
  createdAt: string;
  /** ISO timestamp the checkpoint was last updated. */
  updatedAt: string;
  /** Snapshot of the agent state at checkpoint time (may be partial). */
  state: Partial<AgentState>;
  /** The final result, if the run completed. */
  result?: AgentResult;
}

/**
 * Resolve the primary LLM provider for the agent loop. Resolution order:
 *   1. `opts.provider` (explicit `--provider` flag).
 *   2. `ctx.config.providers.default` (from config).
 *   3. The first registered provider in the router.
 *
 * @returns The resolved provider, or `undefined` if none is configured.
 */
function resolvePrimaryProvider(
  ctx: SanixContext,
  opts: WireUpAgentOptions,
): IProvider | undefined {
  const alias = opts.provider ?? ctx.config.providers.default;
  if (alias) {
    const direct = ctx.router.get(alias);
    if (direct) return direct;
  }
  const list = ctx.router.list();
  return list[0];
}

/**
 * Build the {@link ToolContext} handed to every tool `execute()` call.
 * Permissions are derived from `config.agent.requireApprovalFor`: when
 * `all` is in the list, only safe permissions are granted by default.
 */
function buildToolContext(
  ctx: SanixContext,
  opts: WireUpAgentOptions,
  signal: AbortSignal,
): ToolContext {
  const requireAll = ctx.config.agent.requireApprovalFor.includes('all');
  const allPerms: ToolPermission[] = [
    'file_read',
    'file_write',
    'shell_exec',
    'web_request',
    'memory_write',
    'memory_read',
    'subprocess_long',
    'mcp_call',
    'ask_user',
  ];
  const safePerms: ToolPermission[] = [
    'file_read',
    'memory_read',
    'ask_user',
  ];

  const allowed = requireAll ? safePerms : allPerms;

  return {
    config: ctx.config,
    cwd: opts.cwd ?? process.cwd(),
    signal,
    allowedPermissions: allowed,
    project: opts.project,
    log: (level, msg) => {
      // eslint-disable-next-line no-console
      if (level === 'error') console.error(chalk.red(`[tool:${level}] ${msg}`));
      else if (level === 'warn') console.warn(chalk.yellow(`[tool:${level}] ${msg}`));
    },
  };
}

/**
 * Construct a fully-configured {@link AgentLoop} from a {@link SanixContext}
 * and run options. The loop is *not* started — the caller invokes
 * `loop.run(goal, context)` (or passes the loop to {@link executeGoal}).
 *
 * @param ctx  - The wired SANIX context from {@link bootstrap}.
 * @param opts - Optional wiring flags.
 * @returns A ready-to-run {@link AgentLoop}.
 *
 * @example
 * ```ts
 * const ctx = await bootstrap();
 * const loop = wireUpAgent(ctx, { provider: 'claude-sonnet-4' });
 * const result = await loop.run('Refactor auth', runContext);
 * ```
 */
export function wireUpAgent(
  ctx: SanixContext,
  opts: WireUpAgentOptions = {},
): AgentLoop {
  return wireUpAgentFull(ctx, opts).loop;
}

/**
 * The full set of components constructed by {@link wireUpAgentFull}. Each
 * field is needed by some part of {@link executeGoal} (e.g. the planner
 * is used to pre-decompose the goal for sub-agent spawning; the
 * sub-agent manager is used to spawn sub-agents in parallel; the loop
 * runs the OODA iterations).
 */
export interface WiredAgent {
  /** The agent loop (the primary object — same as {@link wireUpAgent}). */
  loop: AgentLoop;
  /** The planner used to decompose the goal. */
  planner: Planner;
  /** The sub-agent manager used for parallel delegation. */
  subAgentManager: SubAgentManager;
  /** The primary provider (already resolved from config / opts). */
  provider: IProvider | undefined;
}

/**
 * Same as {@link wireUpAgent} but returns the full set of wired
 * components (planner, sub-agent manager, provider). Used by
 * {@link executeGoal} when sub-agent spawning or AutoCommit integration
 * is needed (Task A4 / Parts 1 + 3).
 *
 * @param ctx  - The wired SANIX context from {@link bootstrap}.
 * @param opts - Optional wiring flags.
 * @returns A {@link WiredAgent} bundle.
 */
export function wireUpAgentFull(
  ctx: SanixContext,
  opts: WireUpAgentOptions = {},
): WiredAgent {
  const provider = resolvePrimaryProvider(ctx, opts);

  // The planner, executor, reflector, and sub-agent manager all share the
  // primary provider. A more sophisticated setup would route the reflector
  // to a cheaper model, but for now we keep it simple — the router's
  // fallback logic handles provider outages regardless.
  const maxConcurrency = opts.parallel ?? ctx.config.agent.maxSubAgents;
  const subAgentManager = new SubAgentManager(ctx.config, {
    provider,
    memory: ctx.memory,
    maxConcurrency,
  });
  const planner = new Planner(ctx.config, { provider });
  const executor = new Executor(ctx.config, ctx.tools, {
    provider,
    subAgentManager,
  });
  const reflector = new Reflector(ctx.config, { provider });

  const loop = new AgentLoop(ctx.config, {
    provider,
    planner,
    executor,
    reflector,
    subAgentManager,
    toolRegistry: ctx.tools,
    memory: ctx.memory,
    contextBuilder: ctx.contextBuilder,
    memoryCompressor: ctx.compressor,
    systemPrompt: opts.systemPrompt,
    maxIterations: opts.maxIterations ?? ctx.config.agent.maxIterations,
  });

  return { loop, planner, subAgentManager, provider };
}

/**
 * Build a {@link RunContext} suitable for `AgentLoop.run()`.
 */
function buildRunContext(
  ctx: SanixContext,
  opts: ExecuteGoalOptions,
  signal: AbortSignal,
): RunContext {
  return {
    config: ctx.config,
    cwd: opts.cwd ?? process.cwd(),
    seedMessages: opts.seedMessages,
    signal,
    project: opts.project,
    toolContext: buildToolContext(ctx, opts, signal),
  };
}

/**
 * Run the agent loop with plain-text progress output (no Ink TUI).
 * Subscribes to the loop's events and prints:
 *   - `decide`   → the chosen decision type + reasoning.
 *   - `iteration`→ a compact iteration counter + token usage.
 *   - `complete` → a final "done" line.
 *   - `error`    → the error in red.
 *
 * @returns The final {@link AgentResult}.
 */
async function runLoopPlainText(
  ctx: SanixContext,
  goal: string,
  loop: AgentLoop,
  opts: ExecuteGoalOptions,
  signal: AbortSignal,
): Promise<AgentResult> {
  const spinner: Ora = ora({
    text: chalk.cyan('Booting SANIX agent…'),
    color: 'cyan',
  }).start();

  let lastIteration = 0;

  loop.on('decide', ({ iteration, decision }) => {
    lastIteration = iteration;
    spinner.stop();
    const type = chalk.hex('#00D4FF')(decision.type);
    const reasoning =
      'reasoning' in decision && decision.reasoning
        ? chalk.dim(` — ${decision.reasoning}`)
        : '';
    // eslint-disable-next-line no-console
    console.log(`  [${chalk.gray(`#${iteration}`)}] decide: ${type}${reasoning}`);
    spinner.start(chalk.cyan('Thinking…'));
  });

  loop.on('iteration', ({ iteration, tokens }) => {
    lastIteration = iteration;
    spinner.text = chalk.cyan(
      `Iter ${iteration} · ${tokens.inputTokens + tokens.outputTokens} tokens`,
    );
  });

  loop.on('error', ({ error }) => {
    spinner.fail(chalk.red(`Error: ${error.message}`));
  });

  const runContext = buildRunContext(ctx, opts, signal);
  spinner.text = chalk.cyan(`Goal: ${goal}`);

  try {
    const result = await loop.run(goal, runContext);
    spinner.stop();
    return result;
  } catch (err) {
    spinner.fail(chalk.red('Agent loop failed'));
    const msg = err instanceof Error ? err.message : String(err);
    // Return a synthetic failure result so the caller's renderResult can
    // produce a consistent summary.
    return {
      success: false,
      summary: `Agent loop crashed: ${msg}`,
      iterations: lastIteration,
      totalTokens: { inputTokens: 0, outputTokens: 0 },
      finalState: {} as AgentState,
      actions: [],
      modifiedFiles: [],
      lessonsLearned: [],
      abortReason: msg,
    };
  }
}

/**
 * Resolve the checkpoint path for a run. If `opts.checkpoint` is set, use
 * it verbatim (after `~` expansion). Otherwise, generate a fresh id under
 * `~/.sanix/checkpoints/<id>.json`.
 *
 * @param opts - The execute-goal options.
 * @returns The resolved path and the run id.
 */
function resolveCheckpointPath(opts: ExecuteGoalOptions): {
  path: string;
  id: string;
} {
  if (opts.checkpoint) {
    const expanded = opts.checkpoint.startsWith('~/')
      ? join(homedir(), opts.checkpoint.slice(2))
      : opts.checkpoint;
    // Derive the id from the file name (sans extension).
    const base = expanded.split(/[\\/]/).pop() ?? newRunId();
    const id = base.replace(/\.json$/i, '');
    return { path: expanded, id };
  }
  const id = newRunId();
  return { path: join(DEFAULT_CHECKPOINT_DIR, `${id}.json`), id };
}

/**
 * Wire up the agent, render the TUI (or plain-text fallback), and return
 * the final result. Handles:
 *   - `--dry-run` (plan only, no execution).
 *   - `--checkpoint` (save/resume state).
 *   - `--no-tui` (plain-text rendering).
 *   - `--no-subagents` (skip parallel sub-agent delegation — Task A4 / Part 1).
 *   - `--git` (auto-commit git integration — Task A4 / Part 3).
 *   - `--workspace` (default on) workspace context loading — Task A4 / Part 6.
 *   - Resume from an existing checkpoint file.
 *
 * @param ctx  - The wired SANIX context.
 * @param goal - The user's high-level goal.
 * @param opts - Execution flags.
 * @returns The final {@link AgentResult}.
 *
 * @example
 * ```ts
 * const ctx = await bootstrap();
 * const result = await executeGoal(ctx, 'Refactor auth', { provider: 'claude-sonnet-4' });
 * renderResult(result, { verbose: true });
 * ```
 */
export async function executeGoal(
  ctx: SanixContext,
  goal: string,
  opts: ExecuteGoalOptions = {},
): Promise<AgentResult> {
  const startTime = Date.now();
  const abortController = new AbortController();
  const signal = abortController.signal;

  // Graceful Ctrl-C: abort the loop, then exit.
  const onSigInt = () => {
    abortController.abort();
  };
  process.once('SIGINT', onSigInt);
  process.once('SIGTERM', onSigInt);

  // Checkpoint resume: if the file exists, load it and short-circuit with
  // a synthetic result that summarizes the prior run. Full state replay
  // (continuing the prior loop in-place) is left as future work — the
  // infrastructure to round-trip AgentState through JSON is here, but the
  // loop's internal state is not trivially restorable.
  const { path: checkpointPath, id } = resolveCheckpointPath(opts);
  if (opts.checkpoint && existsSync(checkpointPath)) {
    const prior = loadCheckpoint(checkpointPath);
    // eslint-disable-next-line no-console
    console.log(
      chalk.yellow(
        `Resuming from checkpoint ${prior.id} (created ${prior.createdAt}).`,
      ),
    );
    if (prior.result) {
      return prior.result;
    }
  }

  // ── Task V13-2: friendly "no API key" error. ──────────────────────────
  // Before wiring up the agent, surface a clear, actionable error if the
  // router has no providers. This happens when the user has neither run
  // `sanix config init` nor exported any of the well-known API-key env
  // vars. Without this check, the loop silently aborts with the cryptic
  // "No provider configured — agent cannot decide." message.
  if (ctx.router.list().length === 0) {
    throw new Error(
      'No API key set. Run: sanix config init (or export ANTHROPIC_API_KEY / OPENAI_API_KEY)',
    );
  }

  // Wire up the agent (and grab the planner + sub-agent manager for
  // sub-agent delegation + AutoCommit integration).
  const wired = wireUpAgentFull(ctx, opts);
  const { loop, planner, subAgentManager } = wired;

  // ── Task A4 / Part 6: Workspace context loading. ────────────────────
  // Detect the workspace and inject relevant-file context into the
  // agent's seed messages so the LLM has high-signal project info on the
  // first iteration.
  let workspaceCtx: WorkspaceContext | null = null;
  if (opts.workspace !== false) {
    try {
      const loader = new WorkspaceLoader();
      const cwd = opts.cwd ?? process.cwd();
      workspaceCtx = await loader.detect(cwd);
      const relevant = await loader.selectRelevantFiles(goal, workspaceCtx, {
        maxFiles: 12,
      });
      const wsWithFiles: WorkspaceContext = {
        ...workspaceCtx,
        relevantFiles: relevant,
      };
      const ctxStr = await loader.buildContextString(wsWithFiles, 2000);
      if (ctxStr.length > 0) {
        const existingSeeds = opts.seedMessages ?? [];
        opts = {
          ...opts,
          seedMessages: [
            {
              role: 'system' as const,
              content: `Workspace context:\n${ctxStr}`,
            },
            ...existingSeeds,
          ],
        };
      }
    } catch (err) {
      // Non-fatal — workspace context is best-effort.
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn(chalk.yellow(`Workspace context load failed: ${msg}`));
    }
  }

  // Dry-run: ask the planner to decompose, print the plan, exit.
  if (opts.dryRun) {
    return await runDryRun(ctx, loop, goal, opts, signal, id, checkpointPath);
  }

  // ── Task A4 / Part 1: Sub-agent delegation. ─────────────────────────
  // Pre-decompose the goal and spawn sub-agents for parallelizable,
  // delegatable, dependency-free tasks. Sub-agents run in parallel with
  // the main agent loop; their results merge into memory automatically
  // via SubAgentManager.receiveReport → MemoryRouter.mergeSubAgentResult.
  let subAgentResults: SubAgentResult[] = [];
  if (!opts.noSubAgents) {
    try {
      const plan = await planner.decompose(goal, {
        cwd: opts.cwd ?? process.cwd(),
        project: opts.project,
        availableTools: ctx.tools.enabledNames(),
      });
      subAgentResults = await spawnSubAgentsForPlan(
        ctx,
        plan,
        subAgentManager,
        opts,
        signal,
      );
    } catch (err) {
      // Non-fatal — sub-agent delegation is best-effort.
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn(chalk.yellow(`Sub-agent delegation skipped: ${msg}`));
    }
  }

  // ── Task A4 / Part 3: Auto-commit git integration. ──────────────────
  // When `--git` is enabled, create an AutoCommit instance and wire it
  // into the loop's `act` event (the closest equivalent to the `tool:after`
  // hook in the HookManager). The start commit happens before the loop
  // runs; the completion commit happens after.
  let autoCommit: AutoCommit | null = null;
  let gitCommits: string[] = [];
  if (opts.git) {
    try {
      autoCommit = new AutoCommit(
        { enabled: true, autoBranch: true, stageFiles: true },
        opts.cwd ?? process.cwd(),
      );
      if (await autoCommit.isGitRepo()) {
        const startR = await autoCommit.startGoal(goal);
        if (startR) {
          gitCommits.push(startR.commitSha);
          // Hook on `act` (post-tool) to commit each write.
          loop.on('act', ({ decision, result }) => {
            if (decision.type !== 'TOOL_CALL') return;
            void autoCommit
              ?.commitAction(decision.toolName, decision.arguments, result)
              .then((sha) => {
                if (sha) gitCommits.push(sha);
              })
              .catch(() => {
                // Non-fatal — auto-commit failures shouldn't kill the run.
              });
          });
        }
      } else {
        // eslint-disable-next-line no-console
        console.warn(chalk.yellow(`--git: not a git repo; auto-commit disabled.`));
        autoCommit = null;
      }
    } catch (err) {
      // Non-fatal.
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn(chalk.yellow(`Auto-commit init failed: ${msg}`));
      autoCommit = null;
    }
  }

  let result: AgentResult;
  const isTty = process.stdout.isTTY === true;
  const canUseTui = !opts.noTui && tuiAvailable();

  if (canUseTui && isTty) {
    // Full Ink TUI — drive live updates via instance.rerender on each
    // AgentLoop event.
    try {
      result = await runWithTui({
        context: ctx,
        goal,
        loop,
        subAgentManager,
        signal,
        onQuit: () => abortController.abort(),
      });
    } catch (err) {
      // TUI failure → fall back to plain text.
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn(chalk.yellow(`TUI unavailable (${msg}); using plain-text renderer.`));
      result = await runLoopPlainText(ctx, goal, loop, opts, signal);
    }
  } else {
    // --no-tui, non-TTY, or @sanix/tui not available — use the CLI's
    // own streaming plain-text renderer.
    result = await runLoopPlainText(ctx, goal, loop, opts, signal);
  }

  // Wait for any lingering sub-agents (in case the loop finished first).
  // Their results have already been merged into memory via the
  // SubAgentManager's automatic `receiveReport` ->
  // `MemoryRouter.mergeSubAgentResult` flow; we capture them here for the
  // final summary.
  if (!opts.noSubAgents && subAgentManager.runningCount > 0) {
    try {
      subAgentResults = await subAgentManager.waitForAll();
    } catch {
      // Non-fatal.
    }
  } else if (!opts.noSubAgents) {
    // Sub-agents already finished; collect their results from the manager.
    try {
      subAgentResults = await subAgentManager.waitForAll();
    } catch {
      // Non-fatal.
    }
  }

  // ── Task A4 / Part 3: final commit. ─────────────────────────────────
  if (autoCommit) {
    try {
      const finalSha = await autoCommit.completeGoal(goal, result.success);
      if (finalSha) gitCommits.push(finalSha);
    } catch {
      // Non-fatal.
    }
  }

  // ── Task A4 / Part 7: enrich the result with the extra metadata. ────
  const elapsedMs = Date.now() - startTime;
  const enriched = enrichResult(result, {
    subAgentResults,
    gitCommits,
    elapsedMs,
    workspace: workspaceCtx,
  });

  // Save the checkpoint.
  try {
    saveCheckpoint(ctx, {
      id,
      goal,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      state: enriched.finalState,
      result: enriched,
    }, checkpointPath);
  } catch (err) {
    // Non-fatal.
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.warn(chalk.yellow(`Failed to save checkpoint: ${msg}`));
  }

  process.removeListener('SIGINT', onSigInt);
  process.removeListener('SIGTERM', onSigInt);

  return enriched;
}

/**
 * Run a `--dry-run` flow: ask the planner to decompose the goal, print the
 * resulting plan, and return a synthetic {@link AgentResult} indicating
 * nothing was executed.
 */
async function runDryRun(
  ctx: SanixContext,
  _loop: AgentLoop,
  goal: string,
  opts: ExecuteGoalOptions,
  signal: AbortSignal,
  id: string,
  checkpointPath: string,
): Promise<AgentResult> {
  // eslint-disable-next-line no-console
  console.log(chalk.cyan('Dry run — generating plan only.\n'));

  const runContext = buildRunContext(ctx, opts, signal);

  // Use the loop's planner directly (it was wired in wireUpAgent). We
  // access it via the loop's public API by calling initState + reading
  // the plan after one orient() — but the cleanest path is to call the
  // planner ourselves. Since wireUpAgent doesn't expose the planner, we
  // re-construct one here for dry-run purposes.
  const planner = new Planner(ctx.config, {
    provider: resolvePrimaryProvider(ctx, opts),
  });

  try {
    const plan = await planner.decompose(goal, {
      cwd: runContext.cwd,
      project: runContext.project,
      availableTools: ctx.tools.enabledNames(),
    });

    // eslint-disable-next-line no-console
    console.log(chalk.hex('#00D4FF')('Plan:'));
    // eslint-disable-next-line no-console
    console.log(chalk.white(`  Goal: ${plan.goal}`));
    // eslint-disable-next-line no-console
    console.log(chalk.dim(`  Understanding: ${plan.understanding}`));
    if (plan.ambiguities.length > 0) {
      // eslint-disable-next-line no-console
      console.log(chalk.yellow('  Ambiguities:'));
      for (const a of plan.ambiguities) {
        // eslint-disable-next-line no-console
        console.log(chalk.yellow(`    - ${a}`));
      }
    }
    // eslint-disable-next-line no-console
    console.log(chalk.white('  Tasks:'));
    for (const t of plan.tasks) {
      const status = chalk.gray(`[${t.status}]`);
      // eslint-disable-next-line no-console
      console.log(`    ${status} ${chalk.cyan(t.id)}: ${t.title}`);
      if (t.dependencies.length > 0) {
        // eslint-disable-next-line no-console
        console.log(chalk.dim(`        deps: ${t.dependencies.join(', ')}`));
      }
    }
    if (plan.successCriteria.length > 0) {
      // eslint-disable-next-line no-console
      console.log(chalk.green('  Success criteria:'));
      for (const c of plan.successCriteria) {
        // eslint-disable-next-line no-console
        console.log(chalk.green(`    - ${c}`));
      }
    }
    // eslint-disable-next-line no-console
    console.log(
      chalk.dim(
        `\n  Estimated budget: ${plan.estimatedTokenBudget} tokens · provider: ${plan.recommendedProvider}`,
      ),
    );
    // eslint-disable-next-line no-console
    console.log(chalk.cyan('\nDry run complete — no actions taken.\n'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(chalk.red(`Planner failed: ${msg}`));
  }

  // Save a checkpoint representing the dry-run.
  const result: AgentResult = {
    success: true,
    summary: 'Dry run — plan generated, no actions taken.',
    iterations: 0,
    totalTokens: { inputTokens: 0, outputTokens: 0 },
    finalState: {} as AgentState,
    actions: [],
    modifiedFiles: [],
    lessonsLearned: [],
  };

  try {
    saveCheckpoint(
      ctx,
      {
        id,
        goal,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        state: {},
        result,
      },
      checkpointPath,
    );
  } catch {
    // Non-fatal.
  }

  // Reference `_loop` so TypeScript doesn't complain about the unused
  // parameter — we accept the loop in the signature for API symmetry.
  void _loop;

  return result;
}

/**
 * Save a checkpoint to disk. Creates the parent directory if needed.
 *
 * @param ctx     - Unused except for type symmetry; the checkpoint is
 *                  self-contained.
 * @param data    - The checkpoint payload.
 * @param path    - Destination path (absolute or `~`-prefixed).
 */
export function saveCheckpoint(
  _ctx: SanixContext,
  data: CheckpointData,
  path: string,
): void {
  const resolved = path.startsWith('~/')
    ? join(homedir(), path.slice(2))
    : path;
  const dir = dirname(resolved);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(resolved, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Load a checkpoint from disk.
 *
 * @param path - Source path (absolute or `~`-prefixed).
 * @returns The parsed {@link CheckpointData}.
 * @throws if the file does not exist or contains invalid JSON.
 */
export function loadCheckpoint(path: string): CheckpointData {
  const resolved = path.startsWith('~/')
    ? join(homedir(), path.slice(2))
    : path;
  const text = readFileSync(resolved, 'utf-8');
  const raw = JSON.parse(text) as unknown;
  // Light runtime narrowing: ensure the required fields are present.
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !('id' in raw) ||
    !('goal' in raw) ||
    !('createdAt' in raw)
  ) {
    throw new Error(`Invalid checkpoint file: ${resolved}`);
  }
  return raw as CheckpointData;
}

/** Options accepted by {@link renderResult}. */
export interface RenderResultOptions {
  /** Print extra detail (action log, lessons learned). */
  verbose?: boolean;
}

/**
 * Augmented agent result — adds the metadata required by the Task A4 / Part 7
 * summary (cost, cache hit rate, sub-agents spawned, git commits, elapsed
 * time, lessons learned, workspace context).
 *
 * The standard {@link AgentResult} doesn't carry these fields, so we attach
 * them under a single `sanix` envelope. `renderResult` reads from this
 * envelope when present; otherwise it falls back to the standard fields.
 */
export interface SanixResultMeta {
  /** Total elapsed wall-clock time in milliseconds. */
  elapsedMs?: number;
  /** Sub-agent results collected during the run (Task A4 / Part 1). */
  subAgentResults?: SubAgentResult[];
  /** Git commit SHAs recorded by AutoCommit (Task A4 / Part 3). */
  gitCommits?: string[];
  /** Workspace context detected at run start (Task A4 / Part 6). */
  workspace?: WorkspaceContext | null;
  /** Total cost in USD (Task A4 / Part 7). */
  costUsd?: number;
  /** Cache hit rate (0..1) — fraction of input tokens served from cache. */
  cacheHitRate?: number;
}

/** The augmented result returned by {@link executeGoal}. */
export type AugmentedAgentResult = AgentResult & {
  /** SANIX-specific metadata envelope. */
  sanix?: SanixResultMeta;
};

/**
 * Print a human-readable summary of an agent run. Includes success/failure
 * banner, the agent's summary, token usage, duration, files modified,
 * sub-agents spawned, git commits (if any), cost (USD), cache hit rate,
 * and lessons learned (Task A4 / Part 7).
 *
 * @param result - The final {@link AgentResult} from {@link executeGoal}.
 * @param opts   - Optional rendering flags.
 */
export function renderResult(
  result: AgentResult,
  opts: RenderResultOptions = {},
): void {
  const meta = (result as AugmentedAgentResult).sanix ?? {};
  const banner = result.success
    ? chalk.hex('#39D353').bold('✓ SANIX run complete')
    : chalk.hex('#FF4D4D').bold('✗ SANIX run failed');
  // eslint-disable-next-line no-console
  console.log(`\n${banner}\n`);

  // eslint-disable-next-line no-console
  console.log(chalk.white(`Summary: ${result.summary}`));

  const totalTokens = result.totalTokens.inputTokens + result.totalTokens.outputTokens;
  // eslint-disable-next-line no-console
  console.log(
    chalk.dim(
      `Tokens: ${totalTokens} (in: ${result.totalTokens.inputTokens}, out: ${result.totalTokens.outputTokens})`,
    ),
  );
  // eslint-disable-next-line no-console
  console.log(chalk.dim(`Iterations: ${result.iterations}`));

  // ── Task A4 / Part 7: cache hit rate + cost. ────────────────────────
  if (typeof meta.cacheHitRate === 'number') {
    const pct = (meta.cacheHitRate * 100).toFixed(1);
    // eslint-disable-next-line no-console
    console.log(chalk.dim(`Cache hit rate: ${pct}%`));
  }
  if (typeof meta.costUsd === 'number') {
    // eslint-disable-next-line no-console
    console.log(chalk.hex('#FFB347')(`Cost: $${meta.costUsd.toFixed(4)}`));
  }

  // ── Task A4 / Part 7: sub-agents spawned. ───────────────────────────
  if (meta.subAgentResults && meta.subAgentResults.length > 0) {
    // eslint-disable-next-line no-console
    console.log(chalk.cyan(`Sub-agents spawned: ${meta.subAgentResults.length}`));
    for (const r of meta.subAgentResults) {
      const mark = r.success ? chalk.green('✓') : chalk.red('✗');
      // eslint-disable-next-line no-console
      console.log(`  ${mark} ${r.agentId.slice(0, 8)} — ${r.summary.slice(0, 80)}`);
    }
  }

  // ── Task A4 / Part 7: files modified. ───────────────────────────────
  if (result.modifiedFiles.length > 0) {
    // eslint-disable-next-line no-console
    console.log(chalk.cyan(`Modified files (${result.modifiedFiles.length}):`));
    for (const f of result.modifiedFiles) {
      // eslint-disable-next-line no-console
      console.log(`  ${f}`);
    }
  }

  // ── Task A4 / Part 7: git commits. ──────────────────────────────────
  if (meta.gitCommits && meta.gitCommits.length > 0) {
    // eslint-disable-next-line no-console
    console.log(chalk.cyan(`Git commits (${meta.gitCommits.length}):`));
    for (const sha of meta.gitCommits) {
      // eslint-disable-next-line no-console
      console.log(`  ${sha.slice(0, 12)}`);
    }
  }

  // ── Task A4 / Part 7: elapsed time. ─────────────────────────────────
  if (typeof meta.elapsedMs === 'number') {
    // eslint-disable-next-line no-console
    console.log(chalk.dim(`Elapsed: ${formatDuration(meta.elapsedMs)}`));
  }

  if (result.abortReason) {
    // eslint-disable-next-line no-console
    console.log(chalk.yellow(`Abort reason: ${result.abortReason}`));
  }

  if (opts.verbose) {
    if (result.lessonsLearned.length > 0) {
      // eslint-disable-next-line no-console
      console.log(chalk.hex('#FFB347')('Lessons learned:'));
      for (const l of result.lessonsLearned) {
        // eslint-disable-next-line no-console
        console.log(`  - ${l}`);
      }
    }
    if (result.actions.length > 0) {
      // eslint-disable-next-line no-console
      console.log(chalk.hex('#FFB347')('Action history:'));
      for (const a of result.actions) {
        const status = a.error ? chalk.red('✗') : chalk.green('✓');
        // eslint-disable-next-line no-console
        console.log(
          `  ${status} [${a.iteration}] ${a.decision.type}${a.error ? ` — ${a.error}` : ''}`,
        );
      }
    }
  }
  // eslint-disable-next-line no-console
  console.log();
}

// ─── Task A4 / Part 1: Sub-agent delegation helpers ──────────────────────

/**
 * Spawn sub-agents for the parallelizable, delegatable, dependency-free
 * tasks in `plan`. The sub-agents run in parallel (concurrency is bounded
 * by the `SubAgentManager`'s internal `p-limit`); their results are merged
 * into the parent's memory automatically via
 * `SubAgentManager.receiveReport` → `MemoryRouter.mergeSubAgentResult`.
 *
 * This function does **not** wait for all sub-agents to complete — it
 * spawns them and returns immediately so they can run concurrently with
 * the main agent loop. The caller may await `subAgentManager.waitForAll()`
 * later if it wants to block on completion.
 *
 * @param ctx              - The wired SANIX context.
 * @param plan             - The decomposed plan from the planner.
 * @param subAgentManager  - The sub-agent manager.
 * @param opts             - Execution flags (used for cwd + project).
 * @param signal           - Abort signal (passed to sub-agents via RunContext).
 * @returns The list of sub-agent spawn results (resolved once all complete).
 *          Returns an empty array when no tasks are delegatable.
 */
async function spawnSubAgentsForPlan(
  ctx: SanixContext,
  plan: Plan,
  subAgentManager: SubAgentManager,
  opts: ExecuteGoalOptions,
  signal: AbortSignal,
): Promise<SubAgentResult[]> {
  // Only spawn when the plan is parallelizable AND there are delegatable
  // tasks. The spec says "check `plan.parallelizable` and `plan.tasks` for
  // tasks with `canDelegate: true`".
  if (!plan.parallelizable) return [];
  const delegatableTasks = plan.tasks.filter(
    (t: TaskNode) =>
      t.canDelegate &&
      t.dependencies.length === 0 &&
      t.status === 'pending',
  );
  if (delegatableTasks.length === 0) return [];

  const runContext: RunContext = {
    config: ctx.config,
    cwd: opts.cwd ?? process.cwd(),
    seedMessages: opts.seedMessages,
    signal,
    project: opts.project,
    toolContext: buildToolContext(ctx, opts, signal),
  };

  // Convert TaskNode → SubTask and spawn each. The SubAgentManager's
  // internal p-limit bounds the concurrency; we spawn all delegatable
  // tasks up-front and let the manager queue them.
  for (const task of delegatableTasks) {
    const subTask: SubTask = {
      id: task.id,
      title: task.title,
      description: task.description,
      type: task.type,
      tools: task.tools,
      tokenBudget: task.tokenBudget,
    };
    try {
      await subAgentManager.spawn(subTask, runContext);
    } catch (err) {
      // Non-fatal — a single spawn failure shouldn't kill the run.
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn(chalk.yellow(`Sub-agent spawn failed for ${task.id}: ${msg}`));
    }
  }

  // Don't wait — return immediately so the caller can run the main loop
  // while sub-agents work in parallel. The caller will await
  // `subAgentManager.waitForAll()` after the main loop finishes.
  return [];
}

// ─── Task A4 / Part 7: result enrichment ─────────────────────────────────

/** Options accepted by {@link enrichResult}. */
export interface EnrichResultOptions {
  /** Sub-agent results collected during the run. */
  subAgentResults?: SubAgentResult[];
  /** Git commit SHAs recorded by AutoCommit. */
  gitCommits?: string[];
  /** Wall-clock elapsed time in milliseconds. */
  elapsedMs?: number;
  /** Workspace context detected at run start. */
  workspace?: WorkspaceContext | null;
}

/**
 * Augment an {@link AgentResult} with the Task A4 metadata envelope
 * (sub-agent results, git commits, elapsed time, workspace context, cost,
 * cache hit rate). The cost + cache hit rate are derived from the result's
 * action history (each {@link ActionRecord} carries tokens; the LLMResponse
 * on each action's TaskResult carries `costUsd` and `cacheHit`).
 *
 * @param result - The raw agent result.
 * @param opts   - The enrichment metadata.
 * @returns The augmented result (same identity, with a `sanix` envelope).
 */
export function enrichResult(
  result: AgentResult,
  opts: EnrichResultOptions,
): AugmentedAgentResult {
  // Compute cache hit rate + total cost from the action history.
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let costUsd = 0;
  for (const action of result.actions) {
    inputTokens += action.tokens.inputTokens;
    if (action.tokens.cacheReadTokens) {
      cacheReadTokens += action.tokens.cacheReadTokens;
    }
    if (action.tokens.cachedTokens) {
      cacheReadTokens += action.tokens.cachedTokens;
    }
    // The TaskResult on each action carries an llmResponse with costUsd.
    if (action.toolResult) {
      const r = action.toolResult as unknown as {
        llmResponse?: { costUsd?: number; cacheHit?: boolean };
      };
      if (r.llmResponse?.costUsd) {
        costUsd += r.llmResponse.costUsd;
      }
    }
  }
  const cacheHitRate =
    inputTokens > 0 ? cacheReadTokens / inputTokens : undefined;

  const augmented = result as AugmentedAgentResult;
  augmented.sanix = {
    subAgentResults: opts.subAgentResults,
    gitCommits: opts.gitCommits,
    elapsedMs: opts.elapsedMs,
    workspace: opts.workspace,
    costUsd: costUsd > 0 ? costUsd : undefined,
    cacheHitRate,
  };
  return augmented;
}

/** Format a millisecond duration as a compact human-readable string. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}min`;
  return `${(ms / 3_600_000).toFixed(1)}hr`;
}
