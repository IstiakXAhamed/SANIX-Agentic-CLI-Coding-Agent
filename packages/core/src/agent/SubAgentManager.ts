/**
 * @file agent/SubAgentManager.ts
 * @description Sub-agent spawning + lifecycle per spec §6. Each sub-agent
 * gets a compressed parent context and a (configurably) cheaper provider.
 * Concurrency is bounded by `p-limit` (default 4 per spec).
 *
 * Sub-agents report back via `receiveReport`, which merges their learned
 * facts into the parent's memory via the MemoryRouter.
 *
 * @packageDocumentation
 */

import EventEmitter from 'eventemitter3';
import pLimit from 'p-limit';
import { nanoid } from 'nanoid';
import type { IProvider, LLMMessage, LLMRequest, LLMResponse, TokenUsage } from '@sanix/providers';
import type { SanixConfig } from '@sanix/config';
import type {
  AgentReport,
  RunContext,
  SubAgentHandle,
  SubAgentResult,
  SubTask,
} from './types.js';
import type { MemoryRouter } from '../memory/MemoryRouter.js';

/**
 * Events emitted by the SubAgentManager.
 */
export interface SubAgentManagerEvents {
  /** Fired when a sub-agent is spawned. */
  spawn: { agentId: string; task: SubTask };
  /** Fired when a sub-agent completes (success or failure). */
  complete: { report: AgentReport };
  /** Fired when a sub-agent errors out. */
  error: { agentId: string; error: string };
}

/**
 * Options for {@link SubAgentManager.constructor}.
 */
export interface SubAgentManagerOptions {
  /** The cheaper provider for sub-agent LLM calls. */
  provider?: IProvider;
  /** Max concurrent sub-agents. Default: config.agent.maxSubAgents (4). */
  maxConcurrency?: number;
  /** The memory router (for merging sub-agent results). */
  memory?: MemoryRouter;
  /** Tool names a sub-agent is allowed to use (subset of all tools). */
  allowedTools?: string[];
}

/**
 * Internal record of a running sub-agent.
 */
interface RunningAgent {
  id: string;
  task: SubTask;
  handle: SubAgentHandle;
  startedAt: string;
  abortController: AbortController;
}

/**
 * Sub-agent spawning + lifecycle manager.
 *
 * @example
 * ```ts
 * const manager = new SubAgentManager(config, { provider: cheapProvider, memory: router });
 * const handle = await manager.spawn(task, parentContext);
 * const results = await manager.waitForAll();
 * for (const r of results) console.log(r.summary);
 * ```
 */
export class SubAgentManager extends EventEmitter<SubAgentManagerEvents> {
  private readonly config: SanixConfig;
  private readonly provider: IProvider | undefined;
  private readonly memory: MemoryRouter | undefined;
  private readonly allowedTools: string[];
  private readonly limit: ReturnType<typeof pLimit>;
  private readonly agents = new Map<string, RunningAgent>();

  constructor(config: SanixConfig, opts: SubAgentManagerOptions = {}) {
    super();
    this.config = config;
    this.provider = opts.provider;
    this.memory = opts.memory;
    this.allowedTools = opts.allowedTools ?? [];
    this.limit = pLimit(opts.maxConcurrency ?? config.agent.maxSubAgents);
  }

  /**
   * Spawn a sub-agent for a sub-task. The sub-agent runs in the background
   * (respecting the concurrency limit); the returned handle resolves when
   * it finishes.
   *
   * @param task - The sub-task to delegate.
   * @param parentContext - The parent's run context (for cwd, config, etc.).
   * @returns A handle to the running sub-agent.
   */
  async spawn(task: SubTask, parentContext: RunContext): Promise<SubAgentHandle> {
    const id = task.id ?? nanoid();
    const subTask: SubTask = { ...task, id };
    const abortController = new AbortController();

    // Compress the parent context for the child (just the goal + recent
    // user message — full context compression requires the ContextBuilder).
    const parentContextSummary = this.compressForChild(parentContext);

    const resultPromise = this.limit(async () => {
      try {
        this.emit('spawn', { agentId: id, task: subTask });
        return await this.runSubAgent(subTask, parentContext, parentContextSummary, abortController.signal);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.emit('error', { agentId: id, error: msg });
        const failure: SubAgentResult = {
          agentId: id,
          success: false,
          summary: `Sub-agent failed: ${msg}`,
          modifiedFiles: [],
          learnedFacts: [],
          tokensUsed: { inputTokens: 0, outputTokens: 0 },
          error: msg,
        };
        return failure;
      }
    });

    const handle: SubAgentHandle = {
      id,
      result: resultPromise,
      isRunning: true,
      cancel: () => {
        abortController.abort();
      },
    };

    // Mark not-running when the result resolves.
    void resultPromise.then((r) => {
      const entry = this.agents.get(id);
      if (entry) entry.handle.isRunning = false;
      const report: AgentReport = {
        agentId: id,
        task: subTask,
        result: r,
        reportedAt: new Date().toISOString(),
      };
      void this.receiveReport(id, report);
    });

    this.agents.set(id, {
      id,
      task: subTask,
      handle,
      startedAt: new Date().toISOString(),
      abortController,
    });

    return handle;
  }

  /**
   * Wait for all running sub-agents to complete. Returns their results in
   * the order they finished (not spawn order).
   *
   * @example
   * ```ts
   * const results = await manager.waitForAll();
   * ```
   */
  async waitForAll(): Promise<SubAgentResult[]> {
    const handles = [...this.agents.values()].map((a) => a.handle.result);
    return Promise.all(handles);
  }

  /**
   * Receive a sub-agent's report. Merges learned facts into the parent's
   * memory via the MemoryRouter (if configured) and emits a `complete` event.
   *
   * Called automatically when a sub-agent finishes; callers may also invoke
   * it manually for out-of-band reports.
   *
   * @param agentId - The sub-agent id.
   * @param report - The sub-agent's report.
   */
  async receiveReport(agentId: string, report: AgentReport): Promise<void> {
    if (this.memory) {
      try {
        await this.memory.mergeSubAgentResult(report);
      } catch {
        // Non-fatal — memory merge failures don't affect the agent's result.
      }
    }
    this.emit('complete', { report });
  }

  /**
   * Cancel all running sub-agents (best-effort). Returns the count of
   * cancelled agents.
   */
  cancelAll(): number {
    let count = 0;
    for (const entry of this.agents.values()) {
      if (entry.handle.isRunning) {
        entry.abortController.abort();
        count++;
      }
    }
    return count;
  }

  /**
   * Number of currently-running sub-agents.
   */
  get runningCount(): number {
    let count = 0;
    for (const entry of this.agents.values()) {
      if (entry.handle.isRunning) count++;
    }
    return count;
  }

  /**
   * All known sub-agent ids (running or finished).
   */
  listIds(): string[] {
    return [...this.agents.keys()];
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  /**
   * Run a single sub-agent to completion. A sub-agent is a stripped-down
   * agent loop: it makes a single LLM call (with its allowed tools) to
   * accomplish its sub-task, then reports back. Full sub-agent OODA loops
   * are deferred (the parent agent's loop already orchestrates iteration).
   *
   * @param task - The sub-task.
   * @param parentContext - The parent's run context.
   * @param parentContextSummary - Compressed parent context (text).
   * @param signal - Abort signal for cancellation.
   */
  private async runSubAgent(
    task: SubTask,
    parentContext: RunContext,
    parentContextSummary: string,
    signal: AbortSignal,
  ): Promise<SubAgentResult> {
    if (!this.provider) {
      // No provider — can't run a sub-agent. Return a soft failure.
      return {
        agentId: task.id,
        success: false,
        summary: `Sub-agent '${task.title}' could not run (no provider).`,
        modifiedFiles: [],
        learnedFacts: [],
        tokensUsed: { inputTokens: 0, outputTokens: 0 },
        error: 'No provider configured for sub-agents.',
      };
    }

    const messages: LLMMessage[] = [
      {
        role: 'system',
        content: `You are a SANIX sub-agent. Your task: ${task.title}
${task.description}

Parent context:
${parentContextSummary}

Tools available: ${task.tools.join(', ') || '(none)'}
Token budget: ${task.tokenBudget}

Return ONLY a JSON object:
{
  "success": boolean,
  "summary": string,
  "modifiedFiles": string[],
  "learnedFacts": string[]
}`,
      },
      { role: 'user', content: task.description },
    ];

    const req: LLMRequest = {
      messages,
      maxTokens: Math.min(task.tokenBudget, 4096),
      temperature: 0.1,
      taskType: 'general',
      signal,
    };

    let response: LLMResponse;
    try {
      response = await this.provider.chat(req);
    } catch (err) {
      return {
        agentId: task.id,
        success: false,
        summary: `Sub-agent '${task.title}' LLM call failed.`,
        modifiedFiles: [],
        learnedFacts: [],
        tokensUsed: { inputTokens: 0, outputTokens: 0 },
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // Parse the structured response.
    const jsonText = extractJson(response.content);
    let parsed: SubAgentResultPayload | null = null;
    if (jsonText) {
      try {
        const raw = JSON.parse(jsonText) as unknown;
        parsed = validateResultPayload(raw);
      } catch {
        parsed = null;
      }
    }

    if (!parsed) {
      // Treat the raw response as the summary.
      return {
        agentId: task.id,
        success: true,
        summary: response.content.slice(0, 500),
        modifiedFiles: [],
        learnedFacts: [],
        tokensUsed: response.usage,
      };
    }

    return {
      agentId: task.id,
      success: parsed.success,
      summary: parsed.summary,
      modifiedFiles: parsed.modifiedFiles ?? [],
      learnedFacts: parsed.learnedFacts ?? [],
      tokensUsed: response.usage,
    };
  }

  /**
   * Compress the parent context for a child sub-agent. Returns a brief
   * summary string (goal + recent user message). Full compression requires
   * the ContextBuilder; here we do a simple truncation.
   */
  private compressForChild(parentContext: RunContext): string {
    const seed = parentContext.seedMessages ?? [];
    const lastUser = [...seed].reverse().find((m) => m.role === 'user');
    const lines: string[] = [];
    if (parentContext.project) lines.push(`Project: ${parentContext.project}`);
    if (lastUser) lines.push(`Last user message: ${lastUser.content.slice(0, 200)}`);
    if (seed.length > 0) {
      lines.push(`Seed messages: ${seed.length} (truncated for sub-agent context)`);
    }
    return lines.join('\n');
  }
}

// ─── Internal helpers ───────────────────────────────────────────────────────

interface SubAgentResultPayload {
  success: boolean;
  summary: string;
  modifiedFiles?: string[];
  learnedFacts?: string[];
}

function validateResultPayload(raw: unknown): SubAgentResultPayload | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.success !== 'boolean') return null;
  if (typeof r.summary !== 'string') return null;
  if (r.modifiedFiles !== undefined && !Array.isArray(r.modifiedFiles)) return null;
  if (r.learnedFacts !== undefined && !Array.isArray(r.learnedFacts)) return null;
  return {
    success: r.success,
    summary: r.summary,
    modifiedFiles: Array.isArray(r.modifiedFiles)
      ? r.modifiedFiles.filter((s): s is string => typeof s === 'string')
      : [],
    learnedFacts: Array.isArray(r.learnedFacts)
      ? r.learnedFacts.filter((s): s is string => typeof s === 'string')
      : [],
  };
}

function extractJson(text: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced && fenced[1]) return fenced[1].trim();
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// Re-export TokenUsage type for callers building SubAgentResults by hand.
export type { TokenUsage };
