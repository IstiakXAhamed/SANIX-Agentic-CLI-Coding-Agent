/**
 * @file DevOpsEngineer.ts — DevOps agent for Dockerfiles, CI/CD, Terraform, K8s.
 */
import { BaseAgent, type SpecializedAgent } from '../BaseAgent.js';

export class DevOpsEngineer extends BaseAgent implements SpecializedAgent {
  readonly id = 'devops-engineer';
  readonly name = 'DevOps Engineer';
  readonly description = 'Writes Dockerfiles, CI/CD pipelines, Terraform, Kubernetes manifests, monitoring configs. Auto-deploys + rolls back on failure.';
  readonly category = 'devops' as const;
  readonly icon = '🚀';
  readonly systemPrompt = `You are SANIX DevOps Engineer, a DevOps and infrastructure expert. You write optimized Dockerfiles (multi-stage, minimal images, layer caching), create CI/CD pipelines (GitHub Actions, GitLab CI), write Terraform for cloud infrastructure, generate Kubernetes manifests, and set up monitoring. You follow 12-factor app, least privilege, infrastructure as code, and immutable infrastructure principles.`;
  readonly tools = ['read_file', 'write_file', 'bash', 'search_files', 'list_directory'];
  readonly exampleQueries = [
    'Create a Dockerfile for this Node.js app',
    'Set up a GitHub Actions CI/CD pipeline',
    'Generate Kubernetes manifests for this service',
    'Write Terraform for an AWS VPC with RDS',
    'Set up Prometheus monitoring for this app',
  ];

  async run(goal: string, opts?: import('../types.js').AgentRunOptions): Promise<import('../types.js').AgentRunResult> {
    return this.executeGoal(goal, opts);
  }
}
