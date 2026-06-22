/**
 * @fileoverview `sanix.doctor` — runs `sanix doctor` and shows the health-check
 * report in a side-by-side markdown editor.
 * @module sanix.vscode/commands/doctor
 */
import * as vscode from "vscode";
import { runSanix } from "../providers/SanixCliProvider.js";

/** Factory that returns the command handler. */
export function doctor(): () => Promise<void> {
  return async () => {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: "SANIX running doctor…" },
      async () => {
        const res = await runSanix(["doctor", "--json"]);
        let content: string;
        if (res.code !== 0 && !res.stdout) {
          content = `# SANIX doctor failed\n\n\`\`\`\n${res.stderr}\n\`\`\``;
        } else {
          try {
            const json = JSON.parse(res.stdout) as { checks?: unknown[]; summary?: string };
            content = `# SANIX Doctor Report\n\n${json.summary ?? ""}\n\n\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\``;
          } catch {
            content = `# SANIX Doctor Report\n\n\`\`\`\n${res.stdout}\n\`\`\``;
          }
        }
        const doc = await vscode.workspace.openTextDocument({
          content,
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
