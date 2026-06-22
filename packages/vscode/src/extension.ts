/**
 * @fileoverview SANIX VSCode extension entry point.
 * @module sanix.vscode/extension
 *
 * Activation:
 *   - Registers 12 commands
 *   - Registers the chat webview-view provider (`sanix.chatView`)
 *   - Creates the status bar item
 *   - Starts the SessionWatcher (auto-attaches to active SANIX session)
 *   - Exposes the public API to other extensions via `extension.exports`
 *
 * Deactivation:
 *   - Disposes all registered disposables
 */
import * as vscode from "vscode";
import * as path from "node:path";
import { chmodSync, existsSync } from "node:fs";
import { ChatViewProvider } from "./chat/ChatViewProvider.js";
import { createPublicApi } from "./api/SanixApi.js";
import { SessionWatcher } from "./providers/SessionWatcher.js";
import { StatusBar } from "./status/StatusBar.js";
import { setBundledExtensionPath } from "./providers/SanixCliProvider.js";
import { openChat } from "./commands/openChat.js";
import { sendToChat } from "./commands/sendToChat.js";
import { inlineEdit } from "./commands/inlineEdit.js";
import { runAgent } from "./commands/runAgent.js";
import { runUltraWorker } from "./commands/runUltraWorker.js";
import { explain } from "./commands/explain.js";
import { fix } from "./commands/fix.js";
import { commit } from "./commands/commit.js";
import { doctor } from "./commands/doctor.js";
import { sessionsList } from "./commands/sessionsList.js";
import { switchSession } from "./commands/switchSession.js";
import { showCost } from "./commands/showCost.js";
import { getConfig } from "./config.js";

/** Aggregate of every disposable the extension creates. */
const disposables: vscode.Disposable[] = [];

/**
 * Ensure the bundled CLI bootstrap script is executable on Unix platforms.
 * VS Code extracts the VSIX without preserving file permissions, so we must
 * set +x explicitly before the first `spawn()` call.
 */
function ensureBundledBinaryExecutable(extPath: string): void {
  try {
    const { platform } = process;
    if (platform === "win32") return; // Windows handles .exe association

    let platformDir: string;
    const arch = process.arch;
    if (platform === "darwin" && arch === "arm64") platformDir = "macos-arm64";
    else if (platform === "darwin" && arch === "x64") platformDir = "macos-x64";
    else if (platform === "linux" && arch === "x64") platformDir = "linux-x64";
    else return; // unsupported platform — skip

    const binaryPath = path.join(extPath, "bin", platformDir, "sanix");
    if (existsSync(binaryPath)) {
      chmodSync(binaryPath, 0o755);
    }
  } catch {
    // Non-fatal: if chmod fails, spawn will fail with EACCES, which the
    // existing error handling in runSanix/streamSanix already catches.
  }
}

/** VS Code extension entry point. */
export async function activate(context: vscode.ExtensionContext): Promise<unknown> {
  // Self-contained runtime: inject extension path for bundled binary resolution
  // and ensure the bootstrap scripts are executable on Unix.
  setBundledExtensionPath(context.extensionPath);
  ensureBundledBinaryExecutable(context.extensionPath);

  const statusBar = new StatusBar();
  disposables.push(statusBar);
  if (getConfig().showStatusBar) statusBar.show();

  const sessions = new SessionWatcher();
  disposables.push(sessions);
  await sessions.start();
  sessions.onChange((id) => {
    statusBar.setActiveSession(id);
  });
  statusBar.setActiveSession(sessions.getActiveId());

  const chat = new ChatViewProvider(context, (state) => {
    statusBar.setState(state);
  });
  disposables.push(chat);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chat, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // Register all 12 commands.
  context.subscriptions.push(
    vscode.commands.registerCommand("sanix.openChat", openChat(chat)),
    vscode.commands.registerCommand("sanix.sendToChat", sendToChat(chat)),
    vscode.commands.registerCommand("sanix.inlineEdit", inlineEdit()),
    vscode.commands.registerCommand("sanix.runAgent", runAgent()),
    vscode.commands.registerCommand("sanix.runUltraWorker", runUltraWorker()),
    vscode.commands.registerCommand("sanix.explain", explain()),
    vscode.commands.registerCommand("sanix.fix", fix()),
    vscode.commands.registerCommand("sanix.commit", commit()),
    vscode.commands.registerCommand("sanix.doctor", doctor()),
    vscode.commands.registerCommand("sanix.sessionsList", sessionsList(sessions)),
    vscode.commands.registerCommand("sanix.switchSession", switchSession(sessions)),
    vscode.commands.registerCommand("sanix.showCost", showCost(statusBar)),
  );

  // Re-render status bar + push active-session id whenever config changes.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("sanix")) {
        if (getConfig().showStatusBar) statusBar.show();
        else statusBar.hide();
      }
    }),
  );

  // Poll cost every 5 minutes (best-effort).
  const costTimer = setInterval(async () => {
    const res = await import("./providers/SanixCliProvider.js").then((m) =>
      m.runSanix(["cost", "--today", "--json"]),
    );
    if (res.code === 0) {
      try {
        const json = JSON.parse(res.stdout) as { totalUsd?: number; usd?: number };
        statusBar.setCostToday(json.totalUsd ?? json.usd ?? 0);
      } catch {
        /* ignore */
      }
    }
  }, 5 * 60 * 1000);
  disposables.push({ dispose: () => clearInterval(costTimer) });

  // Expose the public API to other extensions.
  return createPublicApi(sessions);
}

/** VS Code extension deactivation. */
export function deactivate(): void {
  for (const d of disposables) d.dispose();
  disposables.length = 0;
}
