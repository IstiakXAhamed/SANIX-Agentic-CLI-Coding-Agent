/**
 * @fileoverview `sanix.sessionsList` — shows all SANIX sessions in a QuickPick.
 * @module sanix.vscode/commands/sessionsList
 */
import * as vscode from "vscode";
import type { SessionWatcher } from "../providers/SessionWatcher.js";

/** Factory that returns the command handler. */
export function sessionsList(sessions: SessionWatcher): () => Promise<void> {
  return async () => {
    const list = await sessions.listSessions();
    if (list.length === 0) {
      vscode.window.showInformationMessage("SANIX: no sessions yet — send a message to create one.");
      return;
    }
    const items = list.map((s) => ({
      id: s.id,
      label: s.active ? "$(check) " + s.name : s.name,
      description: `${s.messageCount} msgs`,
      detail: `id: ${s.id} · updated ${s.updatedAt}`,
    }));
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: "SANIX sessions — pick one to switch to",
    });
    if (pick) {
      await sessions.switchSession(pick.id);
      vscode.window.showInformationMessage(`SANIX: switched to session ${pick.id}`);
    }
  };
}
