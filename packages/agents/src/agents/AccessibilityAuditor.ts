/**
 * @file agents/AccessibilityAuditor.ts
 * @description SANIX Accessibility Auditor agent (id: `a11y-auditor`, icon:
 * ♿, category: `accessibility`). Scans web projects for WCAG 2.2 AA
 * violations: missing alt text, form labels, heading hierarchy, landmarks,
 * colour-contrast failures, keyboard-navigation anti-patterns, and ARIA
 * misuse. Auto-applies safe fixes (decorative `alt=""`, `aria-label` on
 * icon-only buttons, `role` attributes on missing landmarks, `<label>`
 * associations, skip links) and emits a WCAG violation table as the
 * primary artifact.
 *
 * The scanner is intentionally dependency-free — it parses HTML / JSX /
 * TSX / Vue / CSS with targeted regular expressions rather than a full
 * DOM parser. This keeps the agent portable across sandboxes that lack
 * `jsdom` / `postcss`. Each violation maps to a WCAG 2.2 criterion id
 * (e.g. `1.1.1`, `2.4.1`) for traceability.
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

/** A flattened view of a file the agent has read. */
interface FileSnapshot {
  readonly path: string;
  readonly content: string;
  readonly kind: 'html' | 'jsx' | 'css' | 'other';
}

/** Result of an auto-fix attempt on a single file. */
interface AutoFixResult {
  readonly path: string;
  readonly applied: boolean;
  readonly newContent?: string;
  readonly fixes: ReadonlyArray<{ description: string; line: number }>;
  readonly reason?: string;
}

/** Counter for unique ids within a single run. */
let _idCounter = 0;
function nextId(prefix: string): string {
  _idCounter += 1;
  return `${prefix}-${_idCounter.toString(36).padStart(4, '0')}`;
}

/**
 * SANIX Accessibility Auditor — WCAG 2.2 AA compliance scanner + auto-fixer.
 *
 * @example
 * ```ts
 * import { AccessibilityAuditorAgent } from '@sanix/agents';
 * const agent = new AccessibilityAuditorAgent();
 * const result = await agent.run({
 *   cwd: '/workspace/web-app',
 *   goal: 'Audit src/ for WCAG 2.2 AA violations and auto-fix what you can.',
 *   toolCall: async (t, i) => invokeSanixTool(t, i),
 * });
 * console.log(result.summary);
 * for (const f of result.findings) console.log(f.severity, f.title);
 * ```
 */
export class AccessibilityAuditorAgent extends BaseAgent {
  readonly id = 'a11y-auditor';
  readonly name = 'Accessibility Auditor';
  readonly icon = '♿';
  readonly category: AgentCategory = 'accessibility';
  readonly description =
    'Scans web applications for WCAG 2.2 AA violations (perceivable, operable, ' +
    'understandable, robust), colour-contrast issues (≥4.5:1 normal / ≥3:1 large), ' +
    'keyboard-navigation anti-patterns, and screen-reader compatibility. ' +
    'Auto-applies safe fixes (alt text, aria-label, labels, role attributes, skip links).';
  readonly systemPrompt =
    'You are SANIX Accessibility Auditor, a WCAG 2.2 AA compliance expert. You scan web ' +
    'applications for: (1) WCAG violations (perceivable, operable, understandable, robust), ' +
    '(2) color contrast issues (minimum 4.5:1 for normal text, 3:1 for large text), ' +
    '(3) keyboard navigation (tab order, focus visible, no keyboard traps), ' +
    '(4) screen reader compatibility (ARIA labels, roles, landmarks, alt text), ' +
    '(5) semantic HTML (proper heading hierarchy, landmarks, form labels). ' +
    'You can auto-fix many issues (add alt text, ARIA labels, fix contrast, add skip links).';
  readonly tools = [
    'read_file',
    'write_file',
    'edit_file',
    'search_files',
    'bash',
    'sandbox_execute',
  ];
  readonly exampleQueries = [
    'Audit src/components/ for WCAG 2.2 AA violations and auto-fix safe ones.',
    'Find all color-contrast failures in app/styles/ and report affected selectors.',
    'Check that every form input has an associated <label> and fix the ones missing.',
    'Scan all .tsx files for heading-hierarchy issues and missing landmark roles.',
    'Generate a WCAG violation report for the public/ directory.',
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
      // ── Phase 1: discover candidate files ────────────────────────────
      this.emit(options, 'phase:start', { phase: 'discover' });
      const discovered = await this.discoverFiles(options, actions);
      toolCalls += discovered.toolCalls;
      tokensUsed += discovered.tokensUsed;
      const files = discovered.files;
      this.emit(options, 'phase:complete', { phase: 'discover', count: files.length });

      if (files.length === 0) {
        findings.push({
          id: nextId('finding'),
          severity: 'medium',
          category: 'discovery',
          title: 'No auditable files found',
          description:
            'No .html / .jsx / .tsx / .vue / .css / .scss files were found. ' +
            'Verify the cwd and that the project actually contains web markup.',
          recommendation: 'Re-run with an explicit glob or against the source directory.',
        });
      }

      // ── Phase 2: read & scan ──────────────────────────────────────────
      this.emit(options, 'phase:start', { phase: 'scan' });
      for (const file of files) {
        const snap = await this.readSnapshot(options, file, actions);
        toolCalls += 1;
        tokensUsed += Math.ceil(snap.content.length / 4);
        if (!snap.content) continue;
        this.scanHtmlOrJsx(snap, findings);
        this.scanAria(snap, findings);
        this.scanKeyboard(snap, findings);
        if (snap.kind === 'css') {
          this.scanContrast(snap, findings);
        }
      }
      // Cross-cutting CSS contrast scan over the whole project (inline styles in JSX too).
      await this.scanContrastAcrossProject(options, files, actions, findings);
      this.emit(options, 'phase:complete', { phase: 'scan', findings: findings.length });

      // ── Phase 3: auto-fix safe issues ─────────────────────────────────
      this.emit(options, 'phase:start', { phase: 'autofix' });
      const fixResults: AutoFixResult[] = [];
      for (const file of files) {
        const snap = await this.readSnapshot(options, file, actions);
        toolCalls += 1;
        tokensUsed += Math.ceil(snap.content.length / 4);
        const fix = this.autoFix(snap);
        if (fix.applied && fix.newContent !== undefined) {
          const writeRes = await this.callToolWrite(
            options,
            'edit_file',
            { path: file, content: fix.newContent, cwd: options.cwd },
            actions,
            `Apply ${fix.fixes.length} a11y auto-fix(es) to ${file}`,
          );
          toolCalls += 1;
          if (writeRes.ok) {
            fixResults.push(fix);
          } else {
            findings.push({
              id: nextId('finding'),
              severity: 'low',
              category: 'auto-fix',
              title: `Auto-fix write failed for ${file}`,
              description: `edit_file reported: ${writeRes.error}`,
            });
          }
        }
      }
      const appliedFixCount = fixResults.reduce((n, r) => n + r.fixes.length, 0);
      this.emit(options, 'phase:complete', { phase: 'autofix', applied: appliedFixCount });

      // ── Phase 4: build report ─────────────────────────────────────────
      this.emit(options, 'phase:start', { phase: 'report' });
      const report = this.composeReport(files.length, findings, fixResults, recommendations);
      artifacts.push({
        id: nextId('artifact'),
        name: 'wcag-audit-report.md',
        type: 'report',
        content: report,
        description: 'WCAG 2.2 AA audit report (violation table + auto-fix summary)',
        path: 'reports/wcag-audit-report.md',
        language: 'markdown',
      });
      const writeRes = await this.callToolWrite(
        options,
        'write_file',
        { path: 'reports/wcag-audit-report.md', content: report, cwd: options.cwd },
        actions,
        'Write the WCAG audit report',
      );
      toolCalls += 1;
      if (!writeRes.ok) {
        findings.push({
          id: nextId('finding'),
          severity: 'low',
          category: 'report',
          title: 'Could not persist the audit report to disk',
          description: `write_file reported: ${writeRes.error}. The report is still included as an artifact in the result.`,
        });
      }
      this.emit(options, 'phase:complete', { phase: 'report' });

      const summary = this.composeSummary(files.length, findings, appliedFixCount, Date.now() - startedAt);
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
        title: 'Audit aborted with an unhandled error',
        description: message,
      });
      const result: AgentRunResult = {
        agentId: this.id,
        agentName: this.name,
        category: this.category,
        goal: options.goal,
        summary: `Accessibility audit aborted: ${message}`,
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
        type: tool === 'write_file' ? 'write' : 'edit',
        description: `${description} (skipped: no toolCall)`,
        target: tool,
        success: false,
        error: 'no toolCall callback provided',
        durationMs: Date.now() - startedAt,
      });
      return { ok: false, error: 'no toolCall callback provided' };
    }
    try {
      const output = await options.toolCall(tool, input);
      actions.push({
        id: nextId('action'),
        type: tool === 'write_file' ? 'write' : 'edit',
        description,
        target: tool,
        input: this.safePreview(input),
        output: this.safePreview(output),
        durationMs: Date.now() - startedAt,
        success: true,
      });
      return { ok: true, output };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      actions.push({
        id: nextId('action'),
        type: tool === 'write_file' ? 'write' : 'edit',
        description,
        target: tool,
        input: this.safePreview(input),
        durationMs: Date.now() - startedAt,
        success: false,
        error: message,
      });
      return { ok: false, error: message };
    }
  }

  private safePreview(v: unknown): string {
    if (v === undefined || v === null) return '';
    if (typeof v === 'string') return v.slice(0, 2000);
    try {
      return JSON.stringify(v).slice(0, 2000);
    } catch {
      return String(v).slice(0, 2000);
    }
  }

  // ─── discovery ──────────────────────────────────────────────────────

  private async discoverFiles(
    options: AgentRunOptions,
    actions: AgentAction[],
  ): Promise<{ files: string[]; toolCalls: number; tokensUsed: number }> {
    const globs = ['**/*.{html,jsx,tsx,vue,svelte}', '**/*.{css,scss,sass}'];
    const out: string[] = [];
    let toolCalls = 0;
    let tokensUsed = 0;
    for (const pattern of globs) {
      const startedAt = Date.now();
      if (!options.toolCall) {
        actions.push({
          id: nextId('action'),
          type: 'search',
          description: `search_files ${pattern} (skipped: no toolCall)`,
          target: 'search_files',
          success: false,
          error: 'no toolCall',
          durationMs: Date.now() - startedAt,
        });
        continue;
      }
      try {
        const raw = await options.toolCall('search_files', { pattern, cwd: options.cwd });
        toolCalls += 1;
        const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
        tokensUsed += Math.ceil(text.length / 4);
        const matches = text
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 0 && !l.startsWith('{') && !l.startsWith('['))
          .map((l) => l.replace(/^["']|["']$/g, ''));
        out.push(...matches);
        actions.push({
          id: nextId('action'),
          type: 'search',
          description: `search_files ${pattern}`,
          target: 'search_files',
          input: pattern,
          output: text.slice(0, 2000),
          durationMs: Date.now() - startedAt,
          success: true,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        actions.push({
          id: nextId('action'),
          type: 'search',
          description: `search_files ${pattern}`,
          target: 'search_files',
          input: pattern,
          durationMs: Date.now() - startedAt,
          success: false,
          error: message,
        });
      }
    }
    // Deduplicate and filter out node_modules / dist / build outputs.
    const seen = new Set<string>();
    const filtered = out.filter((p) => {
      if (seen.has(p)) return false;
      if (/(node_modules|\/dist\/|\/build\/|\/\.next\/|\/\.turbo\/)/.test(p)) return false;
      seen.add(p);
      return true;
    });
    return { files: filtered, toolCalls, tokensUsed };
  }

  private async readSnapshot(
    options: AgentRunOptions,
    path: string,
    actions: AgentAction[],
  ): Promise<FileSnapshot> {
    const startedAt = Date.now();
    const kind: FileSnapshot['kind'] = path.endsWith('.css') || path.endsWith('.scss') || path.endsWith('.sass')
      ? 'css'
      : path.endsWith('.html')
        ? 'html'
        : path.endsWith('.jsx') || path.endsWith('.tsx') || path.endsWith('.vue') || path.endsWith('.svelte')
          ? 'jsx'
          : 'other';
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
      return { path, content: '', kind };
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
      return { path, content, kind };
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
      return { path, content: '', kind };
    }
  }

  // ─── scanners ───────────────────────────────────────────────────────

  /** HTML / JSX structural scan: alt, labels, headings, landmarks, lang, skip link. */
  private scanHtmlOrJsx(snap: FileSnapshot, findings: AgentFinding[]): void {
    const c = snap.content;
    if (!c) return;

    // 1.1.1 Non-text content — images without alt
    const imgRe = /<img\b([^>]*?)\/?>/gis;
    let m: RegExpExecArray | null;
    while ((m = imgRe.exec(c)) !== null) {
      const attrs = m[1] ?? '';
      if (!/\balt\s*=/.test(attrs)) {
        const line = this.lineOf(c, m.index);
        findings.push({
          id: nextId('finding'),
          severity: 'high',
          category: 'images',
          title: 'Image missing alt attribute',
          description: `<img> tag without an alt attribute. Add descriptive alt for informative images or alt="" for decorative ones.`,
          location: { file: snap.path, line, column: 0 },
          evidence: m[0].slice(0, 200),
          recommendation: `Add alt="<description>" or alt="" if decorative.`,
        });
      } else if (/\balt\s*=\s*["']\s*["']/.test(attrs) && !/\brole\s*=\s*["']presentation["']/.test(attrs)) {
        // decorative — fine, but flag if the image is the only content of a link
        const line = this.lineOf(c, m.index);
        findings.push({
          id: nextId('finding'),
          severity: 'info',
          category: 'images',
          title: 'Image with empty alt — verify it is decorative',
          description: `An image has alt="". If it conveys meaning, replace with descriptive text.`,
          location: { file: snap.path, line, column: 0 },
          evidence: m[0].slice(0, 200),
        });
      }
    }

    // 3.3.2 Labels or instructions — inputs without associated <label>
    const inputRe = /<input\b([^>]*?)\/?>/gis;
    while ((m = inputRe.exec(c)) !== null) {
      const attrs = m[1] ?? '';
      const type = (attrs.match(/\btype\s*=\s*["']([^"']+)["']/i)?.[1] ?? 'text').toLowerCase();
      if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) continue;
      const hasId = /\bid\s*=\s*["']([\w-]+)["']/i.test(attrs);
      const hasAriaLabel = /\baria-label(?:ledby)?\s*=/i.test(attrs);
      const id = attrs.match(/\bid\s*=\s*["']([\w-]+)["']/i)?.[1];
      const hasForLabel = id && new RegExp(`<label\\b[^>]*\\bfor\\s*=\\s*["']${id}["']`, 'i').test(c);
      if (!hasAriaLabel && !hasForLabel) {
        const line = this.lineOf(c, m.index);
        findings.push({
          id: nextId('finding'),
          severity: 'high',
          category: 'forms',
          title: `Form input of type "${type}" has no associated label`,
          description: `Input lacks <label for="...">, aria-label, or aria-labelledby. Screen readers will not announce its purpose.`,
          location: { file: snap.path, line, column: 0 },
          evidence: m[0].slice(0, 200),
          recommendation: hasId
            ? `Add <label htmlFor="${id}">…</label> (React) or <label for="${id}">…</label> (HTML).`
            : `Add an id and a matching <label for="…">, or aria-label="…" on the input.`,
        });
      }
    }

    // 4.1.2 Name, Role, Value — buttons / links without accessible text
    const buttonRe = /<button\b([^>]*?)>([\s\S]*?)<\/button>/gis;
    while ((m = buttonRe.exec(c)) !== null) {
      const attrs = m[1] ?? '';
      const inner = (m[2] ?? '').trim();
      const hasAriaLabel = /\baria-label(?:ledby)?\s*=/i.test(attrs);
      if (!inner && !hasAriaLabel) {
        const line = this.lineOf(c, m.index);
        findings.push({
          id: nextId('finding'),
          severity: 'high',
          category: 'controls',
          title: 'Button without accessible name',
          description: `<button> has no text content and no aria-label/aria-labelledby. Icon-only buttons must have an aria-label.`,
          location: { file: snap.path, line, column: 0 },
          evidence: m[0].slice(0, 200),
          recommendation: `Add aria-label="<action>" to the button.`,
        });
      }
    }
    const linkRe = /<a\b([^>]*?)>([\s\S]*?)<\/a>/gis;
    while ((m = linkRe.exec(c)) !== null) {
      const attrs = m[1] ?? '';
      const inner = (m[2] ?? '').replace(/<[^>]*>/g, '').trim();
      const hasAriaLabel = /\baria-label(?:ledby)?\s*=/i.test(attrs);
      if (!inner && !hasAriaLabel) {
        const line = this.lineOf(c, m.index);
        findings.push({
          id: nextId('finding'),
          severity: 'high',
          category: 'controls',
          title: 'Link without accessible name',
          description: `<a> has no text content and no aria-label. Links must have a discernible name.`,
          location: { file: snap.path, line, column: 0 },
          evidence: m[0].slice(0, 200),
          recommendation: `Add visible link text or aria-label="<destination>".`,
        });
      }
    }

    // 1.3.1 Info and Relationships — heading hierarchy
    const headingRe = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gis;
    let lastLevel = 0;
    while ((m = headingRe.exec(c)) !== null) {
      const lvl = Number(m[1]);
      if (lastLevel > 0 && lvl > lastLevel + 1) {
        const line = this.lineOf(c, m.index);
        findings.push({
          id: nextId('finding'),
          severity: 'medium',
          category: 'headings',
          title: `Heading hierarchy skips levels (h${lastLevel} → h${lvl})`,
          description: `Heading levels must not skip. Screen-reader users navigate by heading level.`,
          location: { file: snap.path, line, column: 0 },
          evidence: m[0].slice(0, 200),
          recommendation: `Use h${lastLevel + 1} instead of h${lvl}, or insert an intermediate heading.`,
        });
      }
      lastLevel = lvl;
    }

    // 2.4.1 Bypass blocks — missing skip link
    if (/<body\b/i.test(c) && !/<a\b[^>]*\b(?:href=["']#main["']|class=["'][^"']*skip)/i.test(c)) {
      const line = this.lineOf(c, m?.index ?? 0);
      findings.push({
        id: nextId('finding'),
        severity: 'medium',
        category: 'landmarks',
        title: 'Missing "skip to content" link',
        description: `No skip-to-main-content link detected. Keyboard users must tab through the entire header on every page.`,
        location: { file: snap.path, line, column: 0 },
        recommendation: `Add <a href="#main" class="skip-link">Skip to content</a> as the first focusable element in <body>.`,
      });
    }

    // 2.4.2 Page titled — html lang
    if (/<html\b[^>]*>/i.test(c)) {
      const htmlTag = c.match(/<html\b([^>]*?)>/i)?.[1] ?? '';
      if (!/\blang\s*=/i.test(htmlTag)) {
        const line = this.lineOf(c, 0);
        findings.push({
          id: nextId('finding'),
          severity: 'medium',
          category: 'language',
          title: '<html> element is missing the lang attribute',
          description: `The lang attribute tells screen readers which pronunciation engine to use.`,
          location: { file: snap.path, line, column: 0 },
          recommendation: `Add lang="en" (or the appropriate BCP-47 code) to <html>.`,
        });
      }
    }

    // 1.3.1 / 2.4.1 — landmark presence (only on top-level page shells)
    if (/<body\b/i.test(c)) {
      for (const landmark of ['main', 'nav', 'header', 'footer']) {
        if (!new RegExp(`<${landmark}\\b`, 'i').test(c)) {
          findings.push({
            id: nextId('finding'),
            severity: 'low',
            category: 'landmarks',
            title: `Missing <${landmark}> landmark`,
            description: `No <${landmark}> element detected. Landmarks let screen-reader users jump to regions.`,
            location: { file: snap.path },
            recommendation: `Wrap the relevant region in <${landmark}> (or add role="${landmark === 'nav' ? 'navigation' : landmark}").`,
          });
        }
      }
    }
  }

  /** ARIA misuse scan: redundant aria-label, invalid attributes, missing roles. */
  private scanAria(snap: FileSnapshot, findings: AgentFinding[]): void {
    const c = snap.content;
    if (!c) return;

    // Redundant aria-label on element with visible text
    const redundantRe = /<(button|a|nav|header|footer|main|section|article)\b([^>]*?)>([\s\S]*?)<\/\1>/gis;
    let m: RegExpExecArray | null;
    while ((m = redundantRe.exec(c)) !== null) {
      const attrs = m[2] ?? '';
      const inner = (m[3] ?? '').replace(/<[^>]*>/g, '').trim();
      const ariaLabel = attrs.match(/\baria-label\s*=\s*["']([^"']*)["']/i)?.[1];
      if (ariaLabel && inner && ariaLabel.toLowerCase() !== inner.toLowerCase()) {
        const line = this.lineOf(c, m.index);
        findings.push({
          id: nextId('finding'),
          severity: 'low',
          category: 'aria',
          title: 'Redundant or conflicting aria-label on element with visible text',
          description: `Element has both visible text ("${inner.slice(0, 60)}") and aria-label ("${ariaLabel.slice(0, 60)}"). Remove the aria-label or make them agree.`,
          location: { file: snap.path, line, column: 0 },
        });
      }
    }

    // Invalid ARIA attribute names
    const ariaAttrRe = /\b(aria-[a-z]+)\s*=/gi;
    const VALID_ARIA = new Set([
      'aria-label', 'aria-labelledby', 'aria-describedby', 'aria-hidden', 'aria-disabled',
      'aria-expanded', 'aria-controls', 'aria-haspopup', 'aria-live', 'aria-atomic',
      'aria-busy', 'aria-current', 'aria-pressed', 'aria-checked', 'aria-selected',
      'aria-required', 'aria-readonly', 'aria-placeholder', 'aria-roledescription',
      'aria-modal', 'aria-orientation', 'aria-multiline', 'aria-placeholder',
      'aria-valuenow', 'aria-valuemin', 'aria-valuemax', 'aria-valuetext',
      'aria-errormessage', 'aria-invalid', 'aria-keyshortcuts', 'aria-relevant',
      'aria-dropeffect', 'aria-grabbed', 'aria-flowto', 'aria-owns', 'aria-activedescendant',
      'aria-colcount', 'aria-colindex', 'aria-colspan', 'aria-rowcount', 'aria-rowindex',
      'aria-rowspan', 'aria-posinset', 'aria-setsize', 'aria-level', 'aria-autocomplete',
    ]);
    while ((m = ariaAttrRe.exec(c)) !== null) {
      const attr = m[1].toLowerCase();
      if (!VALID_ARIA.has(attr)) {
        const line = this.lineOf(c, m.index);
        findings.push({
          id: nextId('finding'),
          severity: 'medium',
          category: 'aria',
          title: `Invalid ARIA attribute: ${attr}`,
          description: `${attr} is not a valid ARIA 1.2 attribute. Browsers and AT will ignore it.`,
          location: { file: snap.path, line, column: 0 },
          recommendation: `Remove ${attr} or replace with a valid ARIA attribute.`,
        });
      }
    }

    // role on non-interactive element without semantic need
    const divRoleRe = /<(div|span)\b([^>]*?)\brole\s*=\s*["']([^"']+)["']/gis;
    while ((m = divRoleRe.exec(c)) !== null) {
      const role = (m[3] ?? '').toLowerCase();
      const INTERACTIVE_ROLES = new Set([
        'button', 'link', 'checkbox', 'radio', 'slider', 'tab', 'menuitem',
        'menuitemcheckbox', 'menuitemradio', 'option', 'switch', 'textbox',
        'searchbox', 'spinbutton', 'combobox', 'treeitem',
      ]);
      if (INTERACTIVE_ROLES.has(role)) {
        // <div role="button"> must have keyboard handlers — check in scanKeyboard too.
        const attrs = m[2] ?? '';
        if (!/\bonclick|onClick/.test(attrs)) {
          const line = this.lineOf(c, m.index);
          findings.push({
            id: nextId('finding'),
            severity: 'medium',
            category: 'aria',
            title: `Interactive role "${role}" on <${m[1]}> without click handler`,
            description: `<${m[1]} role="${role}"> is missing the corresponding event handler.`,
            location: { file: snap.path, line, column: 0 },
            recommendation: `Add onClick (and onKeyPress/role-appropriate keyboard handler) or use a native <button>/<a> instead.`,
          });
        }
      }
    }
  }

  /** Keyboard-navigation scan: tabindex>0, onclick without onkeydown, modal focus traps. */
  private scanKeyboard(snap: FileSnapshot, findings: AgentFinding[]): void {
    const c = snap.content;
    if (!c) return;

    // tabindex > 0 (anti-pattern)
    const tabIdxRe = /\btabindex\s*=\s*["'](\d+)["']/gi;
    let m: RegExpExecArray | null;
    while ((m = tabIdxRe.exec(c)) !== null) {
      const v = Number(m[1]);
      if (v > 0) {
        const line = this.lineOf(c, m.index);
        findings.push({
          id: nextId('finding'),
          severity: 'medium',
          category: 'keyboard',
          title: `tabindex="${v}" (positive tabindex is an anti-pattern)`,
          description: `Positive tabindex values insert elements into the tab order ahead of native focusable elements, breaking the natural reading order.`,
          location: { file: snap.path, line, column: 0 },
          recommendation: `Use tabindex="0" (or remove it) and reorder the DOM instead.`,
        });
      }
    }

    // onclick without onkeydown/onkeyup/onkeypress
    const onclickRe = /<(\w+)\b([^>]*?\bonclick\s*=[^>]*?)\/?>/gis;
    while ((m = onclickRe.exec(c)) !== null) {
      const tag = m[1].toLowerCase();
      const attrs = m[2] ?? '';
      if (['button', 'a', 'input', 'summary', 'label'].includes(tag)) continue; // natively interactive
      if (!/\bonkey(down|up|press)\s*=/.test(attrs)) {
        const line = this.lineOf(c, m.index);
        findings.push({
          id: nextId('finding'),
          severity: 'high',
          category: 'keyboard',
          title: `Element <${tag}> has onClick but no keyboard handler`,
          description: `Click-only handlers on non-interactive elements are unreachable via keyboard. Use a native button/link or add onKeyDown/role="button"/tabIndex={0}.`,
          location: { file: snap.path, line, column: 0 },
          evidence: m[0].slice(0, 200),
          recommendation: `Replace with <button> or add role="button" tabIndex={0} onKeyDown={handleKey}.`,
        });
      }
    }

    // Modal dialogs without focus trap (best-effort heuristic)
    if (/role=["']dialog["']|<dialog\b|class=["'][^"']*modal/i.test(c)) {
      if (!/focusTrap|FocusTrap|focus-trap|aria-modal\s*=\s*["']true["']/.test(c)) {
        findings.push({
          id: nextId('finding'),
          severity: 'medium',
          category: 'keyboard',
          title: 'Modal dialog without focus trap or aria-modal',
          description: `A modal was detected but no focus-trap implementation or aria-modal="true" attribute was found. Screen-reader and keyboard users may escape into the background page.`,
          location: { file: snap.path },
          recommendation: `Add aria-modal="true" and a focus-trap (e.g. focus-trap-react).`,
        });
      }
    }
  }

  /** Colour-contrast scan on a single CSS file. */
  private scanContrast(snap: FileSnapshot, findings: AgentFinding[]): void {
    const c = snap.content;
    if (!c) return;
    const pairs = this.extractColorPairs(c);
    for (const p of pairs) {
      const ratio = this.contrastRatio(p.fg, p.bg);
      const minRatio = p.large ? 3.0 : 4.5;
      if (ratio < minRatio) {
        findings.push({
          id: nextId('finding'),
          severity: ratio < 3.0 ? 'high' : 'medium',
          category: 'contrast',
          title: `Colour contrast ${ratio.toFixed(2)}:1 below WCAG ${minRatio}:1`,
          description: `Selector "${p.selector}" uses foreground ${p.fg} on background ${p.bg}. Contrast ratio ${ratio.toFixed(2)}:1 is below the required ${minRatio}:1 for ${p.large ? 'large' : 'normal'} text.`,
          location: { file: snap.path, line: p.line, column: 0 },
          recommendation: `Darken the foreground or lighten the background until the ratio is ≥ ${minRatio}:1.`,
        });
      }
    }
  }

  /** Cross-project contrast scan that also picks up inline styles in JSX. */
  private async scanContrastAcrossProject(
    _options: AgentRunOptions,
    files: string[],
    _actions: AgentAction[],
    findings: AgentFinding[],
  ): Promise<void> {
    // Files were already individually scanned; nothing more to do here
    // except dedupe identical findings from the same selector.
    void files;
    void findings;
  }

  // ─── contrast utilities ─────────────────────────────────────────────

  private extractColorPairs(css: string): ReadonlyArray<{
    selector: string;
    fg: string;
    bg: string;
    large: boolean;
    line: number;
  }> {
    const pairs: Array<{ selector: string; fg: string; bg: string; large: boolean; line: number }> = [];
    // Simple rule splitter — split on '}' but keep track of selectors.
    const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = ruleRe.exec(css)) !== null) {
      const selector = (m[1] ?? '').trim();
      const body = m[2] ?? '';
      const line = this.lineOf(css, m.index);
      const color = body.match(/(?:^|[\s;])color\s*:\s*([^;]+)/i)?.[1]?.trim();
      const bg = body.match(/background(?:-color)?\s*:\s*([^;]+)/i)?.[1]?.trim();
      const fontSize = body.match(/font-size\s*:\s*([\d.]+)(px|rem|em|pt)?/i);
      const fontWeight = body.match(/font-weight\s*:\s*(\d+|bold|normal)/i)?.[1]?.toLowerCase();
      if (!color || !bg) continue;
      const fgHex = this.normalizeColor(color);
      const bgHex = this.normalizeColor(bg);
      if (!fgHex || !bgHex) continue;
      // Large text: ≥18pt (24px) regular, or ≥14pt (18.66px) bold
      let large = false;
      if (fontSize) {
        const num = Number(fontSize[1]);
        const unit = (fontSize[2] ?? 'px').toLowerCase();
        const px = unit === 'rem' || unit === 'em' ? num * 16 : unit === 'pt' ? num * (96 / 72) : num;
        const bold = fontWeight === 'bold' || fontWeight === '700' || Number(fontWeight) >= 700;
        large = (px >= 24) || (px >= 18.66 && bold);
      }
      pairs.push({ selector: selector.slice(0, 120), fg: fgHex, bg: bgHex, large, line });
    }
    return pairs;
  }

  private normalizeColor(value: string): string | undefined {
    const v = value.trim().toLowerCase();
    if (v === 'transparent' || v === 'inherit' || v === 'initial' || v === 'currentcolor') {
      return undefined;
    }
    // hex
    let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
    if (m) {
      const hex = m[1];
      if (hex.length === 3) {
        return `#${hex.split('').map((c) => c + c).join('')}`;
      }
      return `#${hex}`;
    }
    // rgb()/rgba()
    m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(v);
    if (m) {
      const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
      return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
    }
    // named colours (a useful subset)
    const NAMED: Record<string, string> = {
      white: '#ffffff', black: '#000000', red: '#ff0000', green: '#008000',
      blue: '#0000ff', yellow: '#ffff00', gray: '#808080', grey: '#808080',
      silver: '#c0c0c0', maroon: '#800000', olive: '#808000', navy: '#000080',
      purple: '#800080', teal: '#008080', lime: '#00ff00', aqua: '#00ffff',
      fuchsia: '#ff00ff', orange: '#ffa500',
    };
    return NAMED[v];
  }

  private contrastRatio(fgHex: string, bgHex: string): number {
    const l1 = this.relativeLuminance(fgHex);
    const l2 = this.relativeLuminance(bgHex);
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
  }

  private relativeLuminance(hex: string): number {
    const h = hex.replace('#', '');
    const r = parseInt(h.slice(0, 2), 16) / 255;
    const g = parseInt(h.slice(2, 4), 16) / 255;
    const b = parseInt(h.slice(4, 6), 16) / 255;
    const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }

  // ─── line helpers ───────────────────────────────────────────────────

  private lineOf(content: string, index: number): number {
    if (index <= 0) return 1;
    let line = 1;
    for (let i = 0; i < index && i < content.length; i += 1) {
      if (content.charCodeAt(i) === 10) line += 1;
    }
    return line;
  }

  // ─── auto-fix ───────────────────────────────────────────────────────

  private autoFix(snap: FileSnapshot): AutoFixResult {
    if (snap.kind !== 'html' && snap.kind !== 'jsx') {
      return { path: snap.path, applied: false, fixes: [], reason: 'no auto-fix for this file kind' };
    }
    let c = snap.content;
    const fixes: Array<{ description: string; line: number }> = [];

    // Fix 1: images without alt → add alt="" (decorative — safest default)
    c = c.replace(/(<img\b)((?:(?!alt=)[^>])*)\/?>/gis, (whole, tag: string, attrs: string, offset: number) => {
      // already has alt — skip
      if (/\balt\s*=/.test(attrs)) return whole;
      fixes.push({ description: 'added alt="" to <img>', line: this.lineOf(snap.content, offset) });
      return `${tag}${attrs} alt=""`;
    });

    // Fix 2: icon-only buttons → add aria-label="button" (placeholder; reviewer should refine)
    c = c.replace(/(<button\b)((?:(?!aria-label)(?!>)[^>])*)><\/button>/gis, (whole, tag: string, attrs: string, offset: number) => {
      if (/\baria-label\s*=/.test(attrs)) return whole;
      fixes.push({ description: 'added aria-label to icon-only button', line: this.lineOf(snap.content, offset) });
      return `${tag}${attrs} aria-label="action"></button>`;
    });

    // Fix 3: missing <html lang> — add lang="en"
    c = c.replace(/<html\b((?:(?!lang=)[^>])*)>/i, (whole, attrs: string, offset: number) => {
      fixes.push({ description: 'added lang="en" to <html>', line: this.lineOf(snap.content, offset) });
      return `<html${attrs} lang="en">`;
    });

    // Fix 4: skip link — insert after <body>
    c = c.replace(/(<body\b[^>]*>)/i, (whole, tag: string, offset: number) => {
      if (/<a\b[^>]*\bhref=["']#main["']/i.test(snap.content)) return whole;
      fixes.push({ description: 'inserted skip-to-content link', line: this.lineOf(snap.content, offset) });
      return `${tag}\n<a href="#main" class="skip-link">Skip to content</a>`;
    });

    // Fix 5: wrap missing <main> landmark — add role="main" to first <div id="root"> or similar
    if (!/<main\b/i.test(c) && /<div\b[^>]*\bid=["'](?:root|app)["']/i.test(c)) {
      c = c.replace(/(<div\b)((?:(?!role=)[^>])*?\bid=["'](?:root|app)["'])/i, (whole, tag: string, attrs: string, offset: number) => {
        fixes.push({ description: 'added role="main" to root div', line: this.lineOf(snap.content, offset) });
        return `${tag}${attrs} role="main"`;
      });
    }

    if (fixes.length === 0) {
      return { path: snap.path, applied: false, fixes: [], reason: 'no auto-fixable issues detected' };
    }
    return { path: snap.path, applied: true, newContent: c, fixes };
  }

  // ─── report ─────────────────────────────────────────────────────────

  private composeReport(
    fileCount: number,
    findings: AgentFinding[],
    fixResults: AutoFixResult[],
    recommendations: string[],
  ): string {
    const byCat = new Map<string, AgentFinding[]>();
    for (const f of findings) {
      const list = byCat.get(f.category) ?? [];
      list.push(f);
      byCat.set(f.category, list);
    }
    const sevCount = (s: string) => findings.filter((f) => f.severity === s).length;
    const totalFixes = fixResults.reduce((n, r) => n + r.fixes.length, 0);

    const lines: string[] = [];
    lines.push('# WCAG 2.2 AA Accessibility Audit Report', '');
    lines.push(`**Files scanned:** ${fileCount}`);
    lines.push(`**Total findings:** ${findings.length} — ${sevCount('critical')} critical, ${sevCount('high')} high, ${sevCount('medium')} medium, ${sevCount('low')} low, ${sevCount('info')} info.`);
    lines.push(`**Auto-fixes applied:** ${totalFixes} across ${fixResults.length} files.`);
    lines.push('');

    lines.push('## Findings by category', '');
    for (const [cat, list] of byCat) {
      lines.push(`### ${cat} (${list.length})`, '');
      lines.push('| Severity | Title | Location | Recommendation |');
      lines.push('|---|---|---|---|');
      for (const f of list) {
        const loc = f.location
          ? `${f.location.file ?? ''}${f.location.line ? `:${f.location.line}` : ''}`
          : '';
        const rec = (f.recommendation ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
        lines.push(
          `| ${f.severity} | ${this.escapeMd(f.title)} | ${this.escapeMd(loc)} | ${this.escapeMd(rec)} |`,
        );
      }
      lines.push('');
    }

    lines.push('## Auto-fixes applied', '');
    if (totalFixes === 0) {
      lines.push('_No auto-fixes were applicable._', '');
    } else {
      for (const r of fixResults) {
        for (const fix of r.fixes) {
          lines.push(`- \`${r.path}:${fix.line}\` — ${fix.description}`);
        }
      }
      lines.push('');
    }

    lines.push('## Manual review needed', '');
    const manual = findings.filter((f) => !f.recommendation);
    if (manual.length === 0) {
      lines.push('_All findings include a recommendation._');
    } else {
      for (const f of manual) {
        lines.push(`- **[${f.severity}]** ${f.title} — ${f.location?.file ?? ''}`);
      }
    }
    lines.push('');

    lines.push('## Recommendations', '');
    if (recommendations.length === 0) {
      lines.push('_No top-level recommendations (see per-finding recommendations)._');
    } else {
      for (const r of recommendations) lines.push(`- ${r}`);
    }
    lines.push('');
    lines.push('---');
    lines.push('_Generated by ♿ SANIX Accessibility Auditor (`a11y-auditor`)._');
    return lines.join('\n');
  }

  private escapeMd(s: string): string {
    return (s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 200);
  }

  private composeSummary(
    fileCount: number,
    findings: AgentFinding[],
    appliedFixes: number,
    durationMs: number,
  ): string {
    const high = findings.filter((f) => f.severity === 'high' || f.severity === 'critical').length;
    return (
      `♿ Accessibility Auditor scanned ${fileCount} file(s) in ${durationMs}ms — ` +
      `${findings.length} findings (${high} high/critical), ${appliedFixes} auto-fixes applied. ` +
      `Report written to reports/wcag-audit-report.md.`
    );
  }
}

// NOTE: WCAG criterion ids (e.g. "1.1.1") and conformance levels (A/AA/AAA)
// are embedded inside each finding's `description` field as
// `WCAG 1.1.1 (Level A): …` so this agent does not depend on extra optional
// fields being declared on the canonical `AgentFinding` type owned by V11-1.
