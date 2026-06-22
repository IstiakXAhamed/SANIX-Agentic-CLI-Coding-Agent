/**
 * @file workspace/index.ts
 * @description Barrel re-export for the SANIX workspace loader.
 *
 * Public surface:
 *   - {@link WorkspaceLoader}    — detect + summarize the user's project.
 *   - {@link WorkspaceContext}    — snapshot of the project's structure.
 *   - {@link ProjectLanguage}     — supported project languages.
 *   - {@link PackageManager}      — supported package managers.
 *   - {@link SelectRelevantFilesOptions} — options for `selectRelevantFiles`.
 *   - {@link BuildContextStringOptions}  — options for `buildContextString`.
 *
 * @packageDocumentation
 */

export {
  WorkspaceLoader,
  type WorkspaceContext,
  type ProjectLanguage,
  type PackageManager,
  type SelectRelevantFilesOptions,
  type BuildContextStringOptions,
} from './WorkspaceLoader.js';
