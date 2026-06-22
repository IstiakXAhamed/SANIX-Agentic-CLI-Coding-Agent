/**
 * @file WebSearch — Brave / Tavily / SerpAPI search. Reads API keys from env.
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

/** Input schema for `web_search`. */
export const WebSearchInputSchema = z.object({
  query: z.string().min(1),
  maxResults: z.number().int().positive().max(50).default(8),
  provider: z.enum(['brave', 'tavily', 'serp']).default('brave'),
});

/** Output schema for `web_search`. */
export const WebSearchOutputSchema = z.object({
  results: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      snippet: z.string(),
    }),
  ),
});

export type WebSearchInput = z.infer<typeof WebSearchInputSchema>;
export type WebSearchOutput = z.infer<typeof WebSearchOutputSchema>;

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface FetchedJson {
  status: number;
  body: unknown;
}

/** Fetch JSON with timeout + abort. */
async function fetchJson(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
  timeoutMs = 15_000,
): Promise<FetchedJson> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onParentAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', onParentAbort, { once: true });
  }
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* keep as text */
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onParentAbort);
  }
}

/** Brave Search API. */
async function braveSearch(
  query: string,
  max: number,
  apiKey: string,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(max));
  const { status, body } = await fetchJson(
    url.toString(),
    {
      method: 'GET',
      headers: {
        'X-Subscription-Token': apiKey,
        Accept: 'application/json',
      },
    },
    signal,
  );
  if (status !== 200) {
    throw new Error(`brave: HTTP ${status}`);
  }
  const b = body as { web?: { results?: Array<Record<string, unknown>> } };
  const results = b?.web?.results ?? [];
  return results.slice(0, max).map((r) => ({
    title: typeof r.title === 'string' ? r.title : '',
    url: typeof r.url === 'string' ? r.url : typeof r.link === 'string' ? r.link : '',
    snippet: typeof r.description === 'string' ? r.description : '',
  }));
}

/** Tavily Search API. */
async function tavilySearch(
  query: string,
  max: number,
  apiKey: string,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const { status, body } = await fetchJson(
    'https://api.tavily.com/search',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: max,
        include_answer: false,
      }),
    },
    signal,
  );
  if (status !== 200) {
    throw new Error(`tavily: HTTP ${status}`);
  }
  const b = body as { results?: Array<Record<string, unknown>> };
  const results = b?.results ?? [];
  return results.slice(0, max).map((r) => ({
    title: typeof r.title === 'string' ? r.title : '',
    url: typeof r.url === 'string' ? r.url : '',
    snippet: typeof r.content === 'string' ? r.content : '',
  }));
}

/** SerpAPI. */
async function serpSearch(
  query: string,
  max: number,
  apiKey: string,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.set('q', query);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('engine', 'google');
  const { status, body } = await fetchJson(
    url.toString(),
    { method: 'GET', headers: { Accept: 'application/json' } },
    signal,
  );
  if (status !== 200) {
    throw new Error(`serp: HTTP ${status}`);
  }
  const b = body as { organic_results?: Array<Record<string, unknown>> };
  const results = b?.organic_results ?? [];
  return results.slice(0, max).map((r) => ({
    title: typeof r.title === 'string' ? r.title : '',
    url: typeof r.link === 'string' ? r.link : typeof r.url === 'string' ? r.url : '',
    snippet: typeof r.snippet === 'string' ? r.snippet : '',
  }));
}

/**
 * WebSearchTool — query the web via Brave / Tavily / SerpAPI.
 *
 * @example
 * ```ts
 * const res = await new WebSearchTool().execute(
 *   { query: 'node 22 features', provider: 'brave' },
 *   ctx,
 * );
 * ```
 */
export class WebSearchTool implements SanixTool<WebSearchInput, WebSearchOutput> {
  readonly name = 'web_search';
  readonly description =
    'Search the web using Brave Search, Tavily, or SerpAPI. Requires the corresponding *_API_KEY env var.';
  readonly inputSchema = WebSearchInputSchema;
  readonly outputSchema = WebSearchOutputSchema;
  readonly permissions: ToolPermission[] = ['web:search'];
  readonly maxTokensInput = 256;
  readonly maxTokensOutput = 8_000;

  async execute(
    input: WebSearchInput,
    context: ToolContext,
  ): Promise<ToolResult<WebSearchOutput>> {
    const start = Date.now();
    try {
      let results: SearchResult[];
      if (input.provider === 'brave') {
        const key = process.env.BRAVE_API_KEY;
        if (!key) {
          return errResult<WebSearchOutput>(
            'web_search: BRAVE_API_KEY env var not set',
            Date.now() - start,
          );
        }
        results = await braveSearch(input.query, input.maxResults, key, context.signal);
      } else if (input.provider === 'tavily') {
        const key = process.env.TAVILY_API_KEY;
        if (!key) {
          return errResult<WebSearchOutput>(
            'web_search: TAVILY_API_KEY env var not set',
            Date.now() - start,
          );
        }
        results = await tavilySearch(input.query, input.maxResults, key, context.signal);
      } else {
        const key = process.env.SERP_API_KEY;
        if (!key) {
          return errResult<WebSearchOutput>(
            'web_search: SERP_API_KEY env var not set',
            Date.now() - start,
          );
        }
        results = await serpSearch(input.query, input.maxResults, key, context.signal);
      }
      return okResult<WebSearchOutput>({ results }, Date.now() - start);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errResult<WebSearchOutput>(`web_search failed: ${msg}`, Date.now() - start);
    }
  }

  formatForContext(result: WebSearchOutput): string {
    if (result.results.length === 0) return 'no search results';
    return result.results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
      .join('\n');
  }
}
