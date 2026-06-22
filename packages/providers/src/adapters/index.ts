/**
 * @file adapters/index.ts
 * @description Barrel re-export of every adapter so callers can do
 * `import { AnthropicAdapter, OpenAIAdapter, ... } from '@sanix/providers/adapters'`.
 *
 * Internal helpers (`_http.ts`, `_openaiCompat.ts`) are intentionally NOT
 * re-exported here — they are implementation detail.
 */

export { AnthropicAdapter, type AnthropicAdapterOptions } from './AnthropicAdapter.js';
export { OpenAIAdapter, type OpenAIAdapterOptions } from './OpenAIAdapter.js';
export { GeminiAdapter, type GeminiAdapterOptions } from './GeminiAdapter.js';
export { MistralAdapter, type MistralAdapterOptions } from './MistralAdapter.js';
export { GroqAdapter, type GroqAdapterOptions } from './GroqAdapter.js';
export { TogetherAdapter, type TogetherAdapterOptions } from './TogetherAdapter.js';
export { DeepSeekAdapter, type DeepSeekAdapterOptions } from './DeepSeekAdapter.js';
export { OllamaAdapter, type OllamaAdapterOptions } from './OllamaAdapter.js';
export { LMStudioAdapter, type LMStudioAdapterOptions } from './LMStudioAdapter.js';
export { OpenAICompatAdapter, type OpenAICompatAdapterOptions } from './OpenAICompatAdapter.js';
