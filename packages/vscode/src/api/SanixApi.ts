/**
 * @fileoverview Public programmatic API exported to other VS Code extensions.
 * @module sanix.vscode/api
 *
 * Other extensions can call:
 *
 * ```ts
 * const sanix = vscode.extensions.getExtension<SanixPublicApi>("istiak-ahamed.sanix")?.exports;
 * const answer = await sanix?.ask("What does this codebase do?");
 * ```
 */
import { runSanix } from "../providers/SanixCliProvider.js";
import { runIntelligencePipeline } from "../intelligence/PipelineProxy.js";
import { SessionWatcher } from "../providers/SessionWatcher.js";
import type { SanixPublicApi, SanixSession } from "../types.js";

/**
 * Build the public API surface, wired to the live SessionWatcher instance.
 * @param sessions active SessionWatcher (created by the extension entry point)
 */
export function createPublicApi(sessions: SessionWatcher): SanixPublicApi {
  return {
    async ask(prompt, opts) {
      const args = ["ask"];
      if (opts?.model) args.push("--model", opts.model);
      args.push(prompt);
      const res = await runSanix(args, { cwd: opts?.cwd });
      if (res.code !== 0) throw new Error(res.stderr || `exit ${res.code}`);
      return res.stdout;
    },
    async runAgent(agent, prompt, opts) {
      const res = await runSanix(["agent", "run", agent, prompt], { cwd: opts?.cwd });
      if (res.code !== 0) throw new Error(res.stderr || `exit ${res.code}`);
      return res.stdout;
    },
    async runUltraWorker(goal, opts) {
      const res = await runSanix(["agent", "run", "ultra-worker", goal], { cwd: opts?.cwd });
      if (res.code !== 0) throw new Error(res.stderr || `exit ${res.code}`);
      return res.stdout;
    },
    async vision(imagePath, prompt, opts) {
      const args = ["ask", "--image", imagePath];
      if (opts?.model) args.push("--model", opts.model);
      args.push(prompt);
      const res = await runSanix(args);
      if (res.code !== 0) throw new Error(res.stderr || `exit ${res.code}`);
      return res.stdout;
    },
    async runIntelligencePipeline(task, opts) {
      return runIntelligencePipeline(task, opts);
    },
    async getCostToday() {
      const res = await runSanix(["cost", "--today", "--json"]);
      if (res.code !== 0) return 0;
      try {
        const parsed = JSON.parse(res.stdout) as { totalUsd?: number; usd?: number };
        return parsed.totalUsd ?? parsed.usd ?? 0;
      } catch {
        return 0;
      }
    },
    async getActiveSession(): Promise<SanixSession | null> {
      const id = sessions.getActiveId();
      if (!id) return null;
      const list = await sessions.listSessions();
      return list.find((s) => s.id === id) ?? null;
    },
    async switchSession(sessionId) {
      if (sessionId) return sessions.switchSession(sessionId);
      const list = await sessions.listSessions();
      return list[0] ?? null;
    },
  };
}
