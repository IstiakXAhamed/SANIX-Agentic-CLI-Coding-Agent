'use client';

import * as React from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Boxes, CheckCircle2, Clock, Cpu, Server, XCircle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { providersApi, authApi } from '@/lib/api';
import { qk } from '@/lib/query-client';
import { cn, formatRelative, truncate } from '@/lib/utils';
import type { AuthStatus } from '@/lib/types';

export function ProviderList() {
  const providersQ = useQuery({
    queryKey: qk.providers.all,
    queryFn: ({ signal }) => providersApi.list(signal),
    refetchInterval: 30_000,
  });

  const authQ = useQuery({
    queryKey: qk.auth.status(),
    queryFn: ({ signal }) => authApi.status(undefined, signal),
    refetchInterval: 30_000,
  });

  // Fetch per-provider status for each provider (so we can show isAvailable).
  const providerIds = (providersQ.data?.providers ?? []).map((p) => p.id);
  const statusQueries = useQueries({
    queries: providerIds.map((id) => ({
      queryKey: qk.providers.status(id),
      queryFn: ({ signal }: { signal: AbortSignal }) => providersApi.status(id, signal),
      refetchInterval: 30_000,
      retry: 0,
    })),
  });

  if (providersQ.isLoading) {
    return <Skeleton className="h-64 w-full" />;
  }

  const providers = providersQ.data?.providers ?? [];
  const authMap = new Map<string, AuthStatus>();
  for (const a of authQ.data?.providers ?? []) {
    if (a.provider) authMap.set(a.provider, a);
  }

  if (providers.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-2 py-12 text-center text-sm text-fg-subtle">
          <Boxes className="h-8 w-8 opacity-40" />
          No providers configured.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead className="border-b border-border bg-bg-subtle/50 text-xs uppercase tracking-wider text-fg-subtle">
          <tr>
            <th className="px-4 py-2 text-left">Provider</th>
            <th className="px-4 py-2 text-left">Type</th>
            <th className="px-4 py-2 text-left">Model</th>
            <th className="px-4 py-2 text-left">Auth</th>
            <th className="px-4 py-2 text-left">Status</th>
            <th className="px-4 py-2 text-right">Priority</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {providers.map((p, i) => {
            const auth = p.id ? authMap.get(p.id) : undefined;
            const status = statusQueries[i]?.data?.status as { isAvailable?: boolean; status?: string } | null | undefined;
            const isAvailable = status?.isAvailable ?? p.isAvailable;
            return (
              <tr key={p.id ?? i} className="transition-colors hover:bg-bg-subtle/30">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <div className={cn('flex h-7 w-7 items-center justify-center rounded-md', p.isLocal ? 'bg-success/10' : 'bg-primary/10')}>
                      {p.isLocal ? <Cpu className="h-3.5 w-3.5 text-success" /> : <Server className="h-3.5 w-3.5 text-primary" />}
                    </div>
                    <div>
                      <div className="font-medium text-fg">{p.name ?? p.id}</div>
                      <div className="font-mono text-[10px] text-fg-subtle">{p.id}</div>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <Badge variant={p.isLocal ? 'success' : 'secondary'} className="text-[10px]">
                    {p.isLocal ? 'local' : (p.type ?? 'cloud')}
                  </Badge>
                </td>
                <td className="px-4 py-3 font-mono text-xs text-fg-muted">{truncate(p.model ?? '—', 28)}</td>
                <td className="px-4 py-3">
                  <AuthBadge auth={auth} />
                </td>
                <td className="px-4 py-3">
                  <AvailabilityBadge isAvailable={isAvailable} />
                </td>
                <td className="px-4 py-3 text-right font-mono text-xs text-fg-muted">
                  {p.priority ?? '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function AuthBadge({ auth }: { auth?: AuthStatus }) {
  if (!auth) return <span className="text-xs text-fg-subtle">—</span>;
  const status = auth.status ?? 'idle';
  const variant: 'success' | 'destructive' | 'warning' | 'muted' =
    status === 'active' ? 'success' : status === 'expired' ? 'warning' : status === 'unauthorized' ? 'destructive' : 'muted';
  return (
    <div className="flex flex-col gap-0.5">
      <Badge variant={variant} className="w-fit text-[10px]">{status}</Badge>
      {auth.expiresAt ? (
        <span className="flex items-center gap-1 text-[10px] text-fg-subtle">
          <Clock className="h-2.5 w-2.5" />
          {formatRelative(auth.expiresAt)}
        </span>
      ) : null}
      {auth.user ? <span className="text-[10px] text-fg-subtle">{auth.user}</span> : null}
    </div>
  );
}

function AvailabilityBadge({ isAvailable }: { isAvailable?: boolean }) {
  if (isAvailable === undefined) return <span className="text-xs text-fg-subtle">—</span>;
  return (
    <Badge variant={isAvailable ? 'success' : 'destructive'} className="gap-1 text-[10px]">
      {isAvailable ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
      {isAvailable ? 'available' : 'offline'}
    </Badge>
  );
}
