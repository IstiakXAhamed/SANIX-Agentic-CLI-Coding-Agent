/**
 * @file agents/OnboardingBuddy.ts
 * @description SANIX Onboarding Buddy agent (id: `onboarding-buddy`, icon:
 * 🤝, category: `onboarding`). Generates a friendly, concise "tour" of a
 * codebase for new team members: project detection, structure analysis,
 * entry-point identification, core-module analysis, design-pattern
 * detection, dev-setup guide, conventions, and a Markdown onboarding doc.
 *
 * The agent uses `list_directory`, `read_file`, `search_files`,
 * `get_dependencies`, `analyze_ast`, and `bash` to walk the project. It
 * supports any language by reading the manifest file (`package.json`,
 * `requirements.txt` / `pyproject.toml`, `Cargo.toml`, `go.mod`,
 * `pom.xml`, `Gemfile`, `mix.exs`).
 *
 * @packageDocumentation
 */

import { BaseAgent } from '../BaseAgent.js';
import type {
  AgentAction,
  AgentArtifact,
  AgentCategory,
  AgentFinding,
  AgentRunOptions,
  AgentRunResult,
} from '../types.js';

/** Detected project metadata. */
interface ProjectMeta {
  readonly name: string;
  readonly language: string;
  readonly framework?: string;
  readonly packageManager: string;
  readonly buildSystem?: string;
  readonly testFramework?: string;
  readonly version?: string;
}

/** A directory entry returned by `list_directory`. */
interface DirEntry {
  readonly name: string;
  readonly kind: 'file' | 'directory';
}

/** Core-module analysis result. */
interface CoreModule {
  readonly name: string;
  readonly location: string;
  readonly responsibility: string;
  readonly keyFiles: string[];
  readonly dependencies: string[];
}

/** Counter for unique ids within a single run. */
let _idCounter = 0;
function nextId(prefix: string): string {
  _idCounter += 1;
  return `${prefix}-${_idCounter.toString(36).padStart(4, '0')}`;
}

/**
 * SANIX Onboarding Buddy — codebase tour guide for new team members.
 *
 * @example
 * ```ts
 * import { OnboardingBuddyAgent } from '@sanix/agents';
 * const agent = new OnboardingBuddyAgent();
 * const result = await agent.run({
 *   cwd: '/workspace/project',
 *   goal: 'Generate an onboarding guide for new engineers joining the project.',
 *   toolCall: async (t, i) => invokeSanixTool(t, i),
 * });
 * console.log(result.summary);
 * ```
 */
export class OnboardingBuddyAgent extends BaseAgent {
  readonly id = 'onboarding-buddy';
  readonly name = 'Onboarding Buddy';
  readonly icon = '🤝';
  readonly category: AgentCategory = 'onboarding';
  readonly description =
    'Analyzes a codebase and generates a friendly, concise onboarding guide ' +
    'covering architecture, entry points, key modules, design patterns, dev ' +
    'environment setup, testing, common tasks, and conventions.';
  readonly systemPrompt =
    'You are SANIX Onboarding Buddy, a codebase tour guide for new team members. ' +
    'You analyze a codebase and generate a comprehensive onboarding guide that helps ' +
    'a new developer understand: (1) project structure and architecture, (2) key entry ' +
    'points, (3) core modules and their responsibilities, (4) design patterns used, ' +
    '(5) how to set up the dev environment, (6) how to run tests, (7) common development ' +
    'tasks, (8) coding conventions, (9) where things live (configs, tests, docs). ' +
    'Your output should read like a friendly, concise tour — not a data dump.';
  readonly tools = [
    'read_file',
    'search_files',
    'analyze_ast',
    'list_directory',
    'bash',
    'get_dependencies',
  ];
  readonly exampleQueries = [
    'Generate an onboarding guide for a new engineer joining this project.',
    'Tour the architecture and identify the entry points and key modules.',
    'Explain how to set up the dev environment and run the test suite.',
    'Identify the design patterns used and document the project conventions.',
    'Produce a "first-day README" for a new contributor.',
  ];

  /** @inheritdoc */
  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    const startedAt = Date.now();
    const actions: AgentAction[] = [];
    const findings: AgentFinding[] = [];
    const artifacts: AgentArtifact[] = [];
    const recommendations: string[] = [];
    let tokensUsed = 0;
    let toolCalls = 0;
    _idCounter = 0;

    this.emit(options, 'agent:start', { agentId: this.id, goal: options.goal });

    try {
      // ── Phase 1: project detection ───────────────────────────────────
      this.emit(options, 'phase:start', { phase: 'detect' });
      const rootEntries = await this.listDirectory(options, '.', actions);
      toolCalls += 1;
      const meta = await this.detectProjectMeta(options, rootEntries, actions);
      toolCalls += 1;
      findings.push({
        id: nextId('finding'),
        severity: 'info',
        category: 'project-detection',
        title: `Detected ${meta.language} project${meta.framework ? ` using ${meta.framework}` : ''}`,
        description: `Package manager: ${meta.packageManager}${meta.buildSystem ? `, build: ${meta.buildSystem}` : ''}${meta.testFramework ? `, tests: ${meta.testFramework}` : ''}.`,
      });
      this.emit(options, 'phase:complete', { phase: 'detect', meta });

      // ── Phase 2: structure analysis ──────────────────────────────────
      this.emit(options, 'phase:start', { phase: 'structure' });
      const structure = await this.analyzeStructure(options, actions);
      toolCalls += structure.toolCalls;
      tokensUsed += structure.tokensUsed;
      this.emit(options, 'phase:complete', { phase: 'structure', dirs: structure.directories.length });

      // ── Phase 3: entry-point identification ──────────────────────────
      this.emit(options, 'phase:start', { phase: 'entry' });
      const entryPoints = await this.identifyEntryPoints(options, meta, actions);
      toolCalls += entryPoints.toolCalls;
      this.emit(options, 'phase:complete', { phase: 'entry', entryPoints: entryPoints.files });
      if (entryPoints.files.length === 0) {
        findings.push({
          id: nextId('finding'),
          severity: 'medium',
          category: 'entry-points',
          title: 'Could not identify an entry point',
          description: 'No main/index/app file was found in the conventional locations.',
          recommendation: 'Document the entry point explicitly in your README.',
        });
      }

      // ── Phase 4: core-module analysis ────────────────────────────────
      this.emit(options, 'phase:start', { phase: 'modules' });
      const modules = await this.analyzeCoreModules(options, meta, structure, actions);
      toolCalls += modules.toolCalls;
      this.emit(options, 'phase:complete', { phase: 'modules', count: modules.list.length });
      for (const m of modules.list.slice(0, 5)) {
        findings.push({
          id: nextId('finding'),
          severity: 'info',
          category: 'core-module',
          title: `Module: ${m.name}`,
          description: `Located at \`${m.location}\`. ${m.responsibility}`,
          recommendation: m.dependencies.length
            ? `Depends on: ${m.dependencies.slice(0, 5).join(', ')}${m.dependencies.length > 5 ? '…' : ''}.`
            : undefined,
        });
      }

      // ── Phase 5: pattern detection ───────────────────────────────────
      this.emit(options, 'phase:start', { phase: 'patterns' });
      const patterns = await this.detectPatterns(options, meta, structure, actions);
      toolCalls += patterns.toolCalls;
      this.emit(options, 'phase:complete', { phase: 'patterns', found: patterns.list });
      for (const p of patterns.list) {
        findings.push({
          id: nextId('finding'),
          severity: 'info',
          category: 'design-pattern',
          title: `Pattern detected: ${p.name}`,
          description: p.evidence,
        });
      }

      // ── Phase 6: dev setup + conventions + tests ─────────────────────
      this.emit(options, 'phase:start', { phase: 'setup' });
      const devSetup = this.composeDevSetup(meta, structure);
      const conventions = this.detectConventions(meta, structure);
      const testGuide = this.composeTestGuide(meta, structure);
      this.emit(options, 'phase:complete', { phase: 'setup' });

      // ── Phase 7: write onboarding doc ────────────────────────────────
      this.emit(options, 'phase:start', { phase: 'write' });
      const doc = this.composeOnboardingDoc(
        meta,
        structure,
        entryPoints.files,
        modules.list,
        patterns.list,
        devSetup,
        conventions,
        testGuide,
      );
      artifacts.push({
        id: nextId('artifact'),
        name: 'ONBOARDING.md',
        type: 'document',
        content: doc,
        description: 'Markdown onboarding guide for new team members',
        path: 'ONBOARDING.md',
        language: 'markdown',
      });
      const writeRes = await this.callToolWrite(
        options,
        'write_file',
        { path: 'ONBOARDING.md', content: doc, cwd: options.cwd },
        actions,
        'Write the onboarding guide',
      );
      toolCalls += 1;
      if (!writeRes.ok) {
        findings.push({
          id: nextId('finding'),
          severity: 'low',
          category: 'write',
          title: 'Failed to persist ONBOARDING.md',
          description: `write_file reported: ${writeRes.error}`,
        });
      }
      this.emit(options, 'phase:complete', { phase: 'write' });

      // ── recommendations ──────────────────────────────────────────────
      recommendations.push('Read ONBOARDING.md end-to-end before writing your first feature.');
      if (entryPoints.files.length > 0) {
        recommendations.push(`Start your read-through at \`${entryPoints.files[0]}\` — the main entry point.`);
      }
      if (modules.list.length > 0) {
        recommendations.push(`Focus next on the \`${modules.list[0].name}\` module — it appears to be the most central.`);
      }
      if (!structure.hasReadme) {
        recommendations.push('Add a top-level README.md — it is currently missing.');
      }
      if (!structure.hasTestsDir) {
        recommendations.push('No test directory was detected. Establish a test convention early.');
      }

      const summary = this.composeSummary(meta, structure, modules.list.length, Date.now() - startedAt);
      const result: AgentRunResult = {
        agentId: this.id,
        agentName: this.name,
        category: this.category,
        goal: options.goal,
        summary,
        findings,
        actions,
        artifacts,
        recommendations,
        metrics: {
          steps: actions.length,
          durationMs: Date.now() - startedAt,
          tokensUsed,
          costUsd: 0,
          toolCalls,
        },
        success: true,
      };
      this.emit(options, 'agent:complete', { agentId: this.id, result });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      findings.push({
        id: nextId('finding'),
        severity: 'critical',
        category: 'pipeline',
        title: 'Onboarding generation aborted',
        description: message,
      });
      const result: AgentRunResult = {
        agentId: this.id,
        agentName: this.name,
        category: this.category,
        goal: options.goal,
        summary: `Onboarding generation aborted: ${message}`,
        findings,
        actions,
        artifacts,
        recommendations,
        metrics: {
          steps: actions.length,
          durationMs: Date.now() - startedAt,
          tokensUsed,
          costUsd: 0,
          toolCalls,
        },
        success: false,
        error: message,
      };
      this.emit(options, 'agent:complete', { agentId: this.id, result });
      return result;
    }
  }

  // ─── tool helpers ───────────────────────────────────────────────────

  private emit(options: AgentRunOptions, event: string, payload: unknown): void {
    try {
      options.emit?.(event, payload);
    } catch {
      /* swallow */
    }
  }

  private async listDirectory(
    options: AgentRunOptions,
    path: string,
    actions: AgentAction[],
  ): Promise<DirEntry[]> {
    const startedAt = Date.now();
    if (!options.toolCall) {
      actions.push({
        id: nextId('action'),
        type: 'list_directory',
        description: `list_directory ${path} (skipped: no toolCall)`,
        target: 'list_directory',
        success: false,
        error: 'no toolCall',
        durationMs: Date.now() - startedAt,
      });
      return [];
    }
    try {
      const raw = await options.toolCall('list_directory', { path, cwd: options.cwd });
      const entries = this.parseDirListing(raw);
      actions.push({
        id: nextId('action'),
        type: 'list_directory',
        description: `list_directory ${path}`,
        target: 'list_directory',
        input: path,
        output: JSON.stringify(entries.slice(0, 50)).slice(0, 2000),
        durationMs: Date.now() - startedAt,
        success: true,
      });
      return entries;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      actions.push({
        id: nextId('action'),
        type: 'list_directory',
        description: `list_directory ${path}`,
        target: 'list_directory',
        input: path,
        durationMs: Date.now() - startedAt,
        success: false,
        error: message,
      });
      return [];
    }
  }

  private parseDirListing(raw: unknown): DirEntry[] {
    if (Array.isArray(raw)) {
      return raw
        .map((item) => {
          if (typeof item === 'string') {
            return { name: item, kind: item.endsWith('/') ? 'directory' : 'file' as const };
          }
          if (item && typeof item === 'object') {
            const obj = item as Record<string, unknown>;
            const name = String(obj.name ?? obj.path ?? '');
            const kind = obj.kind === 'directory' || obj.isDirectory === true ? 'directory' : 'file';
            return { name, kind: kind as 'file' | 'directory' };
          }
          return null;
        })
        .filter((e): e is DirEntry => e !== null);
    }
    const text = typeof raw === 'string' ? raw : String(raw ?? '');
    return text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => ({
        name: l.replace(/\/$/, ''),
        kind: (l.endsWith('/') ? 'directory' : 'file') as 'file' | 'directory',
      }));
  }

  private async readFile(
    options: AgentRunOptions,
    path: string,
    actions: AgentAction[],
  ): Promise<string> {
    const startedAt = Date.now();
    if (!options.toolCall) {
      actions.push({
        id: nextId('action'),
        type: 'read',
        description: `read_file ${path} (skipped: no toolCall)`,
        target: path,
        success: false,
        error: 'no toolCall',
        durationMs: Date.now() - startedAt,
      });
      return '';
    }
    try {
      const raw = await options.toolCall('read_file', { path, cwd: options.cwd });
      const content = typeof raw === 'string' ? raw : String(raw ?? '');
      actions.push({
        id: nextId('action'),
        type: 'read',
        description: `read_file ${path}`,
        target: path,
        output: content.slice(0, 2000),
        durationMs: Date.now() - startedAt,
        success: true,
      });
      return content;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      actions.push({
        id: nextId('action'),
        type: 'read',
        description: `read_file ${path}`,
        target: path,
        durationMs: Date.now() - startedAt,
        success: false,
        error: message,
      });
      return '';
    }
  }

  private async callToolWrite(
    options: AgentRunOptions,
    tool: string,
    input: unknown,
    actions: AgentAction[],
    description: string,
  ): Promise<{ ok: true; output: unknown } | { ok: false; error: string }> {
    const startedAt = Date.now();
    if (!options.toolCall) {
      actions.push({
        id: nextId('action'),
        type: 'write',
        description: `${description} (skipped: no toolCall)`,
        target: tool,
        success: false,
        error: 'no toolCall',
        durationMs: Date.now() - startedAt,
      });
      return { ok: false, error: 'no toolCall' };
    }
    try {
      const output = await options.toolCall(tool, input);
      actions.push({
        id: nextId('action'),
        type: 'write',
        description,
        target: tool,
        input: typeof input === 'string' ? input.slice(0, 2000) : JSON.stringify(input).slice(0, 2000),
        output: typeof output === 'string' ? output.slice(0, 2000) : JSON.stringify(output ?? '').slice(0, 2000),
        durationMs: Date.now() - startedAt,
        success: true,
      });
      return { ok: true, output };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      actions.push({
        id: nextId('action'),
        type: 'write',
        description,
        target: tool,
        durationMs: Date.now() - startedAt,
        success: false,
        error: message,
      });
      return { ok: false, error: message };
    }
  }

  // ─── project detection ──────────────────────────────────────────────

  private async detectProjectMeta(
    options: AgentRunOptions,
    rootEntries: DirEntry[],
    actions: AgentAction[],
  ): Promise<ProjectMeta> {
    const has = (name: string) => rootEntries.some((e) => e.name.toLowerCase() === name.toLowerCase());

    if (has('package.json')) {
      const content = await this.readFile(options, 'package.json', actions);
      return this.parsePackageJson(content);
    }
    if (has('pyproject.toml') || has('requirements.txt') || has('setup.py')) {
      const path = has('pyproject.toml') ? 'pyproject.toml' : has('requirements.txt') ? 'requirements.txt' : 'setup.py';
      const content = await this.readFile(options, path, actions);
      return this.parsePythonProject(content, has('pyproject.toml'));
    }
    if (has('cargo.toml')) {
      const content = await this.readFile(options, 'Cargo.toml', actions);
      return this.parseCargo(content);
    }
    if (has('go.mod')) {
      const content = await this.readFile(options, 'go.mod', actions);
      return this.parseGoMod(content);
    }
    if (has('pom.xml')) {
      return { name: 'maven-project', language: 'Java', packageManager: 'Maven', buildSystem: 'Maven', testFramework: 'JUnit' };
    }
    if (has('gemfile')) {
      return { name: 'ruby-project', language: 'Ruby', packageManager: 'Bundler', testFramework: 'RSpec' };
    }
    if (has('mix.exs')) {
      return { name: 'elixir-project', language: 'Elixir', packageManager: 'Mix', testFramework: 'ExUnit' };
    }
    // Fallback: infer from file extensions present at root.
    const anyTs = rootEntries.some((e) => /\.(ts|tsx)$/.test(e.name));
    const anyJs = rootEntries.some((e) => /\.(js|jsx|mjs)$/.test(e.name));
    const anyPy = rootEntries.some((e) => /\.py$/.test(e.name));
    if (anyTs) return { name: 'typescript-project', language: 'TypeScript', packageManager: 'npm' };
    if (anyJs) return { name: 'javascript-project', language: 'JavaScript', packageManager: 'npm' };
    if (anyPy) return { name: 'python-project', language: 'Python', packageManager: 'pip' };
    return { name: 'unknown-project', language: 'Unknown', packageManager: 'unknown' };
  }

  private parsePackageJson(content: string): ProjectMeta {
    let parsed: { name?: string; version?: string; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
    try {
      parsed = JSON.parse(content);
    } catch {
      /* malformed — fall through with defaults */
    }
    const deps = { ...(parsed.dependencies ?? {}), ...(parsed.devDependencies ?? {}) };
    const scripts = parsed.scripts ?? {};
    let framework: string | undefined;
    if ('next' in deps) framework = 'Next.js';
    else if ('nuxt' in deps) framework = 'Nuxt';
    else if ('react' in deps) framework = 'React';
    else if ('vue' in deps) framework = 'Vue';
    else if ('@angular/core' in deps) framework = 'Angular';
    else if ('express' in deps) framework = 'Express';
    else if ('fastify' in deps) framework = 'Fastify';
    else if ('nestjs' in deps || '@nestjs/core' in deps) framework = 'NestJS';
    let testFramework: string | undefined;
    if ('vitest' in deps) testFramework = 'Vitest';
    else if ('jest' in deps) testFramework = 'Jest';
    else if ('mocha' in deps) testFramework = 'Mocha';
    else if ('@playwright/test' in deps) testFramework = 'Playwright';
    else if ('pytest' in deps) testFramework = 'pytest';
    let packageManager = 'npm';
    if (scripts && typeof scripts.test === 'string' && /pnpm/.test(scripts.test)) packageManager = 'pnpm';
    const buildSystem = scripts && (scripts.build || scripts.dev) ? 'npm scripts' : undefined;
    return {
      name: parsed.name ?? 'node-project',
      version: parsed.version,
      language: framework === 'Next.js' || framework === 'React' || framework === 'Vue' || framework === 'Angular'
        ? 'TypeScript'
        : 'JavaScript',
      framework,
      packageManager,
      buildSystem,
      testFramework,
    };
  }

  private parsePythonProject(content: string, isPyproject: boolean): ProjectMeta {
    const nameMatch = content.match(/name\s*=\s*["']([^"']+)["']/);
    const name = nameMatch?.[1] ?? 'python-project';
    let framework: string | undefined;
    if (/fastapi/i.test(content)) framework = 'FastAPI';
    else if (/django/i.test(content)) framework = 'Django';
    else if (/flask/i.test(content)) framework = 'Flask';
    let testFramework = 'pytest';
    if (/unittest/i.test(content)) testFramework = 'unittest';
    return {
      name,
      language: 'Python',
      framework,
      packageManager: isPyproject ? 'pip (pyproject.toml)' : 'pip',
      buildSystem: isPyproject ? 'pyproject' : undefined,
      testFramework,
    };
  }

  private parseCargo(content: string): ProjectMeta {
    const nameMatch = content.match(/^name\s*=\s*"([^"]+)"/m);
    const name = nameMatch?.[1] ?? 'rust-project';
    return {
      name,
      language: 'Rust',
      packageManager: 'Cargo',
      buildSystem: 'Cargo',
      testFramework: 'cargo test',
    };
  }

  private parseGoMod(content: string): ProjectMeta {
    const modMatch = content.match(/^module\s+(\S+)/m);
    const name = modMatch?.[1] ?? 'go-project';
    return {
      name,
      language: 'Go',
      packageManager: 'Go modules',
      buildSystem: 'go build',
      testFramework: 'go test',
    };
  }

  // ─── structure analysis ─────────────────────────────────────────────

  private async analyzeStructure(
    options: AgentRunOptions,
    actions: AgentAction[],
  ): Promise<{
    directories: DirEntry[];
    sourceDirs: string[];
    testDirs: string[];
    configFiles: string[];
    docFiles: string[];
    ciFiles: string[];
    hasReadme: boolean;
    hasTestsDir: boolean;
    toolCalls: number;
    tokensUsed: number;
  }> {
    const root = await this.listDirectory(options, '.', actions);
    const dirs = root.filter((e) => e.kind === 'directory');
    const files = root.filter((e) => e.kind === 'file');

    const sourceDirs = dirs.filter((d) => /^(src|lib|app|api|server|cmd|internal|pkg|core|modules|packages)$/i.test(d.name)).map((d) => d.name);
    const testDirs = dirs.filter((d) => /^(test|tests|__tests__|spec|specs)$/i.test(d.name)).map((d) => d.name);
    const configFiles = files.filter((f) => /^(\.env|tsconfig\.json|webpack\.config\..*|vite\.config\..*|jest\.config\..*|vitest\.config\..*|\.eslintrc.*|\.prettierrc.*|babel\.config\..*)$/i.test(f.name)).map((f) => f.name);
    const docFiles = files.filter((f) => /^(README|CONTRIBUTING|CHANGELOG|ARCHITECTURE|LICENSE)/i.test(f.name)).map((f) => f.name);
    const ciFiles = files
      .filter((f) => /\.(yml|yaml)$/i.test(f.name))
      .map((f) => f.name)
      .concat(dirs.some((d) => d.name === '.github') ? ['.github/workflows/'] : []);
    const hasReadme = files.some((f) => /^readme/i.test(f.name));
    const hasTestsDir = testDirs.length > 0;
    return {
      directories: dirs,
      sourceDirs,
      testDirs,
      configFiles,
      docFiles,
      ciFiles,
      hasReadme,
      hasTestsDir,
      toolCalls: 1,
      tokensUsed: Math.ceil(JSON.stringify(root).length / 4),
    };
  }

  // ─── entry-point identification ─────────────────────────────────────

  private async identifyEntryPoints(
    options: AgentRunOptions,
    meta: ProjectMeta,
    actions: AgentAction[],
  ): Promise<{ files: string[]; toolCalls: number }> {
    const candidates: Record<string, string[]> = {
      TypeScript: ['src/index.ts', 'src/main.ts', 'src/app.ts', 'src/server.ts', 'index.ts', 'main.ts'],
      JavaScript: ['src/index.js', 'src/main.js', 'src/app.js', 'index.js', 'main.js'],
      Python: ['main.py', 'app.py', 'src/__main__.py', 'src/main.py', '__main__.py'],
      Rust: ['src/main.rs', 'src/lib.rs'],
      Go: ['main.go', 'cmd/main.go'],
      Java: ['src/main/java/Main.java'],
      Ruby: ['lib/<name>.rb', 'app.rb', 'main.rb'],
      Elixir: ['lib/application.ex'],
    };
    const list = candidates[meta.language] ?? candidates.TypeScript;
    const found: string[] = [];
    for (const c of list) {
      const content = await this.readFile(options, c, actions);
      if (content) {
        found.push(c);
        if (found.length >= 3) break;
      }
    }
    return { files: found, toolCalls: found.length };
  }

  // ─── core-module analysis ───────────────────────────────────────────

  private async analyzeCoreModules(
    options: AgentRunOptions,
    _meta: ProjectMeta,
    structure: Awaited<ReturnType<OnboardingBuddyAgent['analyzeStructure']>>,
    actions: AgentAction[],
  ): Promise<{ list: CoreModule[]; toolCalls: number }> {
    const list: CoreModule[] = [];
    let toolCalls = 0;
    const sourceDirs = structure.sourceDirs.length > 0 ? structure.sourceDirs : ['src'];
    for (const dir of sourceDirs.slice(0, 4)) {
      const entries = await this.listDirectory(options, dir, actions);
      toolCalls += 1;
      // Top-level files in this source dir
      const files = entries.filter((e) => e.kind === 'file').map((e) => e.name);
      // Top-level subdirectories = candidate modules
      const subdirs = entries.filter((e) => e.kind === 'directory').map((e) => e.name);
      for (const sub of subdirs.slice(0, 8)) {
        const subEntries = await this.listDirectory(options, `${dir}/${sub}`, actions);
        toolCalls += 1;
        const keyFiles = subEntries
          .filter((e) => e.kind === 'file')
          .map((e) => e.name)
          .slice(0, 6);
        // Read first file to infer responsibility
        let responsibility = `Subdirectory under \`${dir}/\` containing ${subEntries.length} entries.`;
        let dependencies: string[] = [];
        if (keyFiles.length > 0) {
          const firstFile = `${dir}/${sub}/${keyFiles[0]}`;
          const content = await this.readFile(options, firstFile, actions);
          toolCalls += 1;
          if (content) {
            const firstParagraph = this.extractFirstComment(content);
            if (firstParagraph) responsibility = firstParagraph;
            dependencies = this.extractImports(content).slice(0, 8);
          }
        }
        list.push({
          name: sub,
          location: `${dir}/${sub}/`,
          responsibility,
          keyFiles,
          dependencies,
        });
      }
      // If the source dir has files at the top level, treat it as a module itself
      if (files.length > 0) {
        list.push({
          name: dir,
          location: `${dir}/`,
          responsibility: `Top-level source directory containing ${files.length} files including ${files.slice(0, 3).join(', ')}.`,
          keyFiles: files.slice(0, 6),
          dependencies: [],
        });
      }
    }
    return { list, toolCalls };
  }

  private extractFirstComment(content: string): string | undefined {
    // JSDoc /** … */ or # comment block at file head
    const jsdoc = content.match(/^\s*\/\*\*([\s\S]*?)\*\//);
    if (jsdoc) {
      const lines = jsdoc[1]
        .split('\n')
        .map((l) => l.replace(/^\s*\*\s?/, '').trim())
        .filter(Boolean);
      // Find the first @description or first non-tag line
      const desc = lines.find((l) => l.startsWith('@description'));
      if (desc) return desc.replace('@description ', '');
      const firstProse = lines.find((l) => !l.startsWith('@') && l.length > 10);
      if (firstProse) return firstProse;
    }
    const pyComment = content.match(/^\s*#(.*)$/m);
    if (pyComment && pyComment[1].trim().length > 10) return pyComment[1].trim();
    return undefined;
  }

  private extractImports(content: string): string[] {
    const out: string[] = [];
    // ES imports
    const esRe = /import\s+(?:[\w{}\s,*]+\s+from\s+)?['"]([^'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = esRe.exec(content)) !== null) out.push(m[1]);
    // CommonJS
    const cjsRe = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((m = cjsRe.exec(content)) !== null) out.push(m[1]);
    // Python
    const pyRe = /^(?:from\s+(\S+)\s+)?import\s+([\w.,\s]+)/gm;
    while ((m = pyRe.exec(content)) !== null) {
      if (m[1]) out.push(m[1]);
      else out.push(m[2].split(',')[0].trim());
    }
    // Rust
    const rustRe = /^use\s+([^;]+);/gm;
    while ((m = rustRe.exec(content)) !== null) out.push(m[1].trim());
    return Array.from(new Set(out)).filter((s) => !s.startsWith('.'));
  }

  // ─── pattern detection ──────────────────────────────────────────────

  private async detectPatterns(
    _options: AgentRunOptions,
    meta: ProjectMeta,
    structure: Awaited<ReturnType<OnboardingBuddyAgent['analyzeStructure']>>,
    _actions: AgentAction[],
  ): Promise<{ list: Array<{ name: string; evidence: string }>; toolCalls: number }> {
    const list: Array<{ name: string; evidence: string }> = [];
    // MVC / layered heuristics
    if (structure.sourceDirs.some((d) => /controller/i.test(d)) ||
        structure.directories.some((d) => /controller/i.test(d.name))) {
      list.push({ name: 'MVC', evidence: 'A "controller" directory was detected — typical of MVC.' });
    }
    if (structure.directories.some((d) => /model/i.test(d.name)) &&
        structure.directories.some((d) => /view/i.test(d.name))) {
      list.push({ name: 'MVC', evidence: 'Both "model" and "view" directories present.' });
    }
    // Repository pattern
    if (structure.directories.some((d) => /repositor/i.test(d.name))) {
      list.push({ name: 'Repository', evidence: 'A "repositories" directory was detected.' });
    }
    // Clean Architecture / hexagonal
    if (structure.sourceDirs.some((d) => d === 'domain' || d === 'usecase' || d === 'usecases')) {
      list.push({ name: 'Clean Architecture', evidence: 'Presence of "domain"/"usecase" layers.' });
    }
    // DI (NestJS, tsyringe, InversifyJS)
    if (meta.framework === 'NestJS') {
      list.push({ name: 'Dependency Injection', evidence: 'NestJS uses constructor-based DI.' });
    }
    // Next.js App Router
    if (meta.framework === 'Next.js') {
      list.push({
        name: 'App Router (file-based routing)',
        evidence: 'Next.js detected — routes are derived from the file tree under app/.',
      });
    }
    // Monorepo
    if (structure.directories.some((d) => d.name === 'packages') ||
        structure.directories.some((d) => d.name === 'apps')) {
      list.push({ name: 'Monorepo', evidence: 'Top-level "packages/" or "apps/" directory present.' });
    }
    // Event-driven
    if (structure.directories.some((d) => /event|queue|subscriber|listener/i.test(d.name))) {
      list.push({ name: 'Event-driven', evidence: 'Presence of events/queues/subscribers directories.' });
    }
    if (list.length === 0) {
      list.push({
        name: 'No well-known pattern detected',
        evidence: 'The directory layout does not match MVC, Repository, Clean, or Monorepo heuristics.',
      });
    }
    return { list, toolCalls: 0 };
  }

  // ─── conventions / dev setup / tests ────────────────────────────────

  private detectConventions(
    meta: ProjectMeta,
    structure: Awaited<ReturnType<OnboardingBuddyAgent['analyzeStructure']>>,
  ): { naming: string; tests: string; style: string } {
    const hasEslint = structure.configFiles.some((f) => /eslintrc/i.test(f));
    const hasPrettier = structure.configFiles.some((f) => /prettierrc/i.test(f));
    let naming = 'kebab-case for files, PascalCase for classes';
    if (meta.language === 'Python') naming = 'snake_case for files & functions, PascalCase for classes';
    if (meta.language === 'Go') naming = 'lowercase with underscores discouraged; exported = capitalized';
    if (meta.language === 'Rust') naming = 'snake_case for files & functions, PascalCase for types';
    const tests =
      meta.testFramework === 'Vitest' ? '*.test.ts next to source (vitest convention)' :
      meta.testFramework === 'Jest' ? '*.test.ts / *.spec.ts (jest convention)' :
      meta.testFramework === 'pytest' ? 'test_*..py under tests/' :
      meta.testFramework === 'RSpec' ? '*_spec.rb under spec/' :
      'see test directory layout';
    const style: string[] = [];
    if (hasEslint) style.push('ESLint');
    if (hasPrettier) style.push('Prettier');
    if (meta.language === 'Python') style.push('PEP 8 (recommend: black + ruff)');
    if (meta.language === 'Go') style.push('gofmt / goimports');
    if (meta.language === 'Rust') style.push('rustfmt + clippy');
    return { naming, tests, style: style.join(' + ') || 'not configured' };
  }

  private composeDevSetup(
    meta: ProjectMeta,
    structure: Awaited<ReturnType<OnboardingBuddyAgent['analyzeStructure']>>,
  ): string[] {
    const lines: string[] = [];
    lines.push('## Getting Started', '');
    lines.push('### Prerequisites', '');
    switch (meta.language) {
      case 'TypeScript':
      case 'JavaScript':
        lines.push('- Node.js ≥ 20');
        lines.push(`- ${meta.packageManager}`);
        break;
      case 'Python':
        lines.push('- Python ≥ 3.10');
        lines.push('- pip + venv (or your favourite env manager)');
        break;
      case 'Rust':
        lines.push('- Rust (stable) + Cargo');
        break;
      case 'Go':
        lines.push('- Go ≥ 1.21');
        break;
      default:
        lines.push(`- ${meta.language} toolchain`);
    }
    lines.push('');
    lines.push('### Install', '');
    switch (meta.language) {
      case 'TypeScript':
      case 'JavaScript':
        lines.push('```bash');
        lines.push(`${meta.packageManager} install`);
        lines.push('```');
        break;
      case 'Python':
        lines.push('```bash');
        lines.push('python -m venv .venv && source .venv/bin/activate');
        lines.push('pip install -r requirements.txt  # or: pip install -e .');
        lines.push('```');
        break;
      case 'Rust':
        lines.push('```bash\ncargo build\n```');
        break;
      case 'Go':
        lines.push('```bash\ngo mod download\n```');
        break;
    }
    lines.push('');
    lines.push('### Environment');
    if (structure.configFiles.some((f) => f.startsWith('.env'))) {
      lines.push('```bash\ncp .env.example .env  # then edit values\n```');
    } else {
      lines.push('_No `.env` file detected — confirm with the team whether one is needed._');
    }
    lines.push('');
    lines.push('### Run');
    lines.push('```bash');
    switch (meta.language) {
      case 'TypeScript':
      case 'JavaScript':
        lines.push(`${meta.packageManager} run dev`);
        break;
      case 'Python':
        lines.push(meta.framework === 'FastAPI' ? 'uvicorn app.main:app --reload' : 'python main.py');
        break;
      case 'Rust':
        lines.push('cargo run');
        break;
      case 'Go':
        lines.push('go run .');
        break;
    }
    lines.push('```');
    return lines;
  }

  private composeTestGuide(
    meta: ProjectMeta,
    structure: Awaited<ReturnType<OnboardingBuddyAgent['analyzeStructure']>>,
  ): string[] {
    const lines: string[] = [];
    lines.push('## Running Tests', '');
    lines.push('```bash');
    switch (meta.testFramework) {
      case 'Vitest':
      case 'Jest':
        lines.push(`${meta.packageManager} test           # unit tests`);
        lines.push(`${meta.packageManager} run test:e2e   # e2e (if configured)`);
        break;
      case 'pytest':
        lines.push('pytest                # all tests');
        lines.push('pytest tests/unit    # unit only');
        break;
      case 'Mocha':
        lines.push(`${meta.packageManager} test`);
        break;
      case 'Playwright':
        lines.push(`${meta.packageManager} run test:e2e`);
        break;
      case 'cargo test':
        lines.push('cargo test');
        break;
      case 'go test':
        lines.push('go test ./...');
        break;
      case 'RSpec':
        lines.push('bundle exec rspec');
        break;
      case 'ExUnit':
        lines.push('mix test');
        break;
      default:
        lines.push('# Test command unknown — check package.json scripts or the test directory.');
    }
    lines.push('```');
    if (!structure.hasTestsDir) {
      lines.push('');
      lines.push('_No dedicated tests directory was detected. Establish a test convention early._');
    }
    return lines;
  }

  // ─── doc composition ────────────────────────────────────────────────

  private composeOnboardingDoc(
    meta: ProjectMeta,
    structure: Awaited<ReturnType<OnboardingBuddyAgent['analyzeStructure']>>,
    entryPoints: string[],
    modules: CoreModule[],
    patterns: Array<{ name: string; evidence: string }>,
    devSetup: string[],
    conventions: { naming: string; tests: string; style: string },
    testGuide: string[],
  ): string {
    const lines: string[] = [];
    lines.push(`# Welcome to ${meta.name}!`, '');
    lines.push(`> _A friendly tour generated by 🤝 SANIX Onboarding Buddy._`, '');
    lines.push('## Architecture Overview', '');
    lines.push(`This is a **${meta.language}** project${meta.framework ? ` built with **${meta.framework}**` : ''}.`);
    if (patterns.length) {
      lines.push('');
      lines.push('**Patterns detected:**');
      for (const p of patterns) lines.push(`- **${p.name}** — ${p.evidence}`);
    }
    lines.push('');
    lines.push('## Project Structure', '');
    lines.push('```');
    lines.push(`${meta.name}/`);
    for (const d of structure.sourceDirs) lines.push(`├── ${d}/           # source`);
    for (const d of structure.testDirs) lines.push(`├── ${d}/           # tests`);
    for (const f of structure.configFiles.slice(0, 5)) lines.push(`├── ${f}        # config`);
    for (const f of structure.docFiles.slice(0, 5)) lines.push(`├── ${f}        # docs`);
    if (structure.ciFiles.length) lines.push(`├── .github/workflows/   # CI`);
    lines.push('```');
    lines.push('');
    lines.push('## Entry Points', '');
    if (entryPoints.length) {
      for (const e of entryPoints) lines.push(`- \`${e}\``);
    } else {
      lines.push('_No entry point could be auto-detected. Ask the team._');
    }
    lines.push('');
    lines.push('## Key Modules', '');
    if (modules.length === 0) {
      lines.push('_No modules were detected — the project may be flat._');
    } else {
      for (const m of modules.slice(0, 10)) {
        lines.push(`### ${m.name}`);
        lines.push(`- **Location:** \`${m.location}\``);
        lines.push(`- **Responsibility:** ${m.responsibility}`);
        if (m.keyFiles.length) {
          lines.push(`- **Key files:** ${m.keyFiles.map((f) => `\`${f}\``).join(', ')}`);
        }
        if (m.dependencies.length) {
          lines.push(`- **Dependencies:** ${m.dependencies.slice(0, 6).map((d) => `\`${d}\``).join(', ')}`);
        }
        lines.push('');
      }
    }
    lines.push(...devSetup);
    lines.push('');
    lines.push(...testGuide);
    lines.push('');
    lines.push('## Common Tasks', '');
    lines.push('- **Add a new API endpoint:** create a file in the relevant module, register the route in the entry point, add a test.');
    lines.push('- **Add a new module:** create a new directory under the primary source dir, export from the nearest `index.ts`.');
    lines.push('- **Add a test:** follow the `' + conventions.tests + '` convention.');
    lines.push('');
    lines.push('## Conventions', '');
    lines.push(`- **Files:** ${conventions.naming}`);
    lines.push(`- **Tests:** ${conventions.tests}`);
    lines.push(`- **Style:** ${conventions.style}`);
    lines.push('');
    lines.push('## Where Things Live', '');
    lines.push('- **Configs:** ' + (structure.configFiles.length ? structure.configFiles.slice(0, 5).map((f) => `\`${f}\``).join(', ') : '_none detected_'));
    lines.push('- **Tests:** ' + (structure.testDirs.length ? structure.testDirs.map((d) => `\`${d}/\``).join(', ') : '_no dedicated test directory_'));
    lines.push('- **Docs:** ' + (structure.docFiles.length ? structure.docFiles.slice(0, 5).map((f) => `\`${f}\``).join(', ') : '_no docs detected_'));
    lines.push('- **CI:** ' + (structure.ciFiles.length ? structure.ciFiles.map((f) => `\`${f}\``).join(', ') : '_no CI config detected_'));
    lines.push('');
    lines.push('---');
    lines.push('_Welcome aboard! If something is unclear, ask in the team channel._');
    return lines.join('\n');
  }

  private composeSummary(
    meta: ProjectMeta,
    structure: Awaited<ReturnType<OnboardingBuddyAgent['analyzeStructure']>>,
    moduleCount: number,
    durationMs: number,
  ): string {
    return (
      `🤝 Onboarding Buddy toured ${meta.name} (${meta.language}${meta.framework ? `/${meta.framework}` : ''}) ` +
      `in ${durationMs}ms — identified ${structure.sourceDirs.length} source dir(s), ${moduleCount} module(s), ` +
      `${structure.configFiles.length} config file(s). ONBOARDING.md written.`
    );
  }
}
