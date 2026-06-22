/**
 * @file registerAllAgents.ts — singleton AgentRegistry pre-loaded with all
 * 22 specialized SANIX agents (20 base agents + UI/UX Designer + UltraWorker).
 */
import { AgentRegistry } from './AgentRegistry.js';
import type { SpecializedAgent } from './types.js';

// All 20 base agents
import { SecuritySentinel } from './agents/SecuritySentinel.js';
import { MigrationMaestro } from './agents/MigrationMaestro.js';
import { TestArchitect } from './agents/TestArchitect.js';
import { PerfProfiler } from './agents/PerfProfiler.js';
import { DocDoctor } from './agents/DocDoctor.js';
import { RefactorRanger } from './agents/RefactorRanger.js';
import { DependencyDetective } from './agents/DependencyDetective.js';
import { APIDesigner } from './agents/APIDesigner.js';
import { DBAAgent } from './agents/DBAAgent.js';
import { DevOpsEngineer } from './agents/DevOpsEngineer.js';
import { DataScientistAgent } from './agents/DataScientist.js';
import { AccessibilityAuditorAgent } from './agents/AccessibilityAuditor.js';
import { ChangelogGeneratorAgent } from './agents/ChangelogGenerator.js';
import { OnboardingBuddyAgent } from './agents/OnboardingBuddy.js';
import { BugBountyHunter } from './agents/BugBountyHunter.js';
import { CostOptimizer } from './agents/CostOptimizer.js';
import { PairProgrammer } from './agents/PairProgrammer.js';
import { RetroAgent } from './agents/RetroAgent.js';
import { CodeArchaeologist } from './agents/CodeArchaeologist.js';
import { LogDetective } from './agents/LogDetective.js';
// Agents 21-22: UI/UX Designer + UltraWorker orchestrator
import { UIDesigner } from './agents/UIDesigner.js';
import { UltraWorker } from './agents/UltraWorker.js';

let globalRegistry: AgentRegistry | null = null;

export function getGlobalRegistry(): AgentRegistry {
  if (globalRegistry) return globalRegistry;
  globalRegistry = new AgentRegistry();

  const agents: SpecializedAgent[] = [
    new SecuritySentinel(),
    new MigrationMaestro(),
    new TestArchitect(),
    new PerfProfiler(),
    new DocDoctor(),
    new RefactorRanger(),
    new DependencyDetective(),
    new APIDesigner(),
    new DBAAgent(),
    new DevOpsEngineer(),
    new DataScientistAgent(),
    new AccessibilityAuditorAgent(),
    new ChangelogGeneratorAgent(),
    new OnboardingBuddyAgent(),
    new BugBountyHunter(),
    new CostOptimizer(),
    new PairProgrammer(),
    new RetroAgent(),
    new CodeArchaeologist(),
    new LogDetective(),
    // V12-1 additions
    new UIDesigner(),
    new UltraWorker(),
  ];

  for (const agent of agents) {
    try {
      globalRegistry.register(agent);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[sanix/agents] Could not register "${agent.id}": ${msg}`);
    }
  }

  return globalRegistry;
}

export function resetGlobalRegistry(): void {
  globalRegistry = null;
}

export { AgentRegistry } from './AgentRegistry.js';
export type { SpecializedAgent } from './types.js';
