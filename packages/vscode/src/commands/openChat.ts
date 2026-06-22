/**
 * @fileoverview `sanix.openChat` — opens the SANIX sidebar chat view.
 * @module sanix.vscode/commands/openChat
 */
import * as vscode from "vscode";
import type { ChatViewProvider } from "../chat/ChatViewProvider.js";

/** Factory that returns the command handler. */
export function openChat(chat: ChatViewProvider): () => Promise<void> {
  return async () => {
    await vscode.commands.executeCommand("sanix.chatView.focus");
    chat.show();
  };
}
