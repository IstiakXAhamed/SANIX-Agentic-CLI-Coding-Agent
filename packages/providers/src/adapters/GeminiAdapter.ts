/**
 * @file GeminiAdapter.ts
 * @description IProvider adapter for Google's Gemini family
 * (gemini-2.5-pro, gemini-2.0-flash) via the REST `generativelanguage`
 * API. We deliberately avoid the `@google/generative-ai` SDK to keep the
 * providers package dependency-light — REST + fetch is sufficient and
 * avoids bundling the SDK in environments that don't use Gemini.
 *
 * Gemini's wire format is distinct from OpenAI's (parts/contents
 * rather than messages), so this adapter does NOT extend
 * {@link OpenAICompatBase}. It uses the shared `_http.ts` helpers for
 * fetch + SSE + error classification.
 */

import {
  IProvider,
  LLMRequest,
  LLMResponse,
  ToolCall,
  ToolDef,
  type MessageContent,
} from '../interfaces/IProvider.js';
import { getCapability } from '../interfaces/ProviderCapabilities.js';
import { fetchJson, pingUrl, streamSSE, type JsonValue } from './_http.js';

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Extract the plain-text portion of a {@link MessageContent}. Image / file
 * blocks are skipped (Gemini image support is via inlineData, handled
 * separately below). Returns '' for empty content.
 */
function extractTextFromContent(content: MessageContent): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as { type?: string; text?: string };
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push(b.text);
    }
  }
  return parts.join('');
}

/**
 * Extract image blocks from a {@link MessageContent}. Returns an array of
 * `{ mediaType, data }` for each image_base64 / image_file / image_url
 * block. Image URLs are NOT fetched (Gemini doesn't accept URLs — caller
 * would need to fetch and convert to base64).
 */
function extractImagesFromContent(content: MessageContent): Array<{ mediaType: string; data: string }> {
  if (!Array.isArray(content)) return [];
  const out: Array<{ mediaType: string; data: string }> = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as { type?: string; image_base64?: { data: string; mediaType: string } };
    if (b.type === 'image_base64' && b.image_base64) {
      out.push({ mediaType: b.image_base64.mediaType, data: b.image_base64.data });
    }
    // image_url and image_file would need fetching — skip for now (Gemini's
    // REST API doesn't natively support URL or file paths; only inline base64).
  }
  return out;
}


/** Constructor options for {@link GeminiAdapter}. */
export interface GeminiAdapterOptions {
  /** API key. Falls back to env `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) when omitted. */
  apiKey?: string;
  /** Stable alias id (defaults to 'gemini-2.5-pro'). */
  modelId?: string;
  /** Concrete Gemini model id (defaults to alias). */
  concreteModel?: string;
  /** Override the display name shown in the TUI. */
  displayName?: string;
  /** Per-request default timeout in ms. */
  defaultTimeoutMs?: number;
}

/** Gemini content/part shape. */
interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

/**
 * Adapter for Google Gemini models. Translates the unified SANIX
 * protocol onto Gemini's `contents`/`parts` shape, supports tool calling
 * via `functionDeclarations`, and parses both `generateContent` and
 * `streamGenerateContent?alt=sse` responses.
 */
export class GeminiAdapter implements IProvider {
  readonly id: string;
  readonly displayName: string;
  readonly isLocal: boolean;
  readonly strengths: string[];
  readonly latencyMs: number;
  readonly costPerMillionTokens: number;
  readonly maxContextTokens: number;

  private readonly apiKey: string | undefined;
  private readonly concreteModel: string;
  private readonly defaultTimeoutMs: number;

  constructor(opts: GeminiAdapterOptions = {}) {
    this.id = opts.modelId ?? 'gemini-2.5-pro';
    this.concreteModel = opts.concreteModel ?? this.id;
    const cap = getCapability(this.id);
    this.displayName = opts.displayName ?? `Google ${this.id}`;
    this.isLocal = cap.isLocal;
    this.strengths = cap.strengths;
    this.latencyMs = cap.latencyMs;
    this.costPerMillionTokens = cap.costPerMillionTokens;
    this.maxContextTokens = cap.maxContextTokens;
    this.apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 30_000;
  }

  /** @inheritdoc — Gemini has no cheap ping endpoint, so a key implies availability. */
  async available(): Promise<boolean> {
    if (!this.apiKey) return false;
    // Light-touch: hit the models.list endpoint (1 quota unit, near-free).
    return pingUrl(`${GEMINI_BASE_URL}/models?key=${this.apiKey}`, { timeoutMs: 5_000 });
  }

  /** @inheritdoc */
  async chat(req: LLMRequest): Promise<LLMResponse> {
    const startedAt = Date.now();
    const body = this.buildBody(req);
    const url = `${GEMINI_BASE_URL}/models/${this.concreteModel}:generateContent?key=${this.apiKey}`;
    const json = await fetchJson(this.id, url, {
      method: 'POST',
      body,
      signal: req.signal,
      timeoutMs: this.defaultTimeoutMs,
    });
    return this.parseResponse(json, startedAt);
  }

  /** @inheritdoc */
  async *chatStream(req: LLMRequest): AsyncIterable<string> {
    const body = this.buildBody(req);
    const url = `${GEMINI_BASE_URL}/models/${this.concreteModel}:streamGenerateContent?alt=sse&key=${this.apiKey}`;
    for await (const evt of streamSSE(this.id, url, {
      body,
      signal: req.signal,
      timeoutMs: this.defaultTimeoutMs,
    })) {
      const delta = this.extractDelta(evt);
      if (delta) yield delta;
    }
  }

  // ── internal helpers ───────────────────────────────────────────────

  /** Build the Gemini generateContent request body. */
  private buildBody(req: LLMRequest): Record<string, unknown> {
    const contents: GeminiContent[] = [];
    let systemInstruction: string | undefined;

    if (req.systemPrompt) systemInstruction = req.systemPrompt;

    for (const m of req.messages) {
      if (m.role === 'system') {
        const text = extractTextFromContent(m.content);
        systemInstruction = systemInstruction
          ? `${systemInstruction}\n\n${text}`
          : text;
        continue;
      }
      if (m.role === 'user') {
        const text = extractTextFromContent(m.content);
        const images = extractImagesFromContent(m.content);
        const parts: GeminiPart[] = [];
        if (text) parts.push({ text });
        for (const img of images) {
          parts.push({ inlineData: { mimeType: img.mediaType, data: img.data } } as GeminiPart);
        }
        if (parts.length === 0) parts.push({ text: '' });
        contents.push({ role: 'user', parts });
        continue;
      }
      if (m.role === 'assistant') {
        const parts: GeminiPart[] = [];
        const text = extractTextFromContent(m.content);
        if (text) parts.push({ text });
        if (m.tool_calls) {
          for (const tc of m.tool_calls) {
            let args: Record<string, unknown> = {};
            try {
              const parsed: unknown = JSON.parse(tc.function.arguments);
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                args = parsed as Record<string, unknown>;
              }
            } catch {
              args = {};
            }
            parts.push({ functionCall: { name: tc.function.name, args } });
          }
        }
        contents.push({ role: 'model', parts });
        continue;
      }
      // tool result
      contents.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: m.tool_call_id ?? 'tool',
              response: safeParse(extractTextFromContent(m.content)),
            },
          },
        ],
      });
    }

    const body: Record<string, unknown> = { contents };
    if (systemInstruction) {
      body.systemInstruction = { parts: [{ text: systemInstruction }] };
    }
    const genConfig: Record<string, unknown> = {};
    if (req.maxTokens !== undefined) genConfig.maxOutputTokens = req.maxTokens;
    if (req.temperature !== undefined) genConfig.temperature = req.temperature;
    if (Object.keys(genConfig).length > 0) body.generationConfig = genConfig;
    if (req.tools && req.tools.length > 0) {
      body.tools = [{ functionDeclarations: this.translateTools(req.tools) }];
    }
    return body;
  }

  /** Translate SANIX ToolDef[] → Gemini functionDeclarations. */
  private translateTools(tools: ToolDef[]): unknown[] {
    return tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    }));
  }

  /** Parse a non-streaming generateContent response. */
  private parseResponse(json: JsonValue, startedAt: number): LLMResponse {
    const obj = json as { [k: string]: JsonValue };
    const candidates = obj.candidates as { [k: string]: JsonValue }[] | undefined;
    const candidate = candidates?.[0];
    const content = (candidate?.content ?? {}) as { [k: string]: JsonValue };
    const parts = (content.parts ?? []) as { [k: string]: JsonValue }[];

    let text = '';
    const toolCalls: ToolCall[] = [];
    parts.forEach((part, idx) => {
      if (typeof part.text === 'string') {
        text += part.text;
      } else if (part.functionCall && typeof part.functionCall === 'object') {
        const fc = part.functionCall as { name?: JsonValue; args?: JsonValue };
        const name = typeof fc.name === 'string' ? fc.name : '';
        const args = fc.args ?? {};
        toolCalls.push({
          id: `call_${idx}`,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        });
      }
    });

    const usage = (obj.usageMetadata ?? {}) as { [k: string]: JsonValue };
    return {
      content: text,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        inputTokens: toNumber(usage.promptTokenCount),
        outputTokens: toNumber(usage.candidatesTokenCount),
      },
      model: this.concreteModel,
      latencyMs: Date.now() - startedAt,
      stopReason:
        typeof candidate?.finishReason === 'string'
          ? (candidate.finishReason as string)
          : undefined,
    };
  }

  /** Extract a text delta from a single streaming chunk. */
  private extractDelta(evt: JsonValue): string {
    const obj = evt as { [k: string]: JsonValue };
    const candidates = obj.candidates as { [k: string]: JsonValue }[] | undefined;
    const candidate = candidates?.[0];
    const content = (candidate?.content ?? {}) as { [k: string]: JsonValue };
    const parts = (content.parts ?? []) as { [k: string]: JsonValue }[];
    let delta = '';
    for (const part of parts) {
      if (typeof part.text === 'string') delta += part.text;
    }
    return delta;
  }
}

/** Coerce a JsonValue that should be numeric into a finite number (default 0). */
function toNumber(v: JsonValue | undefined): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

/** Parse a JSON string safely into a record; falls back to `{ output: <raw> }`. */
function safeParse(s: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(s);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return { output: s };
}
