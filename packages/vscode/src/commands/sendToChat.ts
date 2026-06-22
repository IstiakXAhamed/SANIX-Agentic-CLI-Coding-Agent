/**
 * @fileoverview `sanix.sendToChat` — sends the active editor's selection into
 * the SANIX chat sidebar (with surrounding context).
 * @module sanix.vscode/commands/sendToChat
 */
import * as vscode from "vscode";
import type { ChatViewProvider } from "../chat/ChatViewProvider.js";

/** Factory that returns the command handler. */
export function sendToChat(chat: ChatViewProvider): () => Promise<void> {
  return async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage("SANIX: open a file first.");
      return;
    }
    const sel = editor.selection;
    const text = editor.document.getText(sel);
    if (!text.trim()) {
      vscode.window.showWarningMessage("SANIX: select some text first.");
      return;
    }
    const lang = editor.document.languageId;
    const rel = vscode.workspace.asRelativePath(editor.document.uri);
    const prompt = [
      `Here is a snippet from \`${rel}\` (language: ${lang}):`,
      "",
      "```" + lang,
      text,
      "```",
      "",
      "Briefly explain what this code does and suggest one improvement.",
    ].join("\n");
    await vscode.commands.executeCommand("sanix.chatView.focus");
    chat.show();
    await chat.sendUserMessage(prompt);
  };
}
