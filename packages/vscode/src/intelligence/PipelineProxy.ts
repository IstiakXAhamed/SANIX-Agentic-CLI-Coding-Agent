/**
 * @fileoverview Thin proxy to the V16 intelligence pipeline running inside the
 * SANIX CLI. Activated when a chat message starts with `/intel `.
 * @module sanix.vscode/intelligence/PipelineProxy
 */
import { runSanix } from "../providers/SanixCliProvider.js";

/**
 * Run the V16 10-step intelligence pipeline on a task via the CLI.
 * Equivalent to: `sanix intelligence run "<task>"`
 *
 * The pipeline makes at most 2 LLM calls per task:
 *   1. generation (pattern-matched + context-injected + assembled)
 *   2. verification fix (only if the first output fails the quality gate)
 *
 * @param task natural-language description of the task
 * @param opts optional cwd override
 * @returns the pipeline's final output (stdout of `sanix intelligence run`)
 */
export async function runIntelligencePipeline(
  task: string,
  opts: { cwd?: string } = {},
): Promise<string> {
  const res = await runSanix(["intelligence", "run", "--json", task], opts);
  if (res.code !== 0) {
    throw new Error(
      `SANIX intelligence pipeline failed (code ${res.code}): ${res.stderr || res.stdout}`,
    );
  }
  // CLI returns a JSON object with `{ output, ...metrics }` — extract the text.
  try {
    const parsed = JSON.parse(res.stdout) as { output?: string };
    if (parsed.output) return parsed.output;
  } catch {
    /* not JSON — fall through to raw stdout */
  }
  return res.stdout;
}

/**
 * Returns true if `text` is a `/intel`-prefixed chat message that should be
 * routed through the V16 pipeline.
 */
export function isIntelRequest(text: string): boolean {
  return /^\s*\/intel(\s+|$)/.test(text);
}

/** Strip the `/intel ` prefix from a chat message. */
export function stripIntelPrefix(text: string): string {
  return text.replace(/^\s*\/intel\s+/, "");
}
