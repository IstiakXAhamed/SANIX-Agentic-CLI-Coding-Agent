/**
 * @file fixtures.ts
 * @description Sample texts and messages used across the test suites.
 */

export const SAMPLE_CODE_TS = `export function add(a: number, b: number): number {
  return a + b;
}

export class Calculator {
  private readonly value: number;
  constructor(initial = 0) {
    this.value = initial;
  }
  public add(n: number): this {
    this.value += n;
    return this;
  }
  public get(): number {
    return this.value;
  }
}
`;

export const SAMPLE_CODE_PY = `def add(a: int, b: int) -> int:
    """Return the sum of a and b."""
    return a + b


class Calculator:
    def __init__(self, initial: int = 0):
        self.value = initial

    def add(self, n: int) -> "Calculator":
        self.value += n
        return self

    def get(self) -> int:
        return self.value
`;

export const SAMPLE_TEXT = `SANIX is an agentic neural intelligence executor that orchestrates
multiple LLM providers, agent teams, retrieval-augmented generation,
knowledge graphs, code sandboxes, and a self-improvement loop. It is
designed to be modular, observable, and cost-aware. The system uses
HNSW for vector search, SQLite for persistence, and a circuit breaker
for provider failover.`;

export const SAMPLE_CONVERSATION = [
  { role: 'system' as const, content: 'You are a helpful coding assistant.' },
  { role: 'user' as const, content: 'How do I read a file in Node.js?' },
  {
    role: 'assistant' as const,
    content:
      "You can use `fs.promises.readFile(path, 'utf-8')` for async reads.",
  },
  { role: 'user' as const, content: 'How about synchronous reads?' },
];

/**
 * Text with clear entities + relationships suitable for knowledge-graph
 * extraction tests. Mentions: Alice (person), Bob (person), Acme (org),
 * Beta (org), auth module (code).
 */
export const SAMPLE_ENTITIES_TEXT =
  'Alice works at Acme. Bob works at Beta. ' +
  'Alice created the auth module. Bob reviewed the auth module. ' +
  'Acme partnered with Beta on the auth module. ' +
  'Alice can be reached at alice@acme.com. ' +
  'The auth module was shipped on 2024-05-12.';

/** Small markdown doc for RAG ingestFile tests. */
export const SAMPLE_MARKDOWN = `# Authentication

This document describes the SANIX authentication system.

## Overview

SANIX uses JWT (JSON Web Tokens) for stateless authentication. Tokens
are signed with HS256 and expire after 24 hours.

## Token format

The token has three base64url-encoded parts separated by dots:

\`header.payload.signature\`

The header specifies the algorithm (HS256). The payload contains the
user id, issued-at, and expiry. The signature verifies the token's
integrity using the server's secret key.

## Refresh tokens

Refresh tokens are stored in an httpOnly cookie and rotated on each
use to prevent replay attacks.
`;
