/**
 * @fileoverview `sanix.runAgent` — QuickPick of the 22 SANIX agents,
 * then runs the selected agent on the active selection (or full file).
 * @module sanix.vscode/commands/runAgent
 */
import * as vscode from "vscode";
import { runSanix } from "../providers/SanixCliProvider.js";

/** The 22 specialized agents built into SANIX (V12-1). */
const AGENTS: { id: string; label: string; detail: string }[] = [
  { id: "coder", label: "Coder", detail: "Writes / refactors production code" },
  { id: "reviewer", label: "Reviewer", detail: "Code review with 52-rule lints" },
  { id: "ultra-worker", label: "UltraWorker", detail: "Master orchestrator (max 4 parallel agents)" },
  { id: "architect", label: "Architect", detail: "System design + ADRs" },
  { id: "tester", label: "Tester", detail: "Test generation (vitest/jest/pytest)" },
  { id: "doc-writer", label: "Doc Writer", detail: "JSDoc + README + API docs" },
  { id: "debugger", label: "Debugger", detail: "Root-cause analysis" },
  { id: "optimizer", label: "Optimizer", detail: "Performance + token optimization" },
  { id: "security-auditor", label: "Security Auditor", detail: "OWASP top-10 scan" },
  { id: "data-scientist", label: "Data Scientist", detail: "Analysis + notebooks" },
  { id: "devops-engineer", label: "DevOps Engineer", detail: "Docker + CI + IaC" },
  { id: "ui-designer", label: "UI Designer", detail: "Wireframes + design system" },
  { id: "api-designer", label: "API Designer", detail: "OpenAPI + RPC schema" },
  { id: "prompt-engineer", label: "Prompt Engineer", detail: "Meta prompt synthesis" },
  { id: "researcher", label: "Researcher", detail: "Web search + citations" },
  { id: "tutor", label: "Tutor", detail: "Step-by-step explanations" },
  { id: "transpiler", label: "Transpiler", detail: "Cross-language translation" },
  { id: "git-wrangler", label: "Git Wrangler", detail: "Merge-conflict resolution" },
  { id: "migration-helper", label: "Migration Helper", detail: "Version bumps + codemods" },
  { id: "qa-engineer", label: "QA Engineer", detail: "E2E test planning" },
  { id: "ml-engineer", label: "ML Engineer", detail: "Model training + eval" },
  { id: "completionist", label: "Completionist", detail: "Fills in TODOs + stubs" },
];

/** Factory that returns the command handler. */
export function runAgent(): () => Promise<void> {
  return async () => {
    const editor = vscode.window.activeTextEditor;
    const pick = await vscode.window.showQuickPick(
      AGENTS.map((a) => ({ id: a.id, label: a.label, detail: a.detail })),
      { placeHolder: "Run a SANIX agent…" },
    );
    if (!pick) return;
    const sel = editor?.selection;
    const text = sel && !sel.isEmpty ? editor!.document.getText(sel) : "";
    const prompt = text
      ? `Act on this code:\n\n\`\`\`${editor!.document.languageId}\n${text}\n\`\`\``
      : "(no selection — describe what you want)";
    const res = await runSanix(["agent", "run", pick.id, prompt]);
    if (res.code !== 0) {
      vscode.window.showErrorMessage(`SANIX agent ${pick.id} failed: ${res.stderr}`);
      return;
    }
    const doc = await vscode.workspace.openTextDocument({
      content: res.stdout,
      language: "markdown",
    });
    await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
  };
}
