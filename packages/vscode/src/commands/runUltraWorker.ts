/**
 * @fileoverview `sanix.runUltraWorker` — runs the UltraWorker orchestrator on
 * a goal the user enters via InputBox. Output opens in a side-by-side editor.
 * @module sanix.vscode/commands/runUltraWorker
 */
import * as vscode from "vscode";
import { runSanix } from "../providers/SanixCliProvider.js";

/** Factory that returns the command handler. */
export function runUltraWorker(): () => Promise<void> {
  return async () => {
    const goal = await vscode.window.showInputBox({
      prompt: "SANIX UltraWorker — describe the high-level goal",
      placeHolder: "e.g. Add a /health endpoint with tests, docs, and CI step",
      ignoreFocusOut: true,
    });
    if (!goal) return;
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "SANIX UltraWorker orchestrating…",
        cancellable: true,
      },
      async (_progress, token) => {
        const res = await runSanix(["agent", "run", "ultra-worker", goal], { token });
        if (res.code !== 0) {
          vscode.window.showErrorMessage(`UltraWorker failed: ${res.stderr}`);
          return;
        }
        const doc = await vscode.workspace.openTextDocument({
          content: res.stdout,
          language: "markdown",
        });
        await vscode.window.showTextDocument(doc, {
          preview: true,
          viewColumn: vscode.ViewColumn.Beside,
        });
      },
    );
  };
}
