/**
 * @file GraphQueryDSL.ts
 * @description A simplified Cypher-like query language for the knowledge
 * graph. Supports:
 *
 *   - `MATCH (n:Type)-[:REL]->(m:Type)` — pattern matching
 *   - `MATCH (n)-[r*1..3]->(m)`         — variable-length paths
 *   - `WHERE n.prop = value`            — filtering (supports =, !=, <, <=, >, >=, AND, OR)
 *   - `RETURN n, m, r`                  — projection (variable list)
 *   - `ORDER BY n.prop DESC`            — sorting
 *   - `LIMIT N`                         — limit
 *
 * This is NOT full Cypher — just enough for common graph queries against
 * the SANIX knowledge graph.
 *
 * ## Grammar (informal)
 *
 * ```
 * query      := MATCH pattern [WHERE condition] RETURN items
 *               [ORDER BY orderItems] [LIMIT number]
 * pattern    := nodePattern (edgePattern nodePattern)*
 * nodePattern:= '(' [var] [':' type] ')'
 * edgePattern:= '-' '[' [var] [':' type] ['*' min ['..' max]] ']' ('->' | '<-' | '-')
 * items      := item (',' item)*
 * item       := var
 * condition  := comparison (('AND' | 'OR') comparison)*
 * comparison := var '.' ident op (value | var '.' ident)
 * orderItems := orderItem (',' orderItem)*
 * orderItem  := var '.' ident ['DESC' | 'ASC']
 * ```
 *
 * @packageDocumentation
 */

import type { GraphStore } from './GraphStore.js';
import type {
  Entity,
  EntityType,
  GraphEdge,
  GraphNode,
  GraphQueryResult,
  Relationship,
  Subgraph,
} from './types.js';

// ─── Parsed AST ───────────────────────────────────────────────────────────

/**
 * A node pattern: `(var:Type)` or `(var)` or `(:Type)` or `()`.
 */
export interface NodePattern {
  /** Variable name (e.g. `n`). May be undefined for anonymous nodes. */
  variable?: string;
  /** Entity type filter. */
  type?: EntityType;
}

/**
 * An edge pattern: `-[var:REL*1..3]->`, `<-[r]-`, etc.
 */
export interface EdgePattern {
  /** Variable name (e.g. `r`). */
  variable?: string;
  /** Relationship type filter. */
  type?: string;
  /** Direction: 'out' (`->`), 'in' (`<-`), or 'both' (`-`). */
  direction: 'out' | 'in' | 'both';
  /** Variable-length path: minimum hops (inclusive). */
  minHops?: number;
  /** Variable-length path: maximum hops (inclusive). */
  maxHops?: number;
}

/**
 * One element of the MATCH pattern: either a node or an edge.
 */
export type PatternElement =
  | { kind: 'node'; node: NodePattern }
  | { kind: 'edge'; edge: EdgePattern };

/**
 * A WHERE comparison: `var.prop op value`.
 */
export interface Comparison {
  /** The variable name (e.g. `n`). */
  variable: string;
  /** The property name (e.g. `name`, `confidence`, `type`). */
  property: string;
  /** The comparison operator. */
  operator: '=' | '!=' | '<' | '<=' | '>' | '>=';
  /** The right-hand side: a literal value or another `var.prop` reference. */
  value: Literal | { variable: string; property: string };
}

/**
 * A WHERE condition is a tree of comparisons joined by AND/OR.
 */
export type Condition =
  | { kind: 'comparison'; comparison: Comparison }
  | { kind: 'and'; left: Condition; right: Condition }
  | { kind: 'or'; left: Condition; right: Condition };

/**
 * A literal value (string, number, boolean, null).
 */
export type Literal =
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' };

/**
 * One item in the RETURN list (a variable name, optionally with `.prop`).
 */
export interface ReturnItem {
  /** Variable name (e.g. `n`, `r`). */
  variable: string;
  /** Optional property name (e.g. `name`). When omitted, return the whole node/edge. */
  property?: string;
}

/**
 * One item in the ORDER BY list.
 */
export interface OrderItem {
  /** Variable name. */
  variable: string;
  /** Property name. */
  property: string;
  /** Sort direction. Default: ASC. */
  direction: 'asc' | 'desc';
}

/**
 * The fully-parsed query AST.
 */
export interface ParsedQuery {
  /** The MATCH pattern (alternating node/edge, starting and ending with node). */
  pattern: PatternElement[];
  /** Optional WHERE condition. */
  where?: Condition;
  /** RETURN items. */
  return: ReturnItem[];
  /** Optional ORDER BY items. */
  orderBy?: OrderItem[];
  /** Optional LIMIT. */
  limit?: number;
}

// ─── Errors ───────────────────────────────────────────────────────────────

/**
 * Thrown when the DSL parser encounters invalid syntax. Carries the
 * 1-based line/column for helpful error messages.
 */
export class DSLParseError extends Error {
  /** 1-based line number where the error occurred. */
  readonly line: number;
  /** 1-based column number where the error occurred. */
  readonly column: number;
  /** The offending token (or "" at end-of-input). */
  readonly token: string;

  constructor(message: string, line: number, column: number, token: string) {
    super(
      `DSL parse error at line ${line}, column ${column} (token "${token}"): ${message}`,
    );
    this.name = 'DSLParseError';
    this.line = line;
    this.column = column;
    this.token = token;
  }
}

// ─── Tokenizer ────────────────────────────────────────────────────────────

/**
 * Token types produced by the tokenizer.
 */
type TokenType =
  | 'KEYWORD' // MATCH, WHERE, RETURN, ORDER, BY, LIMIT, AND, OR, ASC, DESC
  | 'IDENT' // variable or property name
  | 'TYPE' // entity/relationship type label (after ':')
  | 'STRING' // 'literal' or "literal"
  | 'NUMBER' // 123, 1.5
  | 'BOOLEAN' // true, false
  | 'NULL' // null
  | 'LPAREN' // (
  | 'RPAREN' // )
  | 'LBRACKET' // [
  | 'RBRACKET' // ]
  | 'COLON' // :
  | 'COMMA' // ,
  | 'DOT' // .
  | 'ARROW_R' // ->
  | 'ARROW_L' // <-
  | 'DASH' // -
  | 'STAR' // *
  | 'DOTDOT' // ..
  | 'EQ' // =
  | 'NEQ' // !=
  | 'LT' // <
  | 'LE' // <=
  | 'GT' // >
  | 'GE' // >=
  | 'EOF';

interface Token {
  type: TokenType;
  value: string;
  line: number;
  column: number;
}

const KEYWORDS = new Set([
  'MATCH',
  'WHERE',
  'RETURN',
  'ORDER',
  'BY',
  'LIMIT',
  'AND',
  'OR',
  'ASC',
  'DESC',
  'TRUE',
  'FALSE',
  'NULL',
]);

/**
 * Tokenize the input query into a list of tokens. The final token is
 * always an `EOF` sentinel.
 *
 * @throws {@link DSLParseError} on invalid character.
 */
function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const push = (t: TokenType, value: string, l: number, c: number): void => {
    tokens.push({ type: t, value, line: l, column: c });
  };
  const advance = (): string => {
    const ch = input[i++]!;
    if (ch === '\n') {
      line++;
      col = 1;
    } else {
      col++;
    }
    return ch;
  };
  const peek = (): string => input[i] ?? '';

  while (i < input.length) {
    const startLine = line;
    const startCol = col;
    const ch = input[i]!;
    // Whitespace.
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      advance();
      continue;
    }
    // Comments — `//` to end of line.
    if (ch === '/' && input[i + 1] === '/') {
      while (i < input.length && input[i] !== '\n') advance();
      continue;
    }
    // Strings — single or double quoted.
    if (ch === "'" || ch === '"') {
      advance(); // consume opening quote
      let buf = '';
      while (i < input.length && input[i] !== ch) {
        const c2 = input[i]!;
        if (c2 === '\\') {
          advance();
          const esc = peek();
          buf += esc;
          advance();
        } else {
          buf += c2;
          advance();
        }
      }
      if (i >= input.length) {
        throw new DSLParseError(
          'unterminated string literal',
          startLine,
          startCol,
          ch,
        );
      }
      advance(); // consume closing quote
      push('STRING', buf, startLine, startCol);
      continue;
    }
    // Numbers.
    if (isDigit(ch)) {
      let buf = '';
      while (i < input.length && isDigit(input[i]!)) buf += advance();
      if (peek() === '.' && isDigit(input[i + 1] ?? '')) {
        buf += advance();
        while (i < input.length && isDigit(input[i]!)) buf += advance();
      }
      push('NUMBER', buf, startLine, startCol);
      continue;
    }
    // Identifiers / keywords.
    if (isIdentStart(ch)) {
      let buf = '';
      while (i < input.length && isIdentPart(input[i]!)) buf += advance();
      const upper = buf.toUpperCase();
      if (KEYWORDS.has(upper)) {
        if (upper === 'TRUE' || upper === 'FALSE') {
          push('BOOLEAN', upper, startLine, startCol);
        } else if (upper === 'NULL') {
          push('NULL', upper, startLine, startCol);
        } else {
          push('KEYWORD', upper, startLine, startCol);
        }
      } else {
        push('IDENT', buf, startLine, startCol);
      }
      continue;
    }
    // Punctuation.
    if (ch === '(') {
      advance();
      push('LPAREN', ch, startLine, startCol);
      continue;
    }
    if (ch === ')') {
      advance();
      push('RPAREN', ch, startLine, startCol);
      continue;
    }
    if (ch === '[') {
      advance();
      push('LBRACKET', ch, startLine, startCol);
      continue;
    }
    if (ch === ']') {
      advance();
      push('RBRACKET', ch, startLine, startCol);
      continue;
    }
    if (ch === ':') {
      advance();
      push('COLON', ch, startLine, startCol);
      continue;
    }
    if (ch === ',') {
      advance();
      push('COMMA', ch, startLine, startCol);
      continue;
    }
    if (ch === '*') {
      advance();
      push('STAR', ch, startLine, startCol);
      continue;
    }
    // Arrow / dash / dot / dotdot.
    if (ch === '-') {
      if (input[i + 1] === '>') {
        advance();
        advance();
        push('ARROW_R', '->', startLine, startCol);
        continue;
      }
      if (input[i + 1] === '.' && input[i + 2] === '.') {
        // Not a token we expect, but be defensive — treat as DASH then DOTDOT.
        advance();
        push('DASH', '-', startLine, startCol);
        continue;
      }
      advance();
      push('DASH', '-', startLine, startCol);
      continue;
    }
    if (ch === '<') {
      if (input[i + 1] === '-') {
        advance();
        advance();
        push('ARROW_L', '<-', startLine, startCol);
        continue;
      }
      if (input[i + 1] === '=') {
        advance();
        advance();
        push('LE', '<=', startLine, startCol);
        continue;
      }
      advance();
      push('LT', '<', startLine, startCol);
      continue;
    }
    if (ch === '>') {
      if (input[i + 1] === '=') {
        advance();
        advance();
        push('GE', '>=', startLine, startCol);
        continue;
      }
      advance();
      push('GT', '>', startLine, startCol);
      continue;
    }
    if (ch === '=') {
      if (input[i + 1] === '=') {
        // Treat `==` as `=`.
        advance();
        advance();
        push('EQ', '==', startLine, startCol);
        continue;
      }
      advance();
      push('EQ', '=', startLine, startCol);
      continue;
    }
    if (ch === '!') {
      if (input[i + 1] === '=') {
        advance();
        advance();
        push('NEQ', '!=', startLine, startCol);
        continue;
      }
      throw new DSLParseError(
        "unexpected '!' (did you mean '!='?)",
        startLine,
        startCol,
        ch,
      );
    }
    if (ch === '.') {
      if (input[i + 1] === '.') {
        advance();
        advance();
        push('DOTDOT', '..', startLine, startCol);
        continue;
      }
      advance();
      push('DOT', '.', startLine, startCol);
      continue;
    }
    throw new DSLParseError(
      `unexpected character '${ch}'`,
      startLine,
      startCol,
      ch,
    );
  }
  push('EOF', '', line, col);
  return tokens;
}

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}
function isIdentStart(c: string): boolean {
  return (
    (c >= 'a' && c <= 'z') ||
    (c >= 'A' && c <= 'Z') ||
    c === '_'
  );
}
function isIdentPart(c: string): boolean {
  return isIdentStart(c) || isDigit(c);
}

// ─── Parser ───────────────────────────────────────────────────────────────

/**
 * Recursive-descent parser over the token stream.
 */
class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(offset = 0): Token {
    return this.tokens[this.pos + offset] ?? this.tokens[this.tokens.length - 1]!;
  }

  private consume(): Token {
    const t = this.tokens[this.pos]!;
    if (this.pos < this.tokens.length - 1) this.pos++;
    return t;
  }

  private expect(type: TokenType, what: string): Token {
    const t = this.peek();
    if (t.type !== type) {
      throw new DSLParseError(
        `expected ${what} but got '${t.value}'`,
        t.line,
        t.column,
        t.value,
      );
    }
    return this.consume();
  }

  private matchKeyword(kw: string): boolean {
    const t = this.peek();
    if (t.type === 'KEYWORD' && t.value === kw) {
      this.consume();
      return true;
    }
    return false;
  }

  parse(): ParsedQuery {
    this.expectKeyword('MATCH');
    const pattern = this.parsePattern();
    let where: Condition | undefined;
    if (this.matchKeyword('WHERE')) {
      where = this.parseCondition();
    }
    this.expectKeyword('RETURN');
    const returnItems = this.parseReturnItems();
    let orderBy: OrderItem[] | undefined;
    if (this.matchKeyword('ORDER')) {
      this.expectKeyword('BY');
      orderBy = this.parseOrderItems();
    }
    let limit: number | undefined;
    if (this.matchKeyword('LIMIT')) {
      const t = this.expect('NUMBER', 'number after LIMIT');
      limit = Number(t.value);
      if (!Number.isFinite(limit) || limit < 0) {
        throw new DSLParseError(
          `LIMIT must be a non-negative number, got ${t.value}`,
          t.line,
          t.column,
          t.value,
        );
      }
    }
    this.expect('EOF', 'end of query');
    return {
      pattern,
      where,
      return: returnItems,
      orderBy,
      limit,
    };
  }

  private expectKeyword(kw: string): void {
    const t = this.peek();
    if (t.type !== 'KEYWORD' || t.value !== kw) {
      throw new DSLParseError(
        `expected keyword ${kw} but got '${t.value}'`,
        t.line,
        t.column,
        t.value,
      );
    }
    this.consume();
  }

  private parsePattern(): PatternElement[] {
    const elements: PatternElement[] = [];
    elements.push({ kind: 'node', node: this.parseNodePattern() });
    while (
      this.peek().type === 'DASH' ||
      this.peek().type === 'ARROW_L'
    ) {
      const edge = this.parseEdgePattern();
      elements.push({ kind: 'edge', edge });
      elements.push({ kind: 'node', node: this.parseNodePattern() });
    }
    return elements;
  }

  private parseNodePattern(): NodePattern {
    this.expect('LPAREN', "'('");
    const np: NodePattern = {};
    const t = this.peek();
    if (t.type === 'IDENT') {
      np.variable = this.consume().value;
    }
    if (this.peek().type === 'COLON') {
      this.consume();
      const typeTok = this.expect('IDENT', "entity type after ':'");
      np.type = typeTok.value as EntityType;
    }
    this.expect('RPAREN', "')'");
    return np;
  }

  private parseEdgePattern(): EdgePattern {
    // Forms:
    //   -[var:REL*1..3]->    (out)
    //   <-[var:REL]-         (in)
    //   -[var:REL]-          (both)
    let direction: 'out' | 'in' | 'both' = 'both';
    if (this.peek().type === 'ARROW_L') {
      direction = 'in';
      this.consume(); // <-
      this.expect('LBRACKET', "'[' after '<-'");
    } else {
      this.consume(); // -
      this.expect('LBRACKET', "'[' after '-'");
    }
    const ep: EdgePattern = { direction };
    if (this.peek().type === 'IDENT') {
      ep.variable = this.consume().value;
    }
    if (this.peek().type === 'COLON') {
      this.consume();
      const t = this.expect('IDENT', "relationship type after ':'");
      ep.type = t.value;
    }
    if (this.peek().type === 'STAR') {
      this.consume();
      // Variable-length path.
      const minT = this.peek();
      if (minT.type === 'NUMBER') {
        ep.minHops = Number(this.consume().value);
      } else if (minT.type === 'DOTDOT') {
        ep.minHops = 1;
      }
      if (this.peek().type === 'DOTDOT') {
        this.consume();
        const maxT = this.peek();
        if (maxT.type === 'NUMBER') {
          ep.maxHops = Number(this.consume().value);
        }
      } else if (ep.minHops !== undefined) {
        ep.maxHops = ep.minHops;
      }
      if (ep.minHops === undefined) ep.minHops = 1;
      if (ep.maxHops === undefined) ep.maxHops = ep.minHops;
    }
    this.expect('RBRACKET', "']'");
    // Trailing dash / arrow.
    const t = this.peek();
    if (t.type === 'ARROW_R') {
      if (direction === 'in') {
        throw new DSLParseError(
          "invalid edge pattern: '<-[...]->' (use one direction)",
          t.line,
          t.column,
          t.value,
        );
      }
      direction = 'out';
      this.consume();
    } else if (t.type === 'DASH') {
      this.consume();
      // direction stays as it was
    } else {
      throw new DSLParseError(
        `expected '-' or '->' after ']' but got '${t.value}'`,
        t.line,
        t.column,
        t.value,
      );
    }
    ep.direction = direction;
    return ep;
  }

  private parseCondition(): Condition {
    let left = this.parseComparison();
    while (this.peek().type === 'KEYWORD' && (this.peek().value === 'AND' || this.peek().value === 'OR')) {
      const op = this.consume().value as 'AND' | 'OR';
      const right = this.parseComparison();
      left =
        op === 'AND'
          ? { kind: 'and', left, right }
          : { kind: 'or', left, right };
    }
    return left;
  }

  private parseComparison(): Condition {
    // var . ident op (value | var . ident)
    const varTok = this.expect('IDENT', 'variable name in WHERE');
    this.expect('DOT', "'.' in WHERE");
    const propTok = this.expect('IDENT', 'property name in WHERE');
    const opTok = this.peek();
    const opMap: Record<string, Comparison['operator']> = {
      EQ: '=',
      NEQ: '!=',
      LT: '<',
      LE: '<=',
      GT: '>',
      GE: '>=',
    };
    if (!(opTok.type in opMap)) {
      throw new DSLParseError(
        `expected comparison operator but got '${opTok.value}'`,
        opTok.line,
        opTok.column,
        opTok.value,
      );
    }
    this.consume();
    const op = opMap[opTok.type]!;
    // Right-hand side.
    const rhsTok = this.peek();
    let value: Comparison['value'];
    if (rhsTok.type === 'STRING') {
      value = { kind: 'string', value: this.consume().value };
    } else if (rhsTok.type === 'NUMBER') {
      value = { kind: 'number', value: Number(this.consume().value) };
    } else if (rhsTok.type === 'BOOLEAN') {
      value = { kind: 'boolean', value: this.consume().value === 'TRUE' };
    } else if (rhsTok.type === 'NULL') {
      this.consume();
      value = { kind: 'null' };
    } else if (rhsTok.type === 'IDENT') {
      const var2 = this.consume().value;
      this.expect('DOT', "'.' in WHERE right-hand side");
      const prop2 = this.expect('IDENT', 'property name').value;
      value = { variable: var2, property: prop2 };
    } else {
      throw new DSLParseError(
        `expected value or property reference but got '${rhsTok.value}'`,
        rhsTok.line,
        rhsTok.column,
        rhsTok.value,
      );
    }
    return {
      kind: 'comparison',
      comparison: {
        variable: varTok.value,
        property: propTok.value,
        operator: op,
        value,
      },
    };
  }

  private parseReturnItems(): ReturnItem[] {
    const items: ReturnItem[] = [this.parseReturnItem()];
    while (this.peek().type === 'COMMA') {
      this.consume();
      items.push(this.parseReturnItem());
    }
    return items;
  }

  private parseReturnItem(): ReturnItem {
    const varTok = this.expect('IDENT', 'variable in RETURN');
    const item: ReturnItem = { variable: varTok.value };
    if (this.peek().type === 'DOT') {
      this.consume();
      item.property = this.expect('IDENT', 'property name after .').value;
    }
    return item;
  }

  private parseOrderItems(): OrderItem[] {
    const items: OrderItem[] = [this.parseOrderItem()];
    while (this.peek().type === 'COMMA') {
      this.consume();
      items.push(this.parseOrderItem());
    }
    return items;
  }

  private parseOrderItem(): OrderItem {
    const varTok = this.expect('IDENT', 'variable in ORDER BY');
    this.expect('DOT', "'.' in ORDER BY");
    const propTok = this.expect('IDENT', 'property name in ORDER BY');
    let direction: 'asc' | 'desc' = 'asc';
    if (this.peek().type === 'KEYWORD') {
      if (this.peek().value === 'DESC') {
        direction = 'desc';
        this.consume();
      } else if (this.peek().value === 'ASC') {
        this.consume();
      }
    }
    return {
      variable: varTok.value,
      property: propTok.value,
      direction,
    };
  }
}

// ─── GraphQueryDSL ────────────────────────────────────────────────────────

/**
 * Parses + executes simplified Cypher-like queries against a
 * {@link GraphStore}.
 *
 * @example
 * ```ts
 * const dsl = new GraphQueryDSL();
 * const parsed = dsl.parse(
 *   "MATCH (n:Person)-[:WORKS_AT]->(o:Organization) WHERE o.name = 'Acme' RETURN n"
 * );
 * const result = await dsl.execute(parsed, store);
 * console.log(result.matched.length, result.explanation);
 * ```
 */
export class GraphQueryDSL {
  /**
   * Parse a query string into a {@link ParsedQuery} AST.
   *
   * @throws {@link DSLParseError} on invalid syntax.
   */
  parse(query: string): ParsedQuery {
    const tokens = tokenize(query);
    return new Parser(tokens).parse();
  }

  /**
   * Execute a parsed query against the supplied store. Returns matched
   * nodes/edges, an optional subgraph, optional aggregations, and a
   * human-readable explanation.
   */
  async execute(
    parsed: ParsedQuery,
    store: GraphStore,
  ): Promise<GraphQueryResult> {
    // Materialize candidate bindings: a binding is a Map<variable, Entity | Relationship>.
    const nodePatterns = parsed.pattern.filter(
      (p) => p.kind === 'node',
    ) as Array<{ kind: 'node'; node: NodePattern }>;
    const edgePatterns = parsed.pattern.filter(
      (p) => p.kind === 'edge',
    ) as Array<{ kind: 'edge'; edge: EdgePattern }>;

    if (nodePatterns.length === 0) {
      return {
        matched: [],
        explanation: 'Empty MATCH pattern — nothing to do.',
      };
    }

    // Start by enumerating all entities that match the FIRST node pattern.
    const firstNode = nodePatterns[0]!.node;
    let candidates: Entity[] = [];
    if (firstNode.type) {
      candidates = store.listEntities({ type: firstNode.type, limit: 100000 });
    } else {
      candidates = store.listEntities({ limit: 100000 });
    }

    // Strip the wrapper from the remaining node patterns for the walk.
    const remainingNodes: NodePattern[] = nodePatterns
      .slice(1)
      .map((p) => p.node);
    const edges: EdgePattern[] = edgePatterns.map((p) => p.edge);

    // For each starting candidate, walk the pattern.
    const bindings: Array<Map<string, Entity | Relationship>> = [];
    for (const start of candidates) {
      const binding = new Map<string, Entity | Relationship>();
      if (firstNode.variable) binding.set(firstNode.variable, start);
      this.walk(store, start, remainingNodes, edges, 0, binding, bindings);
    }

    // Apply WHERE.
    let filtered = bindings;
    if (parsed.where) {
      filtered = bindings.filter((b) => evalCondition(parsed.where!, b));
    }

    // Apply ORDER BY (only if there's at least one item).
    if (parsed.orderBy && parsed.orderBy.length > 0) {
      filtered = sortBindings(filtered, parsed.orderBy);
    }

    // Apply LIMIT.
    if (parsed.limit !== undefined) {
      filtered = filtered.slice(0, parsed.limit);
    }

    // Project RETURN items.
    const matched: Array<GraphNode | GraphEdge> = [];
    const returnVars = new Set(parsed.return.map((r) => r.variable));
    const subgraphNodes = new Map<string, GraphNode>();
    const subgraphEdges = new Map<string, GraphEdge>();
    let rootEntityId = '';
    for (const b of filtered) {
      for (const item of parsed.return) {
        const v = b.get(item.variable);
        if (!v) continue;
        // Skip property projections (only full node/edge returns are
        // projected into `matched`; property values are surfaced via
        // aggregations / explanation below).
        if (item.property) continue;
        if ('type' in v && 'aliases' in v) {
          // Entity
          const e = v as Entity;
          const degree = store.getRelationships(e.id, { direction: 'both' }).length;
          matched.push({ entity: e, degree });
          if (!rootEntityId) rootEntityId = e.id;
          if (returnVars.has(item.variable)) {
            subgraphNodes.set(e.id, { entity: e, degree });
          }
        } else {
          // Relationship
          const r = v as Relationship;
          const sourceEntity = store.getEntity(r.source);
          const targetEntity = store.getEntity(r.target);
          if (sourceEntity && targetEntity) {
            const edge: GraphEdge = {
              relationship: r,
              sourceEntity,
              targetEntity,
            };
            matched.push(edge);
            subgraphEdges.set(r.id, edge);
            if (sourceEntity) {
              const deg = store
                .getRelationships(sourceEntity.id, { direction: 'both' })
                .length;
              subgraphNodes.set(sourceEntity.id, {
                entity: sourceEntity,
                degree: deg,
              });
            }
            if (targetEntity) {
              const deg = store
                .getRelationships(targetEntity.id, { direction: 'both' })
                .length;
              subgraphNodes.set(targetEntity.id, {
                entity: targetEntity,
                degree: deg,
              });
            }
          }
        }
      }
    }

    // Aggregations: count matched nodes by type.
    const aggregations: Record<string, number> = {};
    for (const m of matched) {
      if ('entity' in m) {
        const t = m.entity.type;
        aggregations[t] = (aggregations[t] ?? 0) + 1;
      } else {
        const t = m.relationship.type;
        aggregations[`rel:${t}`] = (aggregations[`rel:${t}`] ?? 0) + 1;
      }
    }

    // Build subgraph (rooted at the first matched entity, depth = pattern length).
    let subgraph: Subgraph | undefined;
    if (rootEntityId) {
      const depth = Math.max(1, edgePatterns.length);
      subgraph = store.getSubgraph(rootEntityId, depth);
    }

    const explanation =
      `Matched ${matched.length} item(s) across ${filtered.length} binding(s)` +
      (parsed.where ? ' after WHERE filter' : '') +
      (parsed.limit !== undefined ? ` (LIMIT ${parsed.limit})` : '') +
      '.';

    return {
      matched,
      subgraph,
      aggregations,
      explanation,
    };
  }

  /**
   * Walk the pattern recursively, accumulating bindings.
   *
   * @param store - The graph store.
   * @param current - The current entity (the "anchor" for this step).
   * @param remainingNodes - The remaining node patterns to match (after `current`).
   * @param edges - The full list of edge patterns (indexed by `edgeIdx`).
   * @param edgeIdx - The current edge index (also = the index into `remainingNodes`).
   * @param binding - The current variable binding (mutated + cloned on each match).
   * @param out - Accumulator for successful bindings.
   */
  private walk(
    store: GraphStore,
    current: Entity,
    remainingNodes: NodePattern[],
    edges: EdgePattern[],
    edgeIdx: number,
    binding: Map<string, Entity | Relationship>,
    out: Array<Map<string, Entity | Relationship>>,
  ): void {
    if (edgeIdx >= edges.length) {
      // Pattern fully matched — record this binding.
      out.push(new Map(binding));
      return;
    }
    const edge = edges[edgeIdx]!;
    const nextNode = remainingNodes[0]!;
    // Get candidate relationships from `current` based on direction + type.
    let rels: Relationship[];
    if (edge.direction === 'out') {
      rels = store.getRelationships(current.id, {
        direction: 'out',
        type: edge.type,
      });
    } else if (edge.direction === 'in') {
      rels = store.getRelationships(current.id, {
        direction: 'in',
        type: edge.type,
      });
    } else {
      rels = store.getRelationships(current.id, {
        direction: 'both',
        type: edge.type,
      });
    }

    // Variable-length path: expand via BFS up to maxHops.
    if (edge.minHops !== undefined || edge.maxHops !== undefined) {
      const minHops = edge.minHops ?? 1;
      const maxHops = edge.maxHops ?? minHops;
      const paths = this.bfsPaths(
        store,
        current.id,
        edge,
        minHops,
        maxHops,
      );
      for (const path of paths) {
        // path is array of { rel, entity } from hop 1 onward.
        const lastEntityId = path[path.length - 1]!.entityId;
        const lastEntity = store.getEntity(lastEntityId);
        if (!lastEntity) continue;
        if (nextNode.type && lastEntity.type !== nextNode.type) continue;
        if (nextNode.variable) {
          if (binding.has(nextNode.variable)) {
            const existing = binding.get(nextNode.variable);
            if (existing && 'id' in existing && existing.id !== lastEntity.id) {
              continue; // variable must bind consistently
            }
          }
          binding.set(nextNode.variable, lastEntity);
        }
        // Bind the edge variable to the LAST relationship in the path
        // (a simplification — full Cypher would expose the path as a list).
        if (edge.variable) {
          const lastRel = path[path.length - 1]!.rel;
          binding.set(edge.variable, lastRel);
        }
        this.walk(
          store,
          lastEntity,
          remainingNodes.slice(1),
          edges,
          edgeIdx + 1,
          binding,
          out,
        );
        // Unbind for next iteration.
        if (nextNode.variable) binding.delete(nextNode.variable);
        if (edge.variable) binding.delete(edge.variable);
      }
      return;
    }

    // Single-hop edge.
    for (const r of rels) {
      // Direction-aware endpoint selection.
      let nextEntityId: string | undefined;
      if (edge.direction === 'out') {
        if (r.source !== current.id) continue;
        nextEntityId = r.target;
      } else if (edge.direction === 'in') {
        if (r.target !== current.id) continue;
        nextEntityId = r.source;
      } else {
        // both — pick the endpoint that isn't `current`.
        nextEntityId = r.source === current.id ? r.target : r.source;
      }
      if (!nextEntityId) continue;
      const nextEntity = store.getEntity(nextEntityId);
      if (!nextEntity) continue;
      if (nextNode.type && nextEntity.type !== nextNode.type) continue;
      if (nextNode.variable) {
        if (binding.has(nextNode.variable)) {
          const existing = binding.get(nextNode.variable);
          if (existing && 'id' in existing && existing.id !== nextEntity.id) {
            continue;
          }
        }
        binding.set(nextNode.variable, nextEntity);
      }
      if (edge.variable) {
        binding.set(edge.variable, r);
      }
      this.walk(
        store,
        nextEntity,
        remainingNodes.slice(1),
        edges,
        edgeIdx + 1,
        binding,
        out,
      );
      if (nextNode.variable) binding.delete(nextNode.variable);
      if (edge.variable) binding.delete(edge.variable);
    }
  }

  /**
   * BFS over the graph following `edge` constraints, returning all paths
   * of length in `[minHops, maxHops]` starting from `fromId`.
   */
  private bfsPaths(
    store: GraphStore,
    fromId: string,
    edge: EdgePattern,
    minHops: number,
    maxHops: number,
  ): Array<Array<{ rel: Relationship; entityId: string }>> {
    const results: Array<Array<{ rel: Relationship; entityId: string }>> = [];
    const queue: Array<{
      currentId: string;
      path: Array<{ rel: Relationship; entityId: string }>;
      visited: Set<string>;
    }> = [{ currentId: fromId, path: [], visited: new Set([fromId]) }];
    while (queue.length > 0) {
      const { currentId, path, visited } = queue.shift()!;
      if (path.length >= maxHops) continue;
      const rels = store.getRelationships(currentId, {
        direction: edge.direction,
        type: edge.type,
      });
      for (const r of rels) {
        let nextId: string | undefined;
        if (edge.direction === 'out') {
          if (r.source !== currentId) continue;
          nextId = r.target;
        } else if (edge.direction === 'in') {
          if (r.target !== currentId) continue;
          nextId = r.source;
        } else {
          nextId = r.source === currentId ? r.target : r.source;
        }
        if (!nextId) continue;
        if (visited.has(nextId)) continue;
        const newPath = [...path, { rel: r, entityId: nextId }];
        if (newPath.length >= minHops && newPath.length <= maxHops) {
          results.push(newPath);
        }
        const newVisited = new Set(visited);
        newVisited.add(nextId);
        queue.push({
          currentId: nextId,
          path: newPath,
          visited: newVisited,
        });
      }
    }
    return results;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Evaluate a WHERE condition tree against a binding.
 */
function evalCondition(
  cond: Condition,
  binding: Map<string, Entity | Relationship>,
): boolean {
  if (cond.kind === 'and') {
    return evalCondition(cond.left, binding) && evalCondition(cond.right, binding);
  }
  if (cond.kind === 'or') {
    return evalCondition(cond.left, binding) || evalCondition(cond.right, binding);
  }
  return evalComparison(cond.comparison, binding);
}

/**
 * Evaluate a single comparison.
 */
function evalComparison(
  c: Comparison,
  binding: Map<string, Entity | Relationship>,
): boolean {
  const lhs = resolveValue(c.variable, c.property, binding);
  const rhs =
    'variable' in c.value
      ? resolveValue(c.value.variable, c.value.property, binding)
      : literalToJs(c.value);
  switch (c.operator) {
    case '=':
      return lhs === rhs;
    case '!=':
      return lhs !== rhs;
    case '<':
      return compareOrdered(lhs, rhs) < 0;
    case '<=':
      return compareOrdered(lhs, rhs) <= 0;
    case '>':
      return compareOrdered(lhs, rhs) > 0;
    case '>=':
      return compareOrdered(lhs, rhs) >= 0;
  }
}

/**
 * Resolve `var.prop` against a binding. Returns `undefined` if either the
 * variable or the property is absent.
 */
function resolveValue(
  variable: string,
  property: string,
  binding: Map<string, Entity | Relationship>,
): unknown {
  const v = binding.get(variable);
  if (!v) return undefined;
  if ('aliases' in v) {
    // Entity
    const e = v as Entity;
    if (property === 'id') return e.id;
    if (property === 'name') return e.name;
    if (property === 'type') return e.type;
    if (property === 'source') return e.source;
    if (property === 'confidence') return e.confidence;
    if (property === 'createdAt') return e.createdAt;
    if (property === 'updatedAt') return e.updatedAt;
    if (property === 'description') return e.description ?? null;
    if (property === 'aliases') return e.aliases;
    return e.properties[property];
  }
  // Relationship
  const r = v as Relationship;
  if (property === 'id') return r.id;
  if (property === 'type') return r.type;
  if (property === 'source') return r.source;
  if (property === 'target') return r.target;
  if (property === 'confidence') return r.confidence;
  if (property === 'createdAt') return r.createdAt;
  if (property === 'updatedAt') return r.updatedAt;
  if (property === 'evidence') return r.evidence;
  if (property === 'source_meta') return r.source_meta;
  return r.properties[property];
}

/**
 * Convert a Literal AST node to a JS value.
 */
function literalToJs(lit: Literal): unknown {
  switch (lit.kind) {
    case 'string':
      return lit.value;
    case 'number':
      return lit.value;
    case 'boolean':
      return lit.value;
    case 'null':
      return null;
  }
}

/**
 * Compare two values for ordering (`<`, `<=`, `>`, `>=`). Strings compare
 * lexicographically; numbers numerically; mixed types compare by type
 * name (deterministic but not meaningful).
 */
function compareOrdered(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (typeof a === 'boolean' && typeof b === 'boolean') {
    return a === b ? 0 : a ? 1 : -1;
  }
  // Incomparable types — treat as equal (so `<` and friends return false).
  return 0;
}

/**
 * Sort bindings by the ORDER BY items (stable sort).
 */
function sortBindings(
  bindings: Array<Map<string, Entity | Relationship>>,
  orderItems: OrderItem[],
): Array<Map<string, Entity | Relationship>> {
  const indexed = bindings.map((b, i) => ({ b, i }));
  indexed.sort((a, b) => {
    for (const item of orderItems) {
      const av = resolveValue(item.variable, item.property, a.b);
      const bv = resolveValue(item.variable, item.property, b.b);
      const cmp = compareOrdered(av, bv);
      if (cmp !== 0) {
        return item.direction === 'asc' ? cmp : -cmp;
      }
    }
    return a.i - b.i; // stable
  });
  return indexed.map((x) => x.b);
}
