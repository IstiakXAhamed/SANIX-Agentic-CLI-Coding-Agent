/**
 * @file APIDesigner.ts
 * @description SANIX API Designer — an API design specialist agent.
 *
 * Designs RESTful and GraphQL APIs from natural-language requirements
 * (or existing code), generates OpenAPI 3.1 specs, mock servers,
 * TypeScript + Python SDK clients, Postman collections, Markdown
 * documentation, and validates the design against REST/GraphQL best
 * practices (naming, pagination, filtering, sorting, versioning,
 * authentication, rate limiting, status codes).
 *
 * @packageDocumentation
 */

import { nanoid } from 'nanoid';
import { BaseAgent } from '../BaseAgent.js';
import type {
  AgentAction,
  AgentCategory,
  AgentFinding,
  AgentProgressEvent,
  AgentRunOptions,
  AgentRunResult,
} from '../types.js';

/** API style: REST or GraphQL. */
export type ApiStyle = 'rest' | 'graphql' | 'rest_and_graphql';

/** HTTP method (REST). */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** A field's data type. */
export type FieldType =
  | 'string'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'uuid'
  | 'email'
  | 'url'
  | 'binary'
  | 'array'
  | 'object'
  | 'enum'
  | 'reference';

/** A field in a resource schema. */
export interface SchemaField {
  /** Field name (camelCase). */
  name: string;
  /** Field type. */
  type: FieldType;
  /** For `array` types — the element type. */
  items?: SchemaField;
  /** For `object` types — nested fields. */
  properties?: SchemaField[];
  /** For `enum` types — allowed values. */
  enum?: string[];
  /** For `reference` types — the referenced resource name. */
  ref?: string;
  /** Whether the field is required. */
  required: boolean;
  /** Whether the field is nullable. */
  nullable: boolean;
  /** Whether the field is read-only (server-generated). */
  readOnly?: boolean;
  /** Whether the field is write-only (input only). */
  writeOnly?: boolean;
  /** Human-readable description. */
  description?: string;
  /** Default value (for input fields). */
  default?: unknown;
  /** Example value. */
  example?: unknown;
}

/** A resource (entity) in the API. */
export interface ApiResource {
  /** Singular resource name (e.g. `User`). */
  name: string;
  /** Plural name (e.g. `Users`). */
  plural: string;
  /** Description. */
  description: string;
  /** Schema fields. */
  fields: SchemaField[];
  /** Operations supported. */
  operations: ('list' | 'create' | 'read' | 'update' | 'delete' | 'patch')[];
  /** Related resources (foreign-key targets). */
  relations: Array<{ resource: string; type: 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many'; foreignKey?: string }>;
  /** Whether pagination is enabled for list operations. */
  paginated: boolean;
  /** Whether filtering is enabled. */
  filterable: boolean;
  /** Whether sorting is enabled. */
  sortable: boolean;
}

/** A REST endpoint. */
export interface RestEndpoint {
  /** HTTP method. */
  method: HttpMethod;
  /** URL path (e.g. `/api/v1/users/:id`). */
  path: string;
  /** Operation id (e.g. `getUserById`). */
  operationId: string;
  /** Short summary. */
  summary: string;
  /** Path parameters. */
  pathParams: SchemaField[];
  /** Query parameters (filtering, sorting, pagination). */
  queryParams: SchemaField[];
  /** Request body schema (for POST/PUT/PATCH). */
  requestBody?: { resource: string; required: boolean };
  /** Response schema per status code. */
  responses: Array<{ status: number; description: string; resource?: string; isArray?: boolean }>;
  /** Authentication required. */
  authRequired: boolean;
}

/** A GraphQL operation. */
export interface GraphQLOperation {
  /** Operation type. */
  type: 'query' | 'mutation' | 'subscription';
  /** Operation name. */
  name: string;
  /** Description. */
  description: string;
  /** Arguments. */
  args: SchemaField[];
  /** Return type (resource name or scalar). */
  returns: { resource?: string; type: FieldType; isArray?: boolean; nullable?: boolean };
}

/** Generated artifact (file). */
export interface GeneratedArtifact {
  /** File path relative to workspace. */
  path: string;
  /** File contents. */
  content: string;
  /** Artifact kind. */
  kind: 'openapi' | 'graphql_schema' | 'mock_server' | 'sdk_typescript' | 'sdk_python' | 'postman' | 'docs' | 'readme';
}

/** Auth scheme for the API. */
export type AuthScheme = 'none' | 'bearer' | 'basic' | 'apiKey' | 'oauth2' | 'session';

/** A validation issue against the design. */
export interface DesignValidationIssue {
  /** Where the issue was found (endpoint path, resource name, etc.). */
  location: string;
  /** What rule was violated. */
  rule: string;
  /** Severity. */
  severity: 'high' | 'medium' | 'low';
  /** Description. */
  message: string;
  /** Suggested fix. */
  suggestion?: string;
}

/** Options for designing an API. */
export interface APIDesignOptions {
  /** API style (default: REST). */
  style?: ApiStyle;
  /** API version (default `v1`). */
  version?: string;
  /** URL prefix (default `/api`). */
  prefix?: string;
  /** Auth scheme (default `bearer`). */
  auth?: AuthScheme;
  /** Whether to generate a mock server. */
  generateMockServer?: boolean;
  /** Whether to generate SDK clients. */
  generateSDK?: boolean;
  /** Whether to generate a Postman collection. */
  generatePostman?: boolean;
  /** Whether to generate Markdown docs. */
  generateDocs?: boolean;
  /** Output directory for generated artifacts (default `./api-design`). */
  outputDir?: string;
}

/** REST well-known status codes per method. */
const STANDARD_STATUS: Record<HttpMethod, number[]> = {
  GET: [200, 404, 401, 403, 500],
  POST: [201, 400, 401, 403, 409, 422, 500],
  PUT: [200, 204, 400, 401, 403, 404, 422, 500],
  PATCH: [200, 204, 400, 401, 403, 404, 422, 500],
  DELETE: [204, 401, 403, 404, 500],
};

/** Common query params for paginated list endpoints. */
const PAGINATION_PARAMS: SchemaField[] = [
  { name: 'cursor', type: 'string', required: false, nullable: true, description: 'Opaque cursor for the next page' },
  { name: 'limit', type: 'integer', required: false, nullable: false, default: 50, description: 'Max items per page (1..200)' },
];

/** Common query params for sorting. */
const SORT_PARAMS: SchemaField[] = [
  { name: 'sort', type: 'string', required: false, nullable: true, description: 'Comma-separated field names; prefix `-` for descending (e.g. `-created_at,name`)' },
];

/** Common query params for filtering. */
const FILTER_PARAMS: SchemaField[] = [
  { name: 'filter', type: 'string', required: false, nullable: true, description: 'Filter expression (e.g. `status=active&created_at>2024-01-01`)' },
];

/**
 * SANIX API Designer — an API design specialist.
 *
 * @example
 * ```ts
 * import { APIDesigner } from '@sanix/agents';
 *
 * const agent = new APIDesigner();
 * const result = await agent.run({
 *   query: 'Design a REST API for a todo-list app with users, lists, and items.',
 *   workspacePath: '/repo/my-app',
 *   tools: registry,
 *   onProgress: (e) => console.log(`[${e.phase}] ${e.message}`),
 * });
 * console.log(`${result.metrics.endpoints} endpoints designed.`);
 * ```
 */
export class APIDesigner extends BaseAgent {
  /** @inheritdoc */
  readonly id = 'api-designer';
  /** @inheritdoc */
  readonly name = 'SANIX API Designer';
  /** @inheritdoc */
  readonly description =
    'Designs RESTful and GraphQL APIs from requirements (or existing code), following best practices: proper HTTP methods, status codes, resource naming (plural nouns), cursor-based pagination, filtering, sorting, versioning, authentication, and rate limiting. Generates OpenAPI 3.1 specs, mock servers (Express/Apollo), TypeScript + Python SDK clients, Postman collections, and Markdown documentation. Validates designs against REST/GraphQL conventions and flags violations.';
  /** @inheritdoc */
  readonly icon = '🎨';
  /** @inheritdoc */
  readonly category: AgentCategory = 'api' as AgentCategory;
  /** @inheritdoc */
  readonly systemPrompt = `You are SANIX API Designer, an API design expert. You design RESTful and GraphQL APIs following best practices: proper HTTP methods, status codes, resource naming, pagination, filtering, sorting, versioning, authentication, rate limiting. You generate:
- OpenAPI 3.1 specs
- Mock servers (Express/Fastify for REST, Apollo for GraphQL)
- Client SDKs (TypeScript/Python)
- Postman collections
- API documentation

You validate designs against REST/GraphQL conventions and suggest improvements.

Design rules:
- Use plural nouns for resource collections: /users, /users/:id
- Use cursor-based pagination (not offset/limit)
- Support filtering via ?filter=expressions, sorting via ?sort=-field,field
- Support sparse fieldsets via ?fields=id,name
- Use proper HTTP status codes (200, 201, 204, 400, 401, 403, 404, 409, 422, 429, 500)
- Version the API in the URL (/api/v1/) or via header (Accept: application/vnd.api+json;version=1)
- Authenticate via Bearer tokens (JWT) or OAuth2
- Rate-limit per API key (429 + Retry-After header)
- Use ISO 8601 timestamps, UUIDs for ids
- Nest sub-resources no deeper than 2 levels: /users/:id/posts/:id/comments`;
  /** @inheritdoc */
  readonly tools = ['read_file', 'write_file', 'bash', 'search_files', 'analyze_ast'];
  /** @inheritdoc */
  readonly exampleQueries = [
    'Design a REST API for a project-management tool with workspaces, projects, tasks, and comments.',
    'Generate an OpenAPI 3.1 spec for the e-commerce checkout flow (cart → order → payment).',
    'Design a GraphQL schema for a social network with users, posts, likes, and follows.',
    'Generate a TypeScript SDK client from the existing OpenAPI spec at openapi.yaml.',
    'Create a Postman collection + mock server for the Stripe-style payment API.',
  ];

  /**
   * Run the API Designer on a workspace.
   */
  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    const startedAt = Date.now();
    const emit = (phase: string, message: string, progress?: number, data?: Record<string, unknown>): void => {
      const event: AgentProgressEvent = { phase, message, progress, timestamp: Date.now(), data };
      options.onProgress?.(event);
    };
    const tools = options.tools ?? {};

    const findings: AgentFinding[] = [];
    const actions: AgentAction[] = [];
    const metrics: Record<string, number | string> = {};

    try {
      // ── Phase 1: Requirements analysis ─────────────────────────────────
      emit('requirements', 'Analyzing requirements…', 0.05);
      const designOpts: APIDesignOptions = this.parseDesignOptions(options.query);
      const existingCode = await this.findExistingApiCode(options.workspacePath, tools);
      emit('requirements', `Style: ${designOpts.style ?? 'rest'}; ${existingCode.hasExisting ? 'existing API detected' : 'greenfield design'}.`, 0.1);

      // ── Phase 2: Resource identification ───────────────────────────────
      emit('resources', 'Identifying resources + relationships…', 0.15);
      const resources = await this.identifyResources(options.query, existingCode, tools);
      metrics.resources = resources.length;
      emit('resources', `Identified ${resources.length} resources: ${resources.map((r) => r.name).join(', ')}.`, 0.25);

      // ── Phase 3: API design ────────────────────────────────────────────
      emit('design', 'Designing endpoints…', 0.3);
      const style = designOpts.style ?? 'rest';
      let restEndpoints: RestEndpoint[] = [];
      let graphqlOps: GraphQLOperation[] = [];
      if (style === 'rest' || style === 'rest_and_graphql') {
        restEndpoints = this.designRestEndpoints(resources, designOpts);
        metrics.restEndpoints = restEndpoints.length;
      }
      if (style === 'graphql' || style === 'rest_and_graphql') {
        graphqlOps = this.designGraphQLOperations(resources);
        metrics.graphqlOps = graphqlOps.length;
      }
      const totalEndpoints = restEndpoints.length + graphqlOps.length;
      metrics.endpoints = totalEndpoints;
      emit('design', `${totalEndpoints} operations designed.`, 0.4);

      // ── Phase 4: Validation ────────────────────────────────────────────
      emit('validation', 'Validating design against best practices…', 0.45);
      const issues = this.validateDesign(resources, restEndpoints, graphqlOps, designOpts);
      metrics.validationIssues = issues.length;
      for (const issue of issues) {
        findings.push(this.issueToFinding(issue));
      }
      emit('validation', `${issues.length} design issues flagged.`, 0.5);

      // ── Phase 5: Generate artifacts ────────────────────────────────────
      const artifacts: GeneratedArtifact[] = [];
      const outputDir = designOpts.outputDir ?? 'api-design';

      // 5a: OpenAPI spec (REST)
      if (restEndpoints.length > 0) {
        emit('generate', 'Generating OpenAPI 3.1 spec…', 0.55);
        const openapi = this.generateOpenApiSpec(resources, restEndpoints, designOpts);
        artifacts.push({ path: `${outputDir}/openapi.yaml`, content: openapi, kind: 'openapi' });
      }
      // 5b: GraphQL schema
      if (graphqlOps.length > 0) {
        emit('generate', 'Generating GraphQL schema…', 0.6);
        const schema = this.generateGraphQLSchema(resources, graphqlOps);
        artifacts.push({ path: `${outputDir}/schema.graphql`, content: schema, kind: 'graphql_schema' });
      }
      // 5c: Mock server
      if (designOpts.generateMockServer !== false) {
        emit('generate', 'Generating mock server…', 0.65);
        if (restEndpoints.length > 0) {
          const mock = this.generateRestMockServer(resources, restEndpoints, designOpts);
          artifacts.push({ path: `${outputDir}/mock/server.ts`, content: mock, kind: 'mock_server' });
        }
        if (graphqlOps.length > 0) {
          const mock = this.generateGraphQLMockServer(resources, graphqlOps);
          artifacts.push({ path: `${outputDir}/mock/graphql-server.ts`, content: mock, kind: 'mock_server' });
        }
      }
      // 5d: SDK clients
      if (designOpts.generateSDK !== false) {
        emit('generate', 'Generating SDK clients…', 0.75);
        if (restEndpoints.length > 0) {
          artifacts.push({
            path: `${outputDir}/sdk/typescript/client.ts`,
            content: this.generateTypeScriptSDK(resources, restEndpoints, designOpts),
            kind: 'sdk_typescript',
          });
          artifacts.push({
            path: `${outputDir}/sdk/python/client.py`,
            content: this.generatePythonSDK(resources, restEndpoints, designOpts),
            kind: 'sdk_python',
          });
        }
      }
      // 5e: Postman collection
      if (designOpts.generatePostman !== false && restEndpoints.length > 0) {
        emit('generate', 'Generating Postman collection…', 0.85);
        artifacts.push({
          path: `${outputDir}/postman/collection.json`,
          content: this.generatePostmanCollection(resources, restEndpoints, designOpts),
          kind: 'postman',
        });
      }
      // 5f: Documentation
      if (designOpts.generateDocs !== false) {
        emit('generate', 'Generating Markdown documentation…', 0.9);
        const docs = this.generateDocs(resources, restEndpoints, graphqlOps, designOpts);
        artifacts.push({ path: `${outputDir}/docs/API.md`, content: docs, kind: 'docs' });
        const readme = this.generateReadme(resources, artifacts, designOpts);
        artifacts.push({ path: `${outputDir}/README.md`, content: readme, kind: 'readme' });
      }
      metrics.artifactsGenerated = artifacts.length;

      // Write artifacts to disk via write_file tool (best-effort).
      const writeFile = tools['write_file'];
      if (typeof writeFile === 'function') {
        for (const art of artifacts) {
          try {
            await writeFile({
              path: art.path,
              content: art.content,
              workspacePath: options.workspacePath,
            });
            actions.push({
              id: nanoid(10),
              type: 'write_file',
              description: `Wrote ${art.kind} artifact to ${art.path}`,
              status: 'completed',
              target: art.path,
            });
          } catch (err) {
            actions.push({
              id: nanoid(10),
              type: 'write_file',
              description: `Write ${art.kind} to ${art.path} failed`,
              status: 'failed',
              target: art.path,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      } else {
        // No write_file tool — record the artifacts as findings/actions for the caller.
        for (const art of artifacts) {
          actions.push({
            id: nanoid(10),
            type: 'generate_artifact',
            description: `Generated ${art.kind} artifact (${art.content.length} bytes) — would write to ${art.path}`,
            status: 'completed',
            target: art.path,
          });
        }
      }

      // ── Phase 6: Report ────────────────────────────────────────────────
      emit('report', 'API Designer complete.', 1);
      const durationMs = Date.now() - startedAt;
      metrics.durationMs = durationMs;
      const summary = this.buildSummary(resources, restEndpoints, graphqlOps, artifacts, issues);

      return {
        agentId: this.id,
        summary,
        findings,
        actions,
        metrics,
        durationMs,
        success: issues.filter((i) => i.severity === 'high').length === 0,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit('error', `API Designer failed: ${message}`, 1);
      return {
        agentId: this.id,
        summary: `API Designer aborted: ${message}`,
        findings,
        actions,
        metrics,
        durationMs: Date.now() - startedAt,
        success: false,
      };
    }
  }

  // ─── Option parsing ────────────────────────────────────────────────────

  /** Parse design options from a natural-language query. */
  private parseDesignOptions(query: string): APIDesignOptions {
    const opts: APIDesignOptions = {};
    const q = query.toLowerCase();
    if (/\bgraphql\b/.test(q) && /\brest\b/.test(q)) opts.style = 'rest_and_graphql';
    else if (/\bgraphql\b/.test(q)) opts.style = 'graphql';
    else if (/\brest\b/.test(q)) opts.style = 'rest';
    const versionMatch = q.match(/version\s+(\d+)/);
    if (versionMatch) opts.version = `v${versionMatch[1]}`;
    if (/\boauth2?\b/.test(q)) opts.auth = 'oauth2';
    else if (/\bapi\s*key\b/.test(q)) opts.auth = 'apiKey';
    else if (/\bbearer\b/.test(q)) opts.auth = 'bearer';
    else if (/\bno\s*auth\b/.test(q) || /\bpublic\b/.test(q)) opts.auth = 'none';
    opts.version = opts.version ?? 'v1';
    opts.prefix = '/api';
    opts.auth = opts.auth ?? 'bearer';
    opts.generateMockServer = !/\bno\s*mock\b/.test(q);
    opts.generateSDK = !/\bno\s*sdk\b/.test(q);
    opts.generatePostman = !/\bno\s*postman\b/.test(q);
    opts.generateDocs = !/\bno\s*docs\b/.test(q);
    opts.outputDir = 'api-design';
    return opts;
  }

  // ─── Existing-code detection ───────────────────────────────────────────

  /** Look for existing API definitions (route handlers, OpenAPI specs, GraphQL schemas). */
  private async findExistingApiCode(
    workspacePath: string,
    tools: NonNullable<AgentRunOptions['tools']>,
  ): Promise<{ hasExisting: boolean; routeFiles: string[]; openApiSpecs: string[]; graphqlSchemas: string[] }> {
    const searchFiles = tools['search_files'];
    const routeFiles: string[] = [];
    const openApiSpecs: string[] = [];
    const graphqlSchemas: string[] = [];
    const trySearch = async (pattern: string): Promise<string[]> => {
      if (typeof searchFiles !== 'function') return [];
      try {
        const result = await searchFiles({ pattern, path: workspacePath });
        if (Array.isArray(result)) return result.filter((r): r is string => typeof r === 'string');
        if (result && typeof result === 'object') {
          const arr = (result as { matches?: unknown[] }).matches;
          if (Array.isArray(arr)) return arr.filter((r): r is string => typeof r === 'string');
        }
      } catch {
        // skip
      }
      return [];
    };
    const allMatches = await trySearch('**/*.{yaml,yml,json,graphql,ts,js}');
    for (const match of allMatches) {
      const lower = match.toLowerCase();
      if (lower.endsWith('openapi.yaml') || lower.endsWith('openapi.json') || /swagger\.(yaml|json)$/.test(lower)) {
        openApiSpecs.push(match);
      }
      if (lower.endsWith('.graphql') || lower.endsWith('.gql')) {
        graphqlSchemas.push(match);
      }
      if (/\b(routes?|controllers?|handlers?|api)\b/i.test(match) && /\.(ts|js)$/.test(match)) {
        routeFiles.push(match);
      }
    }
    return {
      hasExisting: routeFiles.length > 0 || openApiSpecs.length > 0 || graphqlSchemas.length > 0,
      routeFiles,
      openApiSpecs,
      graphqlSchemas,
    };
  }

  // ─── Resource identification ───────────────────────────────────────────

  /**
   * Identify resources from the query. Uses simple NLP heuristics:
   * extracts capitalized nouns + plural noun phrases and treats each
   * as a candidate resource.
   */
  private async identifyResources(
    query: string,
    existing: { routeFiles: string[]; openApiSpecs: string[]; graphqlSchemas: string[] },
    _tools: NonNullable<AgentRunOptions['tools']>,
  ): Promise<ApiResource[]> {
    const candidates = new Set<string>();
    // Heuristic: find "X with Y, Z, and W" patterns.
    const nounRe = /\b([A-Z][a-zA-Z]+)\b/g;
    let m: RegExpExecArray | null;
    while ((m = nounRe.exec(query)) !== null) {
      const word = m[1];
      if (['REST', 'GraphQL', 'API', 'OAuth', 'JSON', 'XML', 'HTTP', 'URL', 'URI', 'JWT', 'SDK'].includes(word)) continue;
      candidates.add(word);
    }
    // Also extract plural noun phrases (e.g. "users, lists, items").
    const listMatch = query.match(/with\s+([a-zA-Z,\s]+?)(?:\.|$)/);
    if (listMatch) {
      for (const part of listMatch[1].split(/,|\s+and\s+/)) {
        const clean = part.trim().replace(/[^a-zA-Z]/g, '');
        if (clean.length >= 3 && !['the', 'and', 'with', 'for'].includes(clean.toLowerCase())) {
          candidates.add(this.singularize(clean));
        }
      }
    }
    // If we couldn't find anything, default to a generic "Resource" with a single endpoint.
    if (candidates.size === 0) candidates.add('Resource');
    // Ensure CRUD operations + relations are populated.
    const resources: ApiResource[] = [];
    for (const name of candidates) {
      const fields = this.defaultFieldsFor(name);
      resources.push({
        name,
        plural: this.pluralize(name),
        description: `${name} resource.`,
        fields,
        operations: ['list', 'create', 'read', 'update', 'delete'],
        relations: [],
        paginated: true,
        filterable: true,
        sortable: true,
      });
    }
    // Infer relations between resources (any field ending in `Id` that matches another resource's name).
    for (const r of resources) {
      for (const f of r.fields) {
        if (f.name.endsWith('Id') && f.type === 'uuid') {
          const refName = f.name.slice(0, -2);
          const ref = resources.find((x) => x.name === refName || x.plural === this.pluralize(refName));
          if (ref) {
            r.relations.push({ resource: ref.name, type: 'many-to-one', foreignKey: f.name });
          }
        }
      }
    }
    void existing;
    return resources;
  }

  /** Default fields for a freshly-identified resource. */
  private defaultFieldsFor(name: string): SchemaField[] {
    return [
      { name: 'id', type: 'uuid', required: true, nullable: false, readOnly: true, description: `${name} id` },
      { name: 'createdAt', type: 'datetime', required: true, nullable: false, readOnly: true, description: 'Creation timestamp' },
      { name: 'updatedAt', type: 'datetime', required: true, nullable: false, readOnly: true, description: 'Last update timestamp' },
    ];
  }

  /** Very small pluralizer. */
  private pluralize(name: string): string {
    if (name.endsWith('y') && !/[aeiou]y$/i.test(name)) return name.slice(0, -1) + 'ies';
    if (/(s|x|z|ch|sh)$/i.test(name)) return name + 'es';
    return name + 's';
  }

  /** Very small singularizer. */
  private singularize(name: string): string {
    if (name.endsWith('ies')) return name.slice(0, -3) + 'y';
    if (name.endsWith('es') && /(s|x|z|ch|sh)es$/i.test(name)) return name.slice(0, -2);
    if (name.endsWith('s') && !name.endsWith('ss')) return name.slice(0, -1);
    return name;
  }

  // ─── REST endpoint design ──────────────────────────────────────────────

  /** Design REST endpoints for the resources. */
  private designRestEndpoints(resources: ApiResource[], opts: APIDesignOptions): RestEndpoint[] {
    const endpoints: RestEndpoint[] = [];
    const prefix = opts.prefix ?? '/api';
    const version = opts.version ?? 'v1';
    const authRequired = (opts.auth ?? 'bearer') !== 'none';
    for (const r of resources) {
      const basePath = `${prefix}/${version}/${r.plural.toLowerCase()}`;
      const idParam: SchemaField = { name: 'id', type: 'uuid', required: true, nullable: false, description: `${r.name} id` };
      if (r.operations.includes('list')) {
        endpoints.push({
          method: 'GET',
          path: basePath,
          operationId: `list${r.plural}`,
          summary: `List ${r.plural} with cursor-based pagination`,
          pathParams: [],
          queryParams: [
            ...PAGINATION_PARAMS,
            ...(r.sortable ? SORT_PARAMS : []),
            ...(r.filterable ? FILTER_PARAMS : []),
          ],
          responses: [
            { status: 200, description: `Paginated list of ${r.plural}`, resource: r.name, isArray: true },
            { status: 401, description: 'Unauthorized' },
            { status: 403, description: 'Forbidden' },
          ],
          authRequired,
        });
      }
      if (r.operations.includes('create')) {
        endpoints.push({
          method: 'POST',
          path: basePath,
          operationId: `create${r.name}`,
          summary: `Create a new ${r.name.toLowerCase()}`,
          pathParams: [],
          queryParams: [],
          requestBody: { resource: r.name, required: true },
          responses: [
            { status: 201, description: `${r.name} created`, resource: r.name },
            { status: 400, description: 'Bad request' },
            { status: 401, description: 'Unauthorized' },
            { status: 403, description: 'Forbidden' },
            { status: 409, description: `${r.name} already exists` },
            { status: 422, description: 'Validation error' },
          ],
          authRequired,
        });
      }
      if (r.operations.includes('read')) {
        endpoints.push({
          method: 'GET',
          path: `${basePath}/:id`,
          operationId: `get${r.name}ById`,
          summary: `Get a single ${r.name.toLowerCase()} by id`,
          pathParams: [idParam],
          queryParams: [],
          responses: [
            { status: 200, description: `${r.name}`, resource: r.name },
            { status: 401, description: 'Unauthorized' },
            { status: 403, description: 'Forbidden' },
            { status: 404, description: `${r.name} not found` },
          ],
          authRequired,
        });
      }
      if (r.operations.includes('update')) {
        endpoints.push({
          method: 'PUT',
          path: `${basePath}/:id`,
          operationId: `update${r.name}`,
          summary: `Update a ${r.name.toLowerCase()} (full replace)`,
          pathParams: [idParam],
          queryParams: [],
          requestBody: { resource: r.name, required: true },
          responses: STANDARD_STATUS.PUT.map((status) => ({
            status,
            description: status === 200 ? `${r.name} updated` : status === 204 ? 'No content' : this.statusDescription(status),
            resource: status === 200 ? r.name : undefined,
          })),
          authRequired,
        });
      }
      if (r.operations.includes('patch')) {
        endpoints.push({
          method: 'PATCH',
          path: `${basePath}/:id`,
          operationId: `patch${r.name}`,
          summary: `Patch a ${r.name.toLowerCase()} (partial update)`,
          pathParams: [idParam],
          queryParams: [],
          requestBody: { resource: r.name, required: true },
          responses: STANDARD_STATUS.PATCH.map((status) => ({
            status,
            description: status === 200 ? `${r.name} patched` : status === 204 ? 'No content' : this.statusDescription(status),
            resource: status === 200 ? r.name : undefined,
          })),
          authRequired,
        });
      }
      if (r.operations.includes('delete')) {
        endpoints.push({
          method: 'DELETE',
          path: `${basePath}/:id`,
          operationId: `delete${r.name}`,
          summary: `Delete a ${r.name.toLowerCase()}`,
          pathParams: [idParam],
          queryParams: [],
          responses: STANDARD_STATUS.DELETE.map((status) => ({
            status,
            description: status === 204 ? 'Deleted' : this.statusDescription(status),
          })),
          authRequired,
        });
      }
      // Sub-resource routes for relations (one level deep).
      for (const rel of r.relations.slice(0, 3)) {
        const subPath = `${basePath}/:id/${this.pluralize(rel.resource).toLowerCase()}`;
        endpoints.push({
          method: 'GET',
          path: subPath,
          operationId: `list${r.plural}${this.pluralize(rel.resource)}`,
          summary: `List ${this.pluralize(rel.resource).toLowerCase()} belonging to a ${r.name.toLowerCase()}`,
          pathParams: [idParam],
          queryParams: PAGINATION_PARAMS,
          responses: [
            { status: 200, description: `Paginated list of ${this.pluralize(rel.resource)}`, resource: rel.resource, isArray: true },
            { status: 404, description: `${r.name} not found` },
          ],
          authRequired,
        });
      }
    }
    return endpoints;
  }

  /** Human-readable description for an HTTP status code. */
  private statusDescription(status: number): string {
    const map: Record<number, string> = {
      200: 'OK',
      201: 'Created',
      204: 'No Content',
      400: 'Bad Request',
      401: 'Unauthorized',
      403: 'Forbidden',
      404: 'Not Found',
      409: 'Conflict',
      422: 'Unprocessable Entity',
      429: 'Too Many Requests',
      500: 'Internal Server Error',
    };
    return map[status] ?? 'Unknown';
  }

  // ─── GraphQL operation design ──────────────────────────────────────────

  /** Design GraphQL operations for the resources. */
  private designGraphQLOperations(resources: ApiResource[]): GraphQLOperation[] {
    const ops: GraphQLOperation[] = [];
    for (const r of resources) {
      const idArg: SchemaField = { name: 'id', type: 'uuid', required: true, nullable: false };
      const inputArg: SchemaField = {
        name: 'input',
        type: 'object',
        required: true,
        nullable: false,
        properties: r.fields.filter((f) => !f.readOnly),
      };
      if (r.operations.includes('list')) {
        ops.push({
          type: 'query',
          name: `${r.plural[0].toLowerCase()}${r.plural.slice(1)}`,
          description: `List ${r.plural} with cursor-based pagination.`,
          args: [
            { name: 'after', type: 'string', required: false, nullable: true },
            { name: 'limit', type: 'integer', required: false, nullable: false, default: 50 },
            { name: 'filter', type: 'string', required: false, nullable: true },
            { name: 'sort', type: 'string', required: false, nullable: true },
          ],
          returns: { resource: r.name, type: 'object', isArray: true },
        });
      }
      if (r.operations.includes('read')) {
        ops.push({
          type: 'query',
          name: `${r.name[0].toLowerCase()}${r.name.slice(1)}`,
          description: `Get a single ${r.name} by id.`,
          args: [idArg],
          returns: { resource: r.name, type: 'reference', nullable: true },
        });
      }
      if (r.operations.includes('create')) {
        ops.push({
          type: 'mutation',
          name: `create${r.name}`,
          description: `Create a new ${r.name}.`,
          args: [inputArg],
          returns: { resource: r.name, type: 'reference' },
        });
      }
      if (r.operations.includes('update')) {
        ops.push({
          type: 'mutation',
          name: `update${r.name}`,
          description: `Update a ${r.name} by id.`,
          args: [idArg, inputArg],
          returns: { resource: r.name, type: 'reference', nullable: true },
        });
      }
      if (r.operations.includes('delete')) {
        ops.push({
          type: 'mutation',
          name: `delete${r.name}`,
          description: `Delete a ${r.name} by id.`,
          args: [idArg],
          returns: { type: 'boolean' },
        });
      }
    }
    return ops;
  }

  // ─── Validation ────────────────────────────────────────────────────────

  /** Validate the design against best practices. */
  private validateDesign(
    resources: ApiResource[],
    restEndpoints: RestEndpoint[],
    _graphqlOps: GraphQLOperation[],
    opts: APIDesignOptions,
  ): DesignValidationIssue[] {
    const issues: DesignValidationIssue[] = [];
    // Rule: plural nouns for collection paths
    for (const ep of restEndpoints) {
      if (ep.method === 'GET' || ep.method === 'POST') {
        const segs = ep.path.split('/').filter(Boolean);
        const last = segs[segs.length - 1];
        if (last && !last.startsWith(':') && !this.looksPlural(last)) {
          issues.push({
            location: ep.path,
            rule: 'plural-noun-collection',
            severity: 'medium',
            message: `Collection path '${ep.path}' should use a plural noun.`,
            suggestion: `Rename the last segment to its plural form (e.g. '${last}s').`,
          });
        }
      }
    }
    // Rule: every resource should have a `list` operation
    for (const r of resources) {
      if (!r.operations.includes('list')) {
        issues.push({
          location: r.name,
          rule: 'resource-has-list',
          severity: 'low',
          message: `Resource '${r.name}' has no list operation.`,
        });
      }
      if (!r.fields.some((f) => f.name === 'id')) {
        issues.push({
          location: r.name,
          rule: 'resource-has-id',
          severity: 'high',
          message: `Resource '${r.name}' has no 'id' field.`,
          suggestion: `Add an 'id' field (UUID type, read-only).`,
        });
      }
    }
    // Rule: pagination required on list endpoints
    for (const ep of restEndpoints) {
      if (ep.method === 'GET' && !ep.path.includes(':id')) {
        if (!ep.queryParams.some((p) => p.name === 'limit' || p.name === 'cursor')) {
          issues.push({
            location: ep.path,
            rule: 'pagination-required',
            severity: 'medium',
            message: `List endpoint '${ep.path}' has no pagination parameters.`,
          });
        }
      }
    }
    // Rule: auth required for write operations
    if ((opts.auth ?? 'bearer') !== 'none') {
      for (const ep of restEndpoints) {
        if ((ep.method === 'POST' || ep.method === 'PUT' || ep.method === 'PATCH' || ep.method === 'DELETE') && !ep.authRequired) {
          issues.push({
            location: ep.path,
            rule: 'auth-required-for-writes',
            severity: 'high',
            message: `Write endpoint '${ep.method} ${ep.path}' has authRequired=false.`,
          });
        }
      }
    }
    // Rule: nesting depth ≤ 2 levels
    for (const ep of restEndpoints) {
      const paramDepth = ep.path.split('/').filter((s) => s.startsWith(':')).length;
      if (paramDepth > 2) {
        issues.push({
          location: ep.path,
          rule: 'max-nesting-depth',
          severity: 'medium',
          message: `Endpoint '${ep.path}' nests ${paramDepth} levels deep — keep it ≤ 2.`,
        });
      }
    }
    return issues;
  }

  /** Quick check: does a word look plural? */
  private looksPlural(word: string): boolean {
    return word.endsWith('s') && !word.endsWith('ss') && word.length > 2;
  }

  /** Convert a validation issue into an AgentFinding. */
  private issueToFinding(issue: DesignValidationIssue): AgentFinding {
    return {
      id: nanoid(10),
      severity: issue.severity,
      category: 'design_validation',
      title: `${issue.location}: ${issue.rule}`,
      description: issue.message,
      location: { symbol: issue.location },
      evidence: [`rule: ${issue.rule}`, `severity: ${issue.severity}`],
      recommendation: issue.suggestion,
    };
  }

  // ─── OpenAPI spec generation ───────────────────────────────────────────

  /** Generate an OpenAPI 3.1 YAML spec. */
  private generateOpenApiSpec(resources: ApiResource[], endpoints: RestEndpoint[], opts: APIDesignOptions): string {
    const version = opts.version ?? 'v1';
    const auth = opts.auth ?? 'bearer';
    const lines: string[] = [
      `openapi: 3.1.0`,
      `info:`,
      `  title: Generated API`,
      `  version: '1.0.0'`,
      `  description: |`,
      `    Auto-generated by SANIX API Designer.`,
      ``,
      `servers:`,
      `  - url: ${opts.prefix ?? '/api'}/${version}`,
      `    description: Default server`,
      ``,
    ];
    // Security schemes
    lines.push(`components:`);
    lines.push(`  securitySchemes:`);
    if (auth === 'bearer') {
      lines.push(`    bearerAuth:`);
      lines.push(`      type: http`);
      lines.push(`      scheme: bearer`);
      lines.push(`      bearerFormat: JWT`);
    } else if (auth === 'apiKey') {
      lines.push(`    apiKeyAuth:`);
      lines.push(`      type: apiKey`);
      lines.push(`      in: header`);
      lines.push(`      name: X-API-Key`);
    } else if (auth === 'oauth2') {
      lines.push(`    oauth2:`);
      lines.push(`      type: oauth2`);
      lines.push(`      flows:`);
      lines.push(`        authorizationCode:`);
      lines.push(`          authorizationUrl: /oauth/authorize`);
      lines.push(`          tokenUrl: /oauth/token`);
      lines.push(`          scopes: {}`);
    }
    // Schemas
    lines.push(`  schemas:`);
    for (const r of resources) {
      lines.push(`    ${r.name}:`);
      lines.push(`      type: object`);
      lines.push(`      required: [${r.fields.filter((f) => f.required).map((f) => f.name).join(', ')}]`);
      lines.push(`      properties:`);
      for (const f of r.fields) {
        lines.push(`        ${f.name}:`);
        lines.push(...this.fieldToOpenApi(f, '          '));
      }
      // Pagination envelope
      lines.push(`    ${r.name}List:`);
      lines.push(`      type: object`);
      lines.push(`      properties:`);
      lines.push(`        data:`);
      lines.push(`          type: array`);
      lines.push(`          items:`);
      lines.push(`            $ref: '#/components/schemas/${r.name}'`);
      lines.push(`        nextCursor:`);
      lines.push(`          type: string`);
      lines.push(`          nullable: true`);
      lines.push(`        hasMore:`);
      lines.push(`          type: boolean`);
    }
    // Error schema
    lines.push(`    Error:`);
    lines.push(`      type: object`);
    lines.push(`      properties:`);
    lines.push(`        code:`);
    lines.push(`          type: string`);
    lines.push(`        message:`);
    lines.push(`          type: string`);
    lines.push(`        details:`);
    lines.push(`          type: object`);
    lines.push(`          additionalProperties: true`);
    // Paths
    lines.push(`paths:`);
    for (const ep of endpoints) {
      lines.push(`  ${this.openapiPath(ep.path)}:`);
      lines.push(`    ${ep.method.toLowerCase()}:`);
      lines.push(`      operationId: ${ep.operationId}`);
      lines.push(`      summary: ${ep.summary}`);
      if (ep.authRequired) lines.push(`      security:`, ...this.securityLine(auth));
      if (ep.pathParams.length > 0) {
        lines.push(`      parameters:`);
        for (const p of ep.pathParams) {
          lines.push(...this.paramToOpenApi(p, 'path', true, '        '));
        }
        for (const p of ep.queryParams) {
          lines.push(...this.paramToOpenApi(p, 'query', p.required, '        '));
        }
      } else if (ep.queryParams.length > 0) {
        lines.push(`      parameters:`);
        for (const p of ep.queryParams) {
          lines.push(...this.paramToOpenApi(p, 'query', p.required, '        '));
        }
      }
      if (ep.requestBody) {
        lines.push(`      requestBody:`);
        lines.push(`        required: ${ep.requestBody.required}`);
        lines.push(`        content:`);
        lines.push(`          application/json:`);
        lines.push(`            schema:`);
        lines.push(`              $ref: '#/components/schemas/${ep.requestBody.resource}'`);
      }
      lines.push(`      responses:`);
      for (const resp of ep.responses) {
        lines.push(`        '${resp.status}':`);
        lines.push(`          description: ${resp.description}`);
        if (resp.resource) {
          lines.push(`          content:`);
          lines.push(`            application/json:`);
          lines.push(`              schema:`);
          if (resp.isArray) {
            lines.push(`                $ref: '#/components/schemas/${resp.resource}List'`);
          } else {
            lines.push(`                $ref: '#/components/schemas/${resp.resource}'`);
          }
        }
      }
    }
    return lines.join('\n') + '\n';
  }

  /** Convert a path like `/api/v1/users/:id` to OpenAPI form `/api/v1/users/{id}`. */
  private openapiPath(path: string): string {
    return path.replace(/:(\w+)/g, '{$1}');
  }

  /** Convert a schema field to OpenAPI YAML (returns lines). */
  private fieldToOpenApi(field: SchemaField, indent: string): string[] {
    const lines: string[] = [];
    const typeMap: Record<FieldType, string> = {
      string: 'string',
      integer: 'integer',
      number: 'number',
      boolean: 'boolean',
      date: 'string',
      datetime: 'string',
      uuid: 'string',
      email: 'string',
      url: 'string',
      binary: 'string',
      array: 'array',
      object: 'object',
      enum: 'string',
      reference: 'object',
    };
    if (field.type === 'array' && field.items) {
      lines.push(`${indent}type: array`);
      lines.push(`${indent}items:`);
      lines.push(...this.fieldToOpenApi(field.items, indent + '  '));
    } else if (field.type === 'object' && field.properties) {
      lines.push(`${indent}type: object`);
      lines.push(`${indent}properties:`);
      for (const p of field.properties) {
        lines.push(`${indent}  ${p.name}:`);
        lines.push(...this.fieldToOpenApi(p, indent + '    '));
      }
    } else if (field.type === 'reference' && field.ref) {
      lines.push(`${indent}$ref: '#/components/schemas/${field.ref}'`);
    } else {
      lines.push(`${indent}type: ${typeMap[field.type]}`);
      if (field.type === 'uuid') lines.push(`${indent}format: uuid`);
      if (field.type === 'date') lines.push(`${indent}format: date`);
      if (field.type === 'datetime') lines.push(`${indent}format: date-time`);
      if (field.type === 'email') lines.push(`${indent}format: email`);
      if (field.type === 'url') lines.push(`${indent}format: uri`);
      if (field.enum) lines.push(`${indent}enum: [${field.enum.map((e) => `'${e}'`).join(', ')}]`);
    }
    if (field.nullable) lines.push(`${indent}nullable: true`);
    if (field.description) lines.push(`${indent}description: ${field.description}`);
    return lines;
  }

  /** Convert a parameter to OpenAPI YAML (returns lines). */
  private paramToOpenApi(field: SchemaField, in_: 'path' | 'query', required: boolean, indent: string): string[] {
    const lines: string[] = [];
    lines.push(`${indent}- name: ${field.name}`);
    lines.push(`${indent}  in: ${in_}`);
    lines.push(`${indent}  required: ${required}`);
    lines.push(`${indent}  schema:`);
    lines.push(...this.fieldToOpenApi(field, indent + '    '));
    if (field.description) lines.push(`${indent}  description: ${field.description}`);
    return lines;
  }

  /** Security block lines for an auth scheme. */
  private securityLine(auth: AuthScheme): string[] {
    if (auth === 'bearer') return ['        - bearerAuth: []'];
    if (auth === 'apiKey') return ['        - apiKeyAuth: []'];
    if (auth === 'oauth2') return ['        - oauth2: []'];
    return ['        - {}'];
  }

  // ─── GraphQL schema generation ─────────────────────────────────────────

  /** Generate a GraphQL SDL schema. */
  private generateGraphQLSchema(resources: ApiResource[], ops: GraphQLOperation[]): string {
    const lines: string[] = ['# Auto-generated by SANIX API Designer', ''];
    // Type definitions
    for (const r of resources) {
      lines.push(`type ${r.name} {`);
      for (const f of r.fields) {
        lines.push(`  ${f.name}: ${this.graphqlType(f)}${f.nullable ? '' : '!'}`);
      }
      for (const rel of r.relations) {
        lines.push(`  ${this.pluralize(rel.resource).toLowerCase()}: [${rel.resource}!]!`);
      }
      lines.push(`}`);
      lines.push('');
      // Input type
      lines.push(`input ${r.name}Input {`);
      for (const f of r.fields.filter((f) => !f.readOnly)) {
        lines.push(`  ${f.name}: ${this.graphqlType(f)}${f.required && !f.nullable ? '!' : ''}`);
      }
      lines.push(`}`);
      lines.push('');
    }
    // Connection types (Relay-style)
    for (const r of resources) {
      lines.push(`type ${r.name}Connection {`);
      lines.push(`  edges: [${r.name}Edge!]!`);
      lines.push(`  pageInfo: PageInfo!`);
      lines.push(`}`);
      lines.push(`type ${r.name}Edge {`);
      lines.push(`  node: ${r.name}!`);
      lines.push(`  cursor: String!`);
      lines.push(`}`);
      lines.push('');
    }
    lines.push(`type PageInfo {`);
    lines.push(`  hasNextPage: Boolean!`);
    lines.push(`  endCursor: String`);
    lines.push(`}`);
    lines.push('');
    // Query/Mutation/Subscription roots
    const queries = ops.filter((o) => o.type === 'query');
    const mutations = ops.filter((o) => o.type === 'mutation');
    const subscriptions = ops.filter((o) => o.type === 'subscription');
    if (queries.length > 0) {
      lines.push(`type Query {`);
      for (const q of queries) {
        lines.push(`  ${q.name}(${q.args.map((a) => `${a.name}: ${this.graphqlType(a)}${a.required && !a.nullable ? '!' : ''}`).join(', ')}): ${q.returns.isArray ? `[${q.returns.resource ?? q.returns.type}!]!` : (q.returns.resource ?? q.returns.type) + (q.returns.nullable === false ? '!' : '')}`);
      }
      lines.push(`}`);
      lines.push('');
    }
    if (mutations.length > 0) {
      lines.push(`type Mutation {`);
      for (const m of mutations) {
        lines.push(`  ${m.name}(${m.args.map((a) => `${a.name}: ${this.graphqlType(a)}${a.required && !a.nullable ? '!' : ''}`).join(', ')}): ${m.returns.resource ?? m.returns.type}${m.returns.nullable === false ? '!' : ''}`);
      }
      lines.push(`}`);
      lines.push('');
    }
    if (subscriptions.length > 0) {
      lines.push(`type Subscription {`);
      for (const s of subscriptions) {
        lines.push(`  ${s.name}(${s.args.map((a) => `${a.name}: ${this.graphqlType(a)}${a.required && !a.nullable ? '!' : ''}`).join(', ')}): ${s.returns.resource ?? s.returns.type}`);
      }
      lines.push(`}`);
      lines.push('');
    }
    void ops;
    return lines.join('\n');
  }

  /** Map a schema field to a GraphQL type name. */
  private graphqlType(field: SchemaField): string {
    if (field.type === 'reference' && field.ref) return field.ref;
    if (field.type === 'array' && field.items) return `[${this.graphqlType(field.items)}!]`;
    const map: Record<FieldType, string> = {
      string: 'String',
      integer: 'Int',
      number: 'Float',
      boolean: 'Boolean',
      date: 'Date',
      datetime: 'DateTime',
      uuid: 'ID',
      email: 'String',
      url: 'String',
      binary: 'String',
      array: 'String',
      object: 'JSON',
      enum: 'String',
      reference: 'JSON',
    };
    return map[field.type];
  }

  // ─── Mock server generation ────────────────────────────────────────────

  /** Generate an Express mock server for the REST API. */
  private generateRestMockServer(resources: ApiResource[], endpoints: RestEndpoint[], opts: APIDesignOptions): string {
    const prefix = opts.prefix ?? '/api';
    const version = opts.version ?? 'v1';
    return `// Auto-generated by SANIX API Designer.
// Mock REST server (Express) — returns sample data for ${endpoints.length} endpoints.
import express from 'express';

const app = express();
app.use(express.json());

const stores: Record<string, any[]> = {
${resources.map((r) => `  ${r.name}: [${this.sampleResourceObject(r)}],`).join('\n')}
};

${endpoints.map((ep) => this.mockEndpointHandler(ep, prefix, version)).join('\n\n')}

app.listen(3001, () => {
  console.log(\`Mock REST server running on http://localhost:3001${prefix}/${version}\`);
});
`;
  }

  /** Generate a single mock endpoint handler. */
  private mockEndpointHandler(ep: RestEndpoint, prefix: string, version: string): string {
    const expressPath = ep.path.replace(`${prefix}/${version}`, '').replace(/:(\w+)/g, ':$1');
    const resourceName = ep.operationId.replace(/^(list|get|create|update|patch|delete)/, '');
    const singular = resourceName.replace(/s$/, '');
    const body: string[] = [];
    body.push(`app.${ep.method.toLowerCase()}('${expressPath}', (req, res) => {`);
    if (ep.method === 'GET' && !expressPath.includes(':id')) {
      body.push(`  const items = stores['${singular}'] ?? [];`);
      body.push(`  const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);`);
      body.push(`  const data = items.slice(0, limit);`);
      body.push(`  res.json({ data, nextCursor: null, hasMore: items.length > limit });`);
    } else if (ep.method === 'GET') {
      body.push(`  const item = (stores['${singular}'] ?? []).find(x => x.id === req.params.id);`);
      body.push(`  if (!item) return res.status(404).json({ code: 'NOT_FOUND', message: '${singular} not found' });`);
      body.push(`  res.json(item);`);
    } else if (ep.method === 'POST') {
      body.push(`  const item = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...req.body };`);
      body.push(`  (stores['${singular}'] ??= []).push(item);`);
      body.push(`  res.status(201).json(item);`);
    } else if (ep.method === 'PUT' || ep.method === 'PATCH') {
      body.push(`  const list = stores['${singular}'] ?? [];`);
      body.push(`  const idx = list.findIndex(x => x.id === req.params.id);`);
      body.push(`  if (idx < 0) return res.status(404).json({ code: 'NOT_FOUND', message: '${singular} not found' });`);
      body.push(`  list[idx] = { ...list[idx], ...req.body, updatedAt: new Date().toISOString() };`);
      body.push(`  res.json(list[idx]);`);
    } else if (ep.method === 'DELETE') {
      body.push(`  const list = stores['${singular}'] ?? [];`);
      body.push(`  const idx = list.findIndex(x => x.id === req.params.id);`);
      body.push(`  if (idx < 0) return res.status(404).json({ code: 'NOT_FOUND', message: '${singular} not found' });`);
      body.push(`  list.splice(idx, 1);`);
      body.push(`  res.status(204).end();`);
    }
    body.push(`});`);
    return body.join('\n');
  }

  /** Generate an Apollo GraphQL mock server. */
  private generateGraphQLMockServer(resources: ApiResource[], ops: GraphQLOperation[]): string {
    return `// Auto-generated by SANIX API Designer.
// Mock GraphQL server (Apollo) — returns sample data for ${ops.length} operations.
import { ApolloServer } from '@apollo/server';
import { startStandaloneServer } from '@apollo/server/standalone';
import { readFileSync } from 'node:fs';

const typeDefs = readFileSync('./schema.graphql', 'utf8');

const stores = {
${resources.map((r) => `  ${r.name}: [${this.sampleResourceObject(r)}],`).join('\n')}
};

const resolvers = {
  Query: {
${ops.filter((o) => o.type === 'query').map((q) => `    ${q.name}: (_parent, args) => stores.${q.returns.resource}.filter(x => args.id ? x.id === args.id : true).slice(0, args.limit ?? 50),`).join('\n')}
  },
  Mutation: {
${ops.filter((o) => o.type === 'mutation').map((m) => `    ${m.name}: (_parent, args) => { const item = { id: crypto.randomUUID(), ...args.input }; stores.${m.returns.resource}.push(item); return item; },`).join('\n')}
  },
};

const server = new ApolloServer({ typeDefs, resolvers });
startStandaloneServer(server, { listen: { port: 4000 } }).then(({ url }) => {
  console.log(\`Mock GraphQL server running at \${url}\`);
});
`;
  }

  /** Build a sample object literal for a resource (used in mock stores). */
  private sampleResourceObject(r: ApiResource): string {
    const fields: string[] = [];
    for (const f of r.fields) {
      fields.push(`${f.name}: ${this.sampleValue(f)}`);
    }
    return `{ ${fields.join(', ')} }`;
  }

  /** Pick a sensible sample value for a field. */
  private sampleValue(field: SchemaField): string {
    if (field.example !== undefined) return JSON.stringify(field.example);
    switch (field.type) {
      case 'string':
        return field.enum ? `'${field.enum[0]}'` : `'sample-${field.name}'`;
      case 'integer':
        return '42';
      case 'number':
        return '99.99';
      case 'boolean':
        return 'true';
      case 'date':
        return "'2024-01-15'";
      case 'datetime':
        return "'2024-01-15T10:30:00Z'";
      case 'uuid':
        return "'00000000-0000-4000-8000-000000000000'";
      case 'email':
        return "'user@example.com'";
      case 'url':
        return "'https://example.com'";
      case 'array':
        return field.items ? `[${this.sampleValue(field.items)}]` : '[]';
      case 'object':
        return '{}';
      default:
        return 'null';
    }
  }

  // ─── SDK generation ────────────────────────────────────────────────────

  /** Generate a TypeScript SDK client. */
  private generateTypeScriptSDK(resources: ApiResource[], endpoints: RestEndpoint[], _opts: APIDesignOptions): string {
    const lines: string[] = [
      '// Auto-generated by SANIX API Designer.',
      '// TypeScript SDK client — typed methods for all REST endpoints.',
      '',
      'export interface ClientOptions {',
      '  baseUrl: string;',
      "  apiKey?: string;",
      '  bearerToken?: string;',
      '  timeoutMs?: number;',
      '  retries?: number;',
      '}',
      '',
      'export class ApiClientError extends Error {',
      '  constructor(public status: number, public code: string, message: string, public details?: unknown) {',
      '    super(message);',
      '  }',
      '}',
      '',
      'export class ApiClient {',
      '  constructor(private readonly opts: ClientOptions) {}',
      '',
      '  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {',
      '    const url = new URL(path, this.opts.baseUrl);',
      '    const headers: Record<string, string> = { "Content-Type": "application/json" };',
      '    if (this.opts.bearerToken) headers.Authorization = `Bearer ${this.opts.bearerToken}`;',
      '    if (this.opts.apiKey) headers["X-API-Key"] = this.opts.apiKey;',
      '    const signal = AbortSignal.timeout(this.opts.timeoutMs ?? 30000);',
      '    const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal });',
      '    if (!res.ok) {',
      '      const err = await res.json().catch(() => ({ code: "HTTP_ERROR", message: res.statusText }));',
      '      throw new ApiClientError(res.status, err.code ?? "HTTP_ERROR", err.message ?? res.statusText, err.details);',
      '    }',
      '    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);',
      '  }',
      '',
    ];
    for (const r of resources) {
      lines.push(`  // ${r.name} operations`);
      lines.push(`  list${r.plural}(params?: { limit?: number; cursor?: string; sort?: string; filter?: string }): Promise<{ data: ${r.name}[]; nextCursor: string | null; hasMore: boolean }> {`);
      lines.push(`    const qs = new URLSearchParams();`);
      lines.push(`    if (params?.limit) qs.set("limit", String(params.limit));`);
      lines.push(`    if (params?.cursor) qs.set("cursor", params.cursor);`);
      lines.push(`    if (params?.sort) qs.set("sort", params.sort);`);
      lines.push(`    if (params?.filter) qs.set("filter", params.filter);`);
      lines.push(`    return this.request("GET", \`/${r.plural.toLowerCase()}?${'${'}qs${'}'}\`);`);
      lines.push(`  }`);
      lines.push(`  get${r.name}ById(id: string): Promise<${r.name}> { return this.request("GET", \`/${r.plural.toLowerCase()}/${'${'}id${'}'}\`); }`);
      lines.push(`  create${r.name}(input: ${r.name}Input): Promise<${r.name}> { return this.request("POST", \`/${r.plural.toLowerCase()}\`, input); }`);
      lines.push(`  update${r.name}(id: string, input: ${r.name}Input): Promise<${r.name}> { return this.request("PUT", \`/${r.plural.toLowerCase()}/${'${'}id${'}'}\`, input); }`);
      lines.push(`  delete${r.name}(id: string): Promise<void> { return this.request("DELETE", \`/${r.plural.toLowerCase()}/${'${'}id${'}'}\`); }`);
      lines.push('');
    }
    // Type definitions
    for (const r of resources) {
      lines.push(`export interface ${r.name} {`);
      for (const f of r.fields) {
        lines.push(`  ${f.name}${f.nullable ? '?' : ''}: ${this.tsType(f)};`);
      }
      lines.push(`}`);
      lines.push(`export interface ${r.name}Input {`);
      for (const f of r.fields.filter((f) => !f.readOnly)) {
        lines.push(`  ${f.name}${f.required && !f.nullable ? '' : '?'}: ${this.tsType(f)};`);
      }
      lines.push(`}`);
      lines.push('');
    }
    void endpoints;
    lines.push('export default ApiClient;');
    return lines.join('\n') + '\n';
  }

  /** Map a schema field to a TypeScript type. */
  private tsType(field: SchemaField): string {
    if (field.type === 'array' && field.items) return `${this.tsType(field.items)}[]`;
    if (field.type === 'reference' && field.ref) return field.ref;
    if (field.type === 'enum' && field.enum) return field.enum.map((e) => `'${e}'`).join(' | ');
    const map: Record<FieldType, string> = {
      string: 'string',
      integer: 'number',
      number: 'number',
      boolean: 'boolean',
      date: 'string',
      datetime: 'string',
      uuid: 'string',
      email: 'string',
      url: 'string',
      binary: 'string',
      array: 'unknown[]',
      object: 'Record<string, unknown>',
      enum: 'string',
      reference: 'unknown',
    };
    return map[field.type];
  }

  /** Generate a Python SDK client. */
  private generatePythonSDK(resources: ApiResource[], _endpoints: RestEndpoint[], _opts: APIDesignOptions): string {
    const lines: string[] = [
      '# Auto-generated by SANIX API Designer.',
      '# Python SDK client — typed methods for all REST endpoints.',
      'from __future__ import annotations',
      'from dataclasses import dataclass, field',
      'from typing import Any, Optional, List, Dict',
      'import json',
      'import urllib.request',
      'import urllib.error',
      '',
      '@dataclass',
      'class ApiClientError(Exception):',
      '    status: int',
      '    code: str',
      '    message: str',
      '    details: Optional[Dict[str, Any]] = None',
      '',
      '@dataclass',
      'class ClientOptions:',
      '    base_url: str',
      '    api_key: Optional[str] = None',
      '    bearer_token: Optional[str] = None',
      '    timeout_ms: int = 30000',
      '',
      'class ApiClient:',
      '    def __init__(self, opts: ClientOptions):',
      '        self.opts = opts',
      '',
      '    def _request(self, method: str, path: str, body: Optional[dict] = None) -> Any:',
      '        url = self.opts.base_url.rstrip("/") + path',
      '        headers = {"Content-Type": "application/json"}',
      '        if self.opts.bearer_token:',
      '            headers["Authorization"] = f"Bearer {self.opts.bearer_token}"',
      '        if self.opts.api_key:',
      '            headers["X-API-Key"] = self.opts.api_key',
      '        data = json.dumps(body).encode() if body else None',
      '        req = urllib.request.Request(url, data=data, method=method, headers=headers)',
      '        try:',
      '            with urllib.request.urlopen(req, timeout=self.opts.timeout_ms/1000) as resp:',
      '                if resp.status == 204: return None',
      '                return json.loads(resp.read().decode())',
      '        except urllib.error.HTTPError as e:',
      '            err = json.loads(e.read().decode()) if e.fp else {}',
      '            raise ApiClientError(e.code, err.get("code", "HTTP_ERROR"), err.get("message", str(e)))',
      '',
    ];
    for (const r of resources) {
      lines.push(`    # ${r.name} operations`);
      lines.push(`    def list_${r.plural.toLowerCase()}(self, limit: int = 50, cursor: Optional[str] = None) -> dict:`);
      lines.push(`        qs = f"?limit={limit}"`);
      lines.push(`        if cursor:`);
      lines.push(`            qs += f"&cursor={cursor}"`);
      lines.push(`        return self._request("GET", "/${r.plural.toLowerCase()}" + qs)`);
      lines.push(`    def get_${r.name.toLowerCase()}_by_id(self, id: str) -> dict:`);
      lines.push(`        return self._request("GET", f"/${r.plural.toLowerCase()}/{id}")`);
      lines.push(`    def create_${r.name.lower()}(self, input: dict) -> dict:`);
      lines.push(`        return self._request("POST", "/${r.plural.toLowerCase()}", input)`);
      lines.push(`    def update_${r.name.lower()}(self, id: str, input: dict) -> dict:`);
      lines.push(`        return self._request("PUT", f"/${r.plural.toLowerCase()}/{id}", input)`);
      lines.push(`    def delete_${r.name.lower()}(self, id: str) -> None:`);
      lines.push(`        self._request("DELETE", f"/${r.plural.toLowerCase()}/{id}")`);
      lines.push('');
    }
    // Dataclasses
    for (const r of resources) {
      lines.push(`@dataclass`);
      lines.push(`class ${r.name}:`);
      for (const f of r.fields) {
        lines.push(`    ${f.name}: ${this.pythonType(f)}${f.nullable ? ' = None' : ''}`);
      }
      lines.push('');
    }
    return lines.join('\n') + '\n';
  }

  /** Map a schema field to a Python type. */
  private pythonType(field: SchemaField): string {
    if (field.type === 'array' && field.items) return `List[${this.pythonType(field.items)}]`;
    if (field.type === 'reference' && field.ref) return field.ref;
    const map: Record<FieldType, string> = {
      string: 'str',
      integer: 'int',
      number: 'float',
      boolean: 'bool',
      date: 'str',
      datetime: 'str',
      uuid: 'str',
      email: 'str',
      url: 'str',
      binary: 'str',
      array: 'List[Any]',
      object: 'Dict[str, Any]',
      enum: 'str',
      reference: 'Any',
    };
    return map[field.type];
  }

  // ─── Postman collection ────────────────────────────────────────────────

  /** Generate a Postman collection JSON. */
  private generatePostmanCollection(resources: ApiResource[], endpoints: RestEndpoint[], opts: APIDesignOptions): string {
    const collection = {
      info: {
        name: 'SANIX API',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      variable: [
        { key: 'baseUrl', value: `https://api.example.com${opts.prefix ?? '/api'}/${opts.version ?? 'v1'}` },
        { key: 'token', value: 'YOUR_BEARER_TOKEN' },
      ],
      item: resources.map((r) => ({
        name: r.plural,
        item: endpoints
          .filter((ep) => ep.path.includes(`/${r.plural.toLowerCase()}`))
          .map((ep) => ({
            name: ep.summary,
            request: {
              method: ep.method,
              header: [
                { key: 'Authorization', value: 'Bearer {{token}}' },
                { key: 'Content-Type', value: 'application/json' },
              ],
              url: {
                raw: `{{baseUrl}}${ep.path.replace(/:(\w+)/g, ':$1')}`,
                host: ['{{baseUrl}}'],
                path: ep.path.split('/').filter(Boolean),
                query: ep.queryParams.map((p) => ({ key: p.name, value: String(p.default ?? ''), description: p.description })),
              },
              body: ep.requestBody
                ? {
                    mode: 'raw',
                    raw: JSON.stringify(this.sampleResourceObject(r), null, 2),
                  }
                : undefined,
            },
          })),
      })),
    };
    return JSON.stringify(collection, null, 2);
  }

  // ─── Documentation ─────────────────────────────────────────────────────

  /** Generate Markdown API documentation. */
  private generateDocs(
    resources: ApiResource[],
    restEndpoints: RestEndpoint[],
    graphqlOps: GraphQLOperation[],
    opts: APIDesignOptions,
  ): string {
    const lines: string[] = [
      `# API Documentation`,
      ``,
      `> Auto-generated by SANIX API Designer.`,
      ``,
      `- **Style:** ${opts.style ?? 'rest'}`,
      `- **Version:** ${opts.version ?? 'v1'}`,
      `- **Base URL:** \`${opts.prefix ?? '/api'}/${opts.version ?? 'v1'}\``,
      `- **Auth:** ${opts.auth ?? 'bearer'}`,
      ``,
      `## Resources`,
      ``,
    ];
    for (const r of resources) {
      lines.push(`### ${r.name}`);
      lines.push('');
      lines.push(`${r.description}`);
      lines.push('');
      lines.push(`| Field | Type | Required | Description |`);
      lines.push(`|-------|------|----------|-------------|`);
      for (const f of r.fields) {
        lines.push(`| \`${f.name}\` | ${f.type} | ${f.required ? '✓' : ''} | ${f.description ?? ''} |`);
      }
      lines.push('');
      lines.push(`#### Endpoints`);
      lines.push('');
      for (const ep of restEndpoints.filter((e) => e.path.includes(`/${r.plural.toLowerCase()}`))) {
        lines.push(`##### \`${ep.method} ${ep.path}\``);
        lines.push('');
        lines.push(ep.summary);
        lines.push('');
        if (ep.pathParams.length > 0) {
          lines.push(`**Path params:**`);
          for (const p of ep.pathParams) lines.push(`- \`${p.name}\` (${p.type}) — ${p.description ?? ''}`);
          lines.push('');
        }
        if (ep.queryParams.length > 0) {
          lines.push(`**Query params:**`);
          for (const p of ep.queryParams) lines.push(`- \`${p.name}\` (${p.type}) — ${p.description ?? ''}`);
          lines.push('');
        }
        lines.push(`**Responses:**`);
        for (const resp of ep.responses) {
          lines.push(`- \`${resp.status}\` — ${resp.description}`);
        }
        lines.push('');
      }
    }
    if (graphqlOps.length > 0) {
      lines.push(`## GraphQL Operations`);
      lines.push('');
      for (const op of graphqlOps) {
        lines.push(`### \`${op.type} ${op.name}(${op.args.map((a) => `${a.name}: ${a.type}`).join(', ')})\``);
        lines.push('');
        lines.push(op.description);
        lines.push('');
      }
    }
    return lines.join('\n');
  }

  /** Generate a README for the design package. */
  private generateReadme(
    resources: ApiResource[],
    artifacts: GeneratedArtifact[],
    opts: APIDesignOptions,
  ): string {
    return `# API Design Package

Auto-generated by SANIX API Designer.

- Style: ${opts.style ?? 'rest'}
- Version: ${opts.version ?? 'v1'}
- Auth: ${opts.auth ?? 'bearer'}
- Resources: ${resources.length}

## Files

${artifacts.map((a) => `- \`${a.path}\` — ${a.kind}`).join('\n')}

## Quick start

\`\`\`bash
# Start the mock server
cd mock && bun install && bun run server.ts

# View the OpenAPI spec
npx @redocly/cli preview-docs ../openapi.yaml
\`\`\`

## SDK usage (TypeScript)

\`\`\`ts
import { ApiClient } from './sdk/typescript/client';

const client = new ApiClient({
  baseUrl: 'https://api.example.com/api/v1',
  bearerToken: process.env.API_TOKEN!,
});

const items = await client.list${resources[0]?.plural ?? 'Resources'}({ limit: 10 });
console.log(items.data);
\`\`\`
`;
  }

  // ─── Summary ───────────────────────────────────────────────────────────

  /** Build a human-readable run summary. */
  private buildSummary(
    resources: ApiResource[],
    restEndpoints: RestEndpoint[],
    graphqlOps: GraphQLOperation[],
    artifacts: GeneratedArtifact[],
    issues: DesignValidationIssue[],
  ): string {
    return [
      `API Designer designed ${resources.length} resources, ${restEndpoints.length} REST endpoints, ${graphqlOps.length} GraphQL operations.`,
      `Generated ${artifacts.length} artifacts (OpenAPI spec, mock server, SDK clients, Postman collection, docs).`,
      `${issues.length} design issues flagged (${issues.filter((i) => i.severity === 'high').length} high).`,
    ].join(' ');
  }
}
