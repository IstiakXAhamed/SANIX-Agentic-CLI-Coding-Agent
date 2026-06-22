/**
 * @fileoverview `sanix.inlineEdit` — Cmd/Ctrl+K inline edit box.
 * Shows an input box above the selection; the LLM's response replaces the
 * selection (with native undo).
 * @module sanix.vscode/commands/inlineEdit
 */
import * as vscode from "vscode";
import { getConfig } from "../config.js";
import { runSanix } from "../providers/SanixCliProvider.js";

/** Factory that returns the command handler. */
export function inlineEdit(): () => Promise<void> {
  return async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const sel = editor.selection;
    const text = editor.document.getText(sel);
    if (!text.trim()) {
      vscode.window.showWarningMessage("SANIX: select some text to edit (Cmd/Ctrl+K).");
      return;
    }
    const cfg = getConfig();
    const truncated = text.length > cfg.maxInlineSelectionChars
      ? text.slice(0, cfg.maxInlineSelectionChars) + "\n/* …truncated… */"
      : text;
    const instruction = await vscode.window.showInputBox({
      prompt: "SANIX inline edit — describe the change",
      placeHolder: "e.g. rename `foo` to `bar`, add error handling, convert to async…",
      ignoreFocusOut: true,
    });
    if (!instruction) return;
    const prompt = [
      `Edit the following ${editor.document.languageId} code. Only output the new code, no explanation.`,
      `Instruction: ${instruction}`,
      "",
      "```" + editor.document.languageId,
      truncated,
      "```",
    ].join("\n");
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: "SANIX editing…" },
      async () => {
        const res = await runSanix(["ask", "--model", cfg.defaultModel, "--no-markdown", prompt]);
        if (res.code !== 0) {
          vscode.window.showErrorMessage(`SANIX edit failed: ${res.stderr || `exit ${res.code}`}`);
          return;
        }
        const replacement = stripCodeFence(res.stdout, editor.document.languageId);
        editor.edit((b) => b.replace(sel, replacement));
      },
    );
  };
}

/** Strip ```lang fences from the model's response (for inline edit). */
function stripCodeFence(s: string, lang: string): string {
  const fence = new RegExp(`^\`\`\`${lang}?\\s*\\n([\\s\\S]*?)\\n\`\`\`\\s*$`, "i");
  const m = s.trim().match(fence);
  return m ? m[1]! : s.trim();
}
