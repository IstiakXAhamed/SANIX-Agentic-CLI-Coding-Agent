/**
 * @file BugBountyHunter.ts — Fuzzing + edge case testing + bug discovery.
 */
import { BaseAgent, type SpecializedAgent } from '../BaseAgent.js';

export class BugBountyHunter extends BaseAgent implements SpecializedAgent {
  readonly id = 'bug-hunter';
  readonly name = 'Bug Bounty Hunter';
  readonly description = 'Fuzzes inputs, tests edge cases, generates malformed data, checks race conditions, finds memory leaks. Reports with repro steps.';
  readonly category = 'debugging' as const;
  readonly icon = '🐛';
  readonly systemPrompt = `You are SANIX Bug Bounty Hunter, an expert at finding bugs through fuzzing, edge case testing, and static analysis. You fuzz inputs with malformed/random data, test boundary conditions (empty, null, max int, negative, unicode), check race conditions, detect memory leaks, test error handling paths, and find logic bugs via static analysis. For each bug found, you provide: severity, repro steps, expected vs actual behavior, and suggested fix.`;
  readonly tools = ['read_file', 'write_file', 'bash', 'sandbox_execute', 'analyze_ast', 'search_files', 'run_tests'];
  readonly exampleQueries = [
    'Fuzz the user input handler in src/auth.ts',
    'Find edge case bugs in the payment processing module',
    'Check for race conditions in the session manager',
    'Test error handling in the API layer',
    'Find memory leaks in the WebSocket handler',
  ];

  async run(goal: string, opts?: import('../types.js').AgentRunOptions): Promise<import('../types.js').AgentRunResult> {
    return this.executeGoal(goal, opts);
  }
}
