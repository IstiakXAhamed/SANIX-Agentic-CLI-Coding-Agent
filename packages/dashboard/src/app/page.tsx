'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  ArrowRight,
  Brain,
  Coins,
  MessageSquare,
  Plus,
  Settings as SettingsIcon,
  Share2,
  Wrench,
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { AuthGuard } from '@/components/AuthGuard';
import { StatusCard } from '@/components/StatusCard';
import { costApi, healthApi, memoryApi, toolsApi } from '@/lib/api';
import { qk } from '@/lib/query-client';
import { formatUSD, formatCompact, formatRelative } from '@/lib/utils';

export default function OverviewPage() {
  return (
    <AuthGuard>
      <div className="space-y-6">
        <PageHeader />
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <StatusCard />
          <CostSummaryCard />
          <MemorySummaryCard />
          <ToolsSummaryCard />
        </div>

        <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
          <ActiveRunsCard />
          <QuickActionsCard />
        </div>
      </div>
    </AuthGuard>
  );
}

function PageHeader() {
  return (
    <div className="flex flex-col gap-2">
      <h1 className="text-2xl font-semibold tracking-tight text-fg">Overview</h1>
      <p className="text-sm text-fg-muted">
        Real-time view of your SANIX agent runtime, providers, costs, and tools.
      </p>
    </div>
  );
}

function CostSummaryCard() {
  const { data, isLoading } = useQuery({
    queryKey: qk.cost.all,
    queryFn: ({ signal }) => costApi.get(signal),
    refetchInterval: 30_000,
  });

  const totals = data?.summary.totals;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Coins className="h-4 w-4 text-success" />
            Cost
          </CardTitle>
          <Button asChild variant="ghost" size="sm" className="h-7 text-xs">
            <Link href="/cost">Details <ArrowRight className="h-3 w-3" /></Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading ? (
          <Skeleton className="h-8 w-28" />
        ) : (
          <div className="font-mono text-2xl font-semibold text-success">{formatUSD(totals?.totalCostUsd ?? 0, 2)}</div>
        )}
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div>
            <div className="text-fg-subtle">Calls</div>
            <div className="font-mono text-fg">{totals ? formatCompact(totals.totalCalls) : '—'}</div>
          </div>
          <div>
            <div className="text-fg-subtle">Tokens</div>
            <div className="font-mono text-fg">
              {totals ? formatCompact((totals.totalTokensIn ?? 0) + (totals.totalTokensOut ?? 0)) : '—'}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function MemorySummaryCard() {
  const { data, isLoading } = useQuery({
    queryKey: qk.memory.list('', 'all'),
    queryFn: ({ signal }) => memoryApi.list({}, signal),
    refetchInterval: 30_000,
  });
  const count = data?.memories.length ?? 0;
  const latest = data?.memories[0];

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Brain className="h-4 w-4 text-secondary" />
            Memory
          </CardTitle>
          <Button asChild variant="ghost" size="sm" className="h-7 text-xs">
            <Link href="/memory">Browse <ArrowRight className="h-3 w-3" /></Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading ? (
          <Skeleton className="h-8 w-20" />
        ) : (
          <div className="font-mono text-2xl font-semibold text-secondary">{count}</div>
        )}
        <p className="text-xs text-fg-muted">
          {latest ? (
            <>
              Latest: <span className="text-fg">{formatRelative(latest.createdAt)}</span>
            </>
          ) : (
            'No memories yet.'
          )}
        </p>
      </CardContent>
    </Card>
  );
}

function ToolsSummaryCard() {
  const { data, isLoading } = useQuery({
    queryKey: qk.tools.all,
    queryFn: ({ signal }) => toolsApi.list(signal),
    refetchInterval: 30_000,
  });
  const count = data?.tools.length ?? 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Wrench className="h-4 w-4 text-primary" />
            Tools
          </CardTitle>
          <Button asChild variant="ghost" size="sm" className="h-7 text-xs">
            <Link href="/tools">Registry <ArrowRight className="h-3 w-3" /></Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading ? (
          <Skeleton className="h-8 w-16" />
        ) : (
          <div className="font-mono text-2xl font-semibold text-primary">{count}</div>
        )}
        <p className="text-xs text-fg-muted">Registered & ready</p>
      </CardContent>
    </Card>
  );
}

function ActiveRunsCard() {
  // Note: SANIX server doesn't expose a list endpoint in the spec, but
  // we use the runs/* query keys as a placeholder; cost data is fetched
  // separately. We display a CTA to start a new run.
  const health = useQuery({
    queryKey: qk.health,
    queryFn: ({ signal }) => healthApi.get(signal),
    refetchInterval: 10_000,
    retry: 0,
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Activity className="h-4 w-4 text-primary" />
            Active runs
          </CardTitle>
          <Button asChild variant="ghost" size="sm" className="h-7 text-xs">
            <Link href="/runs">All runs <ArrowRight className="h-3 w-3" /></Link>
          </Button>
        </div>
        <CardDescription>Agent runs currently in progress or recently completed.</CardDescription>
      </CardHeader>
      <CardContent>
        {health.data?.status === 'ok' ? (
          <div className="flex flex-col items-center justify-center gap-3 py-8 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
              <Plus className="h-5 w-5 text-primary" />
            </div>
            <p className="text-sm text-fg-muted">No active runs. Start one from the Runs page.</p>
            <Button asChild>
              <Link href="/runs">
                <Activity className="h-4 w-4" />
                Go to Runs
              </Link>
            </Button>
          </div>
        ) : (
          <div className="py-8 text-center text-sm text-fg-subtle">Server offline.</div>
        )}
      </CardContent>
    </Card>
  );
}

function QuickActionsCard() {
  const actions = [
    { href: '/chat', label: 'New chat', icon: MessageSquare, desc: 'Single-turn LLM call' },
    { href: '/runs', label: 'Start run', icon: Activity, desc: 'Launch agent loop' },
    { href: '/memory', label: 'Browse memory', icon: Brain, desc: 'Recall facts' },
    { href: '/share', label: 'Share file', icon: Share2, desc: 'Upload & get link' },
    { href: '/settings', label: 'Settings', icon: SettingsIcon, desc: 'Configure dashboard' },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Quick actions</CardTitle>
        <CardDescription>Common tasks</CardDescription>
      </CardHeader>
      <CardContent className="space-y-1.5">
        {actions.map((a) => {
          const Icon = a.icon;
          return (
            <Link
              key={a.href}
              href={a.href}
              className="group flex items-center gap-3 rounded-md border border-transparent px-3 py-2 transition-all hover:border-border hover:bg-bg-subtle/50"
            >
              <div className="flex h-8 w-8 items-center justify-center rounded-md bg-bg-subtle text-fg-muted transition-colors group-hover:bg-primary/10 group-hover:text-primary">
                <Icon className="h-4 w-4" />
              </div>
              <div className="flex-1">
                <div className="text-sm font-medium text-fg">{a.label}</div>
                <div className="text-xs text-fg-subtle">{a.desc}</div>
              </div>
              <ArrowRight className="h-4 w-4 text-fg-subtle opacity-0 transition-opacity group-hover:opacity-100" />
            </Link>
          );
        })}
      </CardContent>
    </Card>
  );
}
