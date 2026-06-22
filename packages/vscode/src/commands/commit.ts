/**
 * @fileoverview `sanix.commit` — runs `sanix commit` to analyze staged changes
 * and generate a Conventional Commit message, then executes the commit.
 * @module sanix.vscode/commands/commit
 */
import * as vscode from "vscode";
import { runSanix } from "../providers/SanixCliProvider.js";

/** Factory that returns the command handler. */
export function commit(): () => Promise<void> {
  return async () => {
    const dryRun = await vscode.window.showQuickPick(
      [
        { label: "Dry-run (preview only)", value: true },
        { label: "Commit for real", value: false },
      ],
      { placeHolder: "SANIX commit — choose mode" },
    );
    if (!dryRun) return;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: "SANIX generating commit…" },
      async () => {
        const args = ["commit"];
        if (dryRun.value) args.push("--dry-run");
        const res = await runSanix(args);
        if (res.code !== 0) {
          vscode.window.showErrorMessage(`SANIX commit failed: ${res.stderr}`);
          return;
        }
        if (dryRun.value) {
          const confirm = await vscode.window.showInformationMessage(
            "SANIX generated this commit message:",
            "Apply",
            "Discard",
          );
          if (confirm === "Apply") {
            const real = await runSanix(["commit", "--no-verify"]);
            vscode.window.showInformationMessage(
              real.code === 0 ? "✓ SANIX committed." : `Failed: ${real.stderr}`,
            );
          }
        } else {
          vscode.window.showInformationMessage("✓ SANIX committed.");
        }
      },
    );
  };
}
