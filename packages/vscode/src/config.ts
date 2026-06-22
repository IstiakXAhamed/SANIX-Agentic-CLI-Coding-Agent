/**
 * @fileoverview Typed accessor for `sanix.*` configuration settings.
 * @module sanix.vscode/config
 */
import * as vscode from "vscode";

/** The configuration section under which all SANIX settings live. */
export const CONFIG_SECTION = "sanix";

/** Strongly-typed snapshot of the `sanix.*` configuration. */
export interface SanixConfig {
  cliPath: string;
  defaultModel: string;
  streamOutput: boolean;
  maxInlineSelectionChars: number;
  autoApplyDiffs: boolean;
  showStatusBar: boolean;
  theme: "auto" | "light" | "dark";
  costWarningThresholdUsd: number;
  costCriticalThresholdUsd: number;
  intelligencePipeline: boolean;
  enableVision: boolean;
}

/**
 * Read the current SANIX configuration from the VS Code workspace.
 * @returns a typed snapshot of all `sanix.*` settings
 */
export function getConfig(): SanixConfig {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return {
    cliPath: cfg.get<string>("cliPath", ""),
    defaultModel: cfg.get<string>("defaultModel", "anthropic:claude-sonnet-4"),
    streamOutput: cfg.get<boolean>("streamOutput", true),
    maxInlineSelectionChars: cfg.get<number>("maxInlineSelectionChars", 8000),
    autoApplyDiffs: cfg.get<boolean>("autoApplyDiffs", true),
    showStatusBar: cfg.get<boolean>("showStatusBar", true),
    theme: cfg.get<"auto" | "light" | "dark">("theme", "auto"),
    costWarningThresholdUsd: cfg.get<number>("costWarningThresholdUsd", 5),
    costCriticalThresholdUsd: cfg.get<number>("costCriticalThresholdUsd", 20),
    intelligencePipeline: cfg.get<boolean>("intelligencePipeline", true),
    enableVision: cfg.get<boolean>("enableVision", true),
  };
}
