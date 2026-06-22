/**
 * @file errors.ts
 * @description Typed error hierarchy for provider failures. The router and
 * circuit breaker branch on these class identities (rate-limit errors open
 * the breaker faster; abort errors never count as a failure).
 */

/** Base class for every provider-layer failure. Carries the offending provider id. */
export class ProviderError extends Error {
  /** Stable provider id that produced the error. */
  readonly providerId: string;
  /** HTTP status code when known (0 for network failures). */
  readonly status: number;
  /** True when retrying the same provider is unlikely to help. */
  readonly retryable: boolean;

  constructor(providerId: string, message: string, status = 0, retryable = false) {
    super(message);
    this.name = 'ProviderError';
    this.providerId = providerId;
    this.status = status;
    this.retryable = retryable;
    // Restore prototype chain after Error subclassing quirk.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** 429 / 5xx that the router should retry with backoff. */
export class RateLimitError extends ProviderError {
  /** Suggested backoff in ms (parsed from Retry-After when available). */
  readonly retryAfterMs?: number;

  constructor(providerId: string, message: string, retryAfterMs?: number) {
    super(providerId, message, 429, true);
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** 5xx server error — retryable. */
export class ProviderServerError extends ProviderError {
  constructor(providerId: string, status: number, message: string) {
    super(providerId, message, status, true);
    this.name = 'ProviderServerError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** 4xx (non-429) — request was malformed / unauthorized, do not retry. */
export class ProviderRequestError extends ProviderError {
  constructor(providerId: string, status: number, message: string) {
    super(providerId, message, status, false);
    this.name = 'ProviderRequestError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Network failure / timeout / DNS — retryable. */
export class ProviderNetworkError extends ProviderError {
  constructor(providerId: string, message: string) {
    super(providerId, message, 0, true);
    this.name = 'ProviderNetworkError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Convert a raw fetch failure / non-2xx response into the most specific
 * ProviderError subclass. Adapters call this in their catch blocks so the
 * router's retry/circuit logic sees a uniform error taxonomy.
 */
export function classifyHttpError(
  providerId: string,
  status: number,
  bodyText: string,
  retryAfterHeader?: string,
): ProviderError {
  if (status === 429) {
    let retryAfterMs: number | undefined;
    if (retryAfterHeader) {
      const asNum = Number(retryAfterHeader);
      if (!Number.isNaN(asNum)) {
        // Spec says seconds when integer; we treat as ms if it looks like ms.
        retryAfterMs = asNum < 1000 ? asNum * 1000 : asNum;
      }
    }
    return new RateLimitError(
      providerId,
      `Rate limited by ${providerId}${retryAfterMs ? ` (retry after ${retryAfterMs}ms)` : ''}: ${bodyText.slice(0, 200)}`,
      retryAfterMs,
    );
  }
  if (status >= 500 && status < 600) {
    return new ProviderServerError(
      providerId,
      status,
      `${providerId} server error ${status}: ${bodyText.slice(0, 200)}`,
    );
  }
  return new ProviderRequestError(
    providerId,
    status,
    `${providerId} request error ${status}: ${bodyText.slice(0, 200)}`,
  );
}
