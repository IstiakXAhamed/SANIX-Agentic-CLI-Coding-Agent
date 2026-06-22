/**
 * @file agents/UIDesigner.ts
 * @description SANIX UI/UX Designer agent — 🎨 (id: `ui-designer`,
 * category: `design`).
 *
 * The UI/UX Designer is SANIX's interface-design specialist. It can:
 *   1. **Audit** existing UIs for usability issues (inconsistent
 *      spacing, color-palette drift, missing responsive breakpoints,
 *      accessibility gaps, component duplication).
 *   2. **Design** new interfaces from a natural-language requirement —
 *      produces an ASCII wireframe, a component tree, design tokens,
 *      and the actual production-ready component code (React by
 *      default; Vue/Svelte scaffolds also supported).
 *   3. **Author design systems** — color palette, typography scale,
 *      8 px spacing scale, component variants, and design tokens in
 *      three formats (CSS custom properties, Tailwind config, Figma
 *      JSON).
 *   4. **Generate responsive layouts** — mobile-first breakpoints
 *      (375 / 768 / 1024 / 1440).
 *   5. **Author micro-animations** — CSS transitions + Framer Motion
 *      variants for hover / focus / active / enter / exit / loading /
 *      error states.
 *   6. **Generate themes** — light / dark / system themes via CSS
 *      variables.
 *
 * The agent is intentionally dependency-free at runtime: it parses
 * JSX/TSX/Vue/Svelte/CSS with targeted regular expressions rather
 * than a full DOM or PostCSS parser, so it runs in any sandbox. It
 * writes real files (component, story, test, tokens) under
 * `design-output/` in the run's `cwd` — unless `dryRun: true`.
 *
 * @packageDocumentation
 */

import * as path from 'node:path';
import { BaseAgent, type RunContext } from '../BaseAgent.js';
import type {
  AgentCategory,
  AgentFinding,
  AgentRunOptions,
  AgentRunResult,
} from '../types.js';

// ─── Public types ────────────────────────────────────────────────────────────

/** The high-level operating mode the agent selects for a given goal. */
export type UIDesignerMode =
  | 'audit'
  | 'design'
  | 'design-system'
  | 'theme'
  | 'animation';

/** Supported UI frameworks for code generation. */
export type UIFramework = 'react' | 'vue' | 'svelte' | 'html';

/** Supported styling strategies for code generation. */
export type StylingStrategy = 'tailwind' | 'css-modules' | 'styled-components' | 'plain-css';

/** A single color swatch in a generated palette. */
export interface ColorSwatch {
  /** Semantic role (`primary`, `secondary`, `accent`, `neutral`, `success`, ...). */
  role: string;
  /** Shade label (`50` … `950`). */
  shade: string;
  /** Hex value (`#0ea5e9`). */
  hex: string;
  /** Optional human-readable note. */
  note?: string;
}

/** A typography scale entry. */
export interface TypographyEntry {
  /** Token name (`display`, `h1`, `body-lg`, `caption`, `code`, ...). */
  token: string;
  /** Font size in pixels. */
  fontSizePx: number;
  /** Line height as a unitless multiple. */
  lineHeight: number;
  /** Font weight (400, 500, 600, 700). */
  fontWeight: number;
  /** Optional tracking in em. */
  letterSpacingEm?: number;
  /** Usage description. */
  usage: string;
}

/** A component variant definition (e.g. button: primary/secondary/ghost). */
export interface ComponentVariant {
  /** Component name (`Button`, `Input`, `Card`). */
  component: string;
  /** Variant name (`primary`, `ghost`, `destructive`). */
  variant: string;
  /** Styling notes / class tokens. */
  styling: string;
  /** Optional usage guidance. */
  usage?: string;
}

/** A detected UI audit issue. */
export interface UIAuditIssue {
  /** Issue category (`spacing`, `color-drift`, `responsive`, `a11y`, `duplication`). */
  category: 'spacing' | 'color-drift' | 'responsive' | 'a11y' | 'duplication';
  /** Severity bucket. */
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  /** One-line title. */
  title: string;
  /** Multi-line explanation. */
  description: string;
  /** Source file (cwd-relative). */
  file?: string;
  /** 1-indexed line. */
  line?: number;
  /** Concrete suggested fix. */
  suggestion?: string;
}

/** Parsed intent derived from the user's goal. */
export interface UIDesignerIntent {
  mode: UIDesignerMode;
  framework: UIFramework;
  styling: StylingStrategy;
  /** True when the goal mentions "dark mode", "light/dark", or "theme". */
  darkMode: boolean;
  /** A short label for the component/page being designed (best-effort). */
  subject: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Standard responsive breakpoints (mobile-first). */
export const RESPONSIVE_BREAKPOINTS: Readonly<Record<string, number>> = Object.freeze({
  mobile: 375,
  tablet: 768,
  desktop: 1024,
  wide: 1440,
});

/** 8 px spacing scale. */
export const SPACING_SCALE: ReadonlyArray<number> = Object.freeze([4, 8, 12, 16, 24, 32, 48, 64]);

/** File extensions treated as UI component sources. */
const UI_EXTENSIONS = new Set<string>(['.tsx', '.jsx', '.vue', '.svelte', '.astro', '.html', '.css', '.scss']);

/** Keywords that trigger audit mode. */
const AUDIT_KEYWORDS = ['audit', 'scan', 'review', 'check', 'analyze', 'inspect', 'evaluate'];

/** Keywords that trigger design-system mode. */
const DESIGN_SYSTEM_KEYWORDS = ['design system', 'design tokens', 'design token', 'palette', 'color palette', 'typography scale', 'spacing scale', 'component variants'];

/** Keywords that trigger theme mode. */
const THEME_KEYWORDS = ['theme', 'dark mode', 'light mode', 'light/dark', 'light-dark', 'system theme', 'color scheme'];

/** Keywords that trigger animation mode. */
const ANIMATION_KEYWORDS = ['animation', 'micro-animation', 'micro animation', 'transition', 'framer motion', 'motion', 'hover effect', 'hover state'];

/** Keywords that hint at framework preference. */
const FRAMEWORK_KEYWORDS: ReadonlyArray<readonly [UIFramework, ReadonlyArray<string>]> = [
  ['vue', ['vue', 'nuxt']],
  ['svelte', ['svelte', 'kit']],
  ['html', ['html', 'vanilla']],
  // React is the default — listed last so it doesn't shadow the others.
  ['react', ['react', 'next', 'nextjs', 'remix', 'gatsby']],
];

/** Keywords that hint at styling preference. */
const STYLING_KEYWORDS: ReadonlyArray<readonly [StylingStrategy, ReadonlyArray<string>]> = [
  ['css-modules', ['css module', 'css-modules', 'cssmodules']],
  ['styled-components', ['styled-components', 'styled components', 'emotion']],
  ['plain-css', ['plain css', 'vanilla css', 'plain-css']],
  ['tailwind', ['tailwind', 'wind']],
];

// ─── Agent ───────────────────────────────────────────────────────────────────

/**
 * SANIX UI/UX Designer — 🎨 interface design + code-generation agent.
 *
 * The Designer produces real component code (not just descriptions):
 * a `run()` in design mode writes a `.tsx` component, a `.stories.tsx`
 * Storybook entry, and a `.test.tsx` test stub under
 * `<cwd>/design-output/`. Audit mode reads existing components and
 * emits structured findings. Design-system mode emits `tokens.css`,
 * `tailwind.config.ts`, and `tokens.json`. Theme mode emits
 * `theme.css` with `:root` + `[data-theme='dark']` blocks. Animation
 * mode emits a `motion.ts` Framer Motion variants file.
 *
 * @example
 * ```ts
 * import { UIDesigner } from '@sanix/agents';
 *
 * // Audit an existing dashboard.
 * const auditResult = await new UIDesigner().run(
 *   'Audit the dashboard UI for usability issues',
 *   { cwd: '/repo' },
 * );
 * console.log(auditResult.findings.length, 'usability findings');
 *
 * // Generate a new component.
 * const designResult = await new UIDesigner().run(
 *   'Design a login form with OAuth buttons and dark mode support',
 *   { cwd: '/repo' },
 * );
 * // Files written under /repo/design-output/LoginForm/
 * ```
 */
export class UIDesigner extends BaseAgent {
  public readonly id = 'ui-designer';
  public readonly name = 'UI/UX Designer';
  public readonly description =
    'Designs and audits user interfaces. Generates production-ready React/Vue/Svelte ' +
    'components, design systems (color, typography, spacing, tokens), responsive layouts, ' +
    'micro-animations, and light/dark themes. Audits existing UIs for usability and ' +
    'accessibility issues. Follows WCAG AA, 8px grid, mobile-first, and Gestalt principles.';
  public readonly category: AgentCategory = 'design';
  public readonly icon = '🎨';
  public readonly provider = 'claude-sonnet-4';
  public readonly temperature = 0.4;
  public readonly tools = [
    'read_file',
    'write_file',
    'edit_file',
    'search_files',
    'analyze_ast',
    'bash',
    'sandbox_execute',
  ];
  public readonly exampleQueries = [
    'Audit the dashboard UI for usability issues',
    'Design a settings page with tabs for general, auth, memory, notifications',
    'Create a design system with a cyan/amber color palette',
    'Generate a responsive data table component with sorting and pagination',
    'Design a login form with OAuth buttons and dark mode support',
  ];

  public readonly systemPrompt = `You are SANIX UI/UX Designer, an expert in interface design and user experience. You: (1) analyze existing UIs for usability issues (cognitive load, visual hierarchy, consistency, accessibility), (2) design new interfaces from requirements (wireframes → component structure → styled implementation), (3) create and maintain design systems (color palettes, typography, spacing, component variants), (4) generate production-ready component code (React/Vue/Svelte with Tailwind/CSS Modules/styled-components), (5) create responsive layouts (mobile-first, breakpoints), (6) design interactions and micro-animations, (7) generate design tokens (CSS custom properties, Tailwind config, Figma tokens). You follow: Gestalt principles, Fitts's law, Hick's law, DRY design, consistent spacing (8px grid), accessible color contrast (WCAG AA), progressive disclosure, mobile-first.`;

  // ── Run entrypoint ─────────────────────────────────────────────────────────

  public async run(goal: string, opts?: AgentRunOptions): Promise<AgentRunResult> {
    const ctx = this.startRun(goal, opts);
    const intent = this.detectIntent(goal);
    this.emitProgress(
      'analyze',
      `Mode: ${intent.mode} · Framework: ${intent.framework} · Styling: ${intent.styling}${intent.darkMode ? ' · dark-mode' : ''}`,
      intent,
      ctx,
    );

    switch (intent.mode) {
      case 'audit':
        await this.runAudit(ctx, intent);
        break;
      case 'design-system':
        await this.runDesignSystem(ctx, intent);
        break;
      case 'theme':
        await this.runTheme(ctx, intent);
        break;
      case 'animation':
        await this.runAnimation(ctx, intent);
        break;
      case 'design':
      default:
        await this.runDesign(ctx, intent);
        break;
    }

    this.recordMetric(ctx, 'totalFindings', ctx.findings.length, 'set');
    this.recordMetric(
      ctx,
      'criticalFindings',
      ctx.findings.filter((f) => f.severity === 'critical').length,
      'set',
    );
    this.recordMetric(
      ctx,
      'highFindings',
      ctx.findings.filter((f) => f.severity === 'high').length,
      'set',
    );

    return this.finishRun(ctx);
  }

  // ── Intent detection ───────────────────────────────────────────────────────

  /**
   * Heuristically classify the goal into a {@link UIDesignerMode} and
   * extract framework / styling / dark-mode hints. The classifier is
   * keyword-based and intentionally conservative — when no keyword
   * matches, it defaults to `design` mode with React + Tailwind.
   */
  protected detectIntent(goal: string): UIDesignerIntent {
    const g = goal.toLowerCase();

    let mode: UIDesignerMode = 'design';
    if (DESIGN_SYSTEM_KEYWORDS.some((k) => g.includes(k))) mode = 'design-system';
    else if (THEME_KEYWORDS.some((k) => g.includes(k))) mode = 'theme';
    else if (ANIMATION_KEYWORDS.some((k) => g.includes(k))) mode = 'animation';
    else if (AUDIT_KEYWORDS.some((k) => g.includes(k))) mode = 'audit';

    let framework: UIFramework = 'react';
    for (const [fw, kws] of FRAMEWORK_KEYWORDS) {
      if (kws.some((k) => g.includes(k))) {
        framework = fw;
        break;
      }
    }

    let styling: StylingStrategy = 'tailwind';
    for (const [st, kws] of STYLING_KEYWORDS) {
      if (kws.some((k) => g.includes(k))) {
        styling = st;
        break;
      }
    }

    const darkMode =
      /\bdark\s*mode\b/i.test(goal) ||
      /\blight\s*[/-]?\s*dark\b/i.test(goal) ||
      /\bsystem\s*theme\b/i.test(goal);

    const subject = this.extractSubject(goal, mode);

    return { mode, framework, styling, darkMode, subject };
  }

  /**
   * Extract a short PascalCase subject label from the goal (e.g.
   * "Design a login form with OAuth" → `LoginForm`). Used as the
   * directory and file name for generated artifacts.
   */
  protected extractSubject(goal: string, mode: UIDesignerMode): string {
    const stopwords = new Set([
      'a', 'an', 'the', 'design', 'create', 'generate', 'build', 'make',
      'with', 'for', 'and', 'or', 'to', 'of', 'in', 'on', 'that', 'this',
      'please', 'component', 'page', 'ui', 'ux', 'interface', 'screen',
      'audit', 'scan', 'review', 'check', 'analyze', 'inspect', 'evaluate',
      'system', 'tokens', 'token', 'palette', 'theme', 'animation',
      'micro-animation', 'responsive', 'accessible', 'mode',
    ]);
    const words = goal
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1 && !stopwords.has(w));
    if (words.length === 0) {
      return mode === 'design-system' ? 'DesignSystem' : mode === 'theme' ? 'Theme' : mode === 'animation' ? 'Motion' : 'Component';
    }
    // Take up to 3 significant words and PascalCase them.
    return words.slice(0, 3).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
  }

  // ── Mode: audit ────────────────────────────────────────────────────────────

  /**
   * Scan existing UI component files for usability issues. Emits one
   * finding per detected issue and writes a `ui-audit-report.md`
   * summary under `design-output/`.
   */
  protected async runAudit(ctx: RunContext, intent: UIDesignerIntent): Promise<void> {
    this.emitProgress('analyze', 'Scanning UI component files for usability issues…', undefined, ctx);

    const issues: UIAuditIssue[] = [];
    let scanned = 0;

    await this.scanFiles(
      ctx,
      (filePath, content) => {
        scanned++;
        const rel = path.relative(ctx.opts.cwd, filePath);
        issues.push(...this.auditSpacing(rel, content));
        issues.push(...this.auditColorDrift(rel, content));
        issues.push(...this.auditResponsive(rel, content));
        issues.push(...this.auditAccessibility(rel, content, intent));
      },
      { extensions: [...UI_EXTENSIONS] },
    );

    this.recordMetric(ctx, 'filesScanned', scanned, 'set');
    this.recordMetric(ctx, 'issuesFound', issues.length, 'set');

    // Convert to findings (dedupe by title+file+line).
    const seen = new Set<string>();
    for (const issue of issues) {
      const key = `${issue.category}|${issue.title}|${issue.file ?? ''}|${issue.line ?? 0}`;
      if (seen.has(key)) continue;
      seen.add(key);
      this.addFinding(ctx, {
        severity: issue.severity,
        category: `ui-audit:${issue.category}`,
        title: issue.title,
        description: issue.description,
        file: issue.file,
        line: issue.line,
        suggestion: issue.suggestion,
        autoFixable: issue.category !== 'color-drift',
        tags: ['ui', 'ux', issue.category],
      });
    }

    // Write the audit report.
    const report = this.formatAuditReport(ctx, intent, scanned, issues);
    const outPath = path.join(ctx.opts.cwd, 'design-output', 'ui-audit-report.md');
    await this.writeFileSafe(outPath, report, ctx);
    ctx.output = `Audited ${scanned} UI files. Found ${issues.length} issue(s). Report: ${path.relative(ctx.opts.cwd, outPath) || outPath}`;
  }

  /** Detect hardcoded pixel values that fall off the 8 px grid. */
  protected auditSpacing(file: string, content: string): UIAuditIssue[] {
    const issues: UIAuditIssue[] = [];
    // Match `padding: 13px`, `margin: 7px`, `gap: 10px`, `p-3.5` (Tailwind off-grid),
    // but skip 0, 1px (hairline), and percentages.
    const pxRe = /(?:padding|margin|gap|top|bottom|left|right|width|height):\s*(\d+)px/gi;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let m: RegExpExecArray | null;
      pxRe.lastIndex = 0;
      while ((m = pxRe.exec(line)) !== null) {
        const v = parseInt(m[1], 10);
        if (v === 0 || v === 1) continue;
        if (!SPACING_SCALE.includes(v) && v % 4 !== 0) {
          issues.push({
            category: 'spacing',
            severity: 'low',
            title: `Off-grid spacing value: ${v}px`,
            description: `The value ${v}px does not sit on the 8px (or 4px half-step) spacing grid. Inconsistent spacing erodes visual rhythm and increases cognitive load (Gestalt proximity principle).`,
            file,
            line: i + 1,
            suggestion: `Round to the nearest grid value: ${this.nearestSpacing(v)}px. Replace \`${v}px\` with \`${this.nearestSpacing(v)}px\` (or the matching Tailwind class).`,
          });
        }
      }
    }
    return issues;
  }

  /** Detect hardcoded hex colors that bypass a design token. */
  protected auditColorDrift(file: string, content: string): UIAuditIssue[] {
    const issues: UIAuditIssue[] = [];
    const hexRe = /#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/g;
    const lines = content.split('\n');
    const seen = new Set<string>();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Skip comments — they often contain color references.
      if (/^\s*(\/\/|\/\*|\*|--)/.test(line)) continue;
      let m: RegExpExecArray | null;
      hexRe.lastIndex = 0;
      while ((m = hexRe.exec(line)) !== null) {
        const hex = m[0].toLowerCase();
        if (seen.has(`${i}:${hex}`)) continue;
        seen.add(`${i}:${hex}`);
        issues.push({
          category: 'color-drift',
          severity: 'medium',
          title: `Hardcoded color ${hex}`,
          description: `A raw hex color \`${hex}\` is used directly instead of a design token (CSS variable or Tailwind theme color). Hardcoded colors cause palette drift — the same hue ends up with subtly different values across components, weakening brand consistency.`,
          file,
          line: i + 1,
          suggestion: `Replace \`${hex}\` with a semantic token, e.g. \`var(--color-accent-500)\` or \`text-accent-500\`. If this is a new color, add it to the design system first.`,
        });
      }
    }
    return issues;
  }

  /** Detect missing responsive breakpoints (no `sm:` / `md:` / `@media`). */
  protected auditResponsive(file: string, content: string): UIAuditIssue[] {
    const issues: UIAuditIssue[] = [];
    const isTailwind = /\b(flex|grid|gap|p-|m-|w-|h-|text-)\b/.test(content);
    const hasResponsive =
      /\b(sm|md|lg|xl|2xl):/.test(content) || /@media\s*\(/i.test(content);
    // Only flag for layout-bearing files.
    const looksLikeLayout = /\b(flex|grid|container|layout|sidebar|navbar|drawer|modal|dialog|dashboard)\b/i.test(file) ||
      /\b(flex|grid|container|sidebar|navbar)\b/i.test(content);
    if (isTailwind && looksLikeLayout && !hasResponsive) {
      issues.push({
        category: 'responsive',
        severity: 'high',
        title: 'Layout has no responsive breakpoints',
        description: `This component uses layout primitives (flex/grid) but defines no responsive variants (\`sm:\`, \`md:\`, \`lg:\`) or \`@media\` queries. On a 375 px mobile viewport the layout will likely overflow or collapse awkwardly. Mobile-first design requires explicit breakpoint coverage for any non-trivial layout.`,
        file,
        line: 1,
        suggestion: `Add mobile-first breakpoints. Common pattern: base styles target mobile (≥375 px), then \`sm:\` (≥640 px), \`md:\` (≥768 px), \`lg:\` (≥1024 px). Test at 375 / 768 / 1024 / 1440 px.`,
      });
    }
    return issues;
  }

  /** Detect accessibility issues: missing alt, aria-label, focus, contrast hints. */
  protected auditAccessibility(file: string, content: string, _intent: UIDesignerIntent): UIAuditIssue[] {
    const issues: UIAuditIssue[] = [];
    const lines = content.split('\n');

    // Missing `alt` on <img>.
    const imgRe = /<img\b[^>]*>/gi;
    for (let i = 0; i < lines.length; i++) {
      imgRe.lastIndex = 0;
      const m = imgRe.exec(lines[i]);
      if (m && !/\balt\s*=/.test(m[0])) {
        issues.push({
          category: 'a11y',
          severity: 'high',
          title: '<img> missing alt attribute',
          description: `An \`<img>\` element has no \`alt\` attribute. Screen readers announce the filename or skip the image entirely, leaving non-sighted users without context. WCAG 1.1.1 (Level A).`,
          file,
          line: i + 1,
          suggestion: `Add \`alt="descriptive text"\`. If the image is purely decorative, use \`alt=""\` to explicitly hide it from assistive tech.`,
        });
      }
    }

    // Icon-only button without accessible name.
    const iconBtnRe = /<button\b[^>]*>([\s\S]*?)<\/button>/gi;
    for (let i = 0; i < lines.length; i++) {
      iconBtnRe.lastIndex = 0;
      const m = iconBtnRe.exec(lines[i]);
      if (m) {
        const inner = m[1].trim();
        const hasText = /<[a-z][^>]*>.*?<\/[a-z]+>/i.test(inner) === false && inner.length > 0 && !/^<[^>]+\/?>$/.test(inner);
        const hasAria = /\b(aria-label|aria-labelledby)\s*=/.test(m[0]);
        const isSvgOnly = /^<svg\b/i.test(inner.trim()) || /^<i\b/i.test(inner.trim()) || inner.length === 0;
        if ((isSvgOnly || !hasText) && !hasAria) {
          issues.push({
            category: 'a11y',
            severity: 'high',
            title: 'Icon-only button missing accessible name',
            description: `A \`<button>\` contains only an icon (SVG / icon font) with no text and no \`aria-label\`. Screen readers announce "button" with no purpose. WCAG 4.1.2 (Level A).`,
            file,
            line: i + 1,
            suggestion: `Add \`aria-label="Open menu"\` (or the relevant action) to the button.`,
          });
        }
      }
    }

    // Missing focus styles on interactive elements with custom styles.
    if (/\b(button|a|input|select|textarea)\b/i.test(content) && /:hover\b/.test(content) && !/:focus\b/.test(content)) {
      issues.push({
        category: 'a11y',
        severity: 'medium',
        title: ':hover defined without :focus',
        description: `Interactive elements define \`:hover\` styles but no \`:focus\` (or \`:focus-visible\`) styles. Keyboard users get no visual feedback when tabbing. WCAG 2.4.7 (Level AA).`,
        file,
        line: 1,
        suggestion: `Add a matching \`:focus-visible\` rule. Example: \`button:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }\``,
      });
    }

    return issues;
  }

  /** Snap an arbitrary pixel value to the nearest spacing-scale entry. */
  protected nearestSpacing(px: number): number {
    let best = SPACING_SCALE[0];
    let bestDist = Math.abs(px - best);
    for (const s of SPACING_SCALE) {
      const d = Math.abs(px - s);
      if (d < bestDist) {
        best = s;
        bestDist = d;
      }
    }
    // Also consider 4 px half-steps for finer alignment.
    const halfStep = Math.round(px / 4) * 4;
    if (Math.abs(px - halfStep) < bestDist) return halfStep;
    return best;
  }

  /** Format the audit report markdown. */
  protected formatAuditReport(
    ctx: RunContext,
    intent: UIDesignerIntent,
    filesScanned: number,
    issues: UIAuditIssue[],
  ): string {
    const lines: string[] = [];
    lines.push(`# 🎨 UI/UX Designer — Audit Report`);
    lines.push('');
    lines.push(`**Goal:** ${ctx.goal}`);
    lines.push(`**Framework hint:** ${intent.framework} · **Styling:** ${intent.styling}`);
    lines.push(`**Files scanned:** ${filesScanned}`);
    lines.push(`**Issues found:** ${issues.length}`);
    const byCat: Record<string, number> = {};
    for (const i of issues) byCat[i.category] = (byCat[i.category] ?? 0) + 1;
    if (Object.keys(byCat).length > 0) {
      lines.push('');
      lines.push('## Summary by category');
      lines.push('');
      lines.push('| Category | Count |');
      lines.push('| --- | --- |');
      for (const [cat, n] of Object.entries(byCat)) lines.push(`| ${cat} | ${n} |`);
    }
    if (issues.length > 0) {
      lines.push('');
      lines.push('## Accessibility checklist');
      lines.push('');
      lines.push('- [ ] All `<img>` have `alt` (or `alt=""` if decorative)');
      lines.push('- [ ] All icon-only buttons have `aria-label`');
      lines.push('- [ ] Color contrast ≥ 4.5:1 for body text (WCAG AA)');
      lines.push('- [ ] `:focus-visible` styles on every interactive element');
      lines.push('- [ ] Keyboard navigation reaches all controls (Tab order)');
      lines.push('- [ ] No reliance on color alone to convey meaning');
      lines.push('');
      lines.push('## Findings');
      lines.push('');
      const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4 } as const;
      const sorted = [...issues].sort((a, b) => order[a.severity] - order[b.severity]);
      for (const issue of sorted) {
        const loc = issue.file ? ` \`${issue.file}${issue.line ? `:${issue.line}` : ''}\`` : '';
        lines.push(`### [${issue.severity.toUpperCase()}] ${issue.title}${loc}`);
        lines.push('');
        lines.push(`**Category:** ${issue.category}`);
        lines.push('');
        lines.push(issue.description);
        if (issue.suggestion) {
          lines.push('');
          lines.push('**Suggested fix:**');
          lines.push('');
          lines.push(issue.suggestion);
        }
        lines.push('');
      }
    }
    return lines.join('\n');
  }

  // ── Mode: design (component generation) ────────────────────────────────────

  /**
   * Generate a complete component package: wireframe, design tokens,
   * the component file (React/Vue/Svelte/HTML), a Storybook story,
   * and a test stub. All written under `design-output/<Subject>/`.
   */
  protected async runDesign(ctx: RunContext, intent: UIDesignerIntent): Promise<void> {
    const dir = path.join(ctx.opts.cwd, 'design-output', intent.subject);
    this.emitProgress('analyze', `Designing ${intent.subject} → ${path.relative(ctx.opts.cwd, dir) || dir}`, undefined, ctx);

    // 1) Wireframe (ASCII).
    const wireframe = this.generateWireframe(intent);
    await this.writeFileSafe(path.join(dir, 'wireframe.txt'), wireframe, ctx);

    // 2) Component tree.
    const tree = this.generateComponentTree(intent);
    await this.writeFileSafe(path.join(dir, 'component-tree.md'), tree, ctx);

    // 3) Design tokens (CSS variables).
    const tokens = this.generateTokensCss(intent);
    await this.writeFileSafe(path.join(dir, 'tokens.css'), tokens, ctx);

    // 4) Component code.
    const ext = intent.framework === 'react' ? '.tsx' : intent.framework === 'vue' ? '.vue' : intent.framework === 'svelte' ? '.svelte' : '.html';
    const componentCode = this.generateComponent(intent);
    await this.writeFileSafe(path.join(dir, `${intent.subject}${ext}`), componentCode, ctx);

    // 5) Storybook story (React only — others get a usage doc).
    if (intent.framework === 'react') {
      const story = this.generateStory(intent);
      await this.writeFileSafe(path.join(dir, `${intent.subject}.stories.tsx`), story, ctx);
    } else {
      const usage = this.generateUsageDoc(intent);
      await this.writeFileSafe(path.join(dir, 'USAGE.md'), usage, ctx);
    }

    // 6) Test stub.
    const test = this.generateTest(intent);
    await this.writeFileSafe(path.join(dir, `${intent.subject}.test.tsx`), test, ctx);

    // 7) Micro-animation variants (always — even simple hover).
    const motion = this.generateMotion(intent);
    await this.writeFileSafe(path.join(dir, 'motion.ts'), motion, ctx);

    // 8) Accessibility checklist.
    const a11y = this.generateA11yChecklist(intent);
    await this.writeFileSafe(path.join(dir, 'accessibility.md'), a11y, ctx);

    // Record a finding summarizing the deliverable.
    this.addFinding(ctx, {
      severity: 'info',
      category: 'ui-design:deliverable',
      title: `Generated ${intent.subject} component package`,
      description: `Produced a complete component package under \`design-output/${intent.subject}/\`: wireframe, component tree, design tokens (CSS custom properties), the ${intent.framework} component file${intent.framework === 'react' ? ', a Storybook story,' : ', a usage doc,'} a test stub, Framer Motion variants, and an accessibility checklist. Framework: ${intent.framework}. Styling: ${intent.styling}. Dark-mode aware: ${intent.darkMode}.`,
      file: path.relative(ctx.opts.cwd, dir) || dir,
      suggestion: 'Review the generated artifacts, then move the directory into your source tree (e.g. `src/components/`) and adjust imports to match your project conventions.',
      autoFixable: false,
      tags: ['ui', 'design', 'generation', intent.framework, intent.styling],
    });

    ctx.output = `Generated ${intent.subject} component package at ${path.relative(ctx.opts.cwd, dir) || dir} (${intent.framework} + ${intent.styling}). 7 files written.`;
    this.recordMetric(ctx, 'filesGenerated', 7, 'set');
  }

  /** Generate an ASCII wireframe for the requested subject. */
  protected generateWireframe(intent: UIDesignerIntent): string {
    const isForm = /login|signup|form|auth|register|signin/i.test(intent.subject);
    const isTable = /table|grid|list|dashboard/i.test(intent.subject);
    const isSettings = /settings|config|preferences/i.test(intent.subject);
    const isNav = /nav|menu|sidebar|header|footer/i.test(intent.subject);

    const header = [
      `┌─────────────────────────────────────────────────────────────┐`,
      `│  ${intent.subject.padEnd(57)}│`,
      `│  Wireframe · mobile 375px → desktop 1440px                  │`,
      `└─────────────────────────────────────────────────────────────┘`,
      ``,
    ];

    let body: string[];
    if (isForm) {
      body = [
        `   ┌───────────────────────────────────┐`,
        `   │  [ Logo ]            [ Theme ◐ ]  │  ← sticky header (h-16)`,
        `   ├───────────────────────────────────┤`,
        `   │                                   │`,
        `   │        ${intent.subject}           │  ← h1, text-center`,
        `   │        Subtitle copy goes here    │  ← text-muted`,
        `   │                                   │`,
        `   │   ┌─────────────────────────┐     │`,
        `   │   │  Email                  │     │  ← input w/ label`,
        `   │   └─────────────────────────┘     │`,
        `   │   ┌─────────────────────────┐     │`,
        `   │   │  Password         [show]│     │  ← input + icon-btn`,
        `   │   └─────────────────────────┘     │`,
        `   │   □ Remember me    Forgot?         │  ← checkbox + link`,
        `   │                                   │`,
        `   │   ┌─────────────────────────┐     │`,
        `   │   │      Sign in            │     │  ← Button primary, w-full`,
        `   │   └─────────────────────────┘     │`,
        `   │                                   │`,
        `   │   ─── or continue with ───        │  ← divider`,
        `   │                                   │`,
        `   │   [G] [GitHub] [Apple] [SSO]      │  ← OAuth button row`,
        `   │                                   │`,
        `   │   Don't have an account? Sign up  │  ← footer link`,
        `   │                                   │`,
        `   └───────────────────────────────────┘`,
      ];
    } else if (isTable) {
      body = [
        `   ┌───────────────────────────────────────────────────────┐`,
        `   │  [Search…]              [Filter] [+ New]              │  ← toolbar`,
        `   ├───────────────────────────────────────────────────────┤`,
        `   │  □  │ Column A ▲ │ Column B   │ Column C │ Actions    │  ← thead (sortable)`,
        `   ├────┼────────────┼────────────┼──────────┼─────────────┤`,
        `   │  □ │ row-1      │ value      │ value    │ [⋯] [🗑]    │`,
        `   │  □ │ row-2      │ value      │ value    │ [⋯] [🗑]    │`,
        `   │  □ │ row-3      │ value      │ value    │ [⋯] [🗑]    │`,
        `   │  □ │ row-4      │ value      │ value    │ [⋯] [🗑]    │`,
        `   │  □ │ row-5      │ value      │ value    │ [⋯] [🗑]    │`,
        `   ├────┴────────────┴────────────┴──────────┴─────────────┤`,
        `   │  5 of 48 rows                  ‹ 1 2 3 … 10 ›         │  ← pagination`,
        `   └───────────────────────────────────────────────────────┘`,
      ];
    } else if (isSettings) {
      body = [
        `   ┌───────────────────────────────────────────────────────┐`,
        `   │  Settings                                              │`,
        `   ├──────────────┬────────────────────────────────────────┤`,
        `   │  ▸ General   │  General settings                      │`,
        `   │    Auth      │  ┌────────────────────────────────┐    │`,
        `   │    Memory    │  │  Project name            [⋯]  │    │`,
        `   │    Notif.    │  └────────────────────────────────┘    │`,
        `   │    Billing   │  ┌────────────────────────────────┐    │`,
        `   │    API keys  │  │  Timezone                  [▾] │    │`,
        `   │              │  └────────────────────────────────┘    │`,
        `   │              │  □ Send error reports                   │`,
        `   │              │  □ Enable beta features                 │`,
        `   │              │                          [Save] [Cancel] │`,
        `   └──────────────┴────────────────────────────────────────┘`,
      ];
    } else if (isNav) {
      body = [
        `   ┌───────────────────────────────────────────────────────┐`,
        `   │  [Logo]   Home  Products  Docs  Pricing   [Search] [☰]│  ← desktop nav`,
        `   └───────────────────────────────────────────────────────┘`,
        `   On mobile (<768px): hamburger menu opens a slide-in drawer.`,
      ];
    } else {
      body = [
        `   ┌───────────────────────────────────┐`,
        `   │  [ Header bar — h-16, sticky ]    │`,
        `   ├───────────────────────────────────┤`,
        `   │                                   │`,
        `   │   ${intent.subject}                 │`,
        `   │                                   │`,
        `   │   ┌─────────┐  ┌─────────┐         │`,
        `   │   │ Block 1 │  │ Block 2 │         │  ← responsive grid`,
        `   │   └─────────┘  └─────────┘         │     (1 col mobile,`,
        `   │   ┌─────────┐  ┌─────────┐         │      2 col tablet,`,
        `   │   │ Block 3 │  │ Block 4 │         │      4 col desktop)`,
        `   │   └─────────┘  └─────────┘         │`,
        `   │                                   │`,
        `   ├───────────────────────────────────┤`,
        `   │  [ Footer ]                       │`,
        `   └───────────────────────────────────┘`,
      ];
    }

    const notes = [
      ``,
      `## Layout notes`,
      ``,
      `- Mobile-first: base styles target 375 px. Use \`sm:\` (640), \`md:\` (768), \`lg:\` (1024), \`xl:\` (1280), \`2xl:\` (1440).`,
      `- 8 px spacing grid: 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64.`,
      `- Touch targets ≥ 44 × 44 px (Fitts's law).`,
      `- Progressive disclosure: secondary actions collapsed behind \`[⋯]\` or a disclosure.`,
      intent.darkMode ? `- Dark mode: every color references a CSS variable so \`[data-theme='dark']\` flips the palette.'` : `- Light mode (extend with \`data-theme='dark'\` when ready).`,
    ];

    return [...header, ...body, ...notes].join('\n');
  }

  /** Generate a markdown component-tree doc. */
  protected generateComponentTree(intent: UIDesignerIntent): string {
    const lines: string[] = [];
    lines.push(`# Component Tree — ${intent.subject}`);
    lines.push('');
    lines.push('```');
    lines.push(`<${intent.subject}>`);
    lines.push('  ├── <Header>                    // sticky, h-16, brand + actions');
    lines.push('  │   ├── <Brand />');
    lines.push('  │   └── <ThemeToggle />         // aria-label="Toggle theme"');
    lines.push('  ├── <main>');
    lines.push('  │   ├── <Hero>                  // h1 + subtitle, text-center');
    if (/login|form|auth/i.test(intent.subject)) {
      lines.push('  │   ├── <Form>                  // <form> with onSubmit');
      lines.push('  │   │   ├── <TextField name="email">');
      lines.push('  │   │   ├── <TextField name="password" trailing={<ShowHide />}>');
      lines.push('  │   │   ├── <Checkbox name="remember">');
      lines.push('  │   │   └── <Button variant="primary" type="submit">');
      lines.push('  │   └── <OAuthButtons>          // grid of provider buttons');
      lines.push('  │       ├── <OAuthButton provider="google">');
      lines.push('  │       └── <OAuthButton provider="github">');
    } else if (/table|grid|list/i.test(intent.subject)) {
      lines.push('  │   ├── <Toolbar>               // search + filter + new');
      lines.push('  │   ├── <Table>');
      lines.push('  │   │   ├── <TableHead>         // sortable columns');
      lines.push('  │   │   └── <TableBody>');
      lines.push('  │   │       └── <TableRow> × N');
      lines.push('  │   └── <Pagination>            // page size + nav');
    } else if (/settings|config/i.test(intent.subject)) {
      lines.push('  │   ├── <TabList>                // vertical on desktop, horizontal on mobile');
      lines.push('  │   │   ├── <Tab id="general">');
      lines.push('  │   │   ├── <Tab id="auth">');
      lines.push('  │   │   ├── <Tab id="memory">');
      lines.push('  │   │   └── <Tab id="notifications">');
      lines.push('  │   └── <TabPanel>               // renders active section');
    } else {
      lines.push('  │   ├── <Section variant="hero">');
      lines.push('  │   └── <Grid cols={4}>');
      lines.push('  │       └── <Card> × N           // responsive 1→2→4 cols');
    }
    lines.push('  └── <Footer />');
    lines.push('```');
    lines.push('');
    lines.push('## Props interface (sketch)');
    lines.push('');
    lines.push('```ts');
    lines.push(`export interface ${intent.subject}Props {`);
    lines.push(`  /** Optional title override. */`);
    lines.push(`  title?: string;`);
    lines.push(`  /** Optional className passthrough. */`);
    lines.push(`  className?: string;`);
    lines.push(`  /** Optional children for the main slot. */`);
    lines.push(`  children?: React.ReactNode;`);
    if (/table|grid/i.test(intent.subject)) {
      lines.push(`  /** Row data (controlled). */`);
      lines.push(`  rows: ReadonlyArray<Record<string, unknown>>;`);
      lines.push(`  /** Column definitions. */`);
      lines.push(`  columns: ReadonlyArray<{ key: string; header: string; sortable?: boolean }>;`);
      lines.push(`  /** Current page (1-indexed). */`);
      lines.push(`  page: number;`);
      lines.push(`  /** Total row count (for pagination). */`);
      lines.push(`  total: number;`);
      lines.push(`  /** Page size. */`);
      lines.push(`  pageSize?: number;`);
      lines.push(`  /** Sort change handler. */`);
      lines.push(`  onSortChange?: (key: string, dir: 'asc' | 'desc') => void;`);
      lines.push(`  /** Page change handler. */`);
      lines.push(`  onPageChange?: (page: number) => void;`);
    }
    lines.push(`}`);
    lines.push('```');
    return lines.join('\n');
  }

  /** Generate the CSS custom-property tokens file. */
  protected generateTokensCss(intent: UIDesignerIntent): string {
    const palette = this.generatePalette(intent);
    const type = this.generateTypography();
    const lines: string[] = [];
    lines.push(`/* Design tokens for ${intent.subject} — generated by SANIX UI/UX Designer. */`);
    lines.push(`/* Light theme (default) */`);
    lines.push(`:root {`);
    lines.push(`  /* Color palette */`);
    for (const c of palette) {
      lines.push(`  --color-${c.role}-${c.shade}: ${c.hex};`);
    }
    lines.push('');
    lines.push(`  /* Semantic colors */`);
    lines.push(`  --color-bg: var(--color-neutral-50);`);
    lines.push(`  --color-bg-elevated: var(--color-neutral-0);`);
    lines.push(`  --color-fg: var(--color-neutral-900);`);
    lines.push(`  --color-fg-muted: var(--color-neutral-500);`);
    lines.push(`  --color-border: var(--color-neutral-200);`);
    lines.push(`  --color-focus: var(--color-primary-500);`);
    lines.push(`  --color-success: #16a34a;`);
    lines.push(`  --color-warning: #d97706;`);
    lines.push(`  --color-danger:  #dc2626;`);
    lines.push('');
    lines.push(`  /* Typography */`);
    for (const t of type) {
      lines.push(`  --font-${t.token}-size: ${t.fontSizePx}px;`);
      lines.push(`  --font-${t.token}-line: ${t.lineHeight};`);
      lines.push(`  --font-${t.token}-weight: ${t.fontWeight};`);
      if (t.letterSpacingEm !== undefined) lines.push(`  --font-${t.token}-tracking: ${t.letterSpacingEm}em;`);
    }
    lines.push(`  --font-sans: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;`);
    lines.push(`  --font-mono: ui-monospace, 'SF Mono', Menlo, Monaco, Consolas, monospace;`);
    lines.push('');
    lines.push(`  /* Spacing (8px grid) */`);
    for (const s of SPACING_SCALE) lines.push(`  --space-${s}: ${s}px;`);
    lines.push('');
    lines.push(`  /* Radii */`);
    lines.push(`  --radius-sm: 4px;`);
    lines.push(`  --radius-md: 8px;`);
    lines.push(`  --radius-lg: 12px;`);
    lines.push(`  --radius-full: 9999px;`);
    lines.push('');
    lines.push(`  /* Shadows */`);
    lines.push(`  --shadow-sm: 0 1px 2px rgba(0,0,0,0.05);`);
    lines.push(`  --shadow-md: 0 4px 6px -1px rgba(0,0,0,0.10), 0 2px 4px -2px rgba(0,0,0,0.10);`);
    lines.push(`  --shadow-lg: 0 10px 15px -3px rgba(0,0,0,0.10), 0 4px 6px -4px rgba(0,0,0,0.05);`);
    lines.push('');
    lines.push(`  /* Motion */`);
    lines.push(`  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);`);
    lines.push(`  --duration-fast: 150ms;`);
    lines.push(`  --duration-base: 200ms;`);
    lines.push(`  --duration-slow: 300ms;`);
    lines.push('}');
    if (intent.darkMode) {
      lines.push('');
      lines.push(`/* Dark theme */`);
      lines.push(`[data-theme='dark'] {`);
      lines.push(`  --color-bg: var(--color-neutral-950);`);
      lines.push(`  --color-bg-elevated: var(--color-neutral-900);`);
      lines.push(`  --color-fg: var(--color-neutral-50);`);
      lines.push(`  --color-fg-muted: var(--color-neutral-400);`);
      lines.push(`  --color-border: var(--color-neutral-800);`);
      lines.push(`  --color-success: #4ade80;`);
      lines.push(`  --color-warning: #fbbf24;`);
      lines.push(`  --color-danger:  #f87171;`);
      lines.push('}');
    }
    return lines.join('\n');
  }

  /** Generate the actual component source (React/Vue/Svelte/HTML). */
  protected generateComponent(intent: UIDesignerIntent): string {
    if (intent.framework === 'vue') return this.generateVueComponent(intent);
    if (intent.framework === 'svelte') return this.generateSvelteComponent(intent);
    if (intent.framework === 'html') return this.generateHtmlComponent(intent);
    return this.generateReactComponent(intent);
  }

  /** Generate a React component with Tailwind classes (or CSS Modules). */
  protected generateReactComponent(intent: UIDesignerIntent): string {
    const subject = intent.subject;
    const isForm = /login|form|auth/i.test(subject);
    const isTable = /table|grid/i.test(subject);
    const isSettings = /settings|config/i.test(subject);

    const baseImport =
      intent.styling === 'css-modules'
        ? `import styles from './${subject}.module.css';`
        : '';

    const lines: string[] = [];
    lines.push(`/**`);
    lines.push(` * ${subject} — generated by SANIX UI/UX Designer.`);
    lines.push(` * Framework: React · Styling: ${intent.styling} · Dark-mode: ${intent.darkMode}`);
    lines.push(` */`);
    lines.push(`import * as React from 'react';`);
    if (baseImport) lines.push(baseImport);
    lines.push(`import { motion, type Variants } from 'framer-motion';`);
    lines.push(`import { motionVariants } from './motion';`);
    lines.push('');
    lines.push(`export interface ${subject}Props {`);
    if (isTable) {
      lines.push(`  rows: ReadonlyArray<Record<string, unknown>>;`);
      lines.push(`  columns: ReadonlyArray<{ key: string; header: string; sortable?: boolean }>;`);
      lines.push(`  page: number;`);
      lines.push(`  pageSize?: number;`);
      lines.push(`  total: number;`);
      lines.push(`  sortKey?: string;`);
      lines.push(`  sortDir?: 'asc' | 'desc';`);
      lines.push(`  onSortChange?: (key: string, dir: 'asc' | 'desc') => void;`);
      lines.push(`  onPageChange?: (page: number) => void;`);
    } else {
      lines.push(`  title?: string;`);
      lines.push(`  className?: string;`);
      lines.push(`  children?: React.ReactNode;`);
    }
    lines.push(`}`);
    lines.push('');
    lines.push(`export function ${subject}(props: ${subject}Props): React.ReactElement {`);

    if (isTable) {
      lines.push(`  const { rows, columns, page, pageSize = 10, total, sortKey, sortDir = 'asc', onSortChange, onPageChange } = props;`);
      lines.push(`  const pageCount = Math.max(1, Math.ceil(total / pageSize));`);
      lines.push(`  const handleSort = (key: string) => {`);
      lines.push(`    if (!onSortChange) return;`);
      lines.push(`    const nextDir = sortKey === key && sortDir === 'asc' ? 'desc' : 'asc';`);
      lines.push(`    onSortChange(key, nextDir);`);
      lines.push(`  };`);
      lines.push(`  const cls = (extra?: string) => (props.className ? \`\${props.className} \${extra ?? ''}\` : extra);`);
      lines.push(`  return (`);
      lines.push(`    <div className={cls('w-full')}>`);
      lines.push(`      <div className="overflow-x-auto rounded-lg border" style={{ borderColor: 'var(--color-border)' }} role="region" aria-label="${subject}">`);
      lines.push(`        <table className="w-full text-sm">`);
      lines.push(`          <thead className="bg-neutral-50 dark:bg-neutral-900">`);
      lines.push(`            <tr>`);
      lines.push(`              {columns.map((col) => (`);
      lines.push(`                <th key={col.key} scope="col" className="px-4 py-3 text-left font-medium">`);
      lines.push(`                  {col.sortable ? (`);
      lines.push(`                    <button type="button" onClick={() => handleSort(col.key)} className="inline-flex items-center gap-1 hover:text-primary-500 focus-visible:text-primary-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">`);
      lines.push(`                      {col.header}`);
      lines.push(`                      {sortKey === col.key ? (sortDir === 'asc' ? '▲' : '▼') : '↕'}`);
      lines.push(`                      <span className="sr-only">Sort by {col.header}</span>`);
      lines.push(`                    </button>`);
      lines.push(`                  ) : (col.header)}`);
      lines.push(`                </th>`);
      lines.push(`              ))}`);
      lines.push(`            </tr>`);
      lines.push(`          </thead>`);
      lines.push(`          <tbody>`);
      lines.push(`            {rows.length === 0 ? (`);
      lines.push(`              <tr><td colSpan={columns.length} className="px-4 py-12 text-center text-neutral-500">No data.</td></tr>`);
      lines.push(`            ) : rows.map((row, i) => (`);
      lines.push(`              <motion.tr key={i} variants={motionVariants.enter} initial="hidden" animate="visible" className="border-t" style={{ borderColor: 'var(--color-border)' }}>`);
      lines.push(`                {columns.map((col) => (`);
      lines.push(`                  <td key={col.key} className="px-4 py-3">{String(row[col.key] ?? '')}</td>`);
      lines.push(`                ))}`);
      lines.push(`              </motion.tr>`);
      lines.push(`            ))}`);
      lines.push(`          </tbody>`);
      lines.push(`        </table>`);
      lines.push(`      </div>`);
      lines.push(`      <nav aria-label="Pagination" className="mt-4 flex items-center justify-between text-sm">`);
      lines.push(`        <span className="text-neutral-500">Page {page} of {pageCount}</span>`);
      lines.push(`        <div className="flex gap-2">`);
      lines.push(`          <button type="button" disabled={page <= 1} onClick={() => onPageChange?.(page - 1)} className="rounded-md border px-3 py-1.5 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">‹ Prev</button>`);
      lines.push(`          <button type="button" disabled={page >= pageCount} onClick={() => onPageChange?.(page + 1)} className="rounded-md border px-3 py-1.5 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">Next ›</button>`);
      lines.push(`        </div>`);
      lines.push(`      </nav>`);
      lines.push(`    </div>`);
      lines.push(`  );`);
    } else if (isForm) {
      lines.push(`  const { title = '${subject}', className, children } = props;`);
      lines.push(`  const [showPw, setShowPw] = React.useState(false);`);
      lines.push(`  const cls = (extra?: string) => (className ? \`\${className} \${extra ?? ''}\` : extra);`);
      lines.push(`  return (`);
      lines.push(`    <motion.div variants={motionVariants.enter} initial="hidden" animate="visible" className={cls('mx-auto w-full max-w-md p-8 rounded-xl border bg-white dark:bg-neutral-950 shadow-md')} style={{ borderColor: 'var(--color-border)' }}>`);
      lines.push(`      <h1 className="text-center text-2xl font-semibold" style={{ color: 'var(--color-fg)' }}>{title}</h1>`);
      lines.push(`      <p className="mt-1 text-center text-sm" style={{ color: 'var(--color-fg-muted)' }}>Sign in to your account</p>`);
      lines.push(`      <form className="mt-8 space-y-4" onSubmit={(e) => e.preventDefault()}>`);
      lines.push(`        <div>`);
      lines.push(`          <label htmlFor="email" className="block text-sm font-medium">Email</label>`);
      lines.push(`          <input id="email" type="email" required autoComplete="email" className="mt-1 w-full rounded-md border px-3 py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2" style={{ borderColor: 'var(--color-border)' }} />`);
      lines.push(`        </div>`);
      lines.push(`        <div>`);
      lines.push(`          <label htmlFor="password" className="block text-sm font-medium">Password</label>`);
      lines.push(`          <div className="relative mt-1">`);
      lines.push(`            <input id="password" type={showPw ? 'text' : 'password'} required autoComplete="current-password" className="w-full rounded-md border px-3 py-2 pr-10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2" style={{ borderColor: 'var(--color-border)' }} />`);
      lines.push(`            <button type="button" aria-label={showPw ? 'Hide password' : 'Show password'} onClick={() => setShowPw(!showPw)} className="absolute inset-y-0 right-0 px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">`);
      lines.push(`              {showPw ? '🙈' : '👁'}`);
      lines.push(`            </button>`);
      lines.push(`          </div>`);
      lines.push(`        </div>`);
      lines.push(`        <div className="flex items-center justify-between text-sm">`);
      lines.push(`          <label className="inline-flex items-center gap-2"><input type="checkbox" /> Remember me</label>`);
      lines.push(`          <a href="#" className="text-primary-500 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">Forgot?</a>`);
      lines.push(`        </div>`);
      lines.push(`        <button type="submit" className="w-full rounded-md bg-primary-500 px-4 py-2.5 font-medium text-white hover:bg-primary-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">Sign in</button>`);
      lines.push(`      </form>`);
      lines.push(`      <div className="mt-6 flex items-center gap-3 text-xs text-neutral-500"><span className="h-px flex-1 bg-neutral-200" /> or continue with <span className="h-px flex-1 bg-neutral-200" /></div>`);
      lines.push(`      <div className="mt-4 grid grid-cols-2 gap-2">`);
      lines.push(`        {['Google', 'GitHub', 'Apple', 'SSO'].map((p) => (`);
      lines.push(`          <button key={p} type="button" className="rounded-md border px-3 py-2 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2" style={{ borderColor: 'var(--color-border)' }}>{p}</button>`);
      lines.push(`        ))}`);
      lines.push(`      </div>`);
      lines.push(`      {children}`);
      lines.push(`    </motion.div>`);
      lines.push(`  );`);
    } else if (isSettings) {
      lines.push(`  const { title = '${subject}', className, children } = props;`);
      lines.push(`  const [active, setActive] = React.useState('general');`);
      lines.push(`  const tabs = [{ id: 'general', label: 'General' }, { id: 'auth', label: 'Auth' }, { id: 'memory', label: 'Memory' }, { id: 'notifications', label: 'Notifications' }] as const;`);
      lines.push(`  const cls = (extra?: string) => (className ? \`\${className} \${extra ?? ''}\` : extra);`);
      lines.push(`  return (`);
      lines.push(`    <div className={cls('mx-auto w-full max-w-5xl')}>`);
      lines.push(`      <h1 className="text-2xl font-semibold" style={{ color: 'var(--color-fg)' }}>{title}</h1>`);
      lines.push(`      <div className="mt-6 grid gap-6 md:grid-cols-[200px_1fr]">`);
      lines.push(`        <nav aria-label="Settings sections" className="flex gap-1 overflow-x-auto md:flex-col">`);
      lines.push(`          {tabs.map((t) => (`);
      lines.push(`            <button key={t.id} type="button" aria-current={active === t.id ? 'page' : undefined} onClick={() => setActive(t.id)} className="whitespace-nowrap rounded-md px-3 py-2 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 data-[active='true']:bg-primary-50 data-[active='true']:text-primary-600" data-active={active === t.id}>{t.label}</button>`);
      lines.push(`          ))}`);
      lines.push(`        </nav>`);
      lines.push(`        <section aria-labelledby="active-tab" className="rounded-lg border p-6" style={{ borderColor: 'var(--color-border)' }}>`);
      lines.push(`          <h2 id="active-tab" className="text-lg font-medium">{tabs.find((t) => t.id === active)?.label}</h2>`);
      lines.push(`          <div className="mt-4 space-y-4 text-sm">{children ?? <p className="text-neutral-500">Configure {active} settings here.</p>}</div>`);
      lines.push(`        </section>`);
      lines.push(`      </div>`);
      lines.push(`    </div>`);
      lines.push(`  );`);
    } else {
      lines.push(`  const { title = '${subject}', className, children } = props;`);
      lines.push(`  const cls = (extra?: string) => (className ? \`\${className} \${extra ?? ''}\` : extra);`);
      lines.push(`  return (`);
      lines.push(`    <div className={cls('min-h-screen flex flex-col')}>`);
      lines.push(`      <header className="sticky top-0 z-10 h-16 border-b bg-white/80 backdrop-blur dark:bg-neutral-950/80" style={{ borderColor: 'var(--color-border)' }}>`);
      lines.push(`        <div className="mx-auto flex h-full max-w-6xl items-center justify-between px-4">`);
      lines.push(`          <span className="font-semibold">${subject}</span>`);
      lines.push(`          <button type="button" aria-label="Toggle menu" className="md:hidden focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">☰</button>`);
      lines.push(`        </div>`);
      lines.push(`      </header>`);
      lines.push(`      <main className="flex-1">`);
      lines.push(`        <motion.section variants={motionVariants.enter} initial="hidden" animate="visible" className="mx-auto max-w-6xl px-4 py-12">`);
      lines.push(`          <h1 className="text-center text-4xl font-bold">{title}</h1>`);
      lines.push(`          <p className="mt-2 text-center text-neutral-500">Responsive · accessible · ${intent.styling}</p>`);
      lines.push(`          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{children}</div>`);
      lines.push(`        </motion.section>`);
      lines.push(`      </main>`);
      lines.push(`      <footer className="border-t py-6 text-center text-sm text-neutral-500" style={{ borderColor: 'var(--color-border)' }}>© {new Date().getFullYear()} ${subject}</footer>`);
      lines.push(`    </div>`);
      lines.push(`  );`);
    }
    lines.push(`}`);
    lines.push('');
    lines.push(`export default ${subject};`);
    return lines.join('\n');
  }

  /** Generate a minimal Vue 3 SFC. */
  protected generateVueComponent(intent: UIDesignerIntent): string {
    const subject = intent.subject;
    return [
      `<!-- ${subject} — generated by SANIX UI/UX Designer. Vue 3 SFC. -->`,
      `<template>`,
      `  <div class="${subject.toLowerCase()}">`,
      `    <header class="header">`,
      `      <span class="brand">${subject}</span>`,
      `      <button type="button" aria-label="Toggle menu" class="menu-btn">☰</button>`,
      `    </header>`,
      `    <main class="main">`,
      `      <h1>{{ title }}</h1>`,
      `      <slot />`,
      `    </main>`,
      `    <footer class="footer">© {{ year }} ${subject}</footer>`,
      `  </div>`,
      `</template>`,
      ``,
      `<script setup lang="ts">`,
      `import { computed } from 'vue';`,
      ``,
      `const props = withDefaults(defineProps<{ title?: string }>(), { title: '${subject}' });`,
      `const year = computed(() => new Date().getFullYear());`,
      `</script>`,
      ``,
      `<style scoped>`,
      `.${subject.toLowerCase()} { min-height: 100vh; display: flex; flex-direction: column; }`,
      `.header { position: sticky; top: 0; height: 64px; display: flex; align-items: center; justify-content: space-between; padding: 0 var(--space-16); border-bottom: 1px solid var(--color-border); }`,
      `.main { flex: 1; max-width: 1024px; margin: 0 auto; padding: var(--space-48) var(--space-16); }`,
      `.footer { border-top: 1px solid var(--color-border); padding: var(--space-24); text-align: center; }`,
      `@media (max-width: 768px) { .header { padding: 0 var(--space-12); } }`,
      `</style>`,
      ``,
    ].join('\n');
  }

  /** Generate a minimal Svelte component. */
  protected generateSvelteComponent(intent: UIDesignerIntent): string {
    const subject = intent.subject;
    return [
      `<!-- ${subject} — generated by SANIX UI/UX Designer. Svelte. -->`,
      `<script lang="ts">`,
      `  export let title: string = '${subject}';`,
      `</script>`,
      ``,
      `<div class="${subject.toLowerCase()}">`,
      `  <header class="header">`,
      `    <span class="brand">${subject}</span>`,
      `    <button type="button" aria-label="Toggle menu">☰</button>`,
      `  </header>`,
      `  <main class="main">`,
      `    <h1>{title}</h1>`,
      `    <slot />`,
      `  </main>`,
      `  <footer class="footer">© {new Date().getFullYear()} ${subject}</footer>`,
      `</div>`,
      ``,
      `<style>`,
      `  .${subject.toLowerCase()} { min-height: 100vh; display: flex; flex-direction: column; }`,
      `  .header { position: sticky; top: 0; height: 64px; display: flex; align-items: center; justify-content: space-between; padding: 0 var(--space-16); border-bottom: 1px solid var(--color-border); }`,
      `  .main { flex: 1; max-width: 1024px; margin: 0 auto; padding: var(--space-48) var(--space-16); }`,
      `  .footer { border-top: 1px solid var(--color-border); padding: var(--space-24); text-align: center; }`,
      `  @media (max-width: 768px) { .header { padding: 0 var(--space-12); } }`,
      `</style>`,
      ``,
    ].join('\n');
  }

  /** Generate a standalone HTML page (no framework). */
  protected generateHtmlComponent(intent: UIDesignerIntent): string {
    const subject = intent.subject;
    return [
      `<!doctype html>`,
      `<!-- ${subject} — generated by SANIX UI/UX Designer. Vanilla HTML. -->`,
      `<html lang="en"${intent.darkMode ? ` data-theme="light"` : ''}>`,
      `<head>`,
      `  <meta charset="utf-8" />`,
      `  <meta name="viewport" content="width=device-width, initial-scale=1" />`,
      `  <title>${subject}</title>`,
      `  <link rel="stylesheet" href="./tokens.css" />`,
      `</head>`,
      `<body>`,
      `  <header class="header">`,
      `    <span class="brand">${subject}</span>`,
      `    <button type="button" aria-label="Toggle menu">☰</button>`,
      `  </header>`,
      `  <main class="main">`,
      `    <h1>${subject}</h1>`,
      `    <p>Responsive · accessible · vanilla HTML.</p>`,
      `  </main>`,
      `  <footer class="footer">© <span id="year"></span> ${subject}</footer>`,
      `  <script>document.getElementById('year').textContent = new Date().getFullYear();</script>`,
      `</body>`,
      `</html>`,
      ``,
    ].join('\n');
  }

  /** Generate a Storybook story (React only). */
  protected generateStory(intent: UIDesignerIntent): string {
    const subject = intent.subject;
    return [
      `/** ${subject}.stories.tsx — generated by SANIX UI/UX Designer. */`,
      `import type { Meta, StoryObj } from '@storybook/react';`,
      `import { ${subject} } from './${subject}';`,
      ``,
      `const meta: Meta<typeof ${subject}> = {`,
      `  title: 'Design/${subject}',`,
      `  component: ${subject},`,
      `  parameters: { layout: 'padded' },`,
      `  tags: ['autodocs'],`,
      `};`,
      `export default meta;`,
      ``,
      `type Story = StoryObj<typeof ${subject}>;`,
      ``,
      `export const Default: Story = { args: { title: '${subject}' } };`,
      ``,
      `export const DarkMode: Story = {`,
      `  args: { title: '${subject} (dark)' },`,
      `  parameters: { backgrounds: { default: 'dark' } },`,
      `  decorators: [(Story) => {`,
      `    const el = document.createElement('div');`,
      `    el.setAttribute('data-theme', 'dark');`,
      `    el.style.minHeight = '100vh';`,
      `    el.appendChild(document.createElement('div'));`,
      `    return el;`,
      `  }],`,
      `};`,
      ``,
    ].join('\n');
  }

  /** Generate a usage doc for non-React frameworks. */
  protected generateUsageDoc(intent: UIDesignerIntent): string {
    const subject = intent.subject;
    return [
      `# ${subject} — usage`,
      ``,
      `Generated by SANIX UI/UX Designer.`,
      ``,
      `## Framework`,
      `- ${intent.framework}`,
      `- Styling: ${intent.styling}`,
      `- Dark-mode aware: ${intent.darkMode}`,
      ``,
      `## Integration`,
      ``,
      `1. Copy \`${subject}.${intent.framework === 'vue' ? 'vue' : intent.framework === 'svelte' ? 'svelte' : 'html'}\` into your components directory.`,
      `2. Import the design tokens (\`tokens.css\`) once at the app root.`,
      `3. Wire up dark mode by toggling \`data-theme="dark"\` on the \`<html>\` element.`,
      ``,
      `## Responsive breakpoints`,
      ``,
      `| Breakpoint | Width | Tailwind |`,
      `| --- | --- | --- |`,
      `| mobile | 375 px | (base) |`,
      `| tablet | 768 px | \`md:\` |`,
      `| desktop | 1024 px | \`lg:\` |`,
      `| wide | 1440 px | \`2xl:\` |`,
      ``,
      `## Accessibility`,
      ``,
      `See \`accessibility.md\` for the full checklist applied to this component.`,
      ``,
    ].join('\n');
  }

  /** Generate a Vitest test stub. */
  protected generateTest(intent: UIDesignerIntent): string {
    const subject = intent.subject;
    return [
      `/** ${subject}.test.tsx — generated by SANIX UI/UX Designer. */`,
      `import { describe, it, expect } from 'vitest';`,
      `import { render, screen } from '@testing-library/react';`,
      `import { ${subject} } from './${subject}';`,
      ``,
      `describe('${subject}', () => {`,
      `  it('renders the title', () => {`,
      `    render(<${subject} title="Hello" />);`,
      `    expect(screen.getByRole('heading', { name: /hello/i })).toBeDefined();`,
      `  });`,
      ``,
      `  it('meets WCAG: no empty buttons', () => {`,
      `    render(<${subject} />);`,
      `    const buttons = screen.queryAllByRole('button');`,
      `    for (const b of buttons) {`,
      `      const name = (b.getAttribute('aria-label') ?? b.textContent ?? '').trim();`,
      `      expect(name.length, 'button has accessible name').toBeGreaterThan(0);`,
      `    }`,
      `  });`,
      `});`,
      ``,
    ].join('\n');
  }

  /** Generate Framer Motion variants. */
  protected generateMotion(intent: UIDesignerIntent): string {
    return [
      `/** motion.ts — Framer Motion variants for ${intent.subject}. Generated by SANIX UI/UX Designer. */`,
      `import type { Variants } from 'framer-motion';`,
      ``,
      `export const motionVariants = {`,
      `  enter: {`,
      `    hidden: { opacity: 0, y: 8 },`,
      `    visible: { opacity: 1, y: 0, transition: { duration: 0.3, ease: [0.16, 1, 0.3, 1] } },`,
      `    exit: { opacity: 0, y: -8, transition: { duration: 0.2 } },`,
      `  } satisfies Variants,`,
      `  hover: {`,
      `    rest: { scale: 1 },`,
      `    hover: { scale: 1.02, transition: { duration: 0.15 } },`,
      `    pressed: { scale: 0.98, transition: { duration: 0.1 } },`,
      `  } satisfies Variants,`,
      `  feedback: {`,
      `    loading: { opacity: 0.6, transition: { duration: 0.2 } },`,
      `    success: { opacity: 1, transition: { duration: 0.2 } },`,
      `    error: { x: [0, -4, 4, -4, 4, 0], transition: { duration: 0.3 } },`,
      `  } satisfies Variants,`,
      `} as const;`,
      ``,
    ].join('\n');
  }

  /** Generate an accessibility checklist. */
  protected generateA11yChecklist(_intent: UIDesignerIntent): string {
    return [
      `# Accessibility checklist — ${_intent.subject}`,
      ``,
      `Generated by SANIX UI/UX Designer. Verify each item before shipping.`,
      ``,
      `## Perceivable`,
      `- [ ] All images have \`alt\` (decorative → \`alt=""\`)`,
      `- [ ] Color contrast ≥ 4.5:1 body, ≥ 3:1 large text (WCAG AA)`,
      `- [ ] No information conveyed by color alone`,
      `- [ ] Page has a logical heading hierarchy (one \`h1\`, no skipped levels)`,
      ``,
      `## Operable`,
      `- [ ] All interactive elements reachable via keyboard (Tab/Shift+Tab)`,
      `- [ ] Visible focus indicator (\`:focus-visible\`) on every focusable element`,
      `- [ ] No keyboard traps`,
      `- [ ] Touch targets ≥ 44 × 44 px`,
      `- [ ] Skip-to-content link present`,
      ``,
      `## Understandable`,
      `- [ ] Form inputs have associated \`<label>\` (or \`aria-label\`)`,
      `- [ ] Error messages are announced (\`aria-live\`, \`role="alert"\`)`,
      `- [ ] Instructions are clear and adjacent to controls`,
      ``,
      `## Robust`,
      `- [ ] Valid HTML (no duplicate \`id\`s, proper nesting)`,
      `- [ ] ARIA used sparingly — only when native semantics are insufficient`,
      `- [ ] Tested with a screen reader (VoiceOver / NVDA)`,
      `- [ ] Tested at 200% zoom`,
      ``,
    ].join('\n');
  }

  // ── Mode: design-system ────────────────────────────────────────────────────

  /**
   * Generate a complete design-system package: tokens.css,
   * tailwind.config.ts, tokens.json (Figma-compatible), and a
   * component-variants reference doc.
   */
  protected async runDesignSystem(ctx: RunContext, intent: UIDesignerIntent): Promise<void> {
    const dir = path.join(ctx.opts.cwd, 'design-output', 'design-system');
    this.emitProgress('analyze', 'Generating design-system package…', undefined, ctx);

    const tokens = this.generateTokensCss(intent);
    await this.writeFileSafe(path.join(dir, 'tokens.css'), tokens, ctx);

    const tailwind = this.generateTailwindConfig(intent);
    await this.writeFileSafe(path.join(dir, 'tailwind.config.ts'), tailwind, ctx);

    const figma = this.generateFigmaTokens(intent);
    await this.writeFileSafe(path.join(dir, 'tokens.json'), figma, ctx);

    const variants = this.generateComponentVariantsDoc(intent);
    await this.writeFileSafe(path.join(dir, 'component-variants.md'), variants, ctx);

    this.addFinding(ctx, {
      severity: 'info',
      category: 'ui-design:design-system',
      title: 'Design system package generated',
      description: `Generated a 4-file design-system package under \`design-output/design-system/\`: \`tokens.css\` (CSS custom properties + ${intent.darkMode ? 'light/dark themes' : 'light theme'}), \`tailwind.config.ts\` (extended theme with palette, typography, spacing), \`tokens.json\` (Figma-compatible token export), and \`component-variants.md\` (button/input/card variant reference). Palette: ${this.describePalette(intent)}.`,
      file: path.relative(ctx.opts.cwd, dir) || dir,
      suggestion: 'Import tokens.css at your app root and extend your tailwind.config with the generated values.',
      autoFixable: false,
      tags: ['ui', 'design-system', 'tokens'],
    });
    ctx.output = `Design system generated at ${path.relative(ctx.opts.cwd, dir) || dir}. 4 files written.`;
    this.recordMetric(ctx, 'filesGenerated', 4, 'set');
  }

  /** Generate an extended Tailwind config from the design tokens. */
  protected generateTailwindConfig(intent: UIDesignerIntent): string {
    const palette = this.generatePalette(intent);
    const type = this.generateTypography();
    const roles = [...new Set(palette.map((p) => p.role))];
    return [
      `// tailwind.config.ts — generated by SANIX UI/UX Designer.`,
      `import type { Config } from 'tailwindcss';`,
      ``,
      `const config: Config = {`,
      `  darkMode: ['class', "[data-theme='dark']"],`,
      `  theme: {`,
      `    extend: {`,
      `      colors: {`,
      ...roles.map((r) => {
        const shades = palette.filter((p) => p.role === r);
        const entries = shades.map((s) => `          '${s.shade}': '${s.hex}',`).join('\n');
        return `        ${r}: {\n${entries}\n        },`;
      }),
      `      },`,
      `      fontFamily: {`,
      `        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],`,
      `        mono: ['ui-monospace', 'SF Mono', 'Menlo', 'Monaco', 'Consolas', 'monospace'],`,
      `      },`,
      `      fontSize: {`,
      ...type.map((t) => `        '${t.token}': ['${t.fontSizePx}px', { lineHeight: '${t.lineHeight}', fontWeight: '${t.fontWeight}' }],`),
      `      },`,
      `      spacing: {`,
      ...SPACING_SCALE.map((s) => `        '${s}': '${s}px',`),
      `      },`,
      `      borderRadius: {`,
      `        sm: '4px',`,
      `        md: '8px',`,
      `        lg: '12px',`,
      `        xl: '16px',`,
      `      },`,
      `      boxShadow: {`,
      `        sm: '0 1px 2px rgba(0,0,0,0.05)',`,
      `        md: '0 4px 6px -1px rgba(0,0,0,0.10), 0 2px 4px -2px rgba(0,0,0,0.10)',`,
      `        lg: '0 10px 15px -3px rgba(0,0,0,0.10), 0 4px 6px -4px rgba(0,0,0,0.05)',`,
      `      },`,
      `      transitionTimingFunction: {`,
      `        out: 'cubic-bezier(0.16, 1, 0.3, 1)',`,
      `      },`,
      `      screens: {`,
      `        sm: '640px',`,
      `        md: '768px',`,
      `        lg: '1024px',`,
      `        xl: '1280px',`,
      `        '2xl': '1440px',`,
      `      },`,
      `    },`,
      `  },`,
      `  plugins: [],`,
      `};`,
      ``,
      `export default config;`,
      ``,
    ].join('\n');
  }

  /** Generate a Figma-compatible tokens JSON. */
  protected generateFigmaTokens(intent: UIDesignerIntent): string {
    const palette = this.generatePalette(intent);
    const type = this.generateTypography();
    const roles = [...new Set(palette.map((p) => p.role))];
    const colorObj: Record<string, Record<string, { value: string; type: string }>> = {};
    for (const role of roles) {
      colorObj[role] = {};
      for (const sw of palette.filter((p) => p.role === role)) {
        colorObj[role][sw.shade] = { value: sw.hex, type: 'color' };
      }
    }
    const typeObj: Record<string, { value: string; type: string }> = {};
    for (const t of type) {
      typeObj[t.token] = { value: `${t.fontSizePx}px`, type: 'dimension' };
    }
    const tokens = {
      global: {
        color: colorObj,
        typography: typeObj,
        spacing: Object.fromEntries(SPACING_SCALE.map((s) => [s, { value: `${s}px`, type: 'dimension' }])),
        radius: {
          sm: { value: '4px', type: 'dimension' },
          md: { value: '8px', type: 'dimension' },
          lg: { value: '12px', type: 'dimension' },
        },
      },
    };
    return JSON.stringify(tokens, null, 2) + '\n';
  }

  /** Generate a component-variants reference doc. */
  protected generateComponentVariantsDoc(intent: UIDesignerIntent): string {
    const variants: ComponentVariant[] = this.generateComponentVariants();
    const lines: string[] = [];
    lines.push(`# Component variants reference`);
    lines.push('');
    lines.push(`Generated by SANIX UI/UX Designer. Palette: ${this.describePalette(intent)}.`);
    lines.push('');
    const byComp: Record<string, ComponentVariant[]> = {};
    for (const v of variants) (byComp[v.component] ??= []).push(v);
    for (const [comp, vs] of Object.entries(byComp)) {
      lines.push(`## ${comp}`);
      lines.push('');
      lines.push('| Variant | Styling | Usage |');
      lines.push('| --- | --- | --- |');
      for (const v of vs) lines.push(`| \`${v.variant}\` | ${v.styling} | ${v.usage ?? ''} |`);
      lines.push('');
    }
    return lines.join('\n');
  }

  /** Generate the canonical component variants catalog. */
  protected generateComponentVariants(): ComponentVariant[] {
    return [
      { component: 'Button', variant: 'primary', styling: 'bg-primary-500 text-white hover:bg-primary-600', usage: 'Main call-to-action' },
      { component: 'Button', variant: 'secondary', styling: 'border border-neutral-300 bg-white hover:bg-neutral-50', usage: 'Alternative action' },
      { component: 'Button', variant: 'ghost', styling: 'bg-transparent hover:bg-neutral-100', usage: 'Tertiary / toolbar' },
      { component: 'Button', variant: 'destructive', styling: 'bg-danger-500 text-white hover:bg-danger-600', usage: 'Irreversible action' },
      { component: 'Input', variant: 'text', styling: 'rounded-md border px-3 py-2', usage: 'Single-line text' },
      { component: 'Input', variant: 'select', styling: 'rounded-md border px-3 py-2 pr-8', usage: 'Dropdown selection' },
      { component: 'Input', variant: 'checkbox', styling: 'h-4 w-4 rounded border', usage: 'Boolean toggle' },
      { component: 'Card', variant: 'elevated', styling: 'rounded-lg bg-white shadow-md p-6', usage: 'Content container' },
      { component: 'Card', variant: 'outlined', styling: 'rounded-lg border bg-white p-6', usage: 'Dense layout' },
      { component: 'Badge', variant: 'success', styling: 'bg-success-100 text-success-700 rounded-full px-2 py-0.5', usage: 'Positive state' },
      { component: 'Badge', variant: 'warning', styling: 'bg-warning-100 text-warning-700 rounded-full px-2 py-0.5', usage: 'Caution state' },
      { component: 'Badge', variant: 'danger', styling: 'bg-danger-100 text-danger-700 rounded-full px-2 py-0.5', usage: 'Error state' },
    ];
  }

  // ── Mode: theme ────────────────────────────────────────────────────────────

  /**
   * Generate a light/dark/system theme.css with `:root` (light) and
   * `[data-theme='dark']` (dark) blocks, plus a `prefers-color-scheme`
   * fallback for system mode.
   */
  protected async runTheme(ctx: RunContext, intent: UIDesignerIntent): Promise<void> {
    const dir = path.join(ctx.opts.cwd, 'design-output', 'theme');
    this.emitProgress('analyze', 'Generating light/dark/system theme…', undefined, ctx);

    const theme = this.generateThemeCss(intent);
    await this.writeFileSafe(path.join(dir, 'theme.css'), theme, ctx);

    const toggle = this.generateThemeToggle(intent);
    await this.writeFileSafe(path.join(dir, 'theme-toggle.tsx'), toggle, ctx);

    this.addFinding(ctx, {
      severity: 'info',
      category: 'ui-design:theme',
      title: 'Light/dark/system theme generated',
      description: `Generated \`theme.css\` with \`:root\` (light), \`[data-theme='dark']\` (dark), and a \`@media (prefers-color-scheme: dark)\` system fallback. Also generated a \`theme-toggle.tsx\` React component that cycles light → dark → system and persists the user's choice in \`localStorage\`. Palette: ${this.describePalette(intent)}.`,
      file: path.relative(ctx.opts.cwd, dir) || dir,
      suggestion: 'Import theme.css at your app root. Mount <ThemeToggle /> in your header. Initialize data-theme from localStorage before first paint to avoid FOUC.',
      autoFixable: false,
      tags: ['ui', 'theme', 'dark-mode'],
    });
    ctx.output = `Theme generated at ${path.relative(ctx.opts.cwd, dir) || dir}. 2 files written.`;
    this.recordMetric(ctx, 'filesGenerated', 2, 'set');
  }

  /** Generate the theme.css file. */
  protected generateThemeCss(intent: UIDesignerIntent): string {
    const palette = this.generatePalette(intent);
    const primary = palette.find((p) => p.role === 'primary' && p.shade === '500')?.hex ?? '#0ea5e9';
    return [
      `/* theme.css — generated by SANIX UI/UX Designer. */`,
      `/* Light theme (default) */`,
      `:root {`,
      `  --color-bg: #ffffff;`,
      `  --color-bg-elevated: #f9fafb;`,
      `  --color-fg: #111827;`,
      `  --color-fg-muted: #6b7280;`,
      `  --color-border: #e5e7eb;`,
      `  --color-primary: ${primary};`,
      `  --color-primary-fg: #ffffff;`,
      `  --color-success: #16a34a;`,
      `  --color-warning: #d97706;`,
      `  --color-danger: #dc2626;`,
      `  --shadow-sm: 0 1px 2px rgba(0,0,0,0.05);`,
      `  --shadow-md: 0 4px 6px -1px rgba(0,0,0,0.10);`,
      `}`,
      ``,
      `/* Dark theme */`,
      `[data-theme='dark'] {`,
      `  --color-bg: #0b0f17;`,
      `  --color-bg-elevated: #111827;`,
      `  --color-fg: #f9fafb;`,
      `  --color-fg-muted: #9ca3af;`,
      `  --color-border: #1f2937;`,
      `  --color-primary: ${primary};`,
      `  --color-primary-fg: #0b0f17;`,
      `  --color-success: #4ade80;`,
      `  --color-warning: #fbbf24;`,
      `  --color-danger: #f87171;`,
      `  --shadow-sm: 0 1px 2px rgba(0,0,0,0.4);`,
      `  --shadow-md: 0 4px 6px -1px rgba(0,0,0,0.5);`,
      `}`,
      ``,
      `/* System fallback: when no data-theme is set, follow the OS preference. */`,
      `@media (prefers-color-scheme: dark) {`,
      `  :root:not([data-theme='light']) {`,
      `    --color-bg: #0b0f17;`,
      `    --color-bg-elevated: #111827;`,
      `    --color-fg: #f9fafb;`,
      `    --color-fg-muted: #9ca3af;`,
      `    --color-border: #1f2937;`,
      `    --color-primary: ${primary};`,
      `    --color-primary-fg: #0b0f17;`,
      `    --color-success: #4ade80;`,
      `    --color-warning: #fbbf24;`,
      `    --color-danger: #f87171;`,
      `    --shadow-sm: 0 1px 2px rgba(0,0,0,0.4);`,
      `    --shadow-md: 0 4px 6px -1px rgba(0,0,0,0.5);`,
      `  }`,
      `}`,
      ``,
    ].join('\n');
  }

  /** Generate a ThemeToggle React component. */
  protected generateThemeToggle(_intent: UIDesignerIntent): string {
    return [
      `/** theme-toggle.tsx — generated by SANIX UI/UX Designer. */`,
      `import * as React from 'react';`,
      ``,
      `type Theme = 'light' | 'dark' | 'system';`,
      ``,
      `export function ThemeToggle(): React.ReactElement {`,
      `  const [theme, setTheme] = React.useState<Theme>(() => {`,
      `    if (typeof window === 'undefined') return 'system';`,
      `    return (localStorage.getItem('theme') as Theme | null) ?? 'system';`,
      `  });`,
      ``,
      `  React.useEffect(() => {`,
      `    const root = document.documentElement;`,
      `    const resolved = theme === 'system'`,
      `      ? window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'`,
      `      : theme;`,
      `    root.setAttribute('data-theme', resolved);`,
      `    localStorage.setItem('theme', theme);`,
      `  }, [theme]);`,
      ``,
      `  const next: Record<Theme, Theme> = { light: 'dark', dark: 'system', system: 'light' };`,
      `  const label = theme === 'light' ? '☀️' : theme === 'dark' ? '🌙' : '🖥';`,
      `  return (`,
      `    <button`,
      `      type="button"`,
      `      aria-label={\`Toggle theme (current: \${theme})\`}`,
      `      onClick={() => setTheme(next[theme])}`,
      `      className="rounded-md border px-3 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"`,
      `      style={{ borderColor: 'var(--color-border)' }}`,
      `    >`,
      `      {label} <span className="sr-only">{theme}</span>`,
      `    </button>`,
      `  );`,
      `}`,
      ``,
      `export default ThemeToggle;`,
      ``,
    ].join('\n');
  }

  // ── Mode: animation ────────────────────────────────────────────────────────

  /**
   * Generate a Framer Motion variants file plus a CSS transitions
   * file covering hover / focus / active / enter / exit / loading /
   * error states.
   */
  protected async runAnimation(ctx: RunContext, intent: UIDesignerIntent): Promise<void> {
    const dir = path.join(ctx.opts.cwd, 'design-output', 'motion');
    this.emitProgress('analyze', 'Generating micro-animation variants…', undefined, ctx);

    const motion = this.generateMotion(intent);
    await this.writeFileSafe(path.join(dir, 'motion.ts'), motion, ctx);

    const transitions = this.generateTransitionsCss(intent);
    await this.writeFileSafe(path.join(dir, 'transitions.css'), transitions, ctx);

    this.addFinding(ctx, {
      severity: 'info',
      category: 'ui-design:animation',
      title: 'Micro-animation package generated',
      description: `Generated \`motion.ts\` (Framer Motion variants for enter/exit/hover/loading/error) and \`transitions.css\` (CSS transitions using a shared cubic-bezier easing). Honors \`prefers-reduced-motion\`.`,
      file: path.relative(ctx.opts.cwd, dir) || dir,
      suggestion: 'Wrap animated elements in <motion.div variants={motionVariants.enter}>. Import transitions.css once at the app root.',
      autoFixable: false,
      tags: ['ui', 'animation', 'motion'],
    });
    ctx.output = `Motion package generated at ${path.relative(ctx.opts.cwd, dir) || dir}. 2 files written.`;
    this.recordMetric(ctx, 'filesGenerated', 2, 'set');
  }

  /** Generate a CSS transitions stylesheet with reduced-motion guard. */
  protected generateTransitionsCss(_intent: UIDesignerIntent): string {
    return [
      `/* transitions.css — generated by SANIX UI/UX Designer. */`,
      `:root {`,
      `  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);`,
      `  --duration-fast: 150ms;`,
      `  --duration-base: 200ms;`,
      `  --duration-slow: 300ms;`,
      `}`,
      ``,
      `.transition-colors { transition: background-color var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out); }`,
      `.transition-transform { transition: transform var(--duration-fast) var(--ease-out); }`,
      `.transition-opacity { transition: opacity var(--duration-base) var(--ease-out); }`,
      `.transition-all { transition: all var(--duration-base) var(--ease-out); }`,
      ``,
      `/* Hover + focus (never define hover without focus!) */`,
      `.hover-lift:hover, .hover-lift:focus-visible { transform: translateY(-1px); box-shadow: var(--shadow-md); }`,
      `.hover-scale:hover, .hover-scale:focus-visible { transform: scale(1.02); }`,
      ``,
      `/* Active (press) */`,
      `.press:active { transform: scale(0.98); }`,
      ``,
      `/* Enter / exit */`,
      `@keyframes sanix-fade-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }`,
      `@keyframes sanix-fade-out { from { opacity: 1; transform: translateY(0); } to { opacity: 0; transform: translateY(-8px); } }`,
      `.animate-enter { animation: sanix-fade-in var(--duration-slow) var(--ease-out) both; }`,
      `.animate-exit { animation: sanix-fade-out var(--duration-base) var(--ease-out) both; }`,
      ``,
      `/* Loading shimmer */`,
      `@keyframes sanix-shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }`,
      `.animate-shimmer { background: linear-gradient(90deg, transparent 0%, rgba(0,0,0,0.06) 50%, transparent 100%); background-size: 200% 100%; animation: sanix-shimmer 1.5s linear infinite; }`,
      ``,
      `/* Error shake */`,
      `@keyframes sanix-shake { 0%,100% { transform: translateX(0); } 25% { transform: translateX(-4px); } 75% { transform: translateX(4px); } }`,
      `.animate-shake { animation: sanix-shake 0.3s var(--ease-out); }`,
      ``,
      `/* Reduced motion: honor user preference. */`,
      `@media (prefers-reduced-motion: reduce) {`,
      `  *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; scroll-behavior: auto !important; }`,
      `}`,
      ``,
    ].join('\n');
  }

  // ── Palette + typography generators ─────────────────────────────────────────

  /**
   * Generate a color palette. The default is a cyan primary; if the
   * goal mentions a specific hue, it's used as the primary base.
   */
  protected generatePalette(intent: UIDesignerIntent): ColorSwatch[] {
    const g = intent.subject.toLowerCase() + ' ' + '';
    // Detect explicit hue from the original goal via the agent's stored goal is not available here,
    // so we infer from subject + a small palette table.
    let primaryBase = '#0ea5e9'; // cyan-500 default
    let accentBase = '#f59e0b'; // amber-500 default
    if (/amber|orange|yellow/.test(g)) primaryBase = '#f59e0b';
    if (/cyan|sky|blue/.test(g)) primaryBase = '#0ea5e9';
    if (/emerald|green/.test(g)) primaryBase = '#10b981';
    if (/violet|purple/.test(g)) primaryBase = '#8b5cf6';
    if (/rose|pink|red/.test(g)) primaryBase = '#f43f5e';
    if (/teal/.test(g)) primaryBase = '#14b8a6';

    // 11-shade ramp generator (50, 100, 200, ..., 950) by mixing with white/black.
    const ramp = (base: string): Array<{ shade: string; hex: string }> => {
      const { r, g, b } = this.hexToRgb(base);
      type WhiteShade = { kind: 'w'; shade: string; t: number };
      type BlackShade = { kind: 'k'; shade: string; t: number };
      const shades: ReadonlyArray<WhiteShade | BlackShade> = [
        { kind: 'w', shade: '50', t: 0.95 },
        { kind: 'w', shade: '100', t: 0.9 },
        { kind: 'w', shade: '200', t: 0.75 },
        { kind: 'w', shade: '300', t: 0.55 },
        { kind: 'w', shade: '400', t: 0.3 },
        { kind: 'w', shade: '500', t: 0 },
        { kind: 'k', shade: '600', t: 0.1 },
        { kind: 'k', shade: '700', t: 0.25 },
        { kind: 'k', shade: '800', t: 0.4 },
        { kind: 'k', shade: '900', t: 0.55 },
        { kind: 'k', shade: '950', t: 0.7 },
      ];
      return shades.map((s): { shade: string; hex: string } => {
        if (s.kind === 'w') {
          return { shade: s.shade, hex: this.rgbToHex(this.mix(r, g, b, 255, 255, 255, s.t)) };
        }
        return { shade: s.shade, hex: this.rgbToHex(this.mix(r, g, b, 0, 0, 0, s.t)) };
      });
    };

    const swatches: ColorSwatch[] = [];
    for (const s of ramp(primaryBase)) swatches.push({ role: 'primary', shade: s.shade, hex: s.hex });
    for (const s of ramp(accentBase)) swatches.push({ role: 'accent', shade: s.shade, hex: s.hex });
    for (const s of ramp('#6b7280')) swatches.push({ role: 'neutral', shade: s.shade, hex: s.hex });
    // Add neutral-0 (white) and neutral-1000 (near-black) for flexible theming.
    swatches.push({ role: 'neutral', shade: '0', hex: '#ffffff' });
    swatches.push({ role: 'neutral', shade: '1000', hex: '#0b0f17' });
    return swatches;
  }

  /** Linear-interpolate two RGB colors. `t=0` → a, `t=1` → b. */
  protected mix(
    ar: number, ag: number, ab: number,
    br: number, bg: number, bb: number,
    t: number,
  ): { r: number; g: number; b: number } {
    return {
      r: Math.round(ar + (br - ar) * t),
      g: Math.round(ag + (bg - ag) * t),
      b: Math.round(ab + (bb - ab) * t),
    };
  }

  /** Parse a `#rrggbb` (or `#rgb`) hex string into RGB. */
  protected hexToRgb(hex: string): { r: number; g: number; b: number } {
    let h = hex.replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const num = parseInt(h, 16);
    return { r: (num >> 16) & 0xff, g: (num >> 8) & 0xff, b: num & 0xff };
  }

  /** Convert RGB back to `#rrggbb`. */
  protected rgbToHex({ r, g, b }: { r: number; g: number; b: number }): string {
    const toHex = (n: number) => n.toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  /** Human-readable one-liner describing the palette. */
  protected describePalette(intent: UIDesignerIntent): string {
    const palette = this.generatePalette(intent);
    const primary = palette.find((p) => p.role === 'primary' && p.shade === '500')?.hex ?? 'cyan';
    const accent = palette.find((p) => p.role === 'accent' && p.shade === '500')?.hex ?? 'amber';
    return `primary ${primary} + accent ${accent} + neutral gray ramp (11 shades)`;
  }

  /** Generate the canonical typography scale. */
  protected generateTypography(): TypographyEntry[] {
    return [
      { token: 'display', fontSizePx: 48, lineHeight: 1.1, fontWeight: 700, letterSpacingEm: -0.02, usage: 'Hero / landing headlines' },
      { token: 'h1', fontSizePx: 36, lineHeight: 1.2, fontWeight: 700, letterSpacingEm: -0.02, usage: 'Page title' },
      { token: 'h2', fontSizePx: 28, lineHeight: 1.25, fontWeight: 600, letterSpacingEm: -0.01, usage: 'Section heading' },
      { token: 'h3', fontSizePx: 22, lineHeight: 1.3, fontWeight: 600, usage: 'Subsection heading' },
      { token: 'h4', fontSizePx: 18, lineHeight: 1.4, fontWeight: 600, usage: 'Card title' },
      { token: 'body-lg', fontSizePx: 18, lineHeight: 1.6, fontWeight: 400, usage: 'Lead paragraph' },
      { token: 'body', fontSizePx: 16, lineHeight: 1.6, fontWeight: 400, usage: 'Default body copy' },
      { token: 'body-sm', fontSizePx: 14, lineHeight: 1.5, fontWeight: 400, usage: 'Secondary copy' },
      { token: 'caption', fontSizePx: 12, lineHeight: 1.4, fontWeight: 400, usage: 'Captions, table headers' },
      { token: 'code', fontSizePx: 14, lineHeight: 1.5, fontWeight: 400, usage: 'Inline + block code' },
    ];
  }
}
