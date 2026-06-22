/**
 * @file platforms/index.ts
 * @description Barrel export for the platform clients plus a factory
 * function `createPlatformClient` that picks the right client for a
 * given {@link Platform}.
 *
 * Importing paths:
 * ```ts
 * import { GitHubClient, GitLabClient, BitbucketClient, GiteaClient, createPlatformClient }
 *   from '@sanix/prbot/platforms';
 * ```
 *
 * @packageDocumentation
 */

import type { Platform, PlatformClient, PlatformClientOptions } from '../types.js';
import { GitHubClient } from './GitHubClient.js';
import { GitLabClient } from './GitLabClient.js';
import { BitbucketClient } from './BitbucketClient.js';
import { GiteaClient } from './GiteaClient.js';

export { GitHubClient, parseUnifiedDiff } from './GitHubClient.js';
export { GitLabClient } from './GitLabClient.js';
export { BitbucketClient } from './BitbucketClient.js';
export { GiteaClient } from './GiteaClient.js';

/**
 * Factory that returns the right {@link PlatformClient} for a given
 * {@link Platform}. Throws for unknown platforms.
 *
 * @param platform - The target platform.
 * @param options  - Client configuration (see {@link PlatformClientOptions}).
 * @returns A platform client instance.
 */
export function createPlatformClient(platform: Platform, options: PlatformClientOptions): PlatformClient {
  switch (platform) {
    case 'github':
      return new GitHubClient(options);
    case 'gitlab':
      return new GitLabClient(options);
    case 'bitbucket':
      return new BitbucketClient(options);
    case 'gitea':
      return new GiteaClient(options);
    default: {
      // Exhaustiveness check — TypeScript will error if a new platform
      // is added to the union without a case here.
      const exhaustive: never = platform;
      throw new Error(`Unknown platform: ${String(exhaustive)}`);
    }
  }
}
