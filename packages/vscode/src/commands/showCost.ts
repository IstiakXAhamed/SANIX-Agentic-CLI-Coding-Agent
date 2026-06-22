/**
 * @fileoverview `sanix.showCost` — shows today's SANIX cost (USD) via an
 * InformationMessage + updates the status bar.
 * @module sanix.vscode/commands/showCost
 */
import * as vscode from "vscode";
import { runSanix } from "../providers/SanixCliProvider.js";
import type { StatusBar } from "../status/StatusBar.js";

/** Factory that returns the command handler. */
export function showCost(statusBar: StatusBar): () => Promise<void> {
  return async () => {
    const res = await runSanix(["cost", "--today", "--json"]);
    let usd = 0;
    let detail = "";
    if (res.code === 0) {
      try {
        const json = JSON.parse(res.stdout) as {
          totalUsd?: number;
          usd?: number;
          tokens?: { input?: number; output?: number };
        };
        usd = json.totalUsd ?? json.usd ?? 0;
        if (json.tokens) {
          detail = ` (${json.tokens.input ?? 0} in / ${json.tokens.output ?? 0} out tokens)`;
        }
      } catch {
        /* fall back to text */
      }
    }
    statusBar.setCostToday(usd);
    const formatted = usd >= 1 ? `$${usd.toFixed(2)}` : `${usd.toFixed(4)} USD`;
    vscode.window.showInformationMessage(`SANIX cost today: ${formatted}${detail}`);
  };
}
