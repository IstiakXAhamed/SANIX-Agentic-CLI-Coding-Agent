/**
 * @file agents/SecuritySentinel.ts
 * @description SANIX Security Sentinel — 🛡️ continuous security scanner.
 *
 * Scans codebases for:
 *   1. **OWASP Top 10 vulnerabilities** — injection, broken auth,
 *      sensitive data exposure, XXE, broken access control, security
 *      misconfiguration, XSS, insecure deserialization, known
 *      vulnerable components, insufficient logging.
 *   2. **Hardcoded secrets** — AWS keys, GitHub tokens, Google API
 *      keys, Stripe keys, Slack tokens, generic API keys, JWT secrets,
 *      database URLs with passwords, private keys, hardcoded passwords.
 *   3. **Dependency vulnerabilities** — runs `npm audit --json`,
 *      `pip-audit --format json`, `cargo audit --json`, `go vet`.
 *   4. **Insecure configurations** — CORS `*`, missing CSP, debug:true
 *      in production, allowInsecureHTTP, disabled TLS verification.
 *   5. **Cryptographic weaknesses** — MD5/SHA1 for passwords, ECB
 *      mode, hardcoded IVs, `Math.random` for security, short keys.
 *
 * Each finding carries: severity, CWE ID, OWASP category, file:line,
 * code snippet, and a concrete fix. Critical findings surface first.
 *
 * @packageDocumentation
 */

import type {
  AgentCategory,
  AgentFinding,
  AgentRunOptions,
  AgentRunResult,
} from '../types.js';
import { BaseAgent, type RunContext } from '../BaseAgent.js';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/**
 * SANIX Security Sentinel — 🛡️ continuous security scanner.
 *
 * @example
 * ```ts
 * import { SecuritySentinel } from '@sanix/agents';
 *
 * const agent = new SecuritySentinel();
 * const result = await agent.run('Audit this repo for security issues', {
 *   cwd: '/repo',
 *   outputFormat: 'markdown',
 * });
 *
 * const critical = result.findings.filter(f => f.severity === 'critical');
 * console.log(`Found ${critical.length} critical issues.`);
 * ```
 */
export class SecuritySentinel extends BaseAgent {
  public readonly id = 'security-sentinel';
  public readonly name = 'Security Sentinel';
  public readonly description =
    'Continuous security scanning agent. Finds OWASP Top 10 vulnerabilities, ' +
    'hardcoded secrets, dependency CVEs, insecure configurations, and ' +
    'cryptographic weaknesses. Auto-generates patches with CWE references.';
  public readonly category: AgentCategory = 'security';
  public readonly icon = '🛡️';
  public readonly provider = 'claude-sonnet-4';
  public readonly temperature = 0.1;
  public readonly tools = ['read_file', 'search_files', 'bash', 'analyze_ast', 'list_directory'];
  public readonly exampleQueries = [
    'Audit this repository for OWASP Top 10 vulnerabilities.',
    'Find all hardcoded secrets and API keys in src/.',
    'Run npm audit and explain every critical CVE.',
    'Check my CORS, CSP, and TLS configuration for misconfigurations.',
    'Scan for weak crypto usage (MD5, ECB mode, hardcoded IVs).',
  ];

  public readonly systemPrompt = `You are SANIX Security Sentinel, an elite security-focused agent. You scan codebases for:
(1) OWASP Top 10 vulnerabilities (injection, broken auth, sensitive data exposure, XXE, broken access control, security misconfiguration, XSS, insecure deserialization, known vulnerable components, insufficient logging),
(2) hardcoded secrets (API keys, passwords, tokens, private keys),
(3) dependency vulnerabilities (CVEs),
(4) insecure configurations (CORS, CSP, TLS, headers),
(5) cryptographic weaknesses (weak algorithms, hardcoded IVs, ECB mode).

For each finding, provide: severity, CWE ID, description, location, and a concrete fix.
Prioritize critical findings first.`;

  // ── Run entrypoint ─────────────────────────────────────────────────────────

  public async run(goal: string, opts?: AgentRunOptions): Promise<AgentRunResult> {
    const ctx = this.startRun(goal, opts);
    this.emitProgress('analyze', 'Scanning codebase for security issues…', undefined, ctx);

    // 1) Secret detection (regex sweep across all text files).
    await this.scanSecrets(ctx);

    // 2) OWASP Top 10 (pattern-based detection).
    await this.scanOwasp(ctx);

    // 3) Dependency audit (npm audit / pip-audit / cargo audit / go vet).
    await this.scanDependencies(ctx);

    // 4) Insecure configurations (CORS, CSP, TLS, debug).
    await this.scanConfigs(ctx);

    // 5) Cryptographic weaknesses.
    await this.scanCrypto(ctx);

    this.recordMetric(ctx, 'totalFindings', ctx.findings.length, 'set');
    this.recordMetric(
      ctx,
      'criticalFindings',
      ctx.findings.filter((f) => f.severity === 'critical').length,
      'set',
    );

    return this.finishRun(ctx);
  }

  // ── 1) Secret detection ────────────────────────────────────────────────────

  /**
   * Regex patterns for known credential formats. Each pattern carries
   * its human-readable name, CWE id, severity, and a suggested fix.
   */
  private static readonly SECRET_PATTERNS: ReadonlyArray<{
    name: string;
    cwe: string;
    severity: AgentFinding['severity'];
    pattern: RegExp;
    fix: string;
  }> = [
    {
      name: 'AWS Access Key ID',
      cwe: 'CWE-798',
      severity: 'critical',
      pattern: /\bAKIA[0-9A-Z]{16}\b/g,
      fix: 'Rotate the leaked AWS key immediately in IAM, then load it from AWS_SECRET_ACCESS_KEY env var or ~/.aws/credentials.',
    },
    {
      name: 'AWS Secret Access Key',
      cwe: 'CWE-798',
      severity: 'critical',
      pattern: /(?<![A-Za-z0-9/+])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])/g,
      fix: 'Treat as suspect — verify in AWS IAM, rotate if confirmed, and store via AWS_SECRET_ACCESS_KEY env var.',
    },
    {
      name: 'GitHub Personal Access Token',
      cwe: 'CWE-798',
      severity: 'critical',
      pattern: /\bgh[ps]_[A-Za-z0-9]{36,255}\b/g,
      fix: 'Revoke at https://github.com/settings/tokens and load from a secret manager (e.g. GITHUB_TOKEN env var, 1Password CLI, AWS Secrets Manager).',
    },
    {
      name: 'GitHub OAuth Token',
      cwe: 'CWE-798',
      severity: 'high',
      pattern: /\bgho_[A-Za-z0-9]{36,255}\b/g,
      fix: 'Revoke at https://github.com/settings/applications and re-issue via OAuth flow.',
    },
    {
      name: 'GitHub App/User-to-Server Token',
      cwe: 'CWE-798',
      severity: 'high',
      pattern: /\bghu_[A-Za-z0-9]{36,255}\b/g,
      fix: 'Revoke the GitHub App token and rotate the app secret.',
    },
    {
      name: 'GitHub Refresh Token',
      cwe: 'CWE-798',
      severity: 'high',
      pattern: /\bghr_[A-Za-z0-9]{36,255}\b/g,
      fix: 'Revoke the refresh token and re-authenticate.',
    },
    {
      name: 'Google API Key',
      cwe: 'CWE-798',
      severity: 'high',
      pattern: /\bAIza[0-9A-Za-z\-_]{35}\b/g,
      fix: 'Restrict the key in Google Cloud Console (API + referrer + IP), then load via GOOGLE_API_KEY env var.',
    },
    {
      name: 'Stripe Live Secret Key',
      cwe: 'CWE-798',
      severity: 'critical',
      pattern: /\bsk_live_[0-9a-zA-Z]{24,99}\b/g,
      fix: 'Roll the key at https://dashboard.stripe.com/apikeys — Stripe live keys grant full account access.',
    },
    {
      name: 'Stripe Restricted Live Key',
      cwe: 'CWE-798',
      severity: 'critical',
      pattern: /\brk_live_[0-9a-zA-Z]{24,99}\b/g,
      fix: 'Roll the restricted key in Stripe Dashboard — it may still have write scope on sensitive resources.',
    },
    {
      name: 'Slack Token',
      cwe: 'CWE-798',
      severity: 'high',
      pattern: /\bxox[bpas]-[0-9A-Za-z-]{10,72}\b/g,
      fix: 'Revoke at https://api.slack.com/authentication/token-types and rotate via Slack app management UI.',
    },
    {
      name: 'JWT Secret / Token',
      cwe: 'CWE-321',
      severity: 'high',
      pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
      fix: 'If this is a signing secret, rotate immediately. If it is a user JWT, treat as a credential leak.',
    },
    {
      name: 'Database URL with credentials',
      cwe: 'CWE-798',
      severity: 'high',
      pattern: /\b(postgres|postgresql|mongodb(\+srv)?|mysql|redis|amqp):\/\/[^:\s]+:[^@\s]+@[^\s/]+\b/gi,
      fix: 'Move credentials to env var (DATABASE_URL) and ensure the URL is gitignored. Rotate the DB password.',
    },
    {
      name: 'PEM Private Key',
      cwe: 'CWE-321',
      severity: 'critical',
      pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
      fix: 'Rotate the key pair, remove the private key from the repo, scrub git history with git-filter-repo, and load via secret manager.',
    },
    {
      name: 'Generic API key assignment',
      cwe: 'CWE-798',
      severity: 'medium',
      pattern: /\b(?:api[_-]?key|apikey|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\s*[:=]\s*['"][A-Za-z0-9+/=_-]{16,}['"]/gi,
      fix: 'Move to env var or a secret manager. Verify the leaked value is rotated.',
    },
    {
      name: 'Hardcoded password assignment',
      cwe: 'CWE-259',
      severity: 'high',
      pattern: /\bpassword\s*[:=]\s*['"][^'"\s]{4,}['"]/gi,
      fix: 'Remove hardcoded password — load from env var or secret manager. Use bcrypt/argon2 for password hashing.',
    },
  ];

  private async scanSecrets(ctx: RunContext): Promise<void> {
    this.emitProgress('analyze', 'Phase 1: secret detection sweep…', undefined, ctx);
    let scanned = 0;
    await this.scanFiles(ctx, async (filePath, content) => {
      scanned++;
      for (const def of SecuritySentinel.SECRET_PATTERNS) {
        const matches = this.searchInFile(content, def.pattern);
        for (const m of matches) {
          // Skip obvious test/fixture/example files.
          if (this.isTestOrFixture(filePath)) continue;
          // Skip lines that look like comments explaining the format.
          if (/(\bexample\b|\bplaceholder\b|\byour[_-]?key\b|\bxxx+\b)/i.test(m.lineText)) continue;
          this.addFinding(ctx, {
            severity: def.severity,
            category: def.cwe,
            title: `${def.name} exposed in ${this.rel(filePath, ctx)}`,
            description:
              `A ${def.name} appears to be hardcoded in \`${this.rel(filePath, ctx)}:${m.line}\`. ` +
              `Hardcoded credentials are a ${def.cwe} (Use of Hard-coded Credentials) violation and the ` +
              `top cause of cloud account compromise. Anyone with repo access — including ex-employees ` +
              `and CI logs — has the credential.`,
            file: this.rel(filePath, ctx),
            line: m.line,
            snippet: this.snippetAround(content, m.line, 1),
            suggestion: def.fix,
            autoFixable: false,
            tags: ['OWASP-A2', 'secrets', def.cwe],
          });
        }
      }
    });
    this.recordMetric(ctx, 'secretsScannedFiles', scanned, 'set');
  }

  // ── 2) OWASP Top 10 ────────────────────────────────────────────────────────

  /**
   * Pattern-based detection for OWASP Top 10 vulnerabilities. Each
   * pattern declares its CWE id and OWASP 2021 category.
   */
  private static readonly OWASP_PATTERNS: ReadonlyArray<{
    name: string;
    owasp: string;
    cwe: string;
    severity: AgentFinding['severity'];
    pattern: RegExp;
    fix: string;
  }> = [
    {
      name: 'SQL Injection (string-concatenated query)',
      owasp: 'A03:2021-Injection',
      cwe: 'CWE-89',
      severity: 'critical',
      pattern: /\b(?:execute|query|exec)\s*\(\s*['"`](?:SELECT|INSERT|UPDATE|DELETE|DROP|UNION|CREATE|ALTER)\b[^'"`]*\$\{|::|\+\s*\w|\bfmt\.Sprintf\b/gi,
      fix: 'Use a parameterized query / prepared statement. Never interpolate user input into SQL text.',
    },
    {
      name: 'XSS — unescaped HTML output',
      owasp: 'A03:2021-Injection',
      cwe: 'CWE-79',
      severity: 'high',
      pattern: /\bdangerouslySetInnerHTML\s*=\s*\{\{?\s*[^}]*\buser|innerHTML\s*=\s*[^;]*\breq\.|res\.write\s*\(\s*[^)]*\breq\./gi,
      fix: 'Use a templating engine that auto-escapes (React, Handlebars). Never assign untrusted input to innerHTML or dangerouslySetInnerHTML.',
    },
    {
      name: 'Command Injection — exec with user input',
      owasp: 'A03:2021-Injection',
      cwe: 'CWE-78',
      severity: 'critical',
      pattern: /\b(?:exec|execSync|spawn|child_process\.exec)\s*\(\s*[^)]*`[^`]*\$\{|\b(?:os\.system|subprocess\.call|subprocess\.run|os\.popen)\s*\(\s*['"][^'"]*%s|f['"][^'"]*\{[^}]*req\.|f['"][^'"]*\{[^}]*input/gi,
      fix: 'Pass arguments as an array (spawn(cmd, [arg1, arg2])) instead of a shell string. Validate input against an allowlist.',
    },
    {
      name: 'Path Traversal — user input in file path',
      owasp: 'A01:2021-Broken Access Control',
      cwe: 'CWE-22',
      severity: 'high',
      pattern: /\b(?:readFile|readFileSync|writeFile|fs\.read|fs\.write|open|fopen)\s*\(\s*[^)]*\breq\.(?:query|body|params)|\bpath\.join\s*\(\s*[^)]*\breq\.|File\(\s*[^)]*\brequest\./gi,
      fix: 'Normalize the path with path.resolve() and assert it starts with the allowed root. Reject `..` segments.',
    },
    {
      name: 'SSRF — user input in outbound URL',
      owasp: 'A10:2021-SSRF',
      cwe: 'CWE-918',
      severity: 'high',
      pattern: /\b(?:fetch|axios\.|http\.get|https\.get|requests\.get|urllib)\s*\(\s*[^)]*\breq\.(?:query|body|params)|fetch\s*\(\s*`[^`]*\$\{req\./gi,
      fix: 'Validate the URL against an allowlist of hosts. Block internal IP ranges (RFC1918) and metadata endpoints (169.254.169.254).',
    },
    {
      name: 'XXE — XML parsing without disabling external entities',
      owasp: 'A05:2021-Security Misconfiguration',
      cwe: 'CWE-611',
      severity: 'high',
      pattern: /\bparseString|XMLParser|libxmljs|etree|ElementTree|lxml\.(?:etree|fromstring)/g,
      fix: 'Disable external entities: libxml2 NOENT=0, Python lxml set `resolve_entities=False`, Java set FEATURE_SECURE_PROCESSING.',
    },
    {
      name: 'Insecure Deserialization — pickle / eval of user input',
      owasp: 'A08:2021-Software & Data Integrity',
      cwe: 'CWE-502',
      severity: 'critical',
      pattern: /\bpickle\.loads?\s*\(|\beval\s*\(\s*[^)]*\breq\.|\beval\s*\(\s*[^)]*\brequest\.|\bFunction\s*\(\s*['"`]return['"`]\s*\)\s*\(\s*[^)]*req\.|\bMarshal\.load/gi,
      fix: 'Use a data-formatting library like JSON with schema validation. Never pass untrusted input to eval / pickle / Marshal.load.',
    },
    {
      name: 'Broken Access Control — missing auth middleware',
      owasp: 'A01:2021-Broken Access Control',
      cwe: 'CWE-862',
      severity: 'medium',
      pattern: /\bapp\.(?:get|post|put|delete|patch)\s*\(\s*['"][^'"]+['"]\s*,\s*(?:async\s*)?\(\s*req\b/g,
      fix: 'Apply auth middleware (e.g. app.get("/route", authMiddleware, handler)). Verify the user has the required role before responding.',
    },
    {
      name: 'Insufficient Logging — security event not logged',
      owasp: 'A09:2021-Security Logging & Monitoring',
      cwe: 'CWE-778',
      severity: 'low',
      pattern: /\b(?:throw|return)\s+new\s+(?:UnauthorizedError|ForbiddenError|AuthError)\b/g,
      fix: 'Log every auth failure (user, ip, timestamp, reason) to a SIEM-forwarded channel. Alert on burst patterns.',
    },
  ];

  private async scanOwasp(ctx: RunContext): Promise<void> {
    this.emitProgress('analyze', 'Phase 2: OWASP Top 10 pattern scan…', undefined, ctx);
    let scanned = 0;
    await this.scanFiles(ctx, async (filePath, content) => {
      scanned++;
      for (const def of SecuritySentinel.OWASP_PATTERNS) {
        const matches = this.searchInFile(content, def.pattern);
        for (const m of matches) {
          this.addFinding(ctx, {
            severity: def.severity,
            category: def.cwe,
            title: `${def.name} in ${this.rel(filePath, ctx)}:${m.line}`,
            description:
              `Possible ${def.name} (${def.owasp}, ${def.cwe}) detected at ` +
              `\`${this.rel(filePath, ctx)}:${m.line}\`. ${def.name.startsWith('SQL') ? 'String concatenation in a SQL query allows an attacker to alter query semantics.' : ''} ` +
              `Confirm by tracing user input from the request boundary to this sink.`,
            file: this.rel(filePath, ctx),
            line: m.line,
            snippet: this.snippetAround(content, m.line, 2),
            suggestion: def.fix,
            autoFixable: false,
            tags: [def.owasp.split(':')[0], def.cwe],
          });
        }
      }
    });
    this.recordMetric(ctx, 'owaspScannedFiles', scanned, 'set');
  }

  // ── 3) Dependency audit ────────────────────────────────────────────────────

  private async scanDependencies(ctx: RunContext): Promise<void> {
    this.emitProgress('analyze', 'Phase 3: dependency audit (npm/pip/cargo/go)…', undefined, ctx);

    // npm audit (Node).
    if (await this.fileExists('package.json', ctx)) {
      const result = await this.runShell('npm audit --json 2>/dev/null || true', ctx);
      if (result.success && result.stdout) {
        this.parseNpmAudit(result.stdout, ctx);
      }
    }

    // pip-audit (Python).
    if (await this.fileExists('requirements.txt', ctx) || await this.fileExists('pyproject.toml', ctx)) {
      const result = await this.runShell('pip-audit --format json 2>/dev/null || true', ctx);
      if (result.success && result.stdout) {
        this.parsePipAudit(result.stdout, ctx);
      }
    }

    // cargo audit (Rust).
    if (await this.fileExists('Cargo.toml', ctx)) {
      const result = await this.runShell('cargo audit --json 2>/dev/null || true', ctx);
      if (result.success && result.stdout) {
        this.parseCargoAudit(result.stdout, ctx);
      }
    }

    // go vet (Go — limited, but flags obvious issues).
    if (await this.fileExists('go.mod', ctx)) {
      const result = await this.runShell('go vet ./... 2>&1 || true', ctx);
      if (result.success && result.stdout) {
        this.parseGoVet(result.stdout, ctx);
      }
    }
  }

  /**
   * Parse `npm audit --json` output and emit one finding per advisory.
   */
  private parseNpmAudit(stdout: string, ctx: RunContext): void {
    let audit: unknown;
    try {
      audit = JSON.parse(stdout);
    } catch {
      return;
    }
    const vulns = (audit as { vulnerabilities?: Record<string, unknown> })?.vulnerabilities;
    if (!vulns || typeof vulns !== 'object') return;
    for (const [pkg, info] of Object.entries(vulns as Record<string, unknown>)) {
      const v = info as {
        severity?: string;
        via?: Array<{ title?: string; url?: string; cwe?: string[] } | string>;
        fixAvailable?: boolean | { name?: string };
      };
      const severity = this.normalizeSeverity(v.severity);
      const via = Array.isArray(v.via) ? v.via.find((x) => typeof x === 'object') : undefined;
      const advisory = via as { title?: string; url?: string; cwe?: string[] } | undefined;
      const cwe = advisory?.cwe?.[0] ?? 'CWE-1035'; // CWE-1035 = outdated dependency
      this.addFinding(ctx, {
        severity,
        category: cwe,
        title: `npm: ${pkg} — ${(v.severity ?? 'unknown')} vulnerability`,
        description:
          `Package \`${pkg}\` has a known vulnerability. ` +
          (advisory?.title ? `Advisory: ${advisory.title}. ` : '') +
          (advisory?.url ? `See ${advisory.url}. ` : '') +
          (v.fixAvailable ? 'A fix is available — upgrade below.' : 'No fix available yet — consider replacing the package.'),
        file: 'package.json',
        suggestion: v.fixAvailable
          ? `Run \`npm audit fix\` to auto-patch, or \`npm install ${pkg}@latest\` to upgrade.`
          : `No upstream fix — pin to a safe version or replace \`${pkg}\` with a maintained alternative.`,
        autoFixable: !!v.fixAvailable,
        tags: ['OWASP-A6', 'dependency', cwe],
      });
    }
  }

  /**
   * Parse `pip-audit --format json` output.
   */
  private parsePipAudit(stdout: string, ctx: RunContext): void {
    let audit: unknown;
    try {
      audit = JSON.parse(stdout);
    } catch {
      return;
    }
    const deps = (audit as { dependencies?: Array<Record<string, unknown>> })?.dependencies;
    if (!Array.isArray(deps)) return;
    for (const dep of deps) {
      const name = String(dep.name ?? 'unknown');
      const version = String(dep.version ?? '?');
      const vulns = Array.isArray(dep.vulns) ? dep.vulns : [];
      for (const v of vulns) {
        const vv = v as { id?: string; description?: string; fix_versions?: string[]; cwe?: string[] };
        const cwe = vv.cwe?.[0] ?? 'CWE-1035';
        this.addFinding(ctx, {
          severity: 'high',
          category: cwe,
          title: `pip: ${name}@${version} — ${vv.id ?? 'vuln'}`,
          description:
            `Python dependency \`${name}==${version}\` has a known vulnerability (${vv.id ?? 'n/a'}). ` +
            (vv.description ? vv.description + ' ' : '') +
            (vv.fix_versions?.length ? `Fixed in: ${vv.fix_versions.join(', ')}.` : 'No fix version listed.'),
          file: 'requirements.txt',
          suggestion: vv.fix_versions?.length
            ? `Upgrade: \`pip install "${name}>=${vv.fix_versions[0]}"\` and pin in requirements.txt.`
            : 'No upstream fix — replace the package or pin a workaround.',
          autoFixable: !!vv.fix_versions?.length,
          tags: ['OWASP-A6', 'dependency', cwe],
        });
      }
    }
  }

  /**
   * Parse `cargo audit --json` output.
   */
  private parseCargoAudit(stdout: string, ctx: RunContext): void {
    let audit: unknown;
    try {
      audit = JSON.parse(stdout);
    } catch {
      return;
    }
    const vulns = (audit as { vulnerabilities?: { list?: Array<Record<string, unknown>> } })?.vulnerabilities?.list;
    if (!Array.isArray(vulns)) return;
    for (const v of vulns) {
      const advisory = v.advisory as { id?: string; title?: string; url?: string; cwe?: string } | undefined;
      const pkg = v.package as { name?: string; version?: string } | undefined;
      const patched = v.versions as { patched?: string[] } | undefined;
      const cwe = advisory?.cwe ?? 'CWE-1035';
      this.addFinding(ctx, {
        severity: 'high',
        category: cwe,
        title: `cargo: ${pkg?.name ?? '?'}@${pkg?.version ?? '?'} — ${advisory?.id ?? 'advisory'}`,
        description:
          `Rust crate \`${pkg?.name ?? '?'}@${pkg?.version ?? '?'}\` has a known vulnerability. ` +
          (advisory?.title ? `Title: ${advisory.title}. ` : '') +
          (advisory?.url ? `See ${advisory.url}. ` : '') +
          (patched?.patched?.length ? `Fixed in: ${patched.patched.join(', ')}.` : ''),
        file: 'Cargo.toml',
        suggestion: patched?.patched?.length
          ? `Update Cargo.toml: \`${pkg?.name} = "${patched.patched[0]}"\`, then \`cargo update\`.`
          : 'No upstream fix — replace the crate or apply a workaround.',
        autoFixable: !!patched?.patched?.length,
        tags: ['OWASP-A6', 'dependency', cwe],
      });
    }
  }

  /**
   * Parse `go vet ./...` output — best-effort, line-by-line.
   */
  private parseGoVet(stdout: string, ctx: RunContext): void {
    for (const line of stdout.split('\n')) {
      const m = /^#?\s*(\S+\.go):(\d+):(\d+):\s*(.+)$/i.exec(line);
      if (!m) continue;
      const [, file, lineStr, , message] = m;
      this.addFinding(ctx, {
        severity: 'low',
        category: 'CWE-1035',
        title: `go vet: ${file}:${lineStr}`,
        description: `Go vet flagged: ${message}`,
        file,
        line: parseInt(lineStr, 10),
        suggestion: 'Address the vet warning — usually a code smell that may have security implications.',
        autoFixable: false,
        tags: ['OWASP-A6', 'dependency', 'go-vet'],
      });
    }
  }

  // ── 4) Config scan ─────────────────────────────────────────────────────────

  private static readonly CONFIG_PATTERNS: ReadonlyArray<{
    name: string;
    cwe: string;
    severity: AgentFinding['severity'];
    pattern: RegExp;
    fix: string;
  }> = [
    {
      name: 'CORS allow-all',
      cwe: 'CWE-942',
      severity: 'high',
      pattern: /\baccess-control-allow-origin\s*[:=]\s*['"`]\*['"`]|cors\(\s*\{\s*origin\s*:\s*['"`]\*['"`]/gi,
      fix: 'Replace `*` with an allowlist of trusted origins. Reflect the request Origin only if it matches the allowlist.',
    },
    {
      name: 'Missing Content-Security-Policy',
      cwe: 'CWE-1021',
      severity: 'medium',
      pattern: /<meta\s+http-equiv=["']Content-Security-Policy["']/i,
      fix: 'Add a strict CSP header: `default-src \'self\'; script-src \'self\'`. Useful even when present — verify it is non-trivial.',
    },
    {
      name: 'Debug mode enabled',
      cwe: 'CWE-489',
      severity: 'high',
      pattern: /\b(?:debug\s*[:=]\s*true|app\.debug\s*=\s*true|DEBUG\s*=\s*True|NODE_ENV\s*[:=]\s*['"]development['"])/g,
      fix: 'Set debug=false in production. Read from NODE_ENV / APP_ENV; never commit `debug: true` defaults.',
    },
    {
      name: 'allowInsecureHTTP enabled',
      cwe: 'CWE-319',
      severity: 'high',
      pattern: /\ballowInsecureHTTP\s*:\s*true|secure\s*:\s*false\b/gi,
      fix: 'Set `secure: true` for cookies / sessions over HTTPS. Never set `allowInsecureHTTP: true` in production.',
    },
    {
      name: 'TLS verification disabled',
      cwe: 'CWE-295',
      severity: 'critical',
      pattern: /\brejectUnauthorized\s*:\s*false|verify\s*=\s*False|ssl\.verify\s*=\s*False|insecure\s*=\s*true|checkServerIdentity\s*:\s*\(\s*\)\s*=>\s*\{\s*\}/gi,
      fix: 'Remove the override. If the cert is self-signed, add the CA to the trust store instead of disabling verification.',
    },
    {
      name: 'Helmet disabled',
      cwe: 'CWE-693',
      severity: 'low',
      pattern: /\bhelmet\.contentSecurityPolicy\s*\(\s*false\s*\)|app\.disable\(['"]helmet['"]\)/gi,
      fix: 'Re-enable Helmet middleware. CSP and HSTS are cheap, effective protections.',
    },
  ];

  private async scanConfigs(ctx: RunContext): Promise<void> {
    this.emitProgress('analyze', 'Phase 4: insecure-configuration scan…', undefined, ctx);
    let scanned = 0;
    await this.scanFiles(ctx, async (filePath, content) => {
      scanned++;
      for (const def of SecuritySentinel.CONFIG_PATTERNS) {
        const matches = this.searchInFile(content, def.pattern);
        for (const m of matches) {
          this.addFinding(ctx, {
            severity: def.severity,
            category: def.cwe,
            title: `${def.name} in ${this.rel(filePath, ctx)}:${m.line}`,
            description:
              `Configuration issue (${def.cwe}) detected at \`${this.rel(filePath, ctx)}:${m.line}\`. ` +
              `Misconfigured security headers / TLS weaken the app's defense-in-depth and are often exploitable.`,
            file: this.rel(filePath, ctx),
            line: m.line,
            snippet: this.snippetAround(content, m.line, 2),
            suggestion: def.fix,
            autoFixable: true,
            tags: ['OWASP-A5', 'config', def.cwe],
          });
        }
      }
    });
    this.recordMetric(ctx, 'configScannedFiles', scanned, 'set');
  }

  // ── 5) Crypto scan ─────────────────────────────────────────────────────────

  private static readonly CRYPTO_PATTERNS: ReadonlyArray<{
    name: string;
    cwe: string;
    severity: AgentFinding['severity'];
    pattern: RegExp;
    fix: string;
  }> = [
    {
      name: 'MD5 used for password hashing',
      cwe: 'CWE-327',
      severity: 'critical',
      pattern: /\b(?:md5|hashlib\.md5)\s*\(/gi,
      fix: 'Use bcrypt, scrypt, or argon2 for password hashing. MD5 is broken for any security-sensitive purpose.',
    },
    {
      name: 'SHA1 used for password hashing',
      cwe: 'CWE-327',
      severity: 'high',
      pattern: /\b(?:sha1|hashlib\.sha1)\s*\(/gi,
      fix: 'Use bcrypt / argon2 / scrypt. SHA1 is broken for password hashing — fast and un Salted in most usages.',
    },
    {
      name: 'ECB cipher mode',
      cwe: 'CWE-327',
      severity: 'critical',
      pattern: /\bECB\b|\bcrypto\.createCipher(?:iv)?\s*\(\s*['"]aes-\d+-ecb['"]/gi,
      fix: 'Use GCM or CBC mode with a random IV. ECB leaks plaintext patterns — never use it.',
    },
    {
      name: 'Hardcoded IV (initialization vector)',
      cwe: 'CWE-329',
      severity: 'high',
      pattern: /\biv\s*[:=]\s*['"][A-Za-z0-9+/=]{16,}['"]|nonce\s*[:=]\s*['"][A-Za-z0-9+/=]{12,}['"]/gi,
      fix: 'Generate a fresh random IV per encryption with crypto.randomBytes(12). Never reuse IVs with the same key.',
    },
    {
      name: 'Math.random() used for security',
      cwe: 'CWE-338',
      severity: 'high',
      pattern: /\bMath\.random\s*\(\s*\)/g,
      fix: 'Use crypto.getRandomValues() (browser) or crypto.randomBytes() (node) for any security-sensitive randomness.',
    },
    {
      name: 'Short crypto key length',
      cwe: 'CWE-326',
      severity: 'medium',
      pattern: /\bcreate(?:Secret|Hash|Cipher)(?:iv)?\s*\(\s*['"]aes-(?:128|192)['"]|\brsa\s*:\s*\{\s*modulusLength\s*:\s*(?:512|1024|2048)/gi,
      fix: 'Use AES-256 or RSA-3072+. NIST deprecates AES-128 for new long-lived data and <2048-bit RSA is broken.',
    },
  ];

  private async scanCrypto(ctx: RunContext): Promise<void> {
    this.emitProgress('analyze', 'Phase 5: cryptographic-weakness scan…', undefined, ctx);
    let scanned = 0;
    await this.scanFiles(ctx, async (filePath, content) => {
      scanned++;
      for (const def of SecuritySentinel.CRYPTO_PATTERNS) {
        const matches = this.searchInFile(content, def.pattern);
        for (const m of matches) {
          this.addFinding(ctx, {
            severity: def.severity,
            category: def.cwe,
            title: `${def.name} in ${this.rel(filePath, ctx)}:${m.line}`,
            description:
              `Cryptographic weakness (${def.cwe}) at \`${this.rel(filePath, ctx)}:${m.line}\`. ` +
              `Weak crypto undermines every other layer of defense — attackers can recover plaintext, ` +
              `forge tokens, or predict "random" output.`,
            file: this.rel(filePath, ctx),
            line: m.line,
            snippet: this.snippetAround(content, m.line, 2),
            suggestion: def.fix,
            autoFixable: false,
            tags: ['OWASP-A2', 'crypto', def.cwe],
          });
        }
      }
    });
    this.recordMetric(ctx, 'cryptoScannedFiles', scanned, 'set');
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Heuristic: is this file a test / fixture / example? Secrets in
   * such files are usually placeholders, not real leaks.
   */
  private isTestOrFixture(filePath: string): boolean {
    return /(^|[\\/])(tests?|__tests__|test|spec|specs|fixtures?|examples?|samples?|mocks?)([\\/]|$)|\.(test|spec)\.[a-z]+$|\.fixtures?\.[a-z]+$/i.test(
      filePath,
    );
  }

  /**
   * Convert an absolute path to one relative to the run's cwd (so
   * findings show `src/auth.ts:42` instead of
   * `/Users/.../repo/src/auth.ts:42`).
   */
  private rel(absPath: string, ctx: RunContext): string {
    return path.relative(ctx.opts.cwd, absPath) || absPath;
  }

  /**
   * Build a multi-line snippet around `lineNo` (1-indexed). Returns the
   * snippet with line-number prefixes for readability.
   */
  private snippetAround(content: string, lineNo: number, padding: number): string {
    const lines = content.split('\n');
    const start = Math.max(0, lineNo - 1 - padding);
    const end = Math.min(lines.length, lineNo + padding);
    return lines
      .slice(start, end)
      .map((ln, i) => `${start + i + 1}: ${ln}`)
      .join('\n');
  }

  /**
   * Map npm/pip severity strings to the AgentFinding severity union.
   */
  private normalizeSeverity(input: string | undefined): AgentFinding['severity'] {
    switch ((input ?? '').toLowerCase()) {
      case 'critical':
        return 'critical';
      case 'high':
        return 'high';
      case 'moderate':
      case 'medium':
        return 'medium';
      case 'low':
        return 'low';
      default:
        return 'info';
    }
  }

  /**
   * Check if a file exists relative to the run's cwd.
   */
  private async fileExists(relPath: string, ctx: RunContext): Promise<boolean> {
    try {
      const abs = path.resolve(ctx.opts.cwd, relPath);
      await fs.access(abs);
      return true;
    } catch {
      return false;
    }
  }
}
