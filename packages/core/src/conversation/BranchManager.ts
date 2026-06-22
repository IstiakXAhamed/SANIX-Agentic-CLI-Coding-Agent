/**
 * @file conversation/BranchManager.ts
 * @description Conversation branching for SANIX chat mode. Lets a user fork
 * the current conversation from any prior message, explore an alternative
 * path, then switch back — without losing either branch.
 *
 * Each branch is an independent `LLMMessage[]` with a parent pointer.
 * `fork(fromMessageIndex)` creates a new branch whose message history is
 * the parent's first N messages. `switchTo` makes a branch active; all
 * `appendMessage` / `getMessages` calls operate on the active branch.
 *
 * @packageDocumentation
 */

import { nanoid } from 'nanoid';
import type { LLMMessage } from '@sanix/providers';

// ─── Branch shape ───────────────────────────────────────────────────────────

/**
 * A single conversation branch. Branches form a tree (each has a parentId
 * pointing at its parent, or `null` for the root). Only one branch is
 * `active` at a time.
 */
export interface ConversationBranch {
  /** Unique id (nanoid). */
  id: string;
  /** Parent branch id, or `null` for the root branch. */
  parentId: string | null;
  /** Unix epoch milliseconds. */
  createdAt: number;
  /** The branch's message history (independent of other branches). */
  messages: LLMMessage[];
  /** Optional human-readable label. */
  label?: string;
  /** True if this is the currently-active branch. */
  active: boolean;
}

// ─── BranchManager ──────────────────────────────────────────────────────────

/**
 * Manages a tree of conversation branches. One instance per chat session.
 *
 * @example
 * ```ts
 * const bm = new BranchManager();
 * bm.appendMessage({ role: 'user', content: 'Hello' });
 * bm.appendMessage({ role: 'assistant', content: 'Hi there!' });
 *
 * // Fork from before the assistant's reply to explore a different response.
 * const forkId = bm.fork(1, 'alternative-greeting');
 * bm.switchTo(forkId);
 * bm.appendMessage({ role: 'assistant', content: 'Greetings, human.' });
 *
 * // Switch back to the original branch.
 * bm.switchTo(originalId);
 * console.log(bm.getMessages().length); // 2
 * ```
 */
export class BranchManager {
  /** All branches, keyed by id. */
  private readonly branches: Map<string, ConversationBranch> = new Map();
  /** The currently-active branch id. */
  private activeBranchId: string;

  constructor() {
    // Create the root branch.
    const rootId = nanoid();
    const root: ConversationBranch = {
      id: rootId,
      parentId: null,
      createdAt: Date.now(),
      messages: [],
      active: true,
    };
    this.branches.set(rootId, root);
    this.activeBranchId = rootId;
  }

  /**
   * Create a new branch with the given parent. The new branch starts with
   * an empty message list (use {@link fork} to copy a prefix of the
   * parent's messages).
   *
   * @param parentId - Parent branch id, or `null` to parent at the root.
   * @param label - Optional human-readable label.
   * @returns The new branch id.
   */
  createBranch(parentId: string | null, label?: string): string {
    const parent = parentId === null ? this.getRoot() : this.branches.get(parentId);
    if (!parent) {
      throw new Error(`createBranch: parent '${parentId}' not found`);
    }
    const id = nanoid();
    const branch: ConversationBranch = {
      id,
      parentId: parent.id,
      createdAt: Date.now(),
      messages: [],
      label,
      active: false,
    };
    this.branches.set(id, branch);
    return id;
  }

  /**
   * Fork a new branch from a specific message index of the currently-active
   * branch. The new branch's messages are the active branch's first
   * `fromMessageIndex` messages (i.e. messages `[0, fromMessageIndex)`).
   * The new branch becomes the active branch.
   *
   * @param fromMessageIndex - Number of messages from the active branch to
   *   copy into the new branch. Must be `>= 0` and `<=` the active branch's
   *   message count. `0` creates an empty branch.
   * @param label - Optional human-readable label.
   * @returns The new branch id.
   */
  fork(fromMessageIndex: number, label?: string): string {
    const parent = this.getActive();
    if (fromMessageIndex < 0) {
      throw new Error(`fork: fromMessageIndex must be >= 0 (got ${fromMessageIndex})`);
    }
    if (fromMessageIndex > parent.messages.length) {
      throw new Error(
        `fork: fromMessageIndex ${fromMessageIndex} out of range (active branch has ${parent.messages.length} messages)`,
      );
    }
    const id = nanoid();
    const branch: ConversationBranch = {
      id,
      parentId: parent.id,
      createdAt: Date.now(),
      messages: parent.messages.slice(0, fromMessageIndex).map(copyMessage),
      label,
      active: false,
    };
    this.branches.set(id, branch);
    this.switchTo(id);
    return id;
  }

  /**
   * Make a branch the active branch. All subsequent {@link appendMessage}
   * and {@link getMessages} calls operate on this branch.
   *
   * @throws if the branch id is unknown.
   */
  switchTo(branchId: string): void {
    const branch = this.branches.get(branchId);
    if (!branch) {
      throw new Error(`switchTo: branch '${branchId}' not found`);
    }
    for (const b of this.branches.values()) b.active = false;
    branch.active = true;
    this.activeBranchId = branchId;
  }

  /**
   * Return the currently-active branch.
   */
  getActive(): ConversationBranch {
    const branch = this.branches.get(this.activeBranchId);
    if (!branch) {
      // Should be unreachable — the active id is always valid.
      throw new Error('BranchManager: active branch missing (internal error)');
    }
    return branch;
  }

  /**
   * List all branches (no particular order).
   */
  list(): ConversationBranch[] {
    return [...this.branches.values()];
  }

  /**
   * Delete a branch. The root branch cannot be deleted. If the deleted
   * branch was active, the root becomes active. Deleting a branch with
   * children is allowed — children retain their `parentId` but their parent
   * will no longer exist (callers should re-parent or delete children
   * first if that matters).
   *
   * @returns `true` if a branch was deleted.
   */
  deleteBranch(id: string): boolean {
    const branch = this.branches.get(id);
    if (!branch) return false;
    if (branch.parentId === null) {
      // Refuse to delete the root branch.
      return false;
    }
    const wasActive = branch.active;
    this.branches.delete(id);
    if (wasActive) {
      // Fall back to the root branch.
      const root = this.getRoot();
      root.active = true;
      this.activeBranchId = root.id;
    }
    return true;
  }

  /**
   * Append a message to the active branch.
   */
  appendMessage(msg: LLMMessage): void {
    this.getActive().messages.push(copyMessage(msg));
  }

  /**
   * Return the active branch's messages (a defensive copy — mutating the
   * returned array does not affect the branch).
   */
  getMessages(): LLMMessage[] {
    return this.getActive().messages.map(copyMessage);
  }

  /**
   * Set or update the label of a branch.
   */
  labelBranch(id: string, label: string): void {
    const branch = this.branches.get(id);
    if (!branch) {
      throw new Error(`labelBranch: branch '${id}' not found`);
    }
    branch.label = label;
  }

  /**
   * Compute the message-level diff between two branches. Returns the
   * messages unique to each branch and the common prefix.
   *
   * Comparison is by structural equality (deep JSON equality of each
   * message), not by reference.
   *
   * @param branchAId - First branch id.
   * @param branchBId - Second branch id.
   * @returns `{ onlyInA, onlyInB, common }`.
   */
  diff(
    branchAId: string,
    branchBId: string,
  ): { onlyInA: LLMMessage[]; onlyInB: LLMMessage[]; common: LLMMessage[] } {
    const a = this.branches.get(branchAId);
    const b = this.branches.get(branchBId);
    if (!a) throw new Error(`diff: branch '${branchAId}' not found`);
    if (!b) throw new Error(`diff: branch '${branchBId}' not found`);

    // Find the longest common prefix.
    const minLen = Math.min(a.messages.length, b.messages.length);
    let commonLen = 0;
    for (let i = 0; i < minLen; i++) {
      if (messageEquals(a.messages[i]!, b.messages[i]!)) {
        commonLen = i + 1;
      } else {
        break;
      }
    }
    const common = a.messages.slice(0, commonLen).map(copyMessage);
    const onlyInA = a.messages.slice(commonLen).map(copyMessage);
    const onlyInB = b.messages.slice(commonLen).map(copyMessage);
    return { onlyInA, onlyInB, common };
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  /** Return the root branch (the one with `parentId === null`). */
  private getRoot(): ConversationBranch {
    for (const b of this.branches.values()) {
      if (b.parentId === null) return b;
    }
    // Should be unreachable — the constructor creates a root.
    throw new Error('BranchManager: root branch missing (internal error)');
  }
}

// ─── Internal helpers ───────────────────────────────────────────────────────

/**
 * Defensive copy of a message. Messages are plain-data objects, so a
 * shallow copy with a copied `tool_calls` array (if present) suffices.
 */
function copyMessage(msg: LLMMessage): LLMMessage {
  if (msg.tool_calls && msg.tool_calls.length > 0) {
    return {
      ...msg,
      tool_calls: msg.tool_calls.map((tc) => ({
        id: tc.id,
        type: tc.type,
        function: { name: tc.function.name, arguments: tc.function.arguments },
      })),
    };
  }
  return { ...msg };
}

/**
 * Structural equality check for two messages. Used by {@link BranchManager.diff}.
 */
function messageEquals(a: LLMMessage, b: LLMMessage): boolean {
  if (a.role !== b.role) return false;
  if (a.content !== b.content) return false;
  if (a.tool_call_id !== b.tool_call_id) return false;
  // Compare tool_calls arrays.
  const aCalls = a.tool_calls ?? [];
  const bCalls = b.tool_calls ?? [];
  if (aCalls.length !== bCalls.length) return false;
  for (let i = 0; i < aCalls.length; i++) {
    const ac = aCalls[i]!;
    const bc = bCalls[i]!;
    if (ac.id !== bc.id) return false;
    if (ac.type !== bc.type) return false;
    if (ac.function.name !== bc.function.name) return false;
    if (ac.function.arguments !== bc.function.arguments) return false;
  }
  return true;
}
