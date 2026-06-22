/**
 * @file Tiny HTML-to-Markdown converter used by `BrowserExtract` and
 * `BrowserSession.extractMainContent`. Intentionally dependency-free and
 * lossy — it strips `<script>`/`<style>`/`<nav>`/`<footer>`/`<aside>`,
 * converts headings/lists/links/code/quotes to Markdown, and collapses
 * the resulting whitespace.
 *
 * For high-fidelity conversion consumers should reach for `turndown` or
 * `@sanix/rag`'s richer extractors; this implementation is deliberately
 * minimal so `@sanix/browser` stays zero-dep beyond Playwright.
 */

/** Strip every HTML tag from a string. */
function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '');
}

/** Decode the most common HTML entities to their literal characters. */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/** Collapse runs of spaces/tabs and excessive blank lines. */
function collapseWhitespace(s: string): string {
  return s
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ \n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Convert a raw HTML fragment to Markdown.
 *
 * @example
 * ```ts
 * const md = htmlToMarkdown('<h1>Title</h1><p>Hello <a href="/x">world</a></p>');
 * // → '# Title\n\nHello [world](/x)'
 * ```
 */
export function htmlToMarkdown(html: string): string {
  let s = html;

  // ── Drop non-content blocks ────────────────────────────────────────────
  s = s
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<template[\s\S]*?<\/template>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  // ── Pre-formatted code blocks (before generic tag stripping) ───────────
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, code: string) => {
    const text = decodeEntities(stripTags(code)).replace(/\n{3,}/g, '\n\n').trim();
    return `\n\n\`\`\`\n${text}\n\`\`\`\n\n`;
  });

  // ── Headings ───────────────────────────────────────────────────────────
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, body: string) => {
    const hashes = '#'.repeat(parseInt(level, 10));
    return `\n\n${hashes} ${stripTags(body).trim()}\n\n`;
  });

  // ── Inline code (do before links so we don't mangle code samples) ──────
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, code: string) => `\`${decodeEntities(code)}\``);

  // ── Links ──────────────────────────────────────────────────────────────
  s = s.replace(
    /<a\b([^>]*)>([\s\S]*?)<\/a>/gi,
    (_m, attrs: string, body: string) => {
      const hrefMatch = attrs.match(/href\s*=\s*["']([^"']+)["']/i);
      const href = hrefMatch ? hrefMatch[1] : '';
      const text = stripTags(body).trim();
      if (!href) return text;
      return `[${text}](${href})`;
    },
  );

  // ── Images ─────────────────────────────────────────────────────────────
  s = s.replace(/<img\b([^>]*)\/?>/gi, (_m, attrs: string) => {
    const srcMatch = attrs.match(/src\s*=\s*["']([^"']+)["']/i);
    const altMatch = attrs.match(/alt\s*=\s*["']([^"']*)["']/i);
    const src = srcMatch ? srcMatch[1] : '';
    const alt = altMatch ? altMatch[1] : '';
    return src ? `![${alt}](${src})` : '';
  });

  // ── Bold / italic / strikethrough ──────────────────────────────────────
  s = s
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**')
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*')
    .replace(/<(s|strike|del)\b[^>]*>([\s\S]*?)<\/\1>/gi, '~~$2~~');

  // ── Blockquotes ────────────────────────────────────────────────────────
  s = s.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, q: string) => {
    const inner = stripTags(q).trim().replace(/\n/g, '\n> ');
    return `\n\n> ${inner}\n\n`;
  });

  // ── Lists (unordered + ordered) ────────────────────────────────────────
  // Unordered list items → "- text"
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, item: string) => {
    const txt = stripTags(item).trim();
    return `- ${txt}\n`;
  });
  // Drop the ul/ol wrappers themselves.
  s = s.replace(/<\/?(ul|ol|menu)\b[^>]*>/gi, '\n');

  // Definition list terms / descriptions.
  s = s
    .replace(/<dt\b[^>]*>([\s\S]*?)<\/dt>/gi, (_m, t: string) => `\n**${stripTags(t).trim()}**\n`)
    .replace(/<dd\b[^>]*>([\s\S]*?)<\/dd>/gi, (_m, d: string) => `: ${stripTags(d).trim()}\n`)
    .replace(/<\/?dl\b[^>]*>/gi, '\n');

  // ── Tables → pipe tables (very rough) ──────────────────────────────────
  s = s.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_m, table: string) => {
    const rows: string[][] = [];
    const rowMatches = table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi);
    for (const rm of rowMatches) {
      const cells: string[] = [];
      const cellMatches = rm[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi);
      for (const cm of cellMatches) {
        cells.push(stripTags(cm[1]).trim());
      }
      if (cells.length) rows.push(cells);
    }
    if (!rows.length) return '';
    const header = rows[0];
    const sep = header.map(() => '---');
    const lines = [
      `| ${header.join(' | ')} |`,
      `| ${sep.join(' | ')} |`,
      ...rows.slice(1).map((r) => `| ${r.join(' | ')} |`),
    ];
    return `\n\n${lines.join('\n')}\n\n`;
  });

  // ── Paragraphs + breaks + dividers ─────────────────────────────────────
  s = s
    .replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, '$1\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n\n---\n\n')
    .replace(/<\/(div|section|article|main|header|td|th|tr|tbody|thead|tfoot)>/gi, '\n');

  // ── Strip remaining tags ───────────────────────────────────────────────
  s = stripTags(s);

  // ── Decode entities + collapse whitespace ──────────────────────────────
  s = decodeEntities(s);
  s = collapseWhitespace(s);

  return s;
}

/** Strip all HTML to plain text (used for the `text` extraction mode). */
export function htmlToText(html: string): string {
  const s = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/(p|div|h[1-6]|li|tr|br|section|article|header|footer)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return collapseWhitespace(decodeEntities(s));
}
