/**
 * @file minimatch.ts
 * @description Tiny dependency-free glob matcher supporting the subset
 * of minimatch syntax that `@sanix/intel` needs:
 *
 *   - `*`     — match within a path segment (no `/`)
 *   - `**`    — match across path segments
 *   - `?`     — single char
 *   - `{a,b}` — alternation
 *   - `[abc]` / `[!abc]` — char classes
 *
 * Patterns are compiled to a RegExp once and cached.
 */

const cache = new Map<string, RegExp>();

/**
 * Convert a glob pattern to a RegExp.
 * @param glob Glob pattern.
 */
export function globToRegex(glob: string): RegExp {
  const cached = cache.get(glob);
  if (cached) return cached;
  let i = 0;
  let out = '^';
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i += 2;
        if (glob[i] === '/') i++;
        out += '.*';
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) { out += '\\{'; }
      else {
        const alts = glob.slice(i + 1, end).split(',').map(escape).join('|');
        out += `(?:${alts})`;
        i = end;
      }
    } else if (c === '[') {
      const end = glob.indexOf(']', i);
      if (end === -1) { out += '\\['; }
      else {
        out += glob.slice(i, end + 1);
        i = end;
      }
    } else if ('.+()|^$\\'.includes(c)) {
      out += '\\' + c;
    } else {
      out += c;
    }
    i++;
  }
  out += '$';
  const re = new RegExp(out);
  cache.set(glob, re);
  return re;
}

/**
 * Test whether a path matches a glob pattern.
 * @param path Path using `/` separators.
 * @param pattern Glob pattern.
 */
export function minimatch(path: string, pattern: string): boolean {
  return globToRegex(pattern).test(path);
}

/**
 * Escape regex special chars in a literal string.
 */
function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
