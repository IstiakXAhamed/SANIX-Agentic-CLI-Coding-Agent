/**
 * @file DependencyAnalyzer — parse dependencies from package.json,
 * requirements.txt, pyproject.toml, Cargo.toml, go.mod.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  type SanixTool,
  type ToolContext,
  type ToolResult,
  type ToolPermission,
  z,
  resolvePath,
  okResult,
  errResult,
} from '../types.js';

/** Input schema for `get_dependencies`. */
export const GetDepsInputSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe('Path to a manifest file OR a directory containing one.'),
});

/** Output schema for `get_dependencies`. */
export const GetDepsOutputSchema = z.object({
  dependencies: z.array(
    z.object({
      name: z.string(),
      version: z.string(),
      type: z.enum(['prod', 'dev', 'peer']),
    }),
  ),
});

export type GetDepsInput = z.infer<typeof GetDepsInputSchema>;
export type GetDepsOutput = z.infer<typeof GetDepsOutputSchema>;

interface Dep {
  name: string;
  version: string;
  type: 'prod' | 'dev' | 'peer';
}

/** Walk up to find a manifest file. */
async function findManifest(
  startAbs: string,
): Promise<{ kind: 'package.json' | 'requirements.txt' | 'pyproject.toml' | 'Cargo.toml' | 'go.mod'; abs: string } | null> {
  let dir = startAbs;
  const stat = await fs.stat(startAbs).catch(() => null);
  if (stat && stat.isFile()) return { kind: detectKind(startAbs), abs: startAbs };
  for (let i = 0; i < 12; i++) {
    for (const name of [
      'package.json',
      'requirements.txt',
      'pyproject.toml',
      'Cargo.toml',
      'go.mod',
    ] as const) {
      const candidate = path.join(dir, name);
      const s = await fs.stat(candidate).catch(() => null);
      if (s && s.isFile()) return { kind: name, abs: candidate };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function detectKind(
  p: string,
): 'package.json' | 'requirements.txt' | 'pyproject.toml' | 'Cargo.toml' | 'go.mod' {
  const base = path.basename(p);
  return base as 'package.json' | 'requirements.txt' | 'pyproject.toml' | 'Cargo.toml' | 'go.mod';
}

function parseDepsFromPackageJson(content: string): Dep[] {
  const out: Dep[] = [];
  let pkg: unknown;
  try {
    pkg = JSON.parse(content);
  } catch {
    return out;
  }
  if (typeof pkg !== 'object' || pkg === null) return out;
  const p = pkg as Record<string, unknown>;
  const collect = (obj: unknown, type: 'prod' | 'dev' | 'peer') => {
    if (typeof obj !== 'object' || obj === null) return;
    for (const [name, version] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof version === 'string') out.push({ name, version, type });
    }
  };
  collect(p.dependencies, 'prod');
  collect(p.devDependencies, 'dev');
  collect(p.peerDependencies, 'peer');
  return out;
}

function parseDepsFromRequirements(content: string): Dep[] {
  const out: Dep[] = [];
  const re = /^\s*([A-Za-z0-9_.-]+)\s*(?:==|>=|<=|~=|!=|>|<)?\s*([^;\s#]*)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const name = m[1];
    const version = m[2] ?? '*';
    if (name.startsWith('#')) continue;
    out.push({ name, version: version || '*', type: 'prod' });
  }
  return out;
}

function parseDepsFromPyproject(content: string): Dep[] {
  const out: Dep[] = [];
  // Match `[project]` dependencies and `[project.optional-dependencies]`.
  const projectSection = extractTomlSection(content, 'project');
  if (projectSection) {
    const depsMatch = projectSection.match(/dependencies\s*=\s*\[([\s\S]*?)\]/);
    if (depsMatch) {
      const depRe = /"([^"]+)"/g;
      let m: RegExpExecArray | null;
      while ((m = depRe.exec(depsMatch[1])) !== null) {
        const parsed = splitPipDep(m[1]);
        out.push({ ...parsed, type: 'prod' });
      }
    }
    const devDepsMatch = projectSection.match(/optional-dependencies\.dev\s*=\s*\[([\s\S]*?)\]/);
    if (devDepsMatch) {
      const depRe = /"([^"]+)"/g;
      let m: RegExpExecArray | null;
      while ((m = depRe.exec(devDepsMatch[1])) !== null) {
        const parsed = splitPipDep(m[1]);
        out.push({ ...parsed, type: 'dev' });
      }
    }
  }
  return out;
}

function splitPipDep(s: string): { name: string; version: string } {
  const m = s.match(/^([A-Za-z0-9_.-]+)\s*(?:([<>=!~]=?)\s*([^\s;]+))?/);
  if (!m) return { name: s, version: '*' };
  return { name: m[1], version: m[2] && m[3] ? `${m[2]}${m[3]}` : '*' };
}

function extractTomlSection(content: string, name: string): string | null {
  const re = new RegExp(`^\\[${name.replace(/\./g, '\\.')}\\]\\s*$`, 'm');
  const m = re.exec(content);
  if (!m) return null;
  const start = m.index + m[0].length;
  const end = content.indexOf('\n[', start);
  return content.slice(start, end === -1 ? undefined : end);
}

function parseDepsFromCargo(content: string): Dep[] {
  const out: Dep[] = [];
  const sectionRe = /^\[(dependencies|dev-dependencies)\]([\s\S]*?)(?=^\[|$)/gm;
  let m: RegExpExecArray | null;
  while ((m = sectionRe.exec(content)) !== null) {
    const isDev = m[1] === 'dev-dependencies';
    const body = m[2];
    // Simple form: `name = "1.0"`.
    const lineRe = /^([A-Za-z0-9_-]+)\s*=\s*"([^"]+)"/gm;
    let lm: RegExpExecArray | null;
    while ((lm = lineRe.exec(body)) !== null) {
      out.push({ name: lm[1], version: lm[2], type: isDev ? 'dev' : 'prod' });
    }
    // Table form: `name = { version = "1.0", ... }`.
    const tableRe = /^([A-Za-z0-9_-]+)\s*=\s*\{\s*version\s*=\s*"([^"]+)"/gm;
    let tm: RegExpExecArray | null;
    while ((tm = tableRe.exec(body)) !== null) {
      out.push({ name: tm[1], version: tm[2], type: isDev ? 'dev' : 'prod' });
    }
  }
  return out;
}

function parseDepsFromGoMod(content: string): Dep[] {
  const out: Dep[] = [];
  const re = /^\s*(require|replace)\s+([^\s]+)\s+(?:[^\s]+\s+)?v([0-9][\w.\-+]*)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    out.push({ name: m[2], version: `v${m[3]}`, type: 'prod' });
  }
  // Handle the block form: `require ( ... )`.
  const blockRe = /require\s*\(([\s\S]*?)\)/g;
  let bm: RegExpExecArray | null;
  while ((bm = blockRe.exec(content)) !== null) {
    const lineRe = /([^\s]+)\s+v([0-9][\w.\-+]*)/g;
    let lm: RegExpExecArray | null;
    while ((lm = lineRe.exec(bm[1])) !== null) {
      out.push({ name: lm[1], version: `v${lm[2]}`, type: 'prod' });
    }
  }
  return out;
}

/**
 * DependencyAnalyzerTool — extract dependencies from a project manifest.
 *
 * @example
 * ```ts
 * const res = await new DependencyAnalyzerTool().execute(
 *   { path: '.' },
 *   ctx,
 * );
 * ```
 */
export class DependencyAnalyzerTool
  implements SanixTool<GetDepsInput, GetDepsOutput>
{
  readonly name = 'get_dependencies';
  readonly description =
    'Parse dependencies from package.json, requirements.txt, pyproject.toml, Cargo.toml, or go.mod.';
  readonly inputSchema = GetDepsInputSchema;
  readonly outputSchema = GetDepsOutputSchema;
  readonly permissions: ToolPermission[] = ['filesystem:read'];
  readonly maxTokensInput = 256;
  readonly maxTokensOutput = 16_000;

  async execute(
    input: GetDepsInput,
    context: ToolContext,
  ): Promise<ToolResult<GetDepsOutput>> {
    const start = Date.now();
    const absPath = resolvePath(input.path, context.cwd);
    try {
      const manifest = await findManifest(absPath);
      if (!manifest) {
        return errResult<GetDepsOutput>(
          `get_dependencies: no manifest found at or above ${absPath}`,
          Date.now() - start,
        );
      }
      const content = await fs.readFile(manifest.abs, 'utf-8');
      let deps: Dep[] = [];
      switch (manifest.kind) {
        case 'package.json':
          deps = parseDepsFromPackageJson(content);
          break;
        case 'requirements.txt':
          deps = parseDepsFromRequirements(content);
          break;
        case 'pyproject.toml':
          deps = parseDepsFromPyproject(content);
          break;
        case 'Cargo.toml':
          deps = parseDepsFromCargo(content);
          break;
        case 'go.mod':
          deps = parseDepsFromGoMod(content);
          break;
      }
      return okResult<GetDepsOutput>({ dependencies: deps }, Date.now() - start);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errResult<GetDepsOutput>(
        `get_dependencies failed: ${msg}`,
        Date.now() - start,
      );
    }
  }

  formatForContext(result: GetDepsOutput): string {
    if (result.dependencies.length === 0) return '(no dependencies found)';
    return result.dependencies
      .map((d) => `[${d.type}] ${d.name}@${d.version}`)
      .join('\n');
  }
}
