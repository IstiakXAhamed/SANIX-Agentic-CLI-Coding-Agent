/**
 * @fileoverview Status bar integration for SANIX.
 * @module sanix.vscode/status/StatusBar
 */
import * as vscode from "vscode";
import type { BackendState } from "../types.js";

const ICONS: Record<BackendState, string> = {
  idle: "$(sanix-idle)",
  running: "$(loading~spin)",
  streaming: "$(pulse)",
  "cost-warning": "$(warning)",
  "cost-critical": "$(error)",
  error: "$(bug)",
};

const COLORS: Record<BackendState, string | undefined> = {
  idle: undefined,
  running: "statusBar.foreground",
  streaming: "editorGutter.addedBackground",
  "cost-warning": "editorWarning.foreground",
  "cost-critical": "editorError.foreground",
  error: "editorError.foreground",
};

const TOOLTIPS: Record<BackendState, string> = {
  idle: "SANIX is idle — click to open chat",
  running: "SANIX is running a command…",
  streaming: "SANIX is streaming output…",
  "cost-warning": "SANIX daily cost exceeds warning threshold",
  "cost-critical": "SANIX daily cost exceeds critical threshold",
  error: "SANIX encountered an error — click to view",
};

/**
 * Manages the SANIX status-bar item (`sanix.statusBar`).
 */
export class StatusBar implements vscode.Disposable {
  private item: vscode.StatusBarItem;
  private state: BackendState = "idle";
  private costToday: number | undefined;
  private activeSession: string | null = null;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.item.command = "sanix.openChat";
    this.render();
  }

  /** Show the status-bar item (respects the `sanix.showStatusBar` setting). */
  show(): void {
    this.item.show();
  }

  /** Hide the status-bar item. */
  hide(): void {
    this.item.hide();
  }

  /** Update the current state — re-renders the item. */
  setState(state: BackendState): void {
    this.state = state;
    this.render();
  }

  /** Update the day's running cost (USD); triggers cost-warning/critical transitions. */
  setCostToday(usd: number | undefined): void {
    this.costToday = usd;
    if (usd === undefined) return;
    const cfg = vscode.workspace.getConfiguration("sanix");
    const critical = cfg.get<number>("costCriticalThresholdUsd", 20);
    const warning = cfg.get<number>("costWarningThresholdUsd", 5);
    if (this.state === "idle" || this.state === "running" || this.state === "streaming") {
      if (usd >= critical) this.state = "cost-critical";
      else if (usd >= warning) this.state = "cost-warning";
    }
    this.render();
  }

  /** Set the active session id shown in the tooltip. */
  setActiveSession(id: string | null): void {
    this.activeSession = id;
    this.render();
  }

  /** Re-render the item from current state. */
  private render(): void {
    const icon = ICONS[this.state];
    const color = COLORS[this.state];
    const tooltip = TOOLTIPS[this.state];
    const costPart =
      this.costToday !== undefined ? ` · $${this.costToday.toFixed(2)}` : "";
    const sessionPart = this.activeSession ? ` · ${this.activeSession.slice(0, 6)}` : "";
    this.item.text = `${icon} SANIX${costPart}${sessionPart}`;
    this.item.tooltip = tooltip;
    this.item.color = color;
    this.item.backgroundColor =
      this.state === "error" || this.state === "cost-critical"
        ? new vscode.ThemeColor("statusBarItem.errorBackground")
        : undefined;
  }

  dispose(): void {
    this.item.dispose();
  }
}
