/**
 * @fileoverview Spawns the `sanix` CLI as a subprocess and streams stdout/stderr.
 * @module sanix.vscode/providers/SanixCliProvider
 *
 * Runtime resolution (priority):
 *   1. `sanix.cliPath` setting  — explicit developer override
 *   2. Bundled binary           — auto-detected from extension install directory
 *   3. `sanix` on PATH          — fallback for development
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as vscode from "vscode";
import { getConfig } from "../config.js";
import type { SanixCliResult } from "../types.js";

// ── Self-containment support ──────────────────────────────────────────────────

/**
 * Extension install path, injected by {@link setBundledExtensionPath} during
 * `activate()`. Used to resolve the bundled CLI binaries under `bin/`.
 */
let extensionPath: string | undefined;

/**
 * Tell the provider where the extension is installed so it can resolve bundled
 * binaries. Call from `activate()`:
 *
 * ```ts
 * setBundledExtensionPath(context.extensionPath);
 * ```
 */
export function setBundledExtensionPath(p: string): void {
  extensionPath = p;
}

/**
 * Map `process.platform` + `process.arch` to the bin/ subdirectory name.
 * Returns `null` for unsupported platform/arch combinations.
 */
function getPlatformDir(): string | null {
  const { platform, arch } = process;
  if (platform === "darwin" && arch === "arm64") return "macos-arm64";
  if (platform === "darwin" && arch === "x64") return "macos-x64";
  if (platform === "win32" && arch === "x64") return "win-x64";
  if (platform === "linux" && arch === "x64") return "linux-x64";
  return null;
}

/**
 * Resolve the absolute path to the platform-specific bundled CLI binary.
 * Returns `null` if:
 *   - extensionPath was never injected (not activated yet)
 *   - the platform/arch isn't in the pre-built set
 *   - the binary file doesn't exist on disk
 */
function getBundledBinaryPath(): string | null {
  try {
    if (!extensionPath) return null;
    const platformDir = getPlatformDir();
    if (!platformDir) return null;

    const binaryName = process.platform === "win32" ? "sanix.exe" : "sanix";
    const binaryPath = path.join(extensionPath, "bin", platformDir, binaryName);

    if (!fs.existsSync(binaryPath)) return null;
    return binaryPath;
  } catch {
    return null;
  }
}

/**
 * Resolve the CLI command + base arguments.
 *
 * Priority:
 *   1. `sanix.cliPath`          — explicit user override (dev/debug)
 *   2. Bundled binary            — auto from extension install
 *   3. `"sanix"` on PATH / npx  — dev fallback
 */
function resolveCli(): { cmd: string; args: string[] } {
  const cfg = getConfig();

  // 1. Explicit developer override
  if (cfg.cliPath) {
    return { cmd: cfg.cliPath, args: [] };
  }

  // 2. Bundled binary (self-contained)
  const bundled = getBundledBinaryPath();
  if (bundled) {
    return { cmd: bundled, args: [] };
  }

  // 3. Fallback to PATH (legacy development mode)
  return { cmd: "sanix", args: [] };
}

/**
 * Run a `sanix` CLI invocation and resolve with stdout/stderr/code/duration.
 * @param args arguments to pass to `sanix` (e.g. `["ask", "--model", "anthropic:claude-sonnet-4", "prompt"]`)
 * @param opts optional cwd + cancellation token
 */
export function runSanix(
  args: string[],
  opts: { cwd?: string; token?: vscode.CancellationToken } = {},
): Promise<SanixCliResult> {
  const { cmd, args: baseArgs } = resolveCli();
  const start = Date.now();
  return new Promise((resolve) => {
    const child = spawn(cmd, [...baseArgs, ...args], {
      cwd: opts.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      shell: process.platform === "win32",
    }) as ChildProcessWithoutNullStreams;

    let stdout = "";
    let stderr = "";
    const tokenListener = opts.token?.onCancellationRequested(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    });

    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", (err) => {
      tokenListener?.dispose();
      resolve({
        stdout: "",
        stderr: stderr || err.message,
        code: -1,
        durationMs: Date.now() - start,
      });
    });
    child.on("close", (code) => {
      tokenListener?.dispose();
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        code: code ?? -1,
        durationMs: Date.now() - start,
      });
    });
  });
}

/**
 * Spawn a streaming `sanix` invocation, calling `onChunk` for each stdout chunk
 * as it arrives. Used by the chat webview for token-by-token rendering.
 * @returns the final exit code
 */
export function streamSanix(
  args: string[],
  onChunk: (chunk: string) => void,
  opts: { cwd?: string; token?: vscode.CancellationToken } = {},
): Promise<number> {
  const { cmd, args: baseArgs } = resolveCli();
  return new Promise((resolve) => {
    const child = spawn(cmd, [...baseArgs, ...args], {
      cwd: opts.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      shell: process.platform === "win32",
    }) as ChildProcessWithoutNullStreams;

    const tokenListener = opts.token?.onCancellationRequested(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    });

    child.stdout.on("data", (chunk: Buffer) => onChunk(chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => onChunk(`\n[stderr] ${chunk.toString("utf8")}`));
    child.on("error", () => {
      tokenListener?.dispose();
      resolve(-1);
    });
    child.on("close", (code) => {
      tokenListener?.dispose();
      resolve(code ?? -1);
    });
  });
}
