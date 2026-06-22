/**
 * @file index.ts
 * @description Public entry point for `@sanix/core`. Re-exports the full
 * surface of the SANIX orchestration engine:
 *
 *   - **agent**        — OODA loop, planner, executor, reflector, sub-agent
 *     manager (the heart of SANIX).
 *   - **memory**       — 4-tier hierarchical memory (working, episodic,
 *     semantic, procedural) + compressor + embedding provider.
 *   - **context**      — token-budget allocator, context builder, pruner, file
 *     context loader (with prompt-cache-aware variants).
 *   - **tools**        — tool registry, validator, result envelope, interfaces.
 *   - **cost**         — per-call cost tracker, pricing table, computeCost
 *     helper (persisted to ~/.sanix/costs.jsonl).
 *   - **hooks**        — extensible hook system (lifecycle, tool, LLM, plan,
 *     sub-agent, cost events with veto / modify semantics).
 *   - **checkpoint**   — session checkpoint persistence + auto-checkpointing.
 *   - **conversation** — chat-mode conversation branching (fork / switch).
 *   - **approval**     — human-in-the-loop tool approval workflow.
 *
 * Importing paths:
 *   import { AgentLoop, MemoryRouter, ContextBuilder, ToolRegistry } from '@sanix/core';
 *   import { Planner } from '@sanix/core/agent';
 *   import { WorkingMemory } from '@sanix/core/memory';
 *   import { TokenBudget, TokenCounter } from '@sanix/core/context';
 *   import { CostTracker, computeCost } from '@sanix/core/cost';
 *   import { SanixTool } from '@sanix/core/tools';
 *   import { HookManager } from '@sanix/core/hooks';
 *   import { CheckpointManager } from '@sanix/core/checkpoint';
 *   import { BranchManager } from '@sanix/core/conversation';
 *   import { ApprovalManager } from '@sanix/core/approval';
 *
 * @packageDocumentation
 */

// ── Agent subsystem ─────────────────────────────────────────────────────────
export * from './agent/index.js';

// ── Memory subsystem ────────────────────────────────────────────────────────
export * from './memory/index.js';

// ── Context subsystem ───────────────────────────────────────────────────────
export * from './context/index.js';

// ── Tools subsystem ─────────────────────────────────────────────────────────
export * from './tools/index.js';

// ── Cost subsystem (per-call cost accounting + prompt-cache savings) ────────
export * from './cost/index.js';

// ── Hooks subsystem (extensible event bus with veto / modify semantics) ─────
export * from './hooks/index.js';

// ── Checkpoint subsystem (session persistence + resume) ─────────────────────
export * from './checkpoint/index.js';

// ── Conversation subsystem (branching for chat mode) ────────────────────────
export * from './conversation/index.js';

// ── Approval subsystem (human-in-the-loop tool approval) ────────────────────
export * from './approval/index.js';
