/**
 * @fileoverview `sanix.explain` — explains the active selection via `sanix explain`.
 * @module sanix.vscode/commands/explain
 */
import * as vscode from "vscode";
import { runSanix } from "../providers/SanixCliProvider.js";

/** Factory that returns the command handler. */
export function explain(): () => Promise<void> {
  return async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage("SANIX: open a file first.");
      return;
    }
    const sel = editor.selection;
    const text = sel.isEmpty
      ? editor.document.getText()
      : editor.document.getText(sel);
    if (!text.trim()) {
      vscode.window.showWarningMessage("SANIX: nothing to explain.");
      return;
    }
    const rel = vscode.workspace.asRelativePath(editor.document.uri);
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: "SANIX explaining…" },
      async () => {
        const res = await runSanix(["explain", "--format", "markdown", `${rel}:${sel.start.line + 1}`]);
        if (res.code !== 0) {
          // Fallback: just `ask` the model directly
          const fallback = await runSanix([
            "ask",
            `Explain this code from ${rel}:\n\n\`\`\`${editor.document.languageId}\n${text}\n\`\`\``,
          ]);
          showInBesideEditor(fallback.code === 0 ? fallback.stdout : fallback.stderr);
          return;
        }
        showInBesideEditor(res.stdout);
      },
    );
  };
}

async function showInBesideEditor(content: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({ content, language: "markdown" });
  await vscode.window.showTextDocument(doc, {
    preview: true,
    viewColumn: vscode.ViewColumn.Beside,
  });
}
