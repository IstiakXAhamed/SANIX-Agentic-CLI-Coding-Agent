/**
 * @file DependencyDetective.ts
 * @description SANIX Dependency Detective — a dependency-management
 * specialist agent.
 *
 * Audits a project's dependencies for: (1) security vulnerabilities
 * (CVEs), (2) license compliance (GPL/AGPL/unlicensed/unknown),
 * (3) outdated versions, (4) unused packages, (5) bundle-size impact,
 * (6) duplicate dependencies (multiple versions of the same package).
 * Safely auto-updates patch/minor versions with test-after + rollback.
 *
 * @packageDocumentation
 */

import { nanoid } from 'nanoid';
import { BaseAgent } from '../BaseAgent.js';
import type {
  AgentAction,
  AgentCategory,
  AgentFinding,
  AgentProgressEvent,
  AgentRunOptions,
  AgentRunResult,
} from '../types.js';

/** Supported dependency ecosystems. */
export type Ecosystem = 'npm' | 'pip' | 'cargo' | 'go' | 'maven' | 'rubygems' | 'nuget';

/** Severity levels for vulnerabilities. */
export type VulnerabilitySeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

/** License categories. */
export type LicenseCategory = 'permissive' | 'weak_copyleft' | 'strong_copyleft' | 'unlicensed' | 'unknown';

/** A single declared dependency. */
export interface Dependency {
  /** Package name (e.g. `lodash`, `requests`). */
  name: string;
  /** Declared version (e.g. `^4.17.21`, `>=2.28.0`). */
  versionSpec: string;
  /** Resolved version (e.g. `4.17.21`), if known. */
  resolvedVersion?: string;
  /** Dependency type (runtime / dev / peer / optional). */
  dependencyType: 'dependencies' | 'devDependencies' | 'peerDependencies' | 'optionalDependencies' | 'runtime' | 'dev';
  /** Whether it's a direct dependency (vs transitive). */
  direct: boolean;
}

/** A vulnerability record. */
export interface Vulnerability {
  /** CVE id or advisory id (e.g. `CVE-2021-23337`). */
  id: string;
  /** Package name. */
  package: string;
  /** Severity. */
  severity: VulnerabilitySeverity;
  /** Vulnerable version range (e.g. `<4.17.21`). */
  vulnerableRange: string;
  /** Fixed-in version (e.g. `4.17.21`). */
  fixedIn?: string;
  /** Short title. */
  title: string;
  /** URL to the advisory. */
  url?: string;
  /** CVSS score (0..10), if known. */
  cvss?: number;
}

/** An outdated-dependency record. */
export interface OutdatedDep {
  /** Package name. */
  package: string;
  /** Currently installed version. */
  current: string;
  /** Latest version available. */
  latest: string;
  /** Update kind: patch (safe), minor (probably safe), major (breaking). */
  kind: 'patch' | 'minor' | 'major';
  /** Whether auto-update was attempted. */
  autoUpdated: boolean;
  /** Whether tests passed after the update. */
  testsPassed?: boolean;
  /** Whether the update was rolled back. */
  rolledBack?: boolean;
}

/** A license issue record. */
export interface LicenseIssue {
  /** Package name. */
  package: string;
  /** Detected license (SPDX id or `UNKNOWN`). */
  license: string;
  /** License category. */
  category: LicenseCategory;
  /** Whether the license is acceptable for this project. */
  acceptable: boolean;
  /** Reason this license is flagged (if not acceptable). */
  reason?: string;
}

/** A bundle-size record (npm frontend packages). */
export interface BundleSizeRecord {
  /** Package name. */
  package: string;
  /** Minified size in bytes. */
  size: number;
  /** Minified + gzipped size in bytes. */
  gzip: number;
  /** Estimated fraction of total bundle (0..1). */
  shareOfBundle?: number;
}

/** A duplicate-dependency record (multiple versions installed). */
export interface DuplicateDep {
  /** Package name. */
  package: string;
  /** All installed versions. */
  versions: string[];
  /** Number of distinct versions. */
  count: number;
}

/** Vulnerability severity → finding severity. */
const VULN_SEVERITY_MAP: Record<VulnerabilitySeverity, 'critical' | 'high' | 'medium' | 'low' | 'info'> = {
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  low: 'low',
  info: 'info',
};

/** Strong-copyleft licenses we always flag. */
const VIRAL_LICENSES = new Set([
  'GPL',
  'GPL-2.0',
  'GPL-2.0-only',
  'GPL-2.0-or-later',
  'GPL-3.0',
  'GPL-3.0-only',
  'GPL-3.0-or-later',
  'AGPL',
  'AGPL-3.0',
  'AGPL-3.0-only',
  'AGPL-3.0-or-later',
  'SSPL',
  'BUSL-1.1',
  'CC-BY-NC',
  'CC-BY-SA',
  'CC-BY-ND',
]);

/** Weak-copyleft licenses (LGPL, MPL, EPL — usually OK with attribution). */
const WEAK_COPYLEFT = new Set([
  'LGPL',
  'LGPL-2.0',
  'LGPL-2.1',
  'LGPL-3.0',
  'MPL',
  'MPL-1.0',
  'MPL-1.1',
  'MPL-2.0',
  'EPL',
  'EPL-1.0',
  'EPL-2.0',
  'CDDL',
  'CDDL-1.0',
  'CDDL-1.1',
]);

/** Permissive licenses (always OK). */
const PERMISSIVE = new Set([
  'MIT',
  'Apache',
  'Apache-2.0',
  'BSD',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BSD-4-Clause',
  'ISC',
  '0BSD',
  'Unlicense',
  'Zlib',
  'WTFPL',
  'CC0',
  'CC0-1.0',
  'Python-2.0',
  'PostgreSQL',
]);

/**
 * SANIX Dependency Detective — a dependency-management specialist.
 *
 * @example
 * ```ts
 * import { DependencyDetective } from '@sanix/agents';
 *
 * const agent = new DependencyDetective();
 * const result = await agent.run({
 *   query: 'Audit dependencies for vulnerabilities + license issues, and auto-update patches.',
 *   workspacePath: '/repo/my-app',
 *   tools: registry,
 *   onProgress: (e) => console.log(`[${e.phase}] ${e.message}`),
 * });
 * console.log(`${result.metrics.vulnerabilitiesFound} vulnerabilities found.`);
 * ```
 */
export class DependencyDetective extends BaseAgent {
  /** @inheritdoc */
  readonly id = 'dependency-detective';
  /** @inheritdoc */
  readonly name = 'SANIX Dependency Detective';
  /** @inheritdoc */
  readonly description =
    'Audits project dependencies for security vulnerabilities (CVEs), license compliance (GPL/AGPL/unlicensed), outdated versions, unused packages, bundle size impact, and duplicate dependencies. Auto-updates patch/minor versions safely by running tests after each update and rolling back if tests fail.';
  /** @inheritdoc */
  readonly icon = '🔍';
  /** @inheritdoc */
  readonly category: AgentCategory = 'dependencies' as AgentCategory;
  /** @inheritdoc */
  readonly systemPrompt = `You are SANIX Dependency Detective, a dependency management expert. You audit project dependencies for:
1. Security vulnerabilities (CVEs)
2. License compliance (GPL, AGPL, unlicensed)
3. Outdated versions
4. Unused dependencies
5. Bundle size impact
6. Duplicate dependencies (different versions of same package)

You can auto-update dependencies safely by checking changelogs for breaking changes, running tests after each update, and rolling back if tests fail.

Always prefer the lowest-risk update path: patch before minor, minor before major. Never auto-update to a major version without explicit user approval — major updates may have breaking changes.`;
  /** @inheritdoc */
  readonly tools = ['read_file', 'bash', 'search_files', 'get_dependencies', 'run_tests'];
  /** @inheritdoc */
  readonly exampleQueries = [
    'Audit all dependencies for vulnerabilities and license issues.',
    'Find unused npm packages in package.json that are not imported anywhere in src/.',
    'Auto-update all patch + minor versions, run tests after each update.',
    'Check bundle size impact of all frontend dependencies via bundlephobia.',
    'Detect duplicate versions of the same package in the dependency tree.',
  ];

  /**
   * Run the Dependency Detective on a workspace.
   */
  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    const startedAt = Date.now();
    const emit = (phase: string, message: string, progress?: number, data?: Record<string, unknown>): void => {
      const event: AgentProgressEvent = { phase, message, progress, timestamp: Date.now(), data };
      options.onProgress?.(event);
    };
    const aborted = (): boolean => options.signal?.aborted === true;
    const tools = options.tools ?? {};

    const findings: AgentFinding[] = [];
    const actions: AgentAction[] = [];
    const metrics: Record<string, number | string> = {};

    try {
      // ── Phase 1: Inventory ─────────────────────────────────────────────
      emit('inventory', 'Parsing dependency manifests…', 0.05);
      const ecosystem = await this.detectEcosystem(options.workspacePath, tools);
      const deps = await this.inventory(options.workspacePath, ecosystem, tools);
      metrics.ecosystem = ecosystem;
      metrics.totalDependencies = deps.length;
      metrics.directDependencies = deps.filter((d) => d.direct).length;
      emit('inventory', `Found ${deps.length} dependencies (${ecosystem}).`, 0.1);

      // ── Phase 2: Vulnerability scan ────────────────────────────────────
      emit('vulnerability_scan', 'Running vulnerability scanner…', 0.15);
      const vulns = await this.scanVulnerabilities(options.workspacePath, ecosystem, tools);
      metrics.vulnerabilitiesFound = vulns.length;
      metrics.criticalVulns = vulns.filter((v) => v.severity === 'critical').length;
      metrics.highVulns = vulns.filter((v) => v.severity === 'high').length;
      for (const v of vulns) {
        findings.push(this.vulnToFinding(v));
      }
      emit(
        'vulnerability_scan',
        `${vulns.length} vulnerabilities (critical=${metrics.criticalVulns}, high=${metrics.highVulns}).`,
        0.3,
      );

      // ── Phase 3: License audit ─────────────────────────────────────────
      emit('license_audit', 'Auditing licenses…', 0.35);
      const licenseIssues = await this.auditLicenses(options.workspacePath, ecosystem, deps, tools);
      const unacceptable = licenseIssues.filter((l) => !l.acceptable);
      metrics.licenseIssues = unacceptable.length;
      metrics.viralLicenses = unacceptable.filter((l) => l.category === 'strong_copyleft').length;
      for (const l of unacceptable) {
        findings.push(this.licenseToFinding(l));
      }
      emit('license_audit', `${unacceptable.length} license issues flagged.`, 0.45);

      // ── Phase 4: Outdated check ────────────────────────────────────────
      emit('outdated_check', 'Checking for outdated dependencies…', 0.5);
      const outdated = await this.checkOutdated(options.workspacePath, ecosystem, tools);
      metrics.outdatedPackages = outdated.length;
      metrics.outdatedPatch = outdated.filter((o) => o.kind === 'patch').length;
      metrics.outdatedMinor = outdated.filter((o) => o.kind === 'minor').length;
      metrics.outdatedMajor = outdated.filter((o) => o.kind === 'major').length;
      for (const o of outdated) {
        findings.push(this.outdatedToFinding(o));
      }
      emit(
        'outdated_check',
        `${outdated.length} outdated (patch=${metrics.outdatedPatch}, minor=${metrics.outdatedMinor}, major=${metrics.outdatedMajor}).`,
        0.55,
      );

      // ── Phase 5: Unused detection ──────────────────────────────────────
      emit('unused_scan', 'Searching codebase for unused dependencies…', 0.6);
      const unused = await this.findUnused(options.workspacePath, deps, tools);
      metrics.unusedDependencies = unused.length;
      for (const u of unused) {
        findings.push(this.unusedToFinding(u, options.workspacePath, tools));
      }
      emit('unused_scan', `${unused.length} unused dependencies detected.`, 0.7);

      // ── Phase 6: Bundle size ───────────────────────────────────────────
      if (ecosystem === 'npm') {
        emit('bundle_scan', 'Checking bundle sizes via bundlephobia…', 0.72);
        const bundles = await this.checkBundleSizes(deps);
        metrics.bundledPackagesChecked = bundles.length;
        const heavy = bundles.filter((b) => b.gzip > 50_000);
        metrics.heavyPackages = heavy.length;
        for (const b of heavy) {
          findings.push(this.bundleToFinding(b));
        }
        emit('bundle_scan', `${heavy.length} heavy packages (>50KB gzip).`, 0.78);
      }

      // ── Phase 7: Duplicate detection ───────────────────────────────────
      emit('duplicate_scan', 'Detecting duplicate dependency versions…', 0.8);
      const duplicates = await this.findDuplicates(options.workspacePath, ecosystem, tools);
      metrics.duplicatePackages = duplicates.length;
      for (const d of duplicates) {
        findings.push(this.duplicateToFinding(d));
      }
      emit('duplicate_scan', `${duplicates.length} duplicate packages.`, 0.85);

      // ── Phase 8: Auto-update (safe patch + minor) ──────────────────────
      emit('auto_update', 'Auto-updating patch + minor versions…', 0.87);
      const updatable = outdated.filter((o) => o.kind === 'patch' || o.kind === 'minor');
      let updated = 0;
      let rolledBack = 0;
      for (let i = 0; i < updatable.length; i++) {
        if (aborted()) throw new Error('Aborted by signal');
        const pkg = updatable[i];
        const progress = 0.87 + 0.1 * (i / Math.max(updatable.length, 1));
        emit('auto_update', `Updating ${pkg.package} ${pkg.current} → ${pkg.latest}…`, progress);
        const result = await this.autoUpdate(pkg, options.workspacePath, ecosystem, tools);
        if (result.applied) {
          updated++;
          pkg.autoUpdated = true;
          pkg.testsPassed = true;
          actions.push({
            id: nanoid(10),
            type: 'update_dependency',
            description: `Update ${pkg.package} from ${pkg.current} to ${pkg.latest} (${pkg.kind})`,
            status: 'completed',
            target: pkg.package,
            before: pkg.current,
            after: pkg.latest,
          });
        } else {
          rolledBack++;
          pkg.autoUpdated = true;
          pkg.testsPassed = false;
          pkg.rolledBack = true;
          actions.push({
            id: nanoid(10),
            type: 'update_dependency',
            description: `Update ${pkg.package} from ${pkg.current} to ${pkg.latest} (${pkg.kind})`,
            status: 'rolled_back',
            target: pkg.package,
            before: pkg.current,
            after: pkg.current,
            error: result.reason ?? 'tests failed',
          });
        }
      }
      metrics.autoUpdatesApplied = updated;
      metrics.autoUpdatesRolledBack = rolledBack;

      // ── Phase 9: Report ────────────────────────────────────────────────
      emit('report', 'Dependency Detective complete.', 1);
      const durationMs = Date.now() - startedAt;
      metrics.durationMs = durationMs;
      const summary = this.buildSummary(metrics, ecosystem);

      return {
        agentId: this.id,
        summary,
        findings,
        actions,
        metrics,
        durationMs,
        success: metrics.criticalVulns === 0,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit('error', `Dependency Detective failed: ${message}`, 1);
      return {
        agentId: this.id,
        summary: `Dependency Detective aborted: ${message}`,
        findings,
        actions,
        metrics,
        durationMs: Date.now() - startedAt,
        success: false,
      };
    }
  }

  // ─── Ecosystem detection ───────────────────────────────────────────────

  /** Detect the dependency ecosystem from manifest files present. */
  private async detectEcosystem(
    workspacePath: string,
    tools: NonNullable<AgentRunOptions['tools']>,
  ): Promise<Ecosystem> {
    const files = await this.listFiles(workspacePath, tools);
    if (files.some((f) => f.endsWith('package.json'))) return 'npm';
    if (files.some((f) => f.endsWith('requirements.txt') || f.endsWith('pyproject.toml'))) return 'pip';
    if (files.some((f) => f.endsWith('Cargo.toml'))) return 'cargo';
    if (files.some((f) => f.endsWith('go.mod'))) return 'go';
    if (files.some((f) => f.endsWith('pom.xml') || f.endsWith('build.gradle'))) return 'maven';
    if (files.some((f) => f.endsWith('Gemfile'))) return 'rubygems';
    if (files.some((f) => f.endsWith('.csproj'))) return 'nuget';
    // Default to npm — the most common.
    return 'npm';
  }

  /** List files at the workspace root (single level). */
  private async listFiles(
    workspacePath: string,
    tools: NonNullable<AgentRunOptions['tools']>,
  ): Promise<string[]> {
    const listDir = tools['list_directory'];
    if (typeof listDir === 'function') {
      try {
        const result = await listDir({ path: workspacePath });
        if (Array.isArray(result)) {
          return result.map((r) => (typeof r === 'string' ? r : (r as { name?: string }).name ?? '')).filter(Boolean);
        }
      } catch {
        // fall through
      }
    }
    try {
      const fs = await import('node:fs/promises');
      const entries = await fs.readdir(workspacePath, { withFileTypes: true });
      return entries.map((e) => e.name);
    } catch {
      return [];
    }
  }

  // ─── Inventory ─────────────────────────────────────────────────────────

  /** Build the dependency inventory from the manifest. */
  private async inventory(
    workspacePath: string,
    ecosystem: Ecosystem,
    tools: NonNullable<AgentRunOptions['tools']>,
  ): Promise<Dependency[]> {
    const getDeps = tools['get_dependencies'];
    if (typeof getDeps === 'function') {
      try {
        const result = await getDeps({ workspacePath, ecosystem });
        if (Array.isArray(result)) {
          const deps: Dependency[] = [];
          for (const r of result) {
            if (r && typeof r === 'object') {
              const rr = r as Partial<Dependency>;
              if (typeof rr.name === 'string' && typeof rr.versionSpec === 'string') {
                deps.push({
                  name: rr.name,
                  versionSpec: rr.versionSpec,
                  resolvedVersion: rr.resolvedVersion,
                  dependencyType: rr.dependencyType ?? 'dependencies',
                  direct: rr.direct ?? true,
                });
              }
            }
          }
          if (deps.length > 0) return deps;
        }
      } catch {
        // fall through
      }
    }
    return this.parseManifest(workspacePath, ecosystem);
  }

  /** Parse a dependency manifest directly. */
  private async parseManifest(workspacePath: string, ecosystem: Ecosystem): Promise<Dependency[]> {
    const path = await import('node:path');
    const fs = await import('node:fs/promises');
    const deps: Dependency[] = [];
    try {
      if (ecosystem === 'npm') {
        const pkgPath = path.join(workspacePath, 'package.json');
        const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8')) as Record<string, unknown>;
        for (const bucket of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const) {
          const map = pkg[bucket];
          if (map && typeof map === 'object') {
            for (const [name, version] of Object.entries(map as Record<string, string>)) {
              deps.push({
                name,
                versionSpec: version,
                dependencyType: bucket,
                direct: true,
              });
            }
          }
        }
      } else if (ecosystem === 'pip') {
        let reqPath: string | null = null;
        for (const candidate of ['requirements.txt', 'pyproject.toml']) {
          try {
            await fs.access(path.join(workspacePath, candidate));
            reqPath = candidate;
            break;
          } catch {
            // try next
          }
        }
        if (reqPath === 'requirements.txt') {
          const content = await fs.readFile(path.join(workspacePath, 'requirements.txt'), 'utf8');
          for (const line of content.split(/\r?\n/)) {
            const trimmed = line.split('#')[0].trim();
            if (!trimmed) continue;
            const m = trimmed.match(/^([A-Za-z0-9_.-]+)\s*(?:==|>=|<=|~=|>|<)?\s*([A-Za-z0-9.*+!-]*)/);
            if (m) {
              deps.push({ name: m[1], versionSpec: m[2] || '*', dependencyType: 'runtime', direct: true });
            }
          }
        }
      } else if (ecosystem === 'cargo') {
        const toml = await fs.readFile(path.join(workspacePath, 'Cargo.toml'), 'utf8');
        const sectionRe = /\[(dependencies|dev-dependencies|build-dependencies)\]([\s\S]*?)(?=\n\[|$)/g;
        let m: RegExpExecArray | null;
        while ((m = sectionRe.exec(toml)) !== null) {
          const section = m[1];
          const body = m[2];
          const lineRe = /^([A-Za-z0-9_-]+)\s*=\s*"([^"]+)"/gm;
          let lm: RegExpExecArray | null;
          while ((lm = lineRe.exec(body)) !== null) {
            deps.push({
              name: lm[1],
              versionSpec: lm[2],
              dependencyType: section === 'dev-dependencies' ? 'devDependencies' : 'dependencies',
              direct: true,
            });
          }
        }
      } else if (ecosystem === 'go') {
        const mod = await fs.readFile(path.join(workspacePath, 'go.mod'), 'utf8');
        const requireRe = /^\s*([A-Za-z0-9./_-]+)\s+v([0-9.]+)\s*$/gm;
        let m: RegExpExecArray | null;
        while ((m = requireRe.exec(mod)) !== null) {
          deps.push({ name: m[1], versionSpec: m[2], dependencyType: 'dependencies', direct: true });
        }
      }
    } catch {
      // best-effort
    }
    return deps;
  }

  // ─── Vulnerability scan ────────────────────────────────────────────────

  /** Run the ecosystem-specific vulnerability scanner. */
  private async scanVulnerabilities(
    workspacePath: string,
    ecosystem: Ecosystem,
    tools: NonNullable<AgentRunOptions['tools']>,
  ): Promise<Vulnerability[]> {
    const commands: Record<Ecosystem, string> = {
      npm: 'npm audit --json',
      pip: 'pip-audit --format=json',
      cargo: 'cargo audit --json',
      go: 'govulncheck -json ./...',
      maven: 'mvn org.owasp:dependency-check:check -Dformat=json',
      rubygems: 'bundle audit check --format=json',
      nuget: 'dotnet list package --vulnerable --format=json',
    };
    const bash = tools['bash'];
    if (typeof bash !== 'function') return [];
    try {
      const result = await bash({ command: commands[ecosystem], cwd: workspacePath });
      return this.parseVulnerabilityOutput(result, ecosystem);
    } catch {
      return [];
    }
  }

  /** Parse vulnerability scanner output into a normalized list. */
  private parseVulnerabilityOutput(result: unknown, ecosystem: Ecosystem): Vulnerability[] {
    const out: Vulnerability[] = [];
    let parsed: unknown = result;
    if (typeof result === 'string') {
      try {
        parsed = JSON.parse(result);
      } catch {
        return out;
      }
    }
    if (!parsed || typeof parsed !== 'object') return out;
    if (ecosystem === 'npm') {
      const advisories = (parsed as { vulnerabilities?: Record<string, unknown> }).vulnerabilities ?? {};
      for (const [name, entry] of Object.entries(advisories)) {
        if (!entry || typeof entry !== 'object') continue;
        const e = entry as {
          severity?: string;
          via?: Array<{ title?: string; url?: string; source?: number | string; range?: string }>;
          fixAvailable?: unknown;
        };
        const severity = (e.severity ?? 'info') as VulnerabilitySeverity;
        for (const via of Array.isArray(e.via) ? e.via : []) {
          if (!via || typeof via !== 'object') continue;
          out.push({
            id: String(via.source ?? via.title ?? `${name}-advisory`),
            package: name,
            severity,
            vulnerableRange: via.range ?? '*',
            fixedIn: typeof e.fixAvailable === 'object' && e.fixAvailable && 'version' in e.fixAvailable
              ? String((e.fixAvailable as { version: unknown }).version)
              : undefined,
            title: via.title ?? `${name} has a ${severity} vulnerability`,
            url: via.url,
          });
        }
      }
    } else if (ecosystem === 'pip') {
      const deps = (parsed as { dependencies?: Array<Record<string, unknown>> }).dependencies ?? [];
      for (const d of deps) {
        const vulns = Array.isArray(d.vulns) ? d.vulns : [];
        for (const v of vulns) {
          if (!v || typeof v !== 'object') continue;
          const vv = v as { id?: string; fix_versions?: string[]; description?: string };
          out.push({
            id: String(vv.id ?? 'pip-advisory'),
            package: String(d.name ?? 'unknown'),
            severity: 'high',
            vulnerableRange: String(d.version ?? '*'),
            fixedIn: Array.isArray(vv.fix_versions) ? vv.fix_versions[0] : undefined,
            title: vv.description ?? `${String(d.name)} has a vulnerability`,
          });
        }
      }
    } else if (ecosystem === 'cargo') {
      const list = (parsed as { vulnerabilities?: Array<Record<string, unknown>> }).vulnerabilities ?? [];
      for (const v of list) {
        const advisories = Array.isArray(v.advisory) ? v.advisory : [];
        const adv = advisories[0] as { id?: string; title?: string; url?: string } | undefined;
        out.push({
          id: String(adv?.id ?? 'cargo-advisory'),
          package: String(v.package ?? 'unknown'),
          severity: 'high',
          vulnerableRange: String(v.patched_versions ?? '*'),
          title: adv?.title ?? `${String(v.package)} has a vulnerability`,
          url: adv?.url,
        });
      }
    } else if (ecosystem === 'go') {
      const findings = (parsed as Array<Record<string, unknown>>).filter(
        (x) => x.osv || x.vulnerability,
      );
      for (const f of findings) {
        const osv = (f.osv ?? f.vulnerability) as { id?: string; summary?: string } | undefined;
        out.push({
          id: String(osv?.id ?? 'go-advisory'),
          package: String(f.module ?? 'unknown'),
          severity: 'high',
          vulnerableRange: '*',
          title: osv?.summary ?? `${String(f.module)} has a vulnerability`,
        });
      }
    }
    return out;
  }

  /** Convert a vulnerability into an AgentFinding. */
  private vulnToFinding(v: Vulnerability): AgentFinding {
    return {
      id: nanoid(10),
      severity: VULN_SEVERITY_MAP[v.severity],
      category: 'security',
      title: `${v.package}: ${v.title}`,
      description: `Vulnerability ${v.id} affects ${v.package} ${v.vulnerableRange}.${
        v.fixedIn ? ` Fixed in ${v.fixedIn}.` : ''
      }${v.cvss ? ` CVSS: ${v.cvss}.` : ''}`,
      location: { symbol: v.package },
      evidence: [
        `severity: ${v.severity}`,
        `vulnerable: ${v.vulnerableRange}`,
        v.fixedIn ? `fixed in: ${v.fixedIn}` : 'no known fix',
      ],
      recommendation: v.fixedIn
        ? `Upgrade ${v.package} to ${v.fixedIn} or higher.`
        : `Monitor for a fix; consider replacing ${v.package}.`,
      url: v.url,
    };
  }

  // ─── License audit ─────────────────────────────────────────────────────

  /** Audit dependency licenses. */
  private async auditLicenses(
    workspacePath: string,
    ecosystem: Ecosystem,
    deps: Dependency[],
    tools: NonNullable<AgentRunOptions['tools']>,
  ): Promise<LicenseIssue[]> {
    const out: LicenseIssue[] = [];
    const bash = tools['bash'];
    // Try npm-license-checker / pip-licenses / cargo-bundle-licenses first.
    const commands: Record<Ecosystem, string | null> = {
      npm: 'npx --yes license-checker --json --summary',
      pip: 'pip-licenses --format=json',
      cargo: 'cargo bundle-licenses --format json',
      go: 'go-licenses report .',
      maven: 'mvn license:download-licenses',
      rubygems: 'bundle licenses',
      nuget: 'dotnet-project-licenses',
    };
    let licenses: Map<string, string> = new Map();
    const cmd = commands[ecosystem];
    if (cmd && typeof bash === 'function') {
      try {
        const result = await bash({ command: cmd, cwd: workspacePath });
        licenses = this.parseLicenseOutput(result, ecosystem);
      } catch {
        // fall through to registry lookup
      }
    }
    // Fallback: registry lookup for npm packages without a local license.
    if (ecosystem === 'npm') {
      for (const dep of deps) {
        if (!licenses.has(dep.name)) {
          try {
            const license = await this.fetchNpmLicense(dep.name);
            if (license) licenses.set(dep.name, license);
          } catch {
            // skip
          }
        }
      }
    }
    for (const dep of deps) {
      const license = (licenses.get(dep.name) ?? 'UNKNOWN').toUpperCase().trim();
      const category = this.categorizeLicense(license);
      const acceptable = category !== 'strong_copyleft' && category !== 'unlicensed';
      out.push({
        package: dep.name,
        license,
        category,
        acceptable,
        reason: !acceptable
          ? category === 'strong_copyleft'
            ? `Viral license (${license}) — may force the consuming project to open-source.`
            : 'No license declared — rights are unclear.'
          : undefined,
      });
    }
    return out;
  }

  /** Parse the output of a license-scanning command. */
  private parseLicenseOutput(result: unknown, ecosystem: Ecosystem): Map<string, string> {
    const out = new Map<string, string>();
    let parsed: unknown = result;
    if (typeof result === 'string') {
      try {
        parsed = JSON.parse(result);
      } catch {
        return out;
      }
    }
    if (!parsed || typeof parsed !== 'object') return out;
    if (ecosystem === 'npm') {
      const obj = parsed as Record<string, { licenses?: string }>;
      for (const [name, entry] of Object.entries(obj)) {
        if (entry && typeof entry === 'object' && typeof entry.licenses === 'string') {
          out.set(name, entry.licenses);
        }
      }
    } else if (ecosystem === 'pip') {
      const arr = parsed as Array<{ name?: string; license?: string }>;
      if (Array.isArray(arr)) {
        for (const r of arr) {
          if (r.name && r.license) out.set(r.name, r.license);
        }
      }
    } else if (ecosystem === 'cargo') {
      const arr = (parsed as { packages?: Array<{ name?: string; licenses?: string[] }> }).packages ?? [];
      for (const r of arr) {
        if (r.name && Array.isArray(r.licenses) && r.licenses.length > 0) {
          out.set(r.name, r.licenses[0]);
        }
      }
    }
    return out;
  }

  /** Categorize an SPDX license string. */
  private categorizeLicense(license: string): LicenseCategory {
    if (!license || license === 'UNKNOWN' || license === 'UNLICENSED' || license === 'NONE') {
      return 'unlicensed';
    }
    // Strip suffixes like "-only" / "-or-later" for the lookup.
    const normalized = license.replace(/-(?:only|or-later)$/i, '');
    if (PERMISSIVE.has(normalized) || PERMISSIVE.has(license)) return 'permissive';
    if (VIRAL_LICENSES.has(normalized) || VIRAL_LICENSES.has(license)) return 'strong_copyleft';
    if (WEAK_COPYLEFT.has(normalized) || WEAK_COPYLEFT.has(license)) return 'weak_copyleft';
    if (/GPL|AGPL|SSPL|BUSL/i.test(license)) return 'strong_copyleft';
    if (/LGPL|MPL|EPL|CDDL/i.test(license)) return 'weak_copyleft';
    if (/MIT|BSD|ISC|Apache|Zlib/i.test(license)) return 'permissive';
    return 'unknown';
  }

  /** Fetch a package's license from the npm registry. */
  private async fetchNpmLicense(name: string): Promise<string | undefined> {
    try {
      const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`);
      if (!res.ok) return undefined;
      const data = (await res.json()) as { license?: string; licenses?: Array<{ type?: string }> };
      if (typeof data.license === 'string') return data.license;
      if (Array.isArray(data.licenses) && data.licenses[0]?.type) return data.licenses[0].type;
      return undefined;
    } catch {
      return undefined;
    }
  }

  /** Convert a license issue into an AgentFinding (only if not acceptable). */
  private licenseToFinding(l: LicenseIssue): AgentFinding {
    return {
      id: nanoid(10),
      severity: l.category === 'strong_copyleft' ? 'high' : 'medium',
      category: 'license',
      title: `${l.package}: ${l.license}`,
      description: l.reason ?? `License category: ${l.category}.`,
      location: { symbol: l.package },
      evidence: [`license: ${l.license}`, `category: ${l.category}`],
      recommendation:
        l.category === 'strong_copyleft'
          ? `Replace ${l.package} with a permissively-licensed alternative, or obtain a commercial license.`
          : `Confirm ${l.package}'s license terms with the package author before continuing to use it.`,
    };
  }

  // ─── Outdated check ────────────────────────────────────────────────────

  /** Check for outdated dependencies. */
  private async checkOutdated(
    workspacePath: string,
    ecosystem: Ecosystem,
    tools: NonNullable<AgentRunOptions['tools']>,
  ): Promise<OutdatedDep[]> {
    const commands: Record<Ecosystem, string> = {
      npm: 'npm outdated --json',
      pip: 'pip list --outdated --format=json',
      cargo: 'cargo outdated --output json',
      go: 'go list -m -u -json all',
      maven: 'mvn versions:display-dependency-updates',
      rubygems: 'bundle outdated --only-explicit',
      nuget: 'dotnet list package --outdated --format=json',
    };
    const bash = tools['bash'];
    if (typeof bash !== 'function') return [];
    try {
      const result = await bash({ command: commands[ecosystem], cwd: workspacePath });
      return this.parseOutdatedOutput(result, ecosystem);
    } catch {
      return [];
    }
  }

  /** Parse outdated command output. */
  private parseOutdatedOutput(result: unknown, ecosystem: Ecosystem): OutdatedDep[] {
    const out: OutdatedDep[] = [];
    let parsed: unknown = result;
    if (typeof result === 'string') {
      try {
        parsed = JSON.parse(result);
      } catch {
        return out;
      }
    }
    if (!parsed || typeof parsed !== 'object') return out;
    if (ecosystem === 'npm') {
      const obj = parsed as Record<string, { current?: string; latest?: string; wanted?: string }>;
      for (const [name, e] of Object.entries(obj)) {
        if (e?.current && e?.latest) {
          out.push({
            package: name,
            current: e.current,
            latest: e.latest,
            kind: this.diffKind(e.current, e.latest),
            autoUpdated: false,
          });
        }
      }
    } else if (ecosystem === 'pip') {
      const arr = parsed as Array<{ name?: string; version?: string; latest_version?: string }>;
      if (Array.isArray(arr)) {
        for (const r of arr) {
          if (r.name && r.version && r.latest_version) {
            out.push({
              package: r.name,
              current: r.version,
              latest: r.latest_version,
              kind: this.diffKind(r.version, r.latest_version),
              autoUpdated: false,
            });
          }
        }
      }
    }
    return out;
  }

  /** Classify the kind of version bump. */
  private diffKind(current: string, latest: string): 'patch' | 'minor' | 'major' {
    const c = current.replace(/^[^0-9]*/, '').split('.').map((x) => parseInt(x, 10) || 0);
    const l = latest.replace(/^[^0-9]*/, '').split('.').map((x) => parseInt(x, 10) || 0);
    while (c.length < 3) c.push(0);
    while (l.length < 3) l.push(0);
    if (l[0] !== c[0]) return 'major';
    if (l[1] !== c[1]) return 'minor';
    return 'patch';
  }

  /** Convert an outdated-dep record into an AgentFinding. */
  private outdatedToFinding(o: OutdatedDep): AgentFinding {
    const severity = o.kind === 'major' ? 'info' : o.kind === 'minor' ? 'low' : 'info';
    return {
      id: nanoid(10),
      severity,
      category: 'outdated',
      title: `${o.package}: ${o.current} → ${o.latest} (${o.kind})`,
      description: `${o.package} is ${o.kind} versions behind. Current: ${o.current}. Latest: ${o.latest}.`,
      location: { symbol: o.package },
      evidence: [`current: ${o.current}`, `latest: ${o.latest}`, `kind: ${o.kind}`],
      recommendation:
        o.kind === 'major'
          ? `Review ${o.package}@${o.latest} changelog for breaking changes before upgrading.`
          : `Update ${o.package} to ${o.latest} (safe ${o.kind} bump).`,
    };
  }

  // ─── Unused detection ──────────────────────────────────────────────────

  /** Find dependencies that are declared but never imported. */
  private async findUnused(
    workspacePath: string,
    deps: Dependency[],
    tools: NonNullable<AgentRunOptions['tools']>,
  ): Promise<Dependency[]> {
    const unused: Dependency[] = [];
    const searchFiles = tools['search_files'];
    for (const dep of deps.filter((d) => d.direct)) {
      if (this.isAlwaysUsed(dep.name)) continue;
      const patterns = this.importPatterns(dep.name);
      let found = false;
      for (const p of patterns) {
        if (typeof searchFiles === 'function') {
          try {
            const result = await searchFiles({ pattern: p, path: workspacePath });
            if (Array.isArray(result) && result.length > 0) {
              found = true;
              break;
            }
            if (result && typeof result === 'object') {
              const arr = (result as { matches?: unknown[] }).matches;
              if (Array.isArray(arr) && arr.length > 0) {
                found = true;
                break;
              }
            }
          } catch {
            // fall back to fs grep
          }
        }
        if (!found) {
          // fs-based grep fallback
          try {
            const hits = await this.grepInWorkspace(workspacePath, p);
            if (hits > 0) {
              found = true;
              break;
            }
          } catch {
            // skip
          }
        }
      }
      if (!found) unused.push(dep);
    }
    return unused;
  }

  /** Built-in deps / meta-packages that are always considered "used". */
  private isAlwaysUsed(name: string): boolean {
    if (
      name.startsWith('@types/') ||
      name.endsWith('-eslint') ||
      name.includes('eslint-plugin') ||
      name.includes('eslint-config') ||
      name === 'typescript' ||
      name === 'tsup' ||
      name === 'vitest' ||
      name === 'jest' ||
      name === '@babel/core' ||
      name === 'prettier'
    ) {
      return true;
    }
    return false;
  }

  /** Regex patterns for finding a package's import. */
  private importPatterns(name: string): string[] {
    const scoped = name.startsWith('@') ? name : name;
    const bare = name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0];
    return [
      `from ['"]${bare}`,
      `require\\(['"]${bare}`,
      `import ['"]${bare}`,
      `import\\(['"]${bare}`,
      `from ['"]${scoped}`,
      `require\\(['"]${scoped}`,
    ];
  }

  /** Best-effort grep across the workspace (text-file walk). */
  private async grepInWorkspace(workspacePath: string, pattern: string): Promise<number> {
    const path = await import('node:path');
    const fs = await import('node:fs/promises');
    const re = new RegExp(pattern);
    let count = 0;
    const visit = async (dir: string, depth: number): Promise<void> => {
      if (depth > 4) return;
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await visit(full, depth + 1);
        } else if (entry.isFile() && /\.(ts|js|tsx|jsx|py|go|rs|rb|php)$/.test(entry.name)) {
          try {
            const content = await fs.readFile(full, 'utf8');
            if (re.test(content)) count++;
          } catch {
            // skip
          }
          if (count > 0) return;
        }
      }
    };
    await visit(workspacePath, 0);
    return count;
  }

  /** Convert an unused-dep into an AgentFinding. */
  private unusedToFinding(
    dep: Dependency,
    workspacePath: string,
    tools: NonNullable<AgentRunOptions['tools']>,
  ): AgentFinding {
    void workspacePath;
    void tools;
    return {
      id: nanoid(10),
      severity: 'low',
      category: 'unused',
      title: `${dep.name} appears unused`,
      description: `${dep.name} (${dep.versionSpec}) is declared in ${dep.dependencyType} but no imports reference it anywhere in the workspace.`,
      location: { symbol: dep.name },
      evidence: [`declared as: ${dep.versionSpec}`, `bucket: ${dep.dependencyType}`],
      recommendation: `Remove ${dep.name} from ${dep.dependencyType}.`,
    };
  }

  // ─── Bundle size ───────────────────────────────────────────────────────

  /** Check bundle sizes via the bundlephobia API (npm only). */
  private async checkBundleSizes(deps: Dependency[]): Promise<BundleSizeRecord[]> {
    const out: BundleSizeRecord[] = [];
    for (const dep of deps.filter((d) => d.direct)) {
      try {
        const res = await fetch(
          `https://bundlephobia.com/api/size?package=${encodeURIComponent(`${dep.name}@${dep.resolvedVersion ?? dep.versionSpec}`)}`,
          { signal: AbortSignal.timeout(8000) },
        );
        if (!res.ok) continue;
        const data = (await res.json()) as { size?: number; gzip?: number };
        if (typeof data.size === 'number' && typeof data.gzip === 'number') {
          out.push({ package: dep.name, size: data.size, gzip: data.gzip });
        }
      } catch {
        // best-effort — skip on error
      }
    }
    // Compute share of bundle (gzip)
    const total = out.reduce((sum, b) => sum + b.gzip, 0);
    if (total > 0) {
      for (const b of out) b.shareOfBundle = b.gzip / total;
    }
    return out;
  }

  /** Convert a heavy bundle-size record into an AgentFinding. */
  private bundleToFinding(b: BundleSizeRecord): AgentFinding {
    return {
      id: nanoid(10),
      severity: b.gzip > 200_000 ? 'high' : 'medium',
      category: 'bundle_size',
      title: `${b.package}: ${(b.gzip / 1024).toFixed(1)} KB gzip`,
      description: `${b.package} adds ${(b.size / 1024).toFixed(1)} KB (${(b.gzip / 1024).toFixed(1)} KB gzip) to the bundle${
        b.shareOfBundle ? ` — ${(b.shareOfBundle * 100).toFixed(1)}% of total` : ''
      }.`,
      location: { symbol: b.package },
      evidence: [`size: ${b.size}B`, `gzip: ${b.gzip}B`],
      recommendation: `Consider a lighter alternative to ${b.package}, or import only the specific submodules you need.`,
    };
  }

  // ─── Duplicate detection ───────────────────────────────────────────────

  /** Detect duplicate versions of the same package in the dependency tree. */
  private async findDuplicates(
    workspacePath: string,
    ecosystem: Ecosystem,
    tools: NonNullable<AgentRunOptions['tools']>,
  ): Promise<DuplicateDep[]> {
    const commands: Record<Ecosystem, string> = {
      npm: 'npm ls --json --all',
      pip: 'pip freeze',
      cargo: 'cargo tree --prefix none',
      go: 'go mod graph',
      maven: 'mvn dependency:tree',
      rubygems: 'bundle list',
      nuget: 'dotnet list package --include-transitive',
    };
    const bash = tools['bash'];
    if (typeof bash !== 'function') return [];
    try {
      const result = await bash({ command: commands[ecosystem], cwd: workspacePath });
      return this.parseDuplicateOutput(result, ecosystem);
    } catch {
      return [];
    }
  }

  /** Parse dependency tree output to find duplicates. */
  private parseDuplicateOutput(result: unknown, ecosystem: Ecosystem): DuplicateDep[] {
    const byPackage = new Map<string, Set<string>>();
    const add = (name: string, version: string): void => {
      const set = byPackage.get(name) ?? new Set<string>();
      set.add(version);
      byPackage.set(name, set);
    };
    let parsed: unknown = result;
    if (typeof result === 'string') {
      if (ecosystem === 'npm') {
        try {
          parsed = JSON.parse(result);
        } catch {
          return [];
        }
      } else {
        // plain text — parse line by line
        for (const line of result.split(/\r?\n/)) {
          const m = line.match(/([A-Za-z0-9@._/-]+)@([0-9][0-9A-Za-z.\-+]+)/);
          if (m) add(m[1], m[2]);
        }
        const out: DuplicateDep[] = [];
        for (const [name, versions] of byPackage) {
          if (versions.size > 1) {
            out.push({ package: name, versions: [...versions].sort(), count: versions.size });
          }
        }
        return out;
      }
    }
    if (ecosystem === 'npm' && parsed && typeof parsed === 'object') {
      const visit = (node: unknown): void => {
        if (!node || typeof node !== 'object') return;
        const n = node as { name?: string; version?: string; dependencies?: Record<string, unknown> };
        if (n.name && n.version) add(n.name, n.version);
        if (n.dependencies) {
          for (const child of Object.values(n.dependencies)) visit(child);
        }
      };
      visit(parsed);
    }
    const out: DuplicateDep[] = [];
    for (const [name, versions] of byPackage) {
      if (versions.size > 1) {
        out.push({ package: name, versions: [...versions].sort(), count: versions.size });
      }
    }
    return out;
  }

  /** Convert a duplicate-dep record into an AgentFinding. */
  private duplicateToFinding(d: DuplicateDep): AgentFinding {
    return {
      id: nanoid(10),
      severity: d.count >= 3 ? 'medium' : 'low',
      category: 'duplicate',
      title: `${d.package}: ${d.count} versions installed`,
      description: `${d.package} has ${d.count} distinct versions in the tree: ${d.versions.join(', ')}.`,
      location: { symbol: d.package },
      evidence: [`versions: ${d.versions.join(', ')}`, `count: ${d.count}`],
      recommendation: `Deduplicate ${d.package} via npm dedupe (npm) or by aligning version ranges across dependents.`,
    };
  }

  // ─── Auto-update ───────────────────────────────────────────────────────

  /** Auto-update a single dependency. Returns the outcome. */
  private async autoUpdate(
    pkg: OutdatedDep,
    workspacePath: string,
    ecosystem: Ecosystem,
    tools: NonNullable<AgentRunOptions['tools']>,
  ): Promise<{ applied: boolean; reason?: string }> {
    const bash = tools['bash'];
    if (typeof bash !== 'function') return { applied: false, reason: 'no bash tool' };
    const installCmds: Record<Ecosystem, string> = {
      npm: `npm install ${pkg.package}@${pkg.latest}`,
      pip: `pip install ${pkg.package}==${pkg.latest}`,
      cargo: `cargo update -p ${pkg.package} --precise ${pkg.latest}`,
      go: `go get ${pkg.package}@v${pkg.latest}`,
      maven: `mvn versions:use-latest-versions -Dincludes=${pkg.package}`,
      rubygems: `bundle update ${pkg.package} --conservative`,
      nuget: `dotnet add package ${pkg.package} --version ${pkg.latest}`,
    };
    try {
      await bash({ command: installCmds[ecosystem], cwd: workspacePath });
    } catch (err) {
      return { applied: false, reason: `install failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    // Run tests after the update.
    const testsPassed = await this.runTests(tools, workspacePath);
    if (!testsPassed) {
      // Roll back to the previous version.
      const rollbackCmds: Record<Ecosystem, string> = {
        npm: `npm install ${pkg.package}@${pkg.current}`,
        pip: `pip install ${pkg.package}==${pkg.current}`,
        cargo: `cargo update -p ${pkg.package} --precise ${pkg.current}`,
        go: `go get ${pkg.package}@v${pkg.current}`,
        maven: `mvn versions:revert`,
        rubygems: `bundle update ${pkg.package} --conservative`,
        nuget: `dotnet add package ${pkg.package} --version ${pkg.current}`,
      };
      try {
        await bash({ command: rollbackCmds[ecosystem], cwd: workspacePath });
      } catch {
        // best-effort rollback
      }
      return { applied: false, reason: 'tests failed after update' };
    }
    return { applied: true };
  }

  /** Run the test suite via the `run_tests` tool. */
  private async runTests(
    tools: NonNullable<AgentRunOptions['tools']>,
    workspacePath: string,
  ): Promise<boolean> {
    const runTestsTool = tools['run_tests'];
    if (typeof runTestsTool !== 'function') return false;
    try {
      const result = await runTestsTool({ workspacePath });
      if (typeof result === 'boolean') return result;
      if (result && typeof result === 'object') {
        const r = result as { passed?: unknown; success?: unknown; exitCode?: unknown; status?: unknown };
        if (typeof r.passed === 'boolean') return r.passed;
        if (typeof r.success === 'boolean') return r.success;
        if (typeof r.exitCode === 'number') return r.exitCode === 0;
        if (typeof r.status === 'string') return r.status === 'passed' || r.status === 'ok';
      }
      return false;
    } catch {
      return false;
    }
  }

  // ─── Summary ───────────────────────────────────────────────────────────

  /** Build a human-readable run summary. */
  private buildSummary(metrics: Record<string, number | string>, ecosystem: Ecosystem): string {
    return [
      `Dependency Detective audited ${metrics.totalDependencies} ${ecosystem} dependencies.`,
      `${metrics.vulnerabilitiesFound} vulnerabilities (critical=${metrics.criticalVulns}, high=${metrics.highVulns}).`,
      `${metrics.licenseIssues} license issues; ${metrics.outdatedPackages} outdated packages.`,
      `${metrics.unusedDependencies} unused; ${metrics.duplicatePackages} duplicate.`,
      `Auto-updated ${metrics.autoUpdatesApplied} package(s); rolled back ${metrics.autoUpdatesRolledBack}.`,
    ].join(' ');
  }
}
