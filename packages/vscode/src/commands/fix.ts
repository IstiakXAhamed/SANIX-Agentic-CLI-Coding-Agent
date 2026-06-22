/**
 * @fileoverview `sanix.fix` — runs `sanix fix` on the active file and applies
 * the suggested edits.
 * @module sanix.vscode/commands/fix
 */
import * as vscode from "vscode";
import { runSanix } from "../providers/SanixCliProvider.js";

/** Factory that returns the command handler. */
export function fix(): () => Promise<void> {
  return async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage("SANIX: open a file to fix.");
      return;
    }
    const rel = vscode.workspace.asRelativePath(editor.document.uri);
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: "SANIX fixing…" },
      async () => {
        const res = await runSanix(["fix", "--file", rel]);
        if (res.code !== 0) {
          vscode.window.showErrorMessage(`SANIX fix failed: ${res.stderr}`);
          return;
        }
        const doc = await vscode.workspace.openTextDocument({
          content: res.stdout || "(no issues found — file is clean)",
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
