/**
 * @file session/SessionManager.ts
 * @description Persistent, atomic session management for the SANIX CLI.
 *
 * A *session* is a named, durable conversation between the user and the
 * agent — including messages, goals, costs, tags, and metadata. Sessions
 * let users save their work, switch between parallel threads of inquiry,
 * fork a conversation at any point, and resume later (even after a
 * process restart).
 *
 * Persistence model
 * -----------------
 * Each session lives at `~/.sanix/sessions/<id>.json` as a single JSON
 * file. The active session id is tracked at `~/.sanix/sessions/active`
 * (a plain-text file containing the id). All writes are *atomic*: the
 * JSON is serialized to `<id>.json.tmp`, then `fs.renameSync` swaps it
 * into place — so a crash mid-write never leaves a truncated session
 * file.
 *
 * The manager is in-memory first. {@link SessionManager.save} /
 * {@link SessionManager.saveSession} flush to disk; {@link load} /
 * {@link loadSession} pull from disk. Mutating operations (create /
 * update / addMessage / fork / ...) update the in-memory copy and call
 * `saveSession(id)` immediately so the disk state is never stale.
 *
 * @packageDocumentation
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { nanoid } from 'nanoid';

/** A single message in a session. */
export interface SessionMessage {
  /** Stable unique id (nanoid). */
  id: string;
  /** Conversation role. `tool` is used for tool-call results. */
  role: 'user' | 'assistant' | 'system' | 'tool';
  /** Message content (plain text). */
  content: string;
  /** Unix ms timestamp. */
  timestamp: number;
  /** Tool invocations recorded alongside this message (if any). */
  toolCalls?: Array<{
    name: string;
    input: unknown;
    output: unknown;
    durationMs: number;
  }>;
  /** Tokens used by this message (input + output, best-effort). */
  tokensUsed?: number;
  /** Estimated USD cost for this message. */
  costUsd?: number;
}

/** Session lifecycle status. */
export type SessionStatus = 'active' | 'completed' | 'aborted';

/** A complete persisted session. */
export interface Session {
  /** Stable unique id (nanoid). */
  id: string;
  /** Human-readable name (auto-generated or user-set). */
  name: string;
  /** Unix ms when the session was created. */
  createdAt: number;
  /** Unix ms when the session was last updated. */
  updatedAt: number;
  /** Conversation messages in chronological order. */
  messages: SessionMessage[];
  /** Optional free-text goal the user declared for the session. */
  goal?: string;
  /** Provider id used for this session (informational). */
  provider?: string;
  /** Model id used for this session (informational). */
  model?: string;
  /** User-assigned tags (free-form strings). */
  tags: string[];
  /** Whether the session is pinned (sticky in `list`). */
  pinned: boolean;
  /** Aggregated metadata for the session. */
  metadata: {
    /** Sum of all message token counts. */
    totalTokens: number;
    /** Sum of all message USD costs. */
    totalCostUsd: number;
    /** Number of agent iterations recorded. */
    iterationCount: number;
    /** Lifecycle status. */
    status: SessionStatus;
  };
}

/** Constructor options for {@link SessionManager}. */
export interface SessionManagerOptions {
  /** Override the sessions directory (defaults to `~/.sanix/sessions/`). */
  sessionsDir?: string;
}

/** Filter object accepted by {@link SessionManager.list}. */
export interface SessionListFilter {
  /** Only sessions with this status. */
  status?: SessionStatus;
  /** Only sessions with this tag. */
  tag?: string;
  /** Only pinned sessions. */
  pinned?: boolean;
}

/** Aggregate stats returned by {@link SessionManager.stats}. */
export interface SessionStats {
  totalSessions: number;
  activeSessions: number;
  totalMessages: number;
  totalCostUsd: number;
  totalTokens: number;
  oldestSession?: number;
  newestSession?: number;
}

/** Search-result entry returned by {@link SessionManager.search}. */
export interface SessionSearchResult {
  session: Session;
  matches: Array<{
    messageId: string;
    snippet: string;
  }>;
}

/** Default sessions directory: `~/.sanix/sessions/`. */
export const DEFAULT_SESSIONS_DIR: string = join(homedir(), '.sanix', 'sessions');

/** Maximum snippet length used by {@link SessionManager.search}. */
const SEARCH_SNIPPET_LEN = 120;

/** Maximum name length (auto-generated names are clipped to this). */
const MAX_NAME_LEN = 80;

/**
 * Build a session name from the first user message. Strips whitespace,
 * clips to {@link MAX_NAME_LEN}, and falls back to "Untitled" when empty.
 */
function autoNameFromMessage(content: string): string {
  const trimmed = content.trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0) return 'Untitled';
  return trimmed.length > MAX_NAME_LEN ? trimmed.slice(0, MAX_NAME_LEN - 1) + '…' : trimmed;
}

/** Build a snippet around the first match of `query` (case-insensitive). */
function buildSnippet(content: string, query: string): string {
  const idx = content.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) {
    return content.length > SEARCH_SNIPPET_LEN
      ? content.slice(0, SEARCH_SNIPPET_LEN - 1) + '…'
      : content;
  }
  const half = Math.floor((SEARCH_SNIPPET_LEN - query.length) / 2);
  const start = Math.max(0, idx - half);
  const end = Math.min(content.length, idx + query.length + half);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < content.length ? '…' : '';
  return prefix + content.slice(start, end) + suffix;
}

/**
 * Session manager. Single in-memory map keyed by session id, persisted
 * to individual JSON files at `<sessionsDir>/<id>.json`.
 *
 * @example
 * ```ts
 * const sm = new SessionManager();
 * await sm.load();
 * const s = sm.create('Auth refactor', { goal: 'Refactor JWT auth' });
 * sm.addMessage(s.id, { role: 'user', content: 'Hello' });
 * await sm.save(); // atomic per-file writes
 * ```
 */
export class SessionManager {
  private readonly sessions: Map<string, Session> = new Map();
  private activeSessionId: string | null = null;
  private readonly sessionsDir: string;

  constructor(opts: SessionManagerOptions = {}) {
    this.sessionsDir = opts.sessionsDir ?? DEFAULT_SESSIONS_DIR;
    // Ensure the directory exists on construction so subsequent save/load
    // calls don't need to re-create it.
    this.ensureDir();
  }

  // ─── Session CRUD ──────────────────────────────────────────────────

  /**
   * Create a new session. If `name` is omitted, it's auto-generated
   * from the first user message added (or "Untitled" if no messages
   * yet). The new session becomes the active session.
   */
  create(name?: string, opts: { goal?: string; provider?: string } = {}): Session {
    const now = Date.now();
    const session: Session = {
      id: nanoid(21),
      name: name ?? 'Untitled',
      createdAt: now,
      updatedAt: now,
      messages: [],
      goal: opts.goal,
      provider: opts.provider,
      tags: [],
      pinned: false,
      metadata: {
        totalTokens: 0,
        totalCostUsd: 0,
        iterationCount: 0,
        status: 'active',
      },
    };
    this.sessions.set(session.id, session);
    this.activeSessionId = session.id;
    void this.saveSession(session.id);
    void this.persistActiveId();
    return session;
  }

  /** Get a session by id (or `null` if not found). */
  get(id: string): Session | null {
    return this.sessions.get(id) ?? null;
  }

  /** Get the active session (or `null` if none). */
  getActive(): Session | null {
    if (!this.activeSessionId) return null;
    return this.sessions.get(this.activeSessionId) ?? null;
  }

  /** Get the active session's id (or `null` if none). */
  getActiveId(): string | null {
    return this.activeSessionId;
  }

  /**
   * List sessions, optionally filtered. Sorted by `pinned` (desc) then
   * `updatedAt` (desc).
   */
  list(filter?: SessionListFilter): Session[] {
    let out = [...this.sessions.values()];
    if (filter?.status) {
      out = out.filter((s) => s.metadata.status === filter.status);
    }
    if (filter?.tag) {
      out = out.filter((s) => s.tags.includes(filter.tag!));
    }
    if (filter?.pinned) {
      out = out.filter((s) => s.pinned);
    }
    out.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });
    return out;
  }

  /**
   * Apply a partial patch to a session. `id` and `createdAt` are
   * immutable; everything else is shallow-merged. `updatedAt` is
   * refreshed. Persists immediately.
   */
  update(id: string, patch: Partial<Session>): void {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`Session not found: ${id}`);
    const { id: _id, createdAt: _createdAt, ...rest } = patch;
    void _id; void _createdAt;
    const updated: Session = {
      ...s,
      ...rest,
      id: s.id,
      createdAt: s.createdAt,
      updatedAt: Date.now(),
    };
    this.sessions.set(id, updated);
    void this.saveSession(id);
  }

  /** Delete a session (also removes its JSON file). Returns `true` if it existed. */
  delete(id: string): boolean {
    const existed = this.sessions.delete(id);
    if (this.activeSessionId === id) {
      this.activeSessionId = null;
      void this.persistActiveId();
    }
    // Remove the file from disk (best-effort).
    const fp = this.sessionFilePath(id);
    try {
      if (existsSync(fp)) unlinkSync(fp);
    } catch {
      // Non-fatal.
    }
    return existed;
  }

  /** Rename a session. */
  rename(id: string, name: string): void {
    this.update(id, { name });
  }

  /** Pin a session (sticky in `list`). */
  pin(id: string): void {
    this.update(id, { pinned: true });
  }

  /** Unpin a session. */
  unpin(id: string): void {
    this.update(id, { pinned: false });
  }

  /** Add a tag to a session (idempotent). */
  tag(id: string, tag: string): void {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`Session not found: ${id}`);
    if (s.tags.includes(tag)) return;
    this.update(id, { tags: [...s.tags, tag] });
  }

  /** Remove a tag from a session (no-op if not present). */
  untag(id: string, tag: string): void {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`Session not found: ${id}`);
    this.update(id, { tags: s.tags.filter((t) => t !== tag) });
  }

  // ─── Session Switching ─────────────────────────────────────────────

  /**
   * Switch the active session to `id`. Returns the now-active session
   * (or `null` if not found).
   */
  switchTo(id: string): Session | null {
    if (!this.sessions.has(id)) return null;
    this.activeSessionId = id;
    void this.persistActiveId();
    return this.sessions.get(id) ?? null;
  }

  // ─── Message Operations ────────────────────────────────────────────

  /**
   * Append a message to a session. Auto-generates `id` and `timestamp`.
   * If the session name is still "Untitled" and this is the first user
   * message, the name is auto-derived from the content. Recomputes
   * aggregate metadata. Persists immediately.
   */
  addMessage(
    sessionId: string,
    msg: Omit<SessionMessage, 'id' | 'timestamp'>,
  ): SessionMessage {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Session not found: ${sessionId}`);
    const full: SessionMessage = {
      ...msg,
      id: nanoid(21),
      timestamp: Date.now(),
    };
    s.messages.push(full);
    // Auto-name from first user message.
    if (s.name === 'Untitled' && msg.role === 'user' && s.messages.filter((m) => m.role === 'user').length === 1) {
      s.name = autoNameFromMessage(msg.content);
    }
    // Recompute metadata.
    this.recomputeMetadata(s);
    s.updatedAt = Date.now();
    void this.saveSession(sessionId);
    return full;
  }

  /** Edit a message's content (preserves id + timestamp). */
  editMessage(sessionId: string, messageId: string, newContent: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Session not found: ${sessionId}`);
    const m = s.messages.find((x) => x.id === messageId);
    if (!m) throw new Error(`Message not found: ${messageId}`);
    m.content = newContent;
    s.updatedAt = Date.now();
    void this.saveSession(sessionId);
  }

  /** Delete a message from a session. */
  deleteMessage(sessionId: string, messageId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Session not found: ${sessionId}`);
    const before = s.messages.length;
    s.messages = s.messages.filter((m) => m.id !== messageId);
    if (s.messages.length === before) return;
    this.recomputeMetadata(s);
    s.updatedAt = Date.now();
    void this.saveSession(sessionId);
  }

  /** Get all messages for a session (chronological). */
  getMessages(sessionId: string): SessionMessage[] {
    const s = this.sessions.get(sessionId);
    return s ? [...s.messages] : [];
  }

  // ─── Fork ──────────────────────────────────────────────────────────

  /**
   * Fork a session into a new one. Optionally start from a specific
   * message id (inclusive) — useful for "what if I had taken a
   * different path here" explorations. The forked session is set
   * active. Metadata is recomputed for the forked slice.
   */
  fork(sessionId: string, fromMessageId?: string, name?: string): Session {
    const source = this.sessions.get(sessionId);
    if (!source) throw new Error(`Session not found: ${sessionId}`);
    let slice: SessionMessage[];
    if (fromMessageId) {
      const idx = source.messages.findIndex((m) => m.id === fromMessageId);
      if (idx < 0) throw new Error(`Fork point message not found: ${fromMessageId}`);
      slice = source.messages.slice(0, idx + 1).map((m) => ({ ...m }));
    } else {
      slice = source.messages.map((m) => ({ ...m }));
    }
    const now = Date.now();
    const forked: Session = {
      id: nanoid(21),
      name: name ?? `${source.name} (fork)`,
      createdAt: now,
      updatedAt: now,
      messages: slice,
      goal: source.goal,
      provider: source.provider,
      model: source.model,
      tags: [...source.tags],
      pinned: false,
      metadata: {
        totalTokens: 0,
        totalCostUsd: 0,
        iterationCount: 0,
        status: 'active',
      },
    };
    this.recomputeMetadata(forked);
    this.sessions.set(forked.id, forked);
    this.activeSessionId = forked.id;
    void this.saveSession(forked.id);
    void this.persistActiveId();
    return forked;
  }

  // ─── Search ────────────────────────────────────────────────────────

  /**
   * Search every session's messages for `query` (case-insensitive
   * substring). Returns one entry per session that has at least one
   * match, with a snippet per matching message.
   */
  search(query: string): SessionSearchResult[] {
    if (!query) return [];
    const q = query.toLowerCase();
    const results: SessionSearchResult[] = [];
    for (const session of this.sessions.values()) {
      const matches: SessionSearchResult['matches'] = [];
      for (const m of session.messages) {
        if (m.content.toLowerCase().includes(q)) {
          matches.push({ messageId: m.id, snippet: buildSnippet(m.content, query) });
        }
      }
      if (matches.length > 0) {
        results.push({ session, matches });
      }
    }
    // Sort by match count desc, then by session updatedAt desc.
    results.sort((a, b) => {
      if (b.matches.length !== a.matches.length) return b.matches.length - a.matches.length;
      return b.session.updatedAt - a.session.updatedAt;
    });
    return results;
  }

  // ─── Persistence ───────────────────────────────────────────────────

  /**
   * Load all sessions from disk into memory. Replaces any existing
   * in-memory state. The active session id is restored from the
   * `active` file (if present).
   */
  async load(): Promise<void> {
    this.sessions.clear();
    if (!existsSync(this.sessionsDir)) {
      this.ensureDir();
      return;
    }
    let entries: string[] = [];
    try {
      entries = readdirSync(this.sessionsDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      if (entry === 'active.json') continue; // shouldn't exist, but skip
      const fp = join(this.sessionsDir, entry);
      try {
        const text = readFileSync(fp, 'utf-8');
        const parsed = JSON.parse(text) as unknown;
        if (!this.isSession(parsed)) continue;
        this.sessions.set(parsed.id, parsed);
      } catch {
        // Skip corrupted files.
      }
    }
    // Restore the active session id.
    const activePath = join(this.sessionsDir, 'active');
    if (existsSync(activePath)) {
      try {
        const id = readFileSync(activePath, 'utf-8').trim();
        if (id && this.sessions.has(id)) {
          this.activeSessionId = id;
        }
      } catch {
        // Ignore.
      }
    }
  }

  /**
   * Save all in-memory sessions to disk. Each session is written
   * atomically (temp file + rename). The `active` file is also
   * re-persisted.
   */
  async save(): Promise<void> {
    this.ensureDir();
    for (const id of this.sessions.keys()) {
      await this.saveSession(id);
    }
    await this.persistActiveId();
  }

  /**
   * Atomically write a single session to disk. The session is
   * serialized to `<id>.json.tmp`, then `renameSync` swaps it into
   * `<id>.json`.
   */
  async saveSession(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    this.ensureDir();
    const fp = this.sessionFilePath(id);
    const tmp = `${fp}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf-8');
      renameSync(tmp, fp);
    } catch {
      // Best-effort cleanup of the temp file if rename failed.
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {
        // Ignore.
      }
    }
  }

  /**
   * Load a single session from disk (replacing any in-memory copy).
   * Returns `null` if the file doesn't exist or is invalid.
   */
  async loadSession(id: string): Promise<Session | null> {
    const fp = this.sessionFilePath(id);
    if (!existsSync(fp)) return null;
    try {
      const text = readFileSync(fp, 'utf-8');
      const parsed = JSON.parse(text) as unknown;
      if (!this.isSession(parsed)) return null;
      this.sessions.set(id, parsed);
      return parsed;
    } catch {
      return null;
    }
  }

  // ─── Export ────────────────────────────────────────────────────────

  /**
   * Export a session as a string in the requested format:
   *  - `json`     — pretty-printed JSON of the full session.
   *  - `markdown` — a readable Markdown transcript.
   *  - `text`     — a plain-text transcript (one line per message).
   */
  exportSession(id: string, format: 'json' | 'markdown' | 'text'): string {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`Session not found: ${id}`);
    if (format === 'json') {
      return JSON.stringify(s, null, 2);
    }
    if (format === 'text') {
      const lines: string[] = [];
      lines.push(`# ${s.name}`);
      lines.push(`id: ${s.id}`);
      lines.push(`created: ${new Date(s.createdAt).toISOString()}`);
      if (s.goal) lines.push(`goal: ${s.goal}`);
      lines.push('');
      for (const m of s.messages) {
        const ts = new Date(m.timestamp).toISOString();
        lines.push(`[${ts}] ${m.role.toUpperCase()}:`);
        lines.push(m.content);
        lines.push('');
      }
      return lines.join('\n');
    }
    // markdown
    const lines: string[] = [];
    lines.push(`# ${s.name}`);
    lines.push('');
    lines.push(`- **ID:** \`${s.id}\``);
    lines.push(`- **Created:** ${new Date(s.createdAt).toISOString()}`);
    lines.push(`- **Updated:** ${new Date(s.updatedAt).toISOString()}`);
    if (s.goal) lines.push(`- **Goal:** ${s.goal}`);
    if (s.provider) lines.push(`- **Provider:** ${s.provider}`);
    if (s.model) lines.push(`- **Model:** ${s.model}`);
    if (s.tags.length > 0) lines.push(`- **Tags:** ${s.tags.join(', ')}`);
    lines.push(`- **Status:** ${s.metadata.status}`);
    lines.push(`- **Tokens:** ${s.metadata.totalTokens}`);
    lines.push(`- **Cost (USD):** $${s.metadata.totalCostUsd.toFixed(6)}`);
    lines.push('');
    lines.push('## Transcript');
    lines.push('');
    for (const m of s.messages) {
      const ts = new Date(m.timestamp).toISOString();
      const header = m.role === 'user'
        ? '🧑 User'
        : m.role === 'assistant'
          ? '🤖 Assistant'
          : m.role === 'system'
            ? '⚙️ System'
            : '🔧 Tool';
      lines.push(`### ${header} — _${ts}_`);
      lines.push('');
      lines.push(m.content);
      lines.push('');
      if (m.toolCalls && m.toolCalls.length > 0) {
        lines.push('<details><summary>Tool calls</summary>');
        lines.push('');
        for (const tc of m.toolCalls) {
          lines.push(`- **${tc.name}** (${tc.durationMs}ms)`);
          lines.push(`  - input: \`${JSON.stringify(tc.input).slice(0, 200)}\``);
          lines.push(`  - output: \`${JSON.stringify(tc.output).slice(0, 200)}\``);
        }
        lines.push('');
        lines.push('</details>');
        lines.push('');
      }
    }
    return lines.join('\n');
  }

  /** Export all sessions as a single JSON string. */
  exportAll(format: 'json'): string {
    if (format !== 'json') throw new Error(`Unsupported export-all format: ${format}`);
    const all = [...this.sessions.values()];
    return JSON.stringify(all, null, 2);
  }

  // ─── Stats ─────────────────────────────────────────────────────────

  /** Aggregate stats across all sessions. */
  stats(): SessionStats {
    let totalMessages = 0;
    let totalCostUsd = 0;
    let totalTokens = 0;
    let activeSessions = 0;
    let oldest: number | undefined;
    let newest: number | undefined;
    for (const s of this.sessions.values()) {
      totalMessages += s.messages.length;
      totalCostUsd += s.metadata.totalCostUsd;
      totalTokens += s.metadata.totalTokens;
      if (s.metadata.status === 'active') activeSessions++;
      if (oldest === undefined || s.createdAt < oldest) oldest = s.createdAt;
      if (newest === undefined || s.createdAt > newest) newest = s.createdAt;
    }
    return {
      totalSessions: this.sessions.size,
      activeSessions,
      totalMessages,
      totalCostUsd,
      totalTokens,
      oldestSession: oldest,
      newestSession: newest,
    };
  }

  // ─── Internal ──────────────────────────────────────────────────────

  /** Path to a single session JSON file. */
  private sessionFilePath(id: string): string {
    return join(this.sessionsDir, `${id}.json`);
  }

  /** Ensure the sessions directory exists. */
  private ensureDir(): void {
    try {
      if (!existsSync(this.sessionsDir)) {
        mkdirSync(this.sessionsDir, { recursive: true });
      }
    } catch {
      // Best-effort.
    }
  }

  /** Atomically persist the active session id to the `active` file. */
  private async persistActiveId(): Promise<void> {
    this.ensureDir();
    const fp = join(this.sessionsDir, 'active');
    const tmp = `${fp}.tmp`;
    try {
      writeFileSync(tmp, this.activeSessionId ?? '', 'utf-8');
      renameSync(tmp, fp);
    } catch {
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {
        // Ignore.
      }
    }
  }

  /** Recompute aggregate metadata for a session from its messages. */
  private recomputeMetadata(s: Session): void {
    let totalTokens = 0;
    let totalCostUsd = 0;
    for (const m of s.messages) {
      if (typeof m.tokensUsed === 'number') totalTokens += m.tokensUsed;
      if (typeof m.costUsd === 'number') totalCostUsd += m.costUsd;
    }
    s.metadata.totalTokens = totalTokens;
    s.metadata.totalCostUsd = totalCostUsd;
    s.metadata.iterationCount = s.messages.filter((m) => m.role === 'assistant').length;
  }

  /** Runtime type guard for a parsed session JSON object. */
  private isSession(value: unknown): value is Session {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Record<string, unknown>;
    return (
      typeof v.id === 'string' &&
      typeof v.name === 'string' &&
      typeof v.createdAt === 'number' &&
      typeof v.updatedAt === 'number' &&
      Array.isArray(v.messages) &&
      typeof v.metadata === 'object' &&
      v.metadata !== null
    );
  }

  /** Total on-disk size (bytes) of the sessions directory. */
  diskSizeBytes(): number {
    if (!existsSync(this.sessionsDir)) return 0;
    let total = 0;
    try {
      for (const entry of readdirSync(this.sessionsDir)) {
        const fp = join(this.sessionsDir, entry);
        try {
          const st = statSync(fp);
          if (st.isFile()) total += st.size;
        } catch {
          // Skip.
        }
      }
    } catch {
      // Ignore.
    }
    return total;
  }
}
