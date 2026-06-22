/**
 * @file @sanix/agents — 22 specialized agents for SANIX.
 * @packageDocumentation
 */

export { BaseAgent } from './BaseAgent.js';
export { AgentRegistry } from './AgentRegistry.js';
export * from './types.js';

// Agents 1-5
export { SecuritySentinel } from './agents/SecuritySentinel.js';
export { MigrationMaestro } from './agents/MigrationMaestro.js';
export { TestArchitect } from './agents/TestArchitect.js';
export { PerfProfiler } from './agents/PerfProfiler.js';
export { DocDoctor } from './agents/DocDoctor.js';

// Agents 6-10
export { RefactorRanger } from './agents/RefactorRanger.js';
export { DependencyDetective } from './agents/DependencyDetective.js';
export { APIDesigner } from './agents/APIDesigner.js';
export { DBAAgent } from './agents/DBAAgent.js';
export { DevOpsEngineer } from './agents/DevOpsEngineer.js';

// Agents 11-15
export { DataScientistAgent } from './agents/DataScientist.js';
export { AccessibilityAuditorAgent } from './agents/AccessibilityAuditor.js';
export { ChangelogGeneratorAgent } from './agents/ChangelogGenerator.js';
export { OnboardingBuddyAgent } from './agents/OnboardingBuddy.js';
export { BugBountyHunter } from './agents/BugBountyHunter.js';

// Agents 16-20
export { CostOptimizer } from './agents/CostOptimizer.js';
export { PairProgrammer } from './agents/PairProgrammer.js';
export { RetroAgent } from './agents/RetroAgent.js';
export { CodeArchaeologist } from './agents/CodeArchaeologist.js';
export { LogDetective } from './agents/LogDetective.js';

// Agents 21-22 (V12-1): UI/UX Designer + UltraWorker orchestrator
export { UIDesigner } from './agents/UIDesigner.js';
export type {
  UIDesignerMode,
  UIFramework,
  StylingStrategy,
  ColorSwatch,
  TypographyEntry,
  ComponentVariant,
  UIAuditIssue,
  UIDesignerIntent,
} from './agents/UIDesigner.js';
export { UltraWorker } from './agents/UltraWorker.js';
export type {
  SubTaskPriority,
  ConflictStrategy,
  SubTask,
  SubTaskResult,
  FindingConflict,
  UltraWorkerOptions,
} from './agents/UltraWorker.js';

// Registry + CLI
export { getGlobalRegistry, resetGlobalRegistry } from './registerAllAgents.js';
export { listAgents, runAgent, showAgent, type AgentCLIOptions } from './cli.js';
