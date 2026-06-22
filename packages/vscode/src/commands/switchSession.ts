/**
 * @fileoverview `sanix.switchSession` — directly switches to a session id the
 * user types. (SessionsList is the friendlier UI; this is for keyboard users.)
 * @module sanix.vscode/commands/switchSession
 */
import * as vscode from "vscode";
import type { SessionWatcher } from "../providers/SessionWatcher.js";

/** Factory that returns the command handler. */
export function switchSession(sessions: SessionWatcher): () => Promise<void> {
  return async () => {
    const list = await sessions.listSessions();
    const id = await vscode.window.showInputBox({
      prompt: "SANIX — session id to switch to",
      placeHolder: list[0]?.id ?? "abc123",
      ignoreFocusOut: true,
    });
    if (!id) return;
    try {
      const s = await sessions.switchSession(id);
      vscode.window.showInformationMessage(
        s ? `SANIX: switched to ${s.name}` : `SANIX: switched to ${id}`,
      );
    } catch (err) {
      vscode.window.showErrorMessage(`SANIX: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}
