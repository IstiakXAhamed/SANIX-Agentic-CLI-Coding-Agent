/**
 * @file approval/ApprovalManager.ts
 * @description Human-in-the-loop tool approval workflow for SANIX. Before
 * the registry executes a tool whose permissions intersect the configured
 * `requireFor` set, the manager calls the registered {@link ApprovalHandler}
 * to ask the user (or a programmatic stand-in) for a decision.
 *
 * Decisions:
 *   - `approve`         — allow this one call.
 *   - `deny`            — deny this one call.
 *   - `approve_always`  — allow this tool for the rest of the session.
 *   - `deny_always`     — deny this tool for the rest of the session.
 *
 * Risk assessment is heuristic: read tools → `low`, write tools → `medium`,
 * shell → `high` (or `critical` if destructive patterns are detected). The
 * risk level is surfaced to the handler so the UI can color-code it.
 *
 * @packageDocumentation
 */

import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { nanoid } from 'nanoid';
import type { ToolPermission } from '../tools/interfaces.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * The user's decision on an approval request.
 * - `approve` / `deny`: apply to this one call only.
 * - `approve_always` / `deny_always`: apply to all future calls of this tool.
 */
export type ApprovalDecision = 'approve' | 'deny' | 'approve_always' | 'deny_always';

/**
 * Risk level assigned by {@link ApprovalManager.assessRisk}. Surfaced to
 * the handler so the UI can color-code the prompt.
 */
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

/**
 * A request for approval, sent to the {@link ApprovalHandler}.
 */
export interface ApprovalRequest {
  /** Unique request id (correlates with the response). */
  id: string;
  /** Tool name. */
  toolName: string;
  /** Tool input (the handler may display a preview). */
  toolInput: unknown;
  /** Permissions the tool requires. */
  permissions: ToolPermission[];
  /** Heuristic risk level. */
  riskLevel: RiskLevel;
  /** Human-readable explanation of why approval is needed. */
  reason: string;
  /** Free-form caller context (e.g. iteration, task id). */
  context?: Record<string, unknown>;
}

/**
 * The handler's response to an {@link ApprovalRequest}.
 */
export interface ApprovalResponse {
  /** The request id this response corresponds to. */
  requestId: string;
  /** The decision. */
  decision: ApprovalDecision;
  /** Optional edited input (only meaningful for `approve` / `approve_always`). */
  modifiedInput?: unknown;
  /** Optional reason for the decision (for audit). */
  reason?: string;
}

/**
 * A function that resolves an {@link ApprovalRequest}. Implementations may
 * prompt the user, query a policy engine, or auto-approve.
 *
 * Note: {@link InteractiveApprovalHandler} and other class-based handlers
 * expose a `requestApproval(req)` method matching this signature; wrap them
 * via `asHandler()` (or inline as `(req) => handler.requestApproval(req)`)
 * when passing to {@link ApprovalManager.setHandler}.
 */
export type ApprovalHandler = (req: ApprovalRequest) => Promise<ApprovalResponse>;

/**
 * Options for {@link ApprovalManager.constructor}.
 */
export interface ApprovalManagerOptions {
  /** Permissions that require approval (default: `['file_write', 'shell_exec']`). */
  requireFor?: ToolPermission[];
}

// ─── ApprovalManager ────────────────────────────────────────────────────────

/**
 * Manages tool-approval workflow. Holds a handler (set by the caller), a
 * set of permissions that require approval, and session-scoped always-allow
 * / always-deny sets.
 *
 * @example
 * ```ts
 * const am = new ApprovalManager({ requireFor: ['file_write', 'shell_exec'] });
 * am.setHandler(async (req) => {
 *   console.log(`Approve ${req.toolName}? (risk: ${req.riskLevel})`);
 *   // ... prompt user ...
 *   return { requestId: req.id, decision: 'approve' };
 * });
 *
 * // Wire into a ToolContext:
 * const ctx: ToolContext = { ..., approvalManager: am };
 * ```
 */
export class ApprovalManager {
  /** The handler (or null if none set — requests throw if no handler). */
  private handler: ApprovalHandler | null = null;
  /** Tool names auto-approved for the session (via `approve_always`). */
  private readonly alwaysAllow: Set<string> = new Set();
  /** Tool names auto-denied for the session (via `deny_always`). */
  private readonly alwaysDeny: Set<string> = new Set();
  /** Permissions that require approval. */
  private readonly requireFor: Set<ToolPermission>;

  constructor(opts: ApprovalManagerOptions = {}) {
    this.requireFor = new Set(
      opts.requireFor ?? ['file_write', 'shell_exec'],
    );
  }

  /**
   * Set the approval handler. Without a handler, {@link requestApproval}
   * throws on any request that isn't covered by always-allow / always-deny.
   */
  setHandler(handler: ApprovalHandler): void {
    this.handler = handler;
  }

  /**
   * Add a permission to the require-approval set.
   */
  requireApprovalFor(perm: ToolPermission): void {
    this.requireFor.add(perm);
  }

  /**
   * Remove a permission from the require-approval set (i.e. tools requiring
   * only this permission will NOT prompt).
   */
  skipApprovalFor(perm: ToolPermission): void {
    this.requireFor.delete(perm);
  }

  /**
   * Check whether a given permission requires approval. Public so the
   * ToolRegistry can short-circuit when no permission intersects.
   */
  requiresApproval(perm: ToolPermission): boolean {
    return this.requireFor.has(perm);
  }

  /**
   * Heuristically assess the risk level of a tool call.
   *
   * Mapping:
   *   - `read_file`, `list_directory`, `directory_tree`, `search_files`,
   *     `web_search`, `fetch_url`, `read_url` → `low`
   *   - `write_file` → `medium`
   *   - `edit_file` → `medium` (or `high` if the path is under `node_modules`
   *     or `.git`)
   *   - `bash` / `shell` → `high` (or `critical` if destructive patterns
   *     like `rm -rf`, `mkfs`, `dd of=`, `:(){:|:&};:`, `> /dev/sda` are
   *     detected)
   *   - `mcp__*` → `medium` (unknown tool surface)
   *   - everything else → `medium`
   *
   * @param toolName - The tool name.
   * @param toolInput - The tool input (used for path / command inspection).
   */
  assessRisk(toolName: string, toolInput: unknown): RiskLevel {
    // MCP tools — unknown surface, default to medium.
    if (toolName.startsWith('mcp__')) return 'medium';

    // Read-only tools.
    switch (toolName) {
      case 'read_file':
      case 'list_directory':
      case 'directory_tree':
      case 'search_files':
      case 'watch_files':
      case 'web_search':
      case 'fetch_url':
      case 'read_url':
      case 'document_reader':
      case 'recall_memory':
      case 'remember_fact':
        return 'low';
    }

    // File writes.
    if (toolName === 'write_file') return 'medium';
    if (toolName === 'edit_file') {
      const filePath = extractFilePath(toolInput);
      if (filePath && (filePath.includes('node_modules') || filePath.includes('.git'))) {
        return 'high';
      }
      return 'medium';
    }
    if (toolName === 'forget_memory') return 'medium';

    // Shell.
    if (toolName === 'bash' || toolName === 'shell') {
      const cmd = extractShellCommand(toolInput);
      if (cmd && isDestructiveCommand(cmd)) return 'critical';
      return 'high';
    }

    // Code-analysis tools (read-only by default).
    if (
      toolName === 'ast_analyzer' ||
      toolName === 'code_indexer' ||
      toolName === 'linter' ||
      toolName === 'dependency_analyzer' ||
      toolName === 'test_runner'
    ) {
      // test_runner may execute code; treat as medium.
      if (toolName === 'test_runner') return 'medium';
      return 'low';
    }

    // Default.
    return 'medium';
  }

  /**
   * Request approval for a tool call. If the tool is in the always-allow or
   * always-deny set, the handler is skipped and a canned response is
   * returned. Otherwise the handler is invoked.
   *
   * @param req - The request (without `id` and `riskLevel`, which are filled in).
   * @returns The handler's (or canned) response.
   * @throws if no handler is set and the tool is not in always-allow/deny.
   */
  async requestApproval(
    req: Omit<ApprovalRequest, 'id' | 'riskLevel'>,
  ): Promise<ApprovalResponse> {
    const id = nanoid();
    const riskLevel = this.assessRisk(req.toolName, req.toolInput);
    const fullReq: ApprovalRequest = { ...req, id, riskLevel };

    // Session-scoped short-circuits.
    if (this.alwaysAllow.has(req.toolName)) {
      return {
        requestId: id,
        decision: 'approve',
        reason: 'Auto-approved (approve_always previously chosen).',
      };
    }
    if (this.alwaysDeny.has(req.toolName)) {
      return {
        requestId: id,
        decision: 'deny',
        reason: 'Auto-denied (deny_always previously chosen).',
      };
    }

    if (!this.handler) {
      throw new Error(
        `ApprovalManager: no handler set for tool '${req.toolName}' (risk: ${riskLevel})`,
      );
    }

    const response = await this.handler(fullReq);

    // Apply always-* decisions to the session sets.
    if (response.decision === 'approve_always') this.alwaysAllow.add(req.toolName);
    if (response.decision === 'deny_always') this.alwaysDeny.add(req.toolName);

    return response;
  }
}

// ─── InteractiveApprovalHandler ─────────────────────────────────────────────

/**
 * An {@link ApprovalHandler} that prompts via stdin/stdout. Used by the CLI
 * `--interactive` flag. Renders the tool name, color-coded risk level, and
 * a preview of the input, then accepts `y` / `n` / `a` (always-allow) / `d`
 * (always-deny) from the user.
 *
 * Non-TTY environments auto-deny (safer default).
 *
 * Note: this class is not directly callable (TypeScript classes cannot be
 * made callable). Use {@link InteractiveApprovalHandler.asHandler} to obtain
 * a function-form handler suitable for {@link ApprovalManager.setHandler}:
 *
 * @example
 * ```ts
 * const am = new ApprovalManager({ requireFor: ['shell_exec'] });
 * am.setHandler(new InteractiveApprovalHandler().asHandler());
 * ```
 */
export class InteractiveApprovalHandler {
  /** Lazy-init the readline interface (only when actually prompting). */
  private rl: readline.Interface | null = null;

  /**
   * Prompt the user for an approval decision.
   *
   * @param req - The approval request.
   * @returns The user's decision.
   */
  async requestApproval(req: ApprovalRequest): Promise<ApprovalResponse> {
    // Non-TTY: auto-deny.
    if (!stdinIsTTY()) {
      return {
        requestId: req.id,
        decision: 'deny',
        reason: 'Non-interactive (stdin is not a TTY).',
      };
    }

    if (!this.rl) {
      this.rl = readline.createInterface({ input, output, terminal: true });
    }

    // Render the request.
    const riskColor = riskColorCode(req.riskLevel);
    const riskLabel = `${riskColor}[${req.riskLevel.toUpperCase()}]\x1b[0m`;
    output.write(`\n┌─ Approval required ${riskLabel}\n`);
    output.write(`│ Tool:  ${req.toolName}\n`);
    output.write(`│ Perms: ${req.permissions.join(', ') || '(none)'}\n`);
    output.write(`│ Reason: ${req.reason}\n`);
    const preview = previewInput(req.toolInput);
    if (preview) {
      const indented = preview.split('\n').slice(0, 10).map((l) => `│   ${l}`).join('\n');
      output.write(`│ Input:\n${indented}\n`);
    }
    output.write(`└─ [y]es / [n]o / [a]lways allow / [d]eny always\n`);

    try {
      const answer = (await this.rl.question('Choice (default n): ')).trim().toLowerCase();
      let decision: ApprovalDecision;
      switch (answer.charAt(0)) {
        case 'y':
          decision = 'approve';
          break;
        case 'a':
          decision = 'approve_always';
          break;
        case 'd':
          decision = 'deny_always';
          break;
        case 'n':
        default:
          decision = 'deny';
          break;
      }
      return { requestId: req.id, decision };
    } catch {
      return {
        requestId: req.id,
        decision: 'deny',
        reason: 'Prompt failed.',
      };
    }
  }

  /**
   * Return a function-form handler wrapping this instance's
   * {@link requestApproval} method. Suitable for passing to
   * {@link ApprovalManager.setHandler}.
   */
  asHandler(): ApprovalHandler {
    return (req: ApprovalRequest) => this.requestApproval(req);
  }

  /**
   * Close the underlying readline interface. Call when the handler is no
   * longer needed to free the stdin listener.
   */
  close(): void {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }
}

// ─── Internal helpers ───────────────────────────────────────────────────────

/**
 * Check whether stdin is a TTY (i.e. interactive).
 */
function stdinIsTTY(): boolean {
  return typeof process !== 'undefined' && Boolean(process.stdin?.isTTY);
}

/**
 * Map a risk level to an ANSI color code (for terminal output).
 */
function riskColorCode(level: RiskLevel): string {
  switch (level) {
    case 'low':
      return '\x1b[32m'; // green
    case 'medium':
      return '\x1b[33m'; // yellow
    case 'high':
      return '\x1b[31m'; // red
    case 'critical':
      return '\x1b[41m\x1b[37m\x1b[1m'; // white on red, bold
  }
}

/**
 * Render a short preview of a tool input for display. Returns up to a few
 * lines of JSON, truncated.
 */
function previewInput(input: unknown): string {
  if (input === undefined || input === null) return '';
  try {
    const json = JSON.stringify(input, null, 2);
    if (json.length > 500) return `${json.slice(0, 500)}\n... (truncated)`;
    return json;
  } catch {
    return String(input).slice(0, 200);
  }
}

/**
 * Extract a file path from a tool input (best-effort). Used by
 * {@link ApprovalManager.assessRisk} to detect risky paths.
 */
function extractFilePath(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const obj = input as Record<string, unknown>;
  if (typeof obj.path === 'string') return obj.path;
  if (typeof obj.filePath === 'string') return obj.filePath;
  if (typeof obj.file === 'string') return obj.file;
  return undefined;
}

/**
 * Extract a shell command from a tool input (best-effort). Used by
 * {@link ApprovalManager.assessRisk} to detect destructive patterns.
 */
function extractShellCommand(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const obj = input as Record<string, unknown>;
  if (typeof obj.command === 'string') return obj.command;
  if (typeof obj.cmd === 'string') return obj.cmd;
  if (typeof obj.script === 'string') return obj.script;
  return undefined;
}

/**
 * Heuristic: does a shell command look destructive?
 *
 * Matches:
 *   - `rm -rf /` (or `rm -rf /*`, `rm -rf ~`, etc.)
 *   - `mkfs` (any filesystem-reformat)
 *   - `dd of=/dev/...`
 *   - `:(){:|:&};:` (fork bomb)
 *   - `> /dev/sda` (raw disk overwrite)
 *   - `chmod -R 777 /`
 *   - `shutdown`, `reboot`, `halt`, `poweroff`
 */
function isDestructiveCommand(cmd: string): boolean {
  const patterns: RegExp[] = [
    /\brm\s+-[rfRF]*r[fRF]*\s+\/(\s|$|\*)/, // rm -rf /
    /\brm\s+-[rfRF]*r[fRF]*\s+~(\s|$|\*)/, // rm -rf ~
    /\bmkfs\b/, // mkfs
    /\bdd\b.*\bof=\/dev\//, // dd of=/dev/...
    /:\s*\(\s*\)\s*\{\s*:\s*\|/, // fork bomb
    />\s*\/dev\/(?:sd|nvme|hd)/, // > /dev/sda
    /\bchmod\s+-R\s+[0-7]{3,4}\s+\/(\s|$)/, // chmod -R 777 /
    /\b(?:shutdown|reboot|halt|poweroff)\b/, // shutdown etc.
  ];
  return patterns.some((re) => re.test(cmd));
}
