/**
 * @file Web tools barrel.
 */
export {
  WebSearchTool,
  WebSearchInputSchema,
  WebSearchOutputSchema,
} from './WebSearch.js';
export type { WebSearchInput, WebSearchOutput } from './WebSearch.js';

export {
  WebFetchTool,
  WebFetchInputSchema,
  WebFetchOutputSchema,
} from './WebFetch.js';
export type { WebFetchInput, WebFetchOutput } from './WebFetch.js';

export {
  DocumentReaderTool,
  ReadDocumentInputSchema,
  ReadDocumentOutputSchema,
} from './DocumentReader.js';
export type { ReadDocumentInput, ReadDocumentOutput } from './DocumentReader.js';
