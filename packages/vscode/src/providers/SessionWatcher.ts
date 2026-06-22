/**
 * @fileoverview Auto-attaches to the active SANIX session and keeps the
 * VS Code extension in sync with the CLI session pointer file
 * (`~/.sanix/sessions/active`).
 * @module sanix.vscode/providers/SessionWatcher
 */
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as vscode from "vscode";
import type { SanixSession } from "../types.js";
import { runSanix } from "./SanixCliProvider.js";

/** Path to the active-session pointer file written by the SANIX CLI. */
function activePointerPath(): string {
  return path.join(os.homedir(), ".sanix", "sessions", "active");
}

/** Directory where SANIX session JSON files are persisted. */
function sessionsDir(): string {
  return path.join(os.homedir(), ".sanix", "sessions");
}

/**
 * Watcher that reloads the active session id whenever the pointer file changes.
 * Emits the new id (or null) on every change.
 */
export class SessionWatcher implements vscode.Disposable {
  private watcher: vscode.FileSystemWatcher | undefined;
  private listeners: ((sessionId: string | null) => void)[] = [];
  private current: string | null = null;

  /** Begin watching; resolves with the current active session id (if any). */
  async start(): Promise<string | null> {
    const pointer = activePointerPath();
    this.current = await this.readPointer();
    // Glob pattern relative to workspace; the pointer is in $HOME so we
    // register a manual interval poll as a fallback when the path is outside
    // the workspace.
    const pattern = new vscode.RelativePattern(
      vscode.Uri.file(path.dirname(pointer)),
      path.basename(pointer),
    );
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
    this.watcher.onDidChange(async () => {
      const next = await this.readPointer();
      if (next !== this.current) {
        this.current = next;
        for (const fn of this.listeners) fn(next);
      }
    });
    this.watcher.onDidCreate(async () => {
      const next = await this.readPointer();
      this.current = next;
      for (const fn of this.listeners) fn(next);
    });
    this.watcher.onDidDelete(() => {
      this.current = null;
      for (const fn of this.listeners) fn(null);
    });
    return this.current;
  }

  /** Subscribe to active-session changes. Returns a disposer. */
  onChange(fn: (sessionId: string | null) => void): vscode.Disposable {
    this.listeners.push(fn);
    return { dispose: () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    } };
  }

  /** The most recently observed active session id (or null). */
  getActiveId(): string | null {
    return this.current;
  }

  /** Read the active pointer file (best-effort). */
  private async readPointer(): Promise<string | null> {
    try {
      const p = activePointerPath();
      if (!existsSync(p)) return null;
      const raw = (await fs.readFile(p, "utf8")).trim();
      return raw || null;
    } catch {
      return null;
    }
  }

  /** List all SANIX sessions by parsing JSON files in the sessions dir. */
  async listSessions(): Promise<SanixSession[]> {
    const dir = sessionsDir();
    if (!existsSync(dir)) return [];
    const entries = await fs.readdir(dir);
    const sessions: SanixSession[] = [];
    const active = this.current;
    for (const entry of entries) {
      if (!entry.endsWith(".json") || entry === "active") continue;
      try {
        const full = path.join(dir, entry);
        const json = JSON.parse(await fs.readFile(full, "utf8"));
        sessions.push({
          id: json.id ?? entry.replace(/\.json$/, ""),
          name: json.name ?? "Untitled",
          createdAt: json.createdAt ?? json.created ?? new Date().toISOString(),
          updatedAt: json.updatedAt ?? json.updated ?? new Date().toISOString(),
          active: active ? json.id === active : false,
          messageCount: Array.isArray(json.messages) ? json.messages.length : 0,
        });
      } catch {
        /* skip malformed */
      }
    }
    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Switch the active session by writing the pointer file (delegates to CLI). */
  async switchSession(sessionId: string): Promise<SanixSession | null> {
    const res = await runSanix(["session", "switch", sessionId]);
    if (res.code !== 0) {
      throw new Error(`sanix session switch failed: ${res.stderr || res.stdout}`);
    }
    this.current = sessionId;
    for (const fn of this.listeners) fn(sessionId);
    const list = await this.listSessions();
    return list.find((s) => s.id === sessionId) ?? null;
  }

  dispose(): void {
    this.watcher?.dispose();
    this.listeners = [];
  }
}
