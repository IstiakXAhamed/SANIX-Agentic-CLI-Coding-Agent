/**
 * @file rules.ts
 * @description The 52 built-in {@link ReviewRule}s that ship with
 * `@sanix/prbot`. Each rule is small, focused, and independently
 * disable-able. Rules are grouped into 10 categories: style,
 * correctness, security, performance, maintainability, documentation,
 * testing, accessibility, compatibility, metadata.
 *
 * Most rules operate on the diff hunks (line-by-line scanning), but a
 * few operate on PR-level metadata (title, body, file list). The
 * helpers {@link eachAddedLine} and {@link eachRemovedLine} make it
 * easy to write a new rule that inspects added/removed code.
 *
 * @packageDocumentation
 */

import type { DiffHunk, PullRequest, ReviewComment, ReviewRule } from './types.js';

/** Iterate every added line in every hunk, yielding `{hunk, line, text}`. */
function eachAddedLine(pr: PullRequest): Iterable<{ hunk: DiffHunk; line: number; text: string }> {
  return {
    [Symbol.iterator]() {
      const hunkIter = pr.hunks[Symbol.iterator]();
      let currentHunk: DiffHunk | undefined;
      let lineIter: Iterator<{ line: number; text: string }> | undefined;
      return {
        next(): IteratorResult<{ hunk: DiffHunk; line: number; text: string }> {
          for (;;) {
            if (!currentHunk) {
              const r = hunkIter.next();
              if (r.done) return { done: true, value: undefined };
              currentHunk = r.value;
              lineIter = addedLines(currentHunk)[Symbol.iterator]();
            }
            const lr = lineIter!.next();
            if (lr.done) {
              currentHunk = undefined;
              continue;
            }
            return { done: false, value: { hunk: currentHunk, line: lr.value.line, text: lr.value.text } };
          }
        },
      };
    },
  };
}

/** Return the added lines of a hunk as `{line, text}`. */
function addedLines(hunk: DiffHunk): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let line = hunk.newStart;
  for (const raw of hunk.body.split('\n')) {
    if (raw.startsWith('@@')) continue;
    if (raw.startsWith('+')) {
      out.push({ line, text: raw.slice(1) });
      line += 1;
    } else if (raw.startsWith('-')) {
      // Removed line — new-side cursor doesn't move.
    } else if (raw.startsWith(' ')) {
      line += 1;
    }
  }
  return out;
}

/** Make a comment anchored to a specific line. */
function comment(
  path: string,
  line: number,
  ruleId: string,
  severity: ReviewComment['severity'],
  body: string,
  suggestion?: string,
): ReviewComment {
  return { path, line, severity, ruleId, body, suggestion };
}

// ─── STYLE (8 rules) ────────────────────────────────────────────────────────

const STYLE_RULES: ReviewRule[] = [
  rule('no-trailing-whitespace', 'No trailing whitespace', 'warning', 'style', false, (pr) => {
    const out: ReviewComment[] = [];
    for (const { hunk, line, text } of eachAddedLine(pr)) {
      if (/[ \t]+$/.test(text)) {
        out.push(comment(hunk.path, line, 'no-trailing-whitespace', 'nit', 'Trailing whitespace.', text.replace(/[ \t]+$/, '')));
      }
    }
    return out;
  }),
  rule('no-tabs', 'No tabs — use spaces', 'warning', 'style', false, (pr) => {
    const out: ReviewComment[] = [];
    for (const { hunk, line, text } of eachAddedLine(pr)) {
      if (text.includes('\t')) {
        out.push(comment(hunk.path, line, 'no-tabs', 'nit', 'Tab character found — use spaces.'));
      }
    }
    return out;
  }),
  rule('line-length-100', 'Lines should not exceed 100 characters', 'suggestion', 'style', false, (pr) => {
    const out: ReviewComment[] = [];
    for (const { hunk, line, text } of eachAddedLine(pr)) {
      if (text.length > 100) {
        out.push(comment(hunk.path, line, 'line-length-100', 'suggestion', `Line is ${text.length} characters (max 100).`));
      }
    }
    return out;
  }),
  rule('no-multiple-empty-lines', 'No consecutive empty lines', 'nit', 'style', false, (pr) => {
    const out: ReviewComment[] = [];
    for (const hunk of pr.hunks) {
      const lines = hunk.body.split('\n');
      let streak = 0;
      let lineNo = hunk.newStart;
      for (const raw of lines) {
        if (raw.startsWith('@@')) continue;
        if (raw.startsWith('+') || raw.startsWith(' ')) {
          const isEmpty = raw === '+' || raw === ' ';
          if (isEmpty) {
            streak += 1;
            if (streak >= 2) {
              out.push(comment(hunk.path, lineNo, 'no-multiple-empty-lines', 'nit', 'Multiple consecutive empty lines.'));
            }
          } else {
            streak = 0;
          }
          if (!raw.startsWith('-')) lineNo += 1;
        } else if (raw.startsWith('-')) {
          // old-side only — new-side cursor unchanged
        }
      }
    }
    return out;
  }),
  rule('consistent-quotes', 'Use single quotes for strings', 'nit', 'style', false, (pr) => {
    const out: ReviewComment[] = [];
    for (const { hunk, line, text } of eachAddedLine(pr)) {
      if (/["'`]/.test(text) && /"[^"]*"/.test(text) && !/^ *\/\/.*/.test(text) && !/import|from|require/.test(text)) {
        // Flag double-quoted strings in TS/JS that could be single-quoted.
        if (/[^'\\]"[^'"]{1,80}[^'\\]"/.test(text)) {
          out.push(comment(hunk.path, line, 'consistent-quotes', 'nit', 'Consider single quotes for consistency.'));
        }
      }
    }
    return out;
  }),
  rule('no-console', 'No console.* in production code', 'warning', 'style', false, (pr) => {
    const out: ReviewComment[] = [];
    for (const { hunk, line, text } of eachAddedLine(pr)) {
      if (/\bconsole\.(log|debug|info|warn|error|trace)\b/.test(text)) {
        out.push(comment(hunk.path, line, 'no-console', 'warning', '`console.*` left in production code — remove or route through logger.'));
      }
    }
    return out;
  }),
  rule('no-debugger', 'No debugger statements', 'error', 'style', true, (pr) => {
    const out: ReviewComment[] = [];
    for (const { hunk, line, text } of eachAddedLine(pr)) {
      if (/\bdebugger\b/.test(text)) {
        out.push(comment(hunk.path, line, 'no-debugger', 'error', '`debugger` statement must be removed.'));
      }
    }
    return out;
  }),
  rule('consistent-naming', 'Use camelCase for variables', 'suggestion', 'style', false, (pr) => {
    const out: ReviewComment[] = [];
    const re = /\b(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/g;
    for (const { hunk, line, text } of eachAddedLine(pr)) {
      for (const m of text.matchAll(re)) {
        const name = m[1] ?? '';
        if (name.includes('_') && !name.toUpperCase().startsWith('_')) {
          out.push(comment(hunk.path, line, 'consistent-naming', 'suggestion', `Identifier \`${name}\` uses snake_case — prefer camelCase in JS/TS.`));
        }
      }
    }
    return out;
  }),
];

// ─── CORRECTNESS (8 rules) ───────────────────────────────────────────────────

const CORRECTNESS_RULES: ReviewRule[] = [
  rule('no-empty-catch', 'No empty catch blocks', 'warning', 'correctness', true, (pr) => {
    const out: ReviewComment[] = [];
    for (const { hunk, line, text } of eachAddedLine(pr)) {
      if (/catch\s*\([^)]*\)\s*\{\s*\}/.test(text)) {
        out.push(comment(hunk.path, line, 'no-empty-catch', 'warning', 'Empty catch block silently swallows errors — at minimum log them.'));
      }
    }
    return out;
  }),
  rule('no-implicit-globals', 'No implicit globals', 'error', 'correctness', true, (pr) => {
    const out: ReviewComment[] = [];
    for (const { hunk, line, text } of eachAddedLine(pr)) {
      if (/^[a-zA-Z_$][\w$]*\s*=/.test(text) && !/^(const|let|var|function|class)\b/.test(text)) {
        out.push(comment(hunk.path, line, 'no-implicit-globals', 'error', 'Implicit global assignment — declare with `const`/`let`/`var`.'));
      }
    }
    return out;
  }),
  rule('prefer-strict-equality', 'Prefer === over ==', 'warning', 'correctness', false, (pr) => {
    const out: ReviewComment[] = [];
    for (const { hunk, line, text } of eachAddedLine(pr)) {
      if (/[^=!]==[^=]/.test(text) && !/===/.test(text)) {
        out.push(comment(hunk.path, line, 'prefer-strict-equality', 'warning', 'Use `===` to avoid type coercion bugs.', text.replace(/([^=!])==([^=])/, '$1===$2')));
      }
    }
    return out;
  }),
  rule('no-assign-in-condition', 'No assignment in condition', 'warning', 'correctness', false, (pr) => {
    const out: ReviewComment[] = [];
    for (const { hunk, line, text } of eachAddedLine(pr)) {
      if (/if\s*\([^)]*=[^=]/.test(text)) {
        out.push(comment(hunk.path, line, 'no-assign-in-condition', 'warning', 'Assignment inside `if` condition — likely a `==` typo.'));
      }
    }
    return out;
  }),
  rule('no-unused-vars', 'No unused variables (heuristic)', 'warning', 'correctness', false, (pr) => {
    const out: ReviewComment[] = [];
    const re = /\b(?:const|let|var)\s+([A-Za-z_][\w]*)\s*=/g;
    for (const { hunk, line, text } of eachAddedLine(pr)) {
      for (const m of text.matchAll(re)) {
        const name = m[1] ?? '';
        const allAdded = [...eachAddedLine(pr)].map((l) => l.text).join('\n');
        const uses = allAdded.split(name).length - 1;
        if (uses <= 1) {
          out.push(comment(hunk.path, line, 'no-unused-vars', 'warning', `Variable \`${name}\` is assigned but never used in the added lines.`));
        }
      }
    }
    return out;
  }),
  rule('no-unreachable', 'No unreachable code', 'warning', 'correctness', false, (pr) => {
    const out: ReviewComment[] = [];
    for (const hunk of pr.hunks) {
      const lines = addedLines(hunk);
      for (let i = 0; i < lines.length - 1; i++) {
        const cur = lines[i]!.text.trim();
        const next = lines[i + 1]!.text.trim();
        if (/^(return|throw|break|continue);?$/.test(cur) && next !== '' && !/^[}\])]/.test(next) && !/^case\b|^default:/.test(next)) {
          out.push(comment(hunk.path, lines[i + 1]!.line, 'no-unreachable', 'warning', 'Code after `return`/`throw`/`break` is unreachable.'));
        }
      }
    }
    return out;
  }),
  rule('no-comparison-operators-equality', 'No equality on booleans', 'nit', 'correctness', false, (pr) => {
    const out: ReviewComment[] = [];
    for (const { hunk, line, text } of eachAddedLine(pr)) {
      if (/===?\s*(true|false)|(true|false)\s*===?/.test(text)) {
        out.push(comment(hunk.path, line, 'no-comparison-operators-equality', 'nit', 'Compare to a boolean directly — drop the `=== true`.'));
      }
    }
    return out;
  }),
  rule('no-unsafe-finally', 'No return/throw in finally', 'error', 'correctness', true, (pr) => {
    const out: ReviewComment[] = [];
    for (const { hunk, line, text } of eachAddedLine(pr)) {
      if (/finally\s*\{[^}]*\b(return|throw)\b/.test(text)) {
        out.push(comment(hunk.path, line, 'no-unsafe-finally', 'error', '`return`/`throw` in `finally` swallows exceptions.'));
      }
    }
    return out;
  }),
];

// ─── SECURITY (8 rules) ──────────────────────────────────────────────────────

const SECURITY_RULES: ReviewRule[] = [
  rule('no-eval', 'No eval()', 'error', 'security', true, (pr) => {
    const out: ReviewComment[] = [];
    for (const { hunk, line, text } of eachAddedLine(pr)) {
      if (/\beval\s*\(/.test(text)) {
        out.push(comment(hunk.path, line, 'no-eval', 'error', '`eval()` is a code-injection risk — remove it.'));
      }
    }
    return out;
  }),
  rule('no-inner-html', 'No innerHTML assignment', 'error', 'security', true, (pr) => {
    const out: ReviewComment[] = [];
    for (const { hunk, line, text } of eachAddedLine(pr)) {
      if (/\.innerHTML\s*=/.test(text)) {
        out.push(comment(hunk.path, line, 'no-inner-html', 'error', 'Setting `innerHTML` is an XSS risk — use `textContent` or a sanitizer.'));
      }
    }
    return out;
  }),
  rule('no-hardcoded-secrets', 'No hardcoded secrets', 'blocker', 'security', true, (pr) => {
    const out: ReviewComment[] = [];
    const re = /(api[_-]?key|secret|password|token|passwd|pwd)\s*[:=]\s*['"][^'"]{8,}['"]/i;
    for (const { hunk, line, text } of eachAddedLine(pr)) {
      if (re.test(text)) {
        out.push(comment(hunk.path, line, 'no-hardcoded-secrets', 'blocker', 'Hardcoded secret detected — move to an environment variable.'));
      }
    }
    return out;
  }),
  rule('no-http-link', 'No plaintext http:// links', 'warning', 'security', false, (pr) => {
    const out: ReviewComment[] = [];
    for (const { hunk, line, text } of eachAddedLine(pr)) {
      if (/http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0)/.test(text)) {
        out.push(comment(hunk.path, line, 'no-http-link', 'warning', 'Use HTTPS instead of HTTP.'));
      }
    }
    return out;
  }),
  rule('no-dangerously-set-innerhtml', 'No dangerouslySetInnerHTML', 'error', 'security', true, (pr) => {
    const out: ReviewComment[] = [];
    for (const { hunk, line, text } of eachAddedLine(pr)) {
      if (/dangerouslySetInnerHTML/.test(text)) {
        out.push(comment(hunk.path, line, 'no-dangerously-set-innerhtml', 'error', '`dangerouslySetInnerHTML` is an XSS risk unless content is sanitised.'));
      }
    }
    return out;
  }),
  rule('no-unsafe-regex', 'No catastrophic-backtracking regex', 'warning', 'security', false, (pr) => {
    const out: ReviewComment[] = [];
    const re = /\(([^)]+)\)\1|(\+\+)\+|\*{2,}/;
    for (const { hunk, line, text } of eachAddedLine(pr)) {
      if (re.test(text)) {
        out.push(comment(hunk.path, line, 'no-unsafe-regex', 'warning', 'Regex pattern may be vulnerable to catastrophic backtracking.'));
      }
    }
    return out;
  }),
  rule('no-sql-injection', 'No SQL string concatenation', 'error', 'security', true, (pr) => {
    const out: ReviewComment[] = [];
    for (const { hunk, line, text } of eachAddedLine(pr)) {
      if (/(SELECT|INSERT|UPDATE|DELETE|DROP).*\+.*\+/i.test(text) || /\$\{.*\}.*\b(SELECT|INSERT|UPDATE|DELETE|DROP)\b/i.test(text)) {
        out.push(comment(hunk.path, line, 'no-sql-injection', 'error', 'SQL string concatenation — use parameterised queries.'));
      }
    }
    return out;
  }),
  rule('no-prototype-pollution', 'No __proto__ assignment', 'error', 'security', true, (pr) => {
    const out: ReviewComment[] = [];
    for (const { hunk, line, text } of eachAddedLine(pr)) {
      if (/__proto__|constructor\s*\[|prototype\s*\[/.test(text)) {
        out.push(comment(hunk.path, line, 'no-prototype-pollution', 'error', 'Prototype pollution risk — avoid `__proto__` and `constructor[...]`.'));
      }
    }
    return out;
  }),
];

// ─── PERFORMANCE (6 rules) ───────────────────────────────────────────────────

const PERFORMANCE_RULES: ReviewRule[] = [
  rule('no-large-loop', 'No loops with >1000 iterations', 'warning', 'performance', false, (pr) => {
    const out: ReviewComment[] = [];
    for (const { hunk, line, text } of eachAddedLine(pr)) {
      const m = text.match(/for\s*\([^;]*;\s*\w+\s*<\s*(\d+)\s*;/);
      if (m && parseInt(m[1] ?? '0', 10) > 1000) {
        out.push(comment(hunk.path, line, 'no-large-loop', 'warning', `Loop bound ${m[1]} is large — consider batching.`));
      }
    }
    return out;
  }),
  rule('no-nested-loops', 'No deeply nested loops', 'warning', 'performance', false, (pr) => {
    const out: ReviewComment[] = [];
    let depth = 0;
    for (const { hunk, line, text } of eachAddedLine(pr)) {
      if (/\bfor\s*\(|\bwhile\s*\(|\.forEach\s*\(|\.map\s*\(|\.reduce\s*\(/.test(text)) depth += 1;
      if (depth >= 3) {
        out.push(comment(hunk.path, line, 'no-nested-loops', 'warning', 'Three or more nested loops — algorithmic complexity concern.'));
      }
      if (text.includes('}')) depth = Math.max(0, depth - 1);
    }
    return out;
  }),
  rule('prefer-map-over-foreach', 'Prefer map() over forEach() when transforming', 'suggestion', 'performance', false, (pr) => {
    const out: ReviewComment[] = [];
    for (const { hunk, line, text } of eachAddedLine(pr)) {
      if (/\.forEach\s*\(\s*\([^)]*\)\s*=>\s*[^}]*\.push\(/.test(text)) {
        out.push(comment(hunk.path, line, 'prefer-map-over-foreach', 'suggestion', 'Use `.map()` instead of `.forEach()` + `.push()`.'));
      }
    }
    return out;
  }),
  rule('no-memoization-leak', 'No unbounded memoization cache', 'warning', 'performance', false, (pr) => {
    const out: ReviewComment[] = [];
    for (const { hunk, line, text } of eachAddedLine(pr)) {
      if (new Map([[1, 2]]).constructor === Map && /new\s+Map\s*\(\s*\)/.test(text) && !/maxSize|max_size|lru/i.test(pr.body)) {
        out.push(comment(hunk.path, line, 'no-memoization-leak', 'warning', 'Unbounded `Map` cache — add a max-size eviction policy.'));
      }
    }
    return out;
  }),
  rule('no-sync-in-async', 'No sync I/O in async function', 'warning', 'performance', false, (pr) => {
    const out: ReviewComment[] = [];
    let inAsync = false;
    for (const { hunk, line, text } of eachAddedLine(pr)) {
      if (/async\s+function|async\s*\(/.test(text)) inAsync = true;
      if (inAsync && /\breadFileSync\b|\bwriteFileSync\b|\bexecSync\b/.test(text)) {
        out.push(comment(hunk.path, line, 'no-sync-in-async', 'warning', 'Sync I/O in async function blocks the event loop — use the async variant.'));
      }
      if (text.includes('}')) inAsync = false;
    }
    return out;
  }),
  rule('no-large-imports', 'No wildcard imports of large libraries', 'warning', 'performance', false, (pr) => {
    const out: ReviewComment[] = [];
    for (const { hunk, line, text } of eachAddedLine(pr)) {
      if (/import\s+\*\s+as\s+\w+\s+from\s+['"]lodash['"]/.test(text) || /import\s+\*\s+as\s+\w+\s+from\s+['"]moment['"]/.test(text)) {
        out.push(comment(hunk.path, line, 'no-large-imports', 'warning', 'Wildcard import of a large library — import specific functions to enable tree-shaking.'));
      }
    }
    return out;
  }),
];

// ─── MAINTAINABILITY (6 rules) ───────────────────────────────────────────────

const MAINTAINABILITY_RULES: ReviewRule[] = [
  rule('max-file-length', 'Files should be < 500 lines', 'warning', 'maintainability', false, (pr) => {
    const out: ReviewComment[] = [];
    const counts = new Map<string, number>();
    for (const hunk of pr.hunks) {
      counts.set(hunk.path, (counts.get(hunk.path) ?? 0) + hunk.newLines);
    }
    for (const [path, n] of counts) {
      if (n > 500) out.push(comment(path, 1, 'max-file-length', 'warning', `File has ${n} new lines — consider splitting.`));
    }
    return out;
  }),
  rule('max-function-length', 'Functions should be < 50 lines', 'suggestion', 'maintainability', false, (pr) => {
    const out: ReviewComment[] = [];
    for (const hunk of pr.hunks) {
      const lines = addedLines(hunk);
      let funcStart: number | null = null;
      let funcLines = 0;
      for (const { line, text } of lines) {
        if (/(function\s+\w+|=>\s*\{|function\s*\()/.test(text)) {
          funcStart = line;
          funcLines = 1;
        } else if (funcStart !== null) {
          funcLines += 1;
          if (text.trim() === '}' || text.trim().endsWith('});')) {
            if (funcLines > 50) {
              out.push(comment(hunk.path, funcStart, 'max-function-length', 'suggestion', `Function is ${funcLines} lines — consider extracting helpers.`));
            }
            funcStart = null;
          }
        }
      }
    }
    return out;
  }),
  rule('no-deep-nesting', 'No more than 4 levels of nesting', 'warning', 'maintainability', false, (pr) => {
    const out: ReviewComment[] = [];
    for (const hunk of pr.hunks) {
      let depth = 0;
      for (const { line, text } of addedLines(hunk)) {
        depth += (text.match(/\{/g) ?? []).length;
        depth -= (text.match(/\}/g) ?? []).length;
        if (depth > 4) {
          out.push(comment(hunk.path, line, 'no-deep-nesting', 'warning', `Nesting depth ${depth} — use early returns or extract a helper.`));
          break;
        }
      }
    }
    return out;
  }),
  rule('no-magic-numbers', 'No magic numbers', 'suggestion', 'maintainability', false, (pr) => {
    const out: ReviewComment[] = [];
    for (const { hunk, line, text } of eachAddedLine(pr)) {
      const m = text.match(/(?<![A-Za-z_])([4-9]\d{2,}|[1-9]\d{3,})\b/);
      if (m && !/port|pageSize|limit|maxSize|timeout/i.test(text)) {
        out.push(comment(hunk.path, line, 'no-magic-numbers', 'suggestion', `Magic number \`${m[1]}\` — extract to a named constant.`));
      }
    }
    return out;
  }),
  rule('prefer-named-export', 'Prefer named exports', 'suggestion', 'maintainability', false, (pr) => {
    const out: ReviewComment[] = [];
    for (const { hunk, line, text } of eachAddedLine(pr)) {
      if (/export\s+default\s+/.test(text)) {
        out.push(comment(hunk.path, line, 'prefer-named-export', 'suggestion', 'Prefer named exports for better refactoring and IDE support.'));
      }
    }
    return out;
  }),
  rule('no-commented-out-code', 'No commented-out code', 'nit', 'maintainability', false, (pr) => {
    const out: ReviewComment[] = [];
    for (const { hunk, line, text } of eachAddedLine(pr)) {
      if (/^\s*\/\/\s*(const|let|var|function|class|if|for|while|return)\b/.test(text)) {
        out.push(comment(hunk.path, line, 'no-commented-out-code', 'nit', 'Commented-out code — delete it (use git history if needed).'));
      }
    }
    return out;
  }),
];

// ─── DOCUMENTATION (4 rules) ─────────────────────────────────────────────────

const DOCUMENTATION_RULES: ReviewRule[] = [
  rule('require-jsdoc', 'Public functions should have JSDoc', 'suggestion', 'documentation', false, (pr) => {
    const out: ReviewComment[] = [];
    for (const hunk of pr.hunks) {
      const lines = addedLines(hunk);
      for (let i = 0; i < lines.length; i++) {
        const cur = lines[i]!.text;
        const prev = i > 0 ? lines[i - 1]!.text : '';
        if (/^export\s+(async\s+)?function\s+\w+/.test(cur) && !/^\s*\*\//.test(prev) && !/^\s*\/\*\*/.test(prev)) {
          out.push(comment(hunk.path, lines[i]!.line, 'require-jsdoc', 'suggestion', 'Exported function missing JSDoc — add a docblock above.'));
        }
      }
    }
    return out;
  }),
  rule('require-readme-update', 'README must be updated when src/ changes', 'info', 'documentation', false, (pr) => {
    const out: ReviewComment[] = [];
    const srcChanged = pr.files.some((f) => f.startsWith('src/'));
    const readmeChanged = pr.files.some((f) => /^README(\.md)?$/i.test(f));
    if (srcChanged && !readmeChanged) {
      out.push(comment('README.md', 1, 'require-readme-update', 'info', 'Source files changed but README was not — confirm docs are still accurate.'));
    }
    return out;
  }),
  rule('require-changelog', 'CHANGELOG must be updated for releases', 'info', 'documentation', false, (pr) => {
    const out: ReviewComment[] = [];
    const versionChanged = pr.files.some((f) => /package\.json$/.test(f));
    const changelogChanged = pr.files.some((f) => /^CHANGELOG(\.md)?$/i.test(f));
    if (versionChanged && !changelogChanged) {
      out.push(comment('CHANGELOG.md', 1, 'require-changelog', 'info', 'Version bump detected but CHANGELOG was not updated.'));
    }
    return out;
  }),
  rule('no-todo-without-issue', 'TODOs should reference an issue', 'nit', 'documentation', false, (pr) => {
    const out: ReviewComment[] = [];
    for (const { hunk, line, text } of eachAddedLine(pr)) {
      const m = text.match(/\/\/\s*TODO\b(?!\s*#\d+)/i);
      if (m) {
        out.push(comment(hunk.path, line, 'no-todo-without-issue', 'nit', 'TODO without an issue reference — add `#123` so it is trackable.'));
      }
    }
    return out;
  }),
];

// ─── TESTING (4 rules) ───────────────────────────────────────────────────────

const TESTING_RULES: ReviewRule[] = [
  rule('require-tests-for-new-functions', 'New exported functions need tests', 'warning', 'testing', false, (pr) => {
    const out: ReviewComment[] = [];
    const newFuncs: string[] = [];
    for (const { hunk, line, text } of eachAddedLine(pr)) {
      const m = text.match(/^export\s+(?:async\s+)?function\s+(\w+)/);
      if (m) {
        newFuncs.push(m[1]!);
        out.push(comment(hunk.path, line, 'require-tests-for-new-functions', 'warning', `New exported function \`${m[1]}\` — add a test file.`));
      }
    }
    return out;
  }),
  rule('no-skip-tests', 'No .skip in tests', 'error', 'testing', true, (pr) => {
    const out: ReviewComment[] = [];
    for (const { hunk, line, text } of eachAddedLine(pr)) {
      if (/\b(describe|it|test)\.skip\b/.test(text)) {
        out.push(comment(hunk.path, line, 'no-skip-tests', 'error', '`.skip` left in test — remove or document why.'));
      }
    }
    return out;
  }),
  rule('no-only-tests', 'No .only in tests', 'blocker', 'testing', true, (pr) => {
    const out: ReviewComment[] = [];
    for (const { hunk, line, text } of eachAddedLine(pr)) {
      if (/\b(describe|it|test)\.only\b/.test(text)) {
        out.push(comment(hunk.path, line, 'no-only-tests', 'blocker', '`.only` blocks the rest of the suite from running — never commit.'));
      }
    }
    return out;
  }),
  rule('require-assertions', 'Tests should call expect/assert', 'warning', 'testing', false, (pr) => {
    const out: ReviewComment[] = [];
    for (const hunk of pr.hunks) {
      const lines = addedLines(hunk);
      let inTest = false;
      let hasAssertion = false;
      let testStart: { line: number; text: string } | null = null;
      for (const { line, text } of lines) {
        if (/\b(it|test)\s*\(/.test(text)) {
          inTest = true;
          hasAssertion = false;
          testStart = { line, text };
        }
        if (inTest && /\b(expect|assert)\s*\(/.test(text)) hasAssertion = true;
        if (inTest && text.trim().endsWith('});')) {
          if (!hasAssertion && testStart) {
            out.push(comment(hunk.path, testStart.line, 'require-assertions', 'warning', 'Test has no assertions — add at least one `expect()`.'));
          }
          inTest = false;
          testStart = null;
        }
      }
    }
    return out;
  }),
];

// ─── ACCESSIBILITY (3 rules) ─────────────────────────────────────────────────

const ACCESSIBILITY_RULES: ReviewRule[] = [
  rule('require-alt-text', 'Images need alt text', 'error', 'accessibility', true, (pr) => {
    const out: ReviewComment[] = [];
    for (const { hunk, line, text } of eachAddedLine(pr)) {
      if (/<img\s[^>]*>/i.test(text) && !/alt\s*=/i.test(text)) {
        out.push(comment(hunk.path, line, 'require-alt-text', 'error', '`<img>` missing `alt` attribute — required for screen readers.'));
      }
    }
    return out;
  }),
  rule('require-aria-label', 'Icon-only buttons need aria-label', 'error', 'accessibility', true, (pr) => {
    const out: ReviewComment[] = [];
    for (const { hunk, line, text } of eachAddedLine(pr)) {
      if (/<button[^>]*>\s*(<i|<svg|<Icon)/i.test(text) && !/aria-label/i.test(text)) {
        out.push(comment(hunk.path, line, 'require-aria-label', 'error', 'Icon-only `<button>` needs an `aria-label`.'));
      }
    }
    return out;
  }),
  rule('no-empty-heading', 'No empty headings', 'error', 'accessibility', true, (pr) => {
    const out: ReviewComment[] = [];
    for (const { hunk, line, text } of eachAddedLine(pr)) {
      if (/<h[1-6]\s*>\s*<\/h[1-6]>/i.test(text)) {
        out.push(comment(hunk.path, line, 'no-empty-heading', 'error', 'Empty heading — screen readers announce it as nothing.'));
      }
    }
    return out;
  }),
];

// ─── COMPATIBILITY (3 rules) ─────────────────────────────────────────────────

const COMPATIBILITY_RULES: ReviewRule[] = [
  rule('no-deprecated-api', 'No deprecated Node.js APIs', 'warning', 'compatibility', false, (pr) => {
    const out: ReviewComment[] = [];
    const deprecated = /\b(new\s+Buffer\b|util\.isArray\b|util\.isDate\b|domain\b)/;
    for (const { hunk, line, text } of eachAddedLine(pr)) {
      if (deprecated.test(text)) {
        out.push(comment(hunk.path, line, 'no-deprecated-api', 'warning', 'Deprecated Node.js API — use the modern replacement.'));
      }
    }
    return out;
  }),
  rule('no-node-specific-api-in-browser', 'No Node-only APIs in browser code', 'error', 'compatibility', true, (pr) => {
    const out: ReviewComment[] = [];
    const nodeApis = /\b(require\s*\(|process\.\w+|__dirname|__filename|fs\.\w+|path\.\w+)\b/;
    for (const { hunk, line, text } of eachAddedLine(pr)) {
      if (nodeApis.test(text) && /\.(tsx|jsx|html)$/.test(hunk.path)) {
        out.push(comment(hunk.path, line, 'no-node-specific-api-in-browser', 'error', 'Node.js-only API in browser code — will fail at runtime.'));
      }
      // The above uses `hunk.path` outside the iterator — rebind.
      void text;
    }
    // Re-scan with hunk context to fix the closure bug.
    const refined: ReviewComment[] = [];
    for (const { hunk, line, text } of eachAddedLine(pr)) {
      if (nodeApis.test(text) && /\.(tsx|jsx|html)$/.test(hunk.path)) {
        refined.push(comment(hunk.path, line, 'no-node-specific-api-in-browser', 'error', 'Node.js-only API in browser code — will fail at runtime.'));
      }
    }
    return refined.length > 0 ? refined : out;
  }),
  rule('require-browserslist', 'Frontend packages need a browserslist', 'info', 'compatibility', false, (pr) => {
    const out: ReviewComment[] = [];
    const pkgChanged = pr.files.some((f) => /package\.json$/.test(f));
    const hasBrowserslist = /browserslist/i.test(pr.body) || pr.files.some((f) => /\.browserslistrc$/.test(f));
    const isFrontend = pr.files.some((f) => /\.(tsx|jsx|vue|svelte)$/.test(f));
    if (pkgChanged && isFrontend && !hasBrowserslist) {
      out.push(comment('package.json', 1, 'require-browserslist', 'info', 'Frontend package without a `browserslist` field — add one for predictable transpilation.'));
    }
    return out;
  }),
];

// ─── METADATA (2 rules) ──────────────────────────────────────────────────────

const METADATA_RULES: ReviewRule[] = [
  rule('require-pr-description', 'PR must have a description', 'warning', 'metadata', false, (pr) => {
    const out: ReviewComment[] = [];
    if (pr.body.trim().length < 20) {
      out.push(comment(pr.files[0] ?? 'README.md', 1, 'require-pr-description', 'warning', 'PR description is empty or too short — explain what & why.'));
    }
    return out;
  }),
  rule('require-pr-template', 'PR should follow the template', 'info', 'metadata', false, (pr) => {
    const out: ReviewComment[] = [];
    const templateMarkers = ['## What', '## Why', '## How', '## Testing', '## Checklist'];
    const missing = templateMarkers.filter((m) => !pr.body.includes(m));
    if (missing.length >= 3) {
      out.push(comment(pr.files[0] ?? 'README.md', 1, 'require-pr-template', 'info', `PR description missing template sections: ${missing.join(', ')}.`));
    }
    return out;
  }),
];

// ─── All 52 rules ────────────────────────────────────────────────────────────

/**
 * The full set of 52 built-in rules. The count is asserted at module
 * load time so a future edit that adds or removes a rule will throw.
 */
export const BUILTIN_RULES: readonly ReviewRule[] = (() => {
  const all = [
    ...STYLE_RULES,
    ...CORRECTNESS_RULES,
    ...SECURITY_RULES,
    ...PERFORMANCE_RULES,
    ...MAINTAINABILITY_RULES,
    ...DOCUMENTATION_RULES,
    ...TESTING_RULES,
    ...ACCESSIBILITY_RULES,
    ...COMPATIBILITY_RULES,
    ...METADATA_RULES,
  ];
  if (all.length !== 52) {
    throw new Error(`Expected 52 built-in rules, got ${all.length}`);
  }
  return all;
})();

/**
 * Helper to construct a {@link ReviewRule} with a compact signature.
 * The `evaluate` function is the only required logic; everything else
 * is metadata.
 */
function rule(
  id: string,
  name: string,
  severity: ReviewComment['severity'],
  category: ReviewRule['category'],
  blocksApproval: boolean,
  evaluate: (pr: PullRequest) => ReviewComment[],
): ReviewRule {
  return { id, name, severity, category, enabled: true, blocksApproval, evaluate };
}
