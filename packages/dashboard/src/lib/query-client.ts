/**
 * @file lib/query-client.ts — shared React Query client + query key factory.
 */
'use client';

import { QueryClient } from '@tanstack/react-query';

/** Singleton QueryClient — created once per browser session. */
let client: QueryClient | null = null;

export function getQueryClient(): QueryClient {
  if (client) return client;
  client = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        gcTime: 5 * 60_000,
        retry: (failureCount, error) => {
          // Don't retry auth errors or client errors.
          if (error && typeof error === 'object' && 'status' in error) {
            const status = (error as { status: number }).status;
            if (status === 401 || status === 403 || status === 404) return false;
            if (status >= 400 && status < 500) return false;
          }
          return failureCount < 2;
        },
        refetchOnWindowFocus: false,
      },
      mutations: { retry: 0 },
    },
  });
  return client;
}

/** Centralized query key factory. */
export const qk = {
  health: ['health'] as const,
  chat: ['chat'] as const,
  runs: {
    all: ['runs'] as const,
    detail: (id: string) => ['runs', id] as const,
    events: (id: string) => ['runs', id, 'events'] as const,
  },
  memory: {
    all: ['memory'] as const,
    list: (query: string, tier: string) => ['memory', 'list', query, tier] as const,
  },
  tools: {
    all: ['tools'] as const,
  },
  providers: {
    all: ['providers'] as const,
    status: (id: string) => ['providers', 'status', id] as const,
  },
  auth: {
    status: (provider?: string) => ['auth', 'status', provider ?? 'all'] as const,
  },
  cost: {
    all: ['cost'] as const,
  },
  config: {
    all: ['config'] as const,
  },
} as const;
