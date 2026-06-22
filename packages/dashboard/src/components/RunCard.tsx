'use client';

import * as React from 'react';
import Link from 'next/link';
import { Clock, DollarSign, Loader2, XCircle, CheckCircle2, AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn, formatUSD, formatDuration, formatRelative, truncate } from '@/lib/utils';
import type { RunState } from '@/lib/types';

const STATUS_META: Record<RunState['status'], { label: string; variant: 'default' | 'secondary' | 'success' | 'destructive' | 'warning' | 'muted'; icon: React.ComponentType<{ className?: string }> }> = {
  starting: { label: 'Starting', variant: 'warning', icon: Clock },
  running: { label: 'Running', variant: 'default', icon: Loader2 },
  completed: { label: 'Completed', variant: 'success', icon: CheckCircle2 },
  failed: { label: 'Failed', variant: 'destructive', icon: XCircle },
  aborted: { label: 'Aborted', variant: 'muted', icon: AlertTriangle },
};

interface RunCardProps {
  run: RunState;
  showOpenButton?: boolean;
}

export function RunCard({ run, showOpenButton = true }: RunCardProps) {
  const meta = STATUS_META[run.status] ?? STATUS_META.starting;
  const Icon = meta.icon;
  const duration = run.endedAt ? run.endedAt - run.startedAt : Date.now() - run.startedAt;

  return (
    <Card className="group transition-colors hover:border-primary/40">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center gap-2">
              <Badge variant={meta.variant} className="gap-1">
                <Icon className={cn('h-3 w-3', run.status === 'running' && 'animate-spin')} />
                {meta.label}
              </Badge>
              <span className="font-mono text-xs text-fg-subtle">#{truncate(run.id, 10)}</span>
            </div>
            <p className="line-clamp-2 text-sm font-medium text-fg">{run.goal}</p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-3 gap-2 text-xs">
          <Metric label="Iteration" value={String(run.iteration)} />
          <Metric label="Cost" value={formatUSD(run.totalCostUsd)} icon={<DollarSign className="h-3 w-3 text-success" />} />
          <Metric label="Duration" value={formatDuration(duration)} icon={<Clock className="h-3 w-3 text-fg-subtle" />} />
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <Metric label="Tokens in" value={run.totalTokensIn.toLocaleString()} />
          <Metric label="Tokens out" value={run.totalTokensOut.toLocaleString()} />
        </div>
        <div className="flex items-center justify-between border-t border-border pt-2">
          <span className="text-xs text-fg-subtle">Started {formatRelative(run.startedAt)}</span>
          {showOpenButton ? (
            <Button asChild size="sm" variant="ghost" className="h-7 text-xs opacity-70 group-hover:opacity-100">
              <Link href={`/runs/${run.id}`}>Open →</Link>
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function Metric({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="rounded-md bg-bg-subtle/50 px-2 py-1.5">
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-fg-subtle">
        {icon}
        {label}
      </div>
      <div className="mt-0.5 font-mono text-sm text-fg">{value}</div>
    </div>
  );
}
