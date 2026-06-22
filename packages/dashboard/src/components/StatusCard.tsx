'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, CheckCircle2, Clock, XCircle } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { healthApi } from '@/lib/api';
import { qk } from '@/lib/query-client';
import { cn, formatUptime, formatDateTime } from '@/lib/utils';

/**
 * StatusCard — server status card showing online/offline, version, uptime.
 */
export function StatusCard() {
  const health = useQuery({
    queryKey: qk.health,
    queryFn: ({ signal }) => healthApi.get(signal),
    refetchInterval: 5_000,
    retry: 0,
  });

  if (health.isLoading && !health.data) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-3 w-32" />
        </CardHeader>
        <CardContent className="space-y-2">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-full" />
        </CardContent>
      </Card>
    );
  }

  const online = health.data?.status === 'ok';
  const now = Date.now();
  const startedAt = health.data ? now - (health.data.uptime ?? 0) : 0;

  return (
    <Card className={cn('overflow-hidden', online ? 'glow-success' : 'glow-error')}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-primary" />
            <CardTitle className="text-sm">Server status</CardTitle>
          </div>
          <Badge variant={online ? 'success' : 'destructive'} className="gap-1">
            {online ? (
              <>
                <CheckCircle2 className="h-3 w-3" /> Online
              </>
            ) : (
              <>
                <XCircle className="h-3 w-3" /> Offline
              </>
            )}
          </Badge>
        </div>
        <CardDescription>SANIX REST API endpoint</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <Row label="Status" value={online ? 'ok' : health.isError ? 'unreachable' : 'unknown'} mono />
        <Row
          label="Version"
          value={health.data?.version ?? '—'}
          mono
        />
        <Row
          label="Uptime"
          value={online ? formatUptime(health.data?.uptime) : '—'}
          icon={<Clock className="h-3 w-3 text-fg-subtle" />}
        />
        <Row label="Started" value={online ? formatDateTime(startedAt) : '—'} mono />
        {!online && health.isError ? (
          <div className="mt-2 rounded-md border border-error/30 bg-error/5 px-3 py-2 text-xs text-error">
            {health.error instanceof Error ? health.error.message : 'Cannot reach the SANIX server.'}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Row({
  label,
  value,
  mono,
  icon,
}: {
  label: string;
  value: string;
  mono?: boolean;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-fg-subtle">
        {icon}
        {label}
      </span>
      <span className={cn('text-sm text-fg', mono && 'font-mono')}>{value}</span>
    </div>
  );
}
