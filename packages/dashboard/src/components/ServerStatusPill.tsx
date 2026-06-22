'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Wifi, WifiOff } from 'lucide-react';
import { healthApi } from '@/lib/api';
import { qk } from '@/lib/query-client';
import { cn, formatUptime } from '@/lib/utils';

/**
 * ServerStatusPill — small live status indicator shown in the topbar.
 * Polls `/health` every 10s.
 */
export function ServerStatusPill() {
  const health = useQuery({
    queryKey: qk.health,
    queryFn: ({ signal }) => healthApi.get(signal),
    refetchInterval: 10_000,
    retry: 0,
  });

  const online = health.data?.status === 'ok';

  return (
    <div
      className={cn(
        'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium transition-colors',
        online
          ? 'border-success/30 bg-success/10 text-success'
          : 'border-error/30 bg-error/10 text-error',
      )}
      title={online ? `Online · v${health.data?.version} · uptime ${formatUptime(health.data?.uptime)}` : 'Server unreachable'}
    >
      {online ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
      <span>{online ? 'Online' : 'Offline'}</span>
      {online ? (
        <span className="hidden text-fg-subtle sm:inline">· {formatUptime(health.data?.uptime)}</span>
      ) : null}
    </div>
  );
}
