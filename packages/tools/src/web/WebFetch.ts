/**
 * @file WebFetch — fetch a URL, with optional HTML→text extraction and a
 * byte cap. Permission: `web:fetch`.
 */
import {
  type SanixTool,
  type ToolContext,
  type ToolResult,
  type ToolPermission,
  z,
  okResult,
  errResult,
} from '../types.js';

/** Input schema for `fetch_url`. */
export const WebFetchInputSchema = z.object({
  url: z.string().url(),
  maxBytes: z.number().int().positive().max(8 * 1024 * 1024).default(1_000_000),
  extractText: z
    .boolean()
    .default(true)
    .describe('Strip HTML tags + collapse whitespace (default true).'),
});

/** Output schema for `fetch_url`. */
export const WebFetchOutputSchema = z.object({
  content: z.string(),
  contentType: z.string(),
  status: z.number().int(),
  bytes: z.number().int(),
});

export type WebFetchInput = z.infer<typeof WebFetchInputSchema>;
export type WebFetchOutput = z.infer<typeof WebFetchOutputSchema>;

/** Strip HTML tags, scripts, styles, and collapse whitespace. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/(p|div|h[1-6]|li|tr|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * WebFetchTool — fetch a URL and return its body.
 *
 * @example
 * ```ts
 * const res = await new WebFetchTool().execute(
 *   { url: 'https://example.com', extractText: true },
 *   ctx,
 * );
 * ```
 */
export class WebFetchTool implements SanixTool<WebFetchInput, WebFetchOutput> {
  readonly name = 'fetch_url';
  readonly description =
    'Fetch a URL and return its body. Optionally strips HTML to plain text. Caps response size to maxBytes.';
  readonly inputSchema = WebFetchInputSchema;
  readonly outputSchema = WebFetchOutputSchema;
  readonly permissions: ToolPermission[] = ['web:fetch'];
  readonly maxTokensInput = 256;
  readonly maxTokensOutput = 32_000;

  async execute(
    input: WebFetchInput,
    context: ToolContext,
  ): Promise<ToolResult<WebFetchOutput>> {
    const start = Date.now();
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15_000);
      const onParentAbort = () => ctrl.abort();
      if (context.signal) {
        if (context.signal.aborted) ctrl.abort();
        else context.signal.addEventListener('abort', onParentAbort, { once: true });
      }
      try {
        const res = await fetch(input.url, {
          signal: ctrl.signal,
          redirect: 'follow',
          headers: { 'User-Agent': 'sanix/1.0 (+https://github.com/sanix)' },
        });
        const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
        const buf = await res.arrayBuffer();
        const bytes = Math.min(buf.byteLength, input.maxBytes);
        const slice = new Uint8Array(buf, 0, bytes);
        const decoder = new TextDecoder('utf-8', { fatal: false });
        const raw = decoder.decode(slice);
        const isHtml = /html/i.test(contentType);
        const content = input.extractText && isHtml ? htmlToText(raw) : raw;
        return okResult<WebFetchOutput>(
          { content, contentType, status: res.status, bytes },
          Date.now() - start,
        );
      } finally {
        clearTimeout(timer);
        if (context.signal) context.signal.removeEventListener('abort', onParentAbort);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errResult<WebFetchOutput>(`fetch_url failed: ${msg}`, Date.now() - start);
    }
  }

  formatForContext(result: WebFetchOutput): string {
    const head = `HTTP ${result.status} (${result.contentType}, ${result.bytes} bytes)`;
    const body =
      result.content.length > 8000
        ? `${result.content.slice(0, 4000)}\n…[truncated]…\n${result.content.slice(-4000)}`
        : result.content;
    return `${head}\n${body}`;
  }
}
