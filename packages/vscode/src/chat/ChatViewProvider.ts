/**
 * @fileoverview Sidebar chat webview for SANIX.
 * @module sanix.vscode/chat/ChatPanel
 *
 * Implements the webview view registered as `sanix.chatView` in the activity
 * bar. Handles:
 *   - rendering the chat HTML/CSS/JS
 *   - bidirectional messaging with the webview (postMessage protocol)
 *   - streaming CLI output chunk-by-chunk into the webview
 *   - applying ```diff blocks via the DiffApplier
 *   - slash-command dispatch (/clear, /agent, /session, /cost, /model, /provider, /help)
 */
import * as vscode from "vscode";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { getConfig } from "../config.js";
import { runSanix, streamSanix } from "../providers/SanixCliProvider.js";
import { applyDiffs, parseDiffs } from "../diff/DiffApplier.js";
import {
  isIntelRequest,
  runIntelligencePipeline,
  stripIntelPrefix,
} from "../intelligence/PipelineProxy.js";
import type { ChatMessage } from "../types.js";

/** Inbound messages from the webview. */
type Inbound =
  | { type: "ready" }
  | { type: "send"; text: string; images?: string[] }
  | { type: "stop" }
  | { type: "applyDiff"; messageId: string };

/** Outbound messages to the webview. */
type Outbound =
  | { type: "history"; messages: ChatMessage[] }
  | { type: "append"; id: string; chunk: string }
  | { type: "done"; id: string; costUsd?: number }
  | { type: "error"; id: string; message: string }
  | { type: "config"; config: Record<string, unknown> }
  | { type: "clear" };

/**
 * VS Code webview-view provider for the SANIX chat sidebar.
 */
export class ChatViewProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  public static readonly viewType = "sanix.chatView";
  private view?: vscode.WebviewView;
  private history: ChatMessage[] = [];
  private activeStreamCts?: vscode.CancellationTokenSource;
  private readonly disposables: vscode.Disposable[] = [];
  /** Streamed messages by id — used to assemble final content for diff parsing. */
  private readonly inflight = new Map<string, string>();

  /**
   * @param context extension activation context (used to resolve webview URIs)
   * @param onStateChange callback invoked when backend state changes (for status bar)
   */
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onStateChange: (state: "idle" | "running" | "streaming" | "error") => void,
  ) {}

  /** Required by `WebviewViewProvider`. */
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview"),
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
      ],
    };
    view.webview.html = this.getHtml(view.webview);
    view.webview.onDidReceiveMessage(
      (msg: Inbound) => this.handleMessage(msg),
      undefined,
      this.disposables,
    );
  }

  /** Show the sidebar view (revealed by the user clicking the activity-bar icon). */
  show(): void {
    if (this.view) this.view.show?.(true);
  }

  /** Push a user message into the chat (e.g. from "Send to Chat" context menu). */
  async sendUserMessage(text: string): Promise<void> {
    await this.handleMessage({ type: "send", text });
  }

  /** Clear the chat history (used by `/clear`). */
  clear(): void {
    this.history = [];
    this.post({ type: "clear" });
  }

  /** Handle an inbound message from the webview. */
  private async handleMessage(msg: Inbound): Promise<void> {
    switch (msg.type) {
      case "ready":
        this.post({ type: "history", messages: this.history });
        this.post({
          type: "config",
          config: {
            ...getConfig(),
            defaultModel: getConfig().defaultModel,
          },
        });
        return;
      case "send":
        await this.handleSend(msg.text);
        return;
      case "stop":
        this.activeStreamCts?.cancel();
        return;
      case "applyDiff":
        await this.handleApplyDiff(msg.messageId);
        return;
    }
  }

  /** Persist a user message + dispatch the assistant response. */
  private async handleSend(text: string): Promise<void> {
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      ts: Date.now(),
    };
    this.history.push(userMsg);
    this.post({ type: "history", messages: this.history });

    // Slash-command dispatch
    const trimmed = text.trim();
    if (trimmed === "/clear") return this.clear();
    if (trimmed === "/help") return this.sendAssistant(this.helpText());
    if (trimmed.startsWith("/agent ")) {
      const rest = trimmed.slice(7).trim();
      const [agent, ...promptParts] = rest.split(/\s+/);
      return this.runAgentCommand(agent, promptParts.join(" "));
    }
    if (trimmed.startsWith("/session")) return this.runSessionCommand(trimmed);
    if (trimmed === "/cost") return this.runCostCommand();
    if (trimmed.startsWith("/model ")) {
      const model = trimmed.slice(7).trim();
      return this.sendAssistant(`Active model set to **${model}** for the next message.`);
    }
    if (trimmed.startsWith("/provider ")) {
      const provider = trimmed.slice(10).trim();
      return this.sendAssistant(`Provider set to **${provider}** for the next message.`);
    }
    // /intel prefix → V16 pipeline
    if (isIntelRequest(trimmed) && getConfig().intelligencePipeline) {
      return this.runIntelPipeline(stripIntelPrefix(trimmed));
    }
    // Default: send to `sanix ask`
    return this.runAsk(trimmed);
  }

  /** Run `sanix ask` and stream output into the webview. */
  private async runAsk(prompt: string): Promise<void> {
    const cfg = getConfig();
    const id = crypto.randomUUID();
    this.startAssistant(id, cfg.defaultModel);
    this.onStateChange("running");
    this.activeStreamCts = new vscode.CancellationTokenSource();
    let accumulated = "";
    if (cfg.streamOutput) {
      this.onStateChange("streaming");
      const code = await streamSanix(
        ["ask", "--model", cfg.defaultModel, prompt],
        (chunk) => {
          accumulated += chunk;
          this.inflight.set(id, accumulated);
          this.post({ type: "append", id, chunk });
        },
        { token: this.activeStreamCts.token },
      );
      if (code !== 0 && accumulated.length === 0) {
        this.post({
          type: "error",
          id,
          message: `sanix ask exited with code ${code}`,
        });
        this.onStateChange("error");
      } else {
        await this.finishAssistant(id, accumulated);
        this.onStateChange("idle");
      }
    } else {
      const res = await runSanix(["ask", "--model", cfg.defaultModel, prompt], {
        token: this.activeStreamCts.token,
      });
      if (res.code !== 0) {
        this.post({ type: "error", id, message: res.stderr || `exit ${res.code}` });
        this.onStateChange("error");
      } else {
        await this.finishAssistant(id, res.stdout);
        this.onStateChange("idle");
      }
    }
    this.inflight.delete(id);
    this.activeStreamCts = undefined;
  }

  /** Run a named agent via `sanix agent run <agent> <prompt>`. */
  private async runAgentCommand(agent: string, prompt: string): Promise<void> {
    const id = crypto.randomUUID();
    this.startAssistant(id, agent);
    this.onStateChange("running");
    const res = await runSanix(["agent", "run", agent, prompt]);
    if (res.code !== 0) {
      this.post({ type: "error", id, message: res.stderr || `exit ${res.code}` });
      this.onStateChange("error");
    } else {
      await this.finishAssistant(id, res.stdout);
      this.onStateChange("idle");
    }
  }

  /** Run UltraWorker orchestrator via `sanix agent run ultra-worker <goal>`. */
  async runUltraWorker(goal: string): Promise<void> {
    return this.runAgentCommand("ultra-worker", goal);
  }

  /** Run `/intel` via the V16 pipeline proxy. */
  private async runIntelPipeline(task: string): Promise<void> {
    const id = crypto.randomUUID();
    this.startAssistant(id, "intel-pipeline");
    this.onStateChange("running");
    try {
      const out = await runIntelligencePipeline(task);
      await this.finishAssistant(id, out);
      this.onStateChange("idle");
    } catch (err) {
      this.post({
        type: "error",
        id,
        message: err instanceof Error ? err.message : String(err),
      });
      this.onStateChange("error");
    }
  }

  /** `/session` slash command — list or switch. */
  private async runSessionCommand(text: string): Promise<void> {
    const parts = text.split(/\s+/);
    if (parts.length === 1) {
      const res = await runSanix(["session", "list", "--json"]);
      await this.finishAssistant(crypto.randomUUID(), "```\n" + res.stdout + "\n```");
      return;
    }
    const res = await runSanix(["session", "switch", parts[1]!]);
    if (res.code !== 0) {
      await this.finishAssistant(crypto.randomUUID(), `Failed: ${res.stderr}`);
    } else {
      await this.finishAssistant(crypto.randomUUID(), `Switched to session **${parts[1]}**.`);
    }
  }

  /** `/cost` slash command — show today's spend. */
  private async runCostCommand(): Promise<void> {
    const res = await runSanix(["cost", "--today", "--json"]);
    await this.finishAssistant(crypto.randomUUID(), "```json\n" + res.stdout + "\n```");
  }

  /** Mark a new assistant message as streaming. */
  private startAssistant(id: string, model: string): void {
    const msg: ChatMessage = {
      id,
      role: "assistant",
      content: "",
      ts: Date.now(),
      streaming: true,
      model,
    };
    this.history.push(msg);
    this.post({ type: "history", messages: this.history });
  }

  /** Finalize an assistant message — parse diffs + persist. */
  private async finishAssistant(id: string, content: string): Promise<void> {
    const idx = this.history.findIndex((m) => m.id === id);
    if (idx >= 0) {
      this.history[idx] = {
        ...this.history[idx]!,
        content,
        streaming: false,
      };
    }
    this.post({ type: "done", id });
    this.post({ type: "history", messages: this.history });
    // Auto-apply diffs if enabled
    if (getConfig().autoApplyDiffs) {
      const diffs = parseDiffs(content);
      if (diffs.length > 0) {
        const n = await applyDiffs(diffs);
        if (n > 0) {
          vscode.window.showInformationMessage(
            `SANIX applied ${n} diff file${n === 1 ? "" : "s"} (undo with Ctrl+Z).`,
          );
        }
      }
    }
  }

  /** Handle the "Apply Diff" button click from the webview. */
  private async handleApplyDiff(messageId: string): Promise<void> {
    const msg = this.history.find((m) => m.id === messageId);
    if (!msg) return;
    const diffs = parseDiffs(msg.content);
    const n = await applyDiffs(diffs, { openAfterApply: true });
    vscode.window.showInformationMessage(`Applied ${n} diff block(s).`);
  }

  /** Send a static assistant message (used for /help, /model, /provider). */
  private async sendAssistant(content: string): Promise<void> {
    const id = crypto.randomUUID();
    this.startAssistant(id, "system");
    await this.finishAssistant(id, content);
  }

  /** Markdown-formatted help text for `/help`. */
  private helpText(): string {
    return [
      "**SANIX slash commands**",
      "",
      "- `/clear` — clear chat history",
      "- `/agent <name> <prompt>` — run a named agent (e.g. `/agent coder fix this bug`)",
      "- `/session` — list sessions; `/session <id>` — switch",
      "- `/cost` — show today's token spend",
      "- `/model <provider:model>` — override the model for the next message",
      "- `/provider <name>` — override the provider for the next message",
      "- `/intel <task>` — run the V16 10-step intelligence pipeline",
      "- `/help` — show this help",
      "",
      "Tip: type your message + Enter to send. Shift+Enter for newline.",
    ].join("\n");
  }

  /** Post a message to the webview (no-op if not yet resolved). */
  private post(msg: Outbound): void {
    this.view?.webview.postMessage(msg);
  }

  /** Build the webview HTML with bundled CSS/JS via `webview.asWebviewUri`. */
  private getHtml(webview: vscode.Webview): string {
    const root = vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview");
    const css = webview.asWebviewUri(vscode.Uri.joinPath(root, "chat.css"));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(root, "chat.js"));
    const nonce = crypto.randomBytes(16).toString("base64");
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${css.toString()}" />
  <title>SANIX Chat</title>
</head>
<body>
  <div id="messages" role="log" aria-live="polite"></div>
  <div id="composer">
    <textarea id="input" placeholder="Ask SANIX…  (/help for commands, /intel for V16 pipeline)" rows="2"></textarea>
    <button id="send" title="Send (Enter)">Send</button>
    <button id="stop" title="Stop (Esc)" disabled>Stop</button>
  </div>
  <script nonce="${nonce}" src="${js.toString()}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.activeStreamCts?.dispose();
    this.disposables.forEach((d) => d.dispose());
    this.disposables.length = 0;
  }
}
