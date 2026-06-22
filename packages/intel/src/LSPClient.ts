/**
 * @file LSPClient.ts
 * @description A thin, dependency-free Language-Server-Protocol client.
 *
 * SANIX ships with a regex-based `SymbolExtractor` that needs no LSP,
 * but for precision work (find-references, type hierarchy, go-to-def)
 * a real language server is unmatched. This client speaks the bare
 * minimum of LSP needed by `@sanix/intel`:
 *
 *   - `initialize` / `initialized`
 *   - `textDocument/didOpen` / `didChange` / `didClose`
 *   - `textDocument/documentSymbol`
 *   - `textDocument/references`
 *   - `textDocument/definition`
 *   - `textDocument/typeDefinition`
 *   - `textDocument/hover`
 *   - `callHierarchy/incomingCalls` / `outgoingCalls` (best-effort)
 *
 * The client spawns the configured server as a child process and
 * speaks newline-delimited JSON-RPC 2.0 over stdio. It deliberately
 * avoids the `vscode-languageserver-protocol` runtime dependency so
 * the package stays install-free — the wire format is simple enough
 * to hand-roll.
 *
 * If a server isn't installed, every method rejects with a clear
 * `LSPError`; the `IntelligenceManager` falls back to regex mode.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomInt } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type {
  LSPDocument,
  LSPServerConfig,
  SupportedLanguage,
} from './types.js';

/**
 * Error thrown by the LSP client.
 */
export class LSPError extends Error {
  /** Machine-readable code. */
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'LSPError';
    this.code = code;
  }
}

/**
 * A single JSON-RPC 2.0 request awaiting a response.
 */
interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  method: string;
  startedAt: number;
}

/** Convert a filesystem path to an LSP `file://` URI. */
function toUri(filePath: string): string {
  return pathToFileURL(filePath).href;
}

/** Infer language id from extension. */
export function languageFromExtension(ext: string): SupportedLanguage | null {
  switch (ext.toLowerCase()) {
    case '.ts':
    case '.tsx':
    case '.mts':
    case '.cts':
      return 'typescript';
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    case '.py':
      return 'python';
    case '.go':
      return 'go';
    case '.rs':
      return 'rust';
    case '.java':
      return 'java';
    default:
      return null;
  }
}

/**
 * LSP client speaking JSON-RPC 2.0 over stdio to a child server.
 *
 * @example
 * ```ts
 * const client = new LSPClient({
 *   command: 'typescript-language-server',
 *   args: ['--stdio'],
 *   extensions: ['.ts', '.tsx'],
 * });
 * await client.start('/workspace');
 * await client.openDoc({ uri: 'file:///workspace/foo.ts', languageId: 'typescript', version: 1, text: '...' });
 * const symbols = await client.documentSymbols('file:///workspace/foo.ts');
 * await client.shutdown();
 * ```
 */
export class LSPClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private initialized = false;
  private readonly emitter = new EventEmitter();
  private rootUri: string | null = null;

  /**
   * @param config Server launch config.
   */
  constructor(private readonly config: LSPServerConfig) {}

  /** EventEmitter for `error`, `exit`, `log` events. */
  public get events(): EventEmitter {
    return this.emitter;
  }

  /**
   * Spawn the server and send `initialize` + `initialized`.
   * @param rootPath Workspace root.
   */
  public async start(rootPath: string): Promise<void> {
    if (this.proc) throw new LSPError('ALREADY_STARTED', 'LSPClient already started');
    this.rootUri = toUri(rootPath);
    try {
      this.proc = spawn(this.config.command, this.config.args ?? [], {
        env: { ...process.env, ...this.config.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      throw new LSPError(
        'SPAWN_FAILED',
        `Failed to launch LSP server "${this.config.command}": ${(e as Error).message}`,
      );
    }
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    this.proc.stderr.on('data', (chunk: Buffer) => {
      this.emitter.emit('log', chunk.toString('utf8'));
    });
    this.proc.on('exit', (code, signal) => {
      this.emitter.emit('exit', { code, signal });
      this.rejectAll(new LSPError('SERVER_EXIT', `LSP server exited (code=${code} signal=${signal})`));
    });
    this.proc.on('error', (err) => {
      this.emitter.emit('error', err);
      this.rejectAll(err);
    });

    await this.request('initialize', {
      processId: process.pid,
      rootUri: this.rootUri,
      capabilities: {
        textDocument: {
          synchronization: { didOpen: true, didChange: true, didClose: true },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          references: {},
          definition: {},
          typeDefinition: {},
          hover: {},
          callHierarchy: { dynamicRegistration: false },
        },
      },
      initializationOptions: this.config.initOptions ?? {},
    });
    this.notify('initialized', {});
    this.initialized = true;
  }

  /**
   * Open a document in the server.
   */
  public async openDoc(doc: LSPDocument): Promise<void> {
    this.notify('textDocument/didOpen', {
      textDocument: { uri: doc.uri, languageId: doc.languageId, version: doc.version, text: doc.text },
    });
  }

  /**
   * Send an incremental change.
   */
  public async changeDoc(uri: string, version: number, text: string): Promise<void> {
    this.notify('textDocument/didChange', {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  /**
   * Close a document.
   */
  public async closeDoc(uri: string): Promise<void> {
    this.notify('textDocument/didClose', { textDocument: { uri } });
  }

  /**
   * Fetch the symbol tree for a document.
   */
  public async documentSymbols(uri: string): Promise<unknown[]> {
    const result = await this.request('textDocument/documentSymbol', { textDocument: { uri } });
    return Array.isArray(result) ? (result as unknown[]) : [];
  }

  /**
   * Find references to a position.
   */
  public async references(uri: string, line: number, character: number, includeDeclaration = true): Promise<unknown[]> {
    const result = await this.request('textDocument/references', {
      textDocument: { uri },
      position: { line, character },
      context: { includeDeclaration },
    });
    return Array.isArray(result) ? (result as unknown[]) : [];
  }

  /**
   * Go to definition.
   */
  public async definition(uri: string, line: number, character: number): Promise<unknown> {
    return this.request('textDocument/definition', {
      textDocument: { uri },
      position: { line, character },
    });
  }

  /**
   * Go to type definition.
   */
  public async typeDefinition(uri: string, line: number, character: number): Promise<unknown> {
    return this.request('textDocument/typeDefinition', {
      textDocument: { uri },
      position: { line, character },
    });
  }

  /**
   * Hover info at a position.
   */
  public async hover(uri: string, line: number, character: number): Promise<unknown> {
    return this.request('textDocument/hover', {
      textDocument: { uri },
      position: { line, character },
    });
  }

  /**
   * Prepare a call hierarchy item at a position (LSP 3.16).
   */
  public async prepareCallHierarchy(uri: string, line: number, character: number): Promise<unknown[]> {
    const result = await this.request('textDocument/prepareCallHierarchy', {
      textDocument: { uri },
      position: { line, character },
    });
    return Array.isArray(result) ? (result as unknown[]) : [];
  }

  /**
   * Incoming calls to a prepared item.
   */
  public async incomingCalls(item: unknown): Promise<unknown[]> {
    const result = await this.request('callHierarchy/incomingCalls', { item });
    return Array.isArray(result) ? (result as unknown[]) : [];
  }

  /**
   * Outgoing calls from a prepared item.
   */
  public async outgoingCalls(item: unknown): Promise<unknown[]> {
    const result = await this.request('callHierarchy/outgoingCalls', { item });
    return Array.isArray(result) ? (result as unknown[]) : [];
  }

  /**
   * Graceful shutdown: `shutdown` → `exit`.
   */
  public async shutdown(): Promise<void> {
    if (!this.proc) return;
    try {
      await this.request('shutdown', null);
      this.notify('exit', null);
    } catch {
      /* server may have exited already */
    } finally {
      this.initialized = false;
      this.proc?.kill('SIGKILL');
      this.proc = null;
    }
  }

  /**
   * Is the server initialized and alive?
   */
  public isAlive(): boolean {
    return this.initialized && this.proc !== null && !this.proc.killed;
  }

  // ─── JSON-RPC plumbing ────────────────────────────────────────────────────

  private request(method: string, params: unknown): Promise<unknown> {
    if (!this.proc) return Promise.reject(new LSPError('NOT_STARTED', 'LSPClient not started'));
    const id = this.nextId++;
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method, startedAt: Date.now() });
      this.write(msg);
    });
  }

  private notify(method: string, params: unknown): void {
    if (!this.proc) return;
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
    this.write(msg);
  }

  private write(body: string): void {
    if (!this.proc) return;
    const frame = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    this.proc.stdin.write(frame);
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    // Parse all complete messages.
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = this.buffer.slice(0, headerEnd);
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const len = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + len) return;
      const body = this.buffer.slice(bodyStart, bodyStart + len);
      this.buffer = this.buffer.slice(bodyStart + len);
      let msg: unknown;
      try {
        msg = JSON.parse(body);
      } catch {
        continue;
      }
      this.handleMessage(msg);
    }
  }

  private handleMessage(msg: unknown): void {
    if (typeof msg !== 'object' || msg === null) return;
    const m = msg as { id?: number; method?: string; result?: unknown; error?: { message?: string; code?: number } };
    if (typeof m.id === 'number' && this.pending.has(m.id)) {
      const pending = this.pending.get(m.id)!;
      this.pending.delete(m.id);
      if (m.error) {
        pending.reject(new LSPError('RPC_ERROR', `${pending.method}: ${m.error.message ?? 'unknown'} (${m.error.code ?? '?'})`));
      } else {
        pending.resolve(m.result);
      }
    } else if (m.method) {
      // Server notification — emit for logging.
      this.emitter.emit('notification', m.method, m);
    }
  }

  private rejectAll(err: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(err);
    }
    this.pending.clear();
  }
}

/** Generate a unique-ish correlation id for batched requests. */
export function nextRequestId(): number {
  return randomInt(1, 0x7fffffff);
}
