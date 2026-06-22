'use client';

import * as React from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useQuery } from '@tanstack/react-query';
import { costApi } from '@/lib/api';
import { qk } from '@/lib/query-client';
import { formatUSD, formatCompact } from '@/lib/utils';
import type { CostBreakdown } from '@/lib/types';

const PROVIDER_COLORS = ['#00D4FF', '#FFB347', '#39D353', '#FF4D4D', '#8B949E', '#1F6FEB', '#A371F7', '#7EE787'];

/** Cost analytics: daily cost bar chart + by-provider pie + cache hit rate. */
export function CostChart() {
  const { data, isLoading } = useQuery({
    queryKey: qk.cost.all,
    queryFn: ({ signal }) => costApi.get(signal),
    refetchInterval: 30_000,
  });

  if (isLoading || !data) {
    return (
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton className="h-72 w-full" />
        <Skeleton className="h-72 w-full" />
      </div>
    );
  }

  const summary: CostBreakdown = data.summary;
  const daily = (summary.daily ?? []).map((d) => ({
    date: d.date,
    cost: Number(d.costUsd?.toFixed(4) ?? 0),
    tokensIn: d.tokensIn ?? 0,
    tokensOut: d.tokensOut ?? 0,
    calls: d.calls ?? 0,
  }));
  const byProvider = (summary.byProvider ?? []).map((p) => ({
    name: p.provider,
    value: Number(p.costUsd?.toFixed(4) ?? 0),
    tokens: (p.tokensIn ?? 0) + (p.tokensOut ?? 0),
    calls: p.calls ?? 0,
  }));
  const totals = summary.totals;
  const cacheHitRate = typeof totals?.cacheHitRate === 'number' ? totals.cacheHitRate : null;

  return (
    <div className="space-y-4">
      {/* Summary tiles */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <SummaryTile label="Total cost" value={formatUSD(totals?.totalCostUsd ?? 0, 2)} accent="success" />
        <SummaryTile label="Total calls" value={formatCompact(totals?.totalCalls ?? 0)} accent="primary" />
        <SummaryTile label="Tokens in" value={formatCompact(totals?.totalTokensIn ?? 0)} accent="secondary" />
        <SummaryTile label="Tokens out" value={formatCompact(totals?.totalTokensOut ?? 0)} accent="primary" />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        {/* Daily cost bar chart */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Daily cost</CardTitle>
            <CardDescription>USD spent per day (last 14 days)</CardDescription>
          </CardHeader>
          <CardContent>
            {daily.length === 0 ? (
              <Empty />
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={daily} margin={{ top: 10, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke="#21262d" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="date" stroke="#8B949E" fontSize={11} tickLine={false} axisLine={false} />
                  <YAxis stroke="#8B949E" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v) => `$${formatCompact(v as number)}`} />
                  <Tooltip
                    contentStyle={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 6, fontSize: 12, color: '#e6edf3' }}
                    formatter={(value: number) => [formatUSD(value, 4), 'Cost']}
                  />
                  <Bar dataKey="cost" fill="#00D4FF" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* By provider pie */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">By provider</CardTitle>
            <CardDescription>Cost share per provider</CardDescription>
          </CardHeader>
          <CardContent>
            {byProvider.length === 0 ? (
              <Empty />
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <PieChart>
                  <Pie
                    data={byProvider}
                    dataKey="value"
                    nameKey="name"
                    innerRadius={50}
                    outerRadius={90}
                    paddingAngle={2}
                  >
                    {byProvider.map((_, i) => (
                      <Cell key={i} fill={PROVIDER_COLORS[i % PROVIDER_COLORS.length]} stroke="#0D1117" strokeWidth={2} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 6, fontSize: 12, color: '#e6edf3' }}
                    formatter={(value: number, _name, entry) => [formatUSD(value, 4), entry?.payload?.name ?? '']}
                  />
                  <Legend
                    iconType="circle"
                    wrapperStyle={{ fontSize: 11, color: '#8B949E' }}
                  />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Cache hit rate + tokens line chart */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Daily tokens & cache hit rate</CardTitle>
          <CardDescription>
            Cache hit rate: {cacheHitRate !== null ? `${(cacheHitRate * 100).toFixed(1)}%` : '—'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {daily.length === 0 ? (
            <Empty />
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={daily} margin={{ top: 10, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="#21262d" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" stroke="#8B949E" fontSize={11} tickLine={false} axisLine={false} />
                <YAxis stroke="#8B949E" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v) => formatCompact(v as number)} />
                <Tooltip
                  contentStyle={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 6, fontSize: 12, color: '#e6edf3' }}
                />
                <Legend iconType="circle" wrapperStyle={{ fontSize: 11, color: '#8B949E' }} />
                <Line type="monotone" dataKey="tokensIn" stroke="#00D4FF" strokeWidth={2} dot={false} name="Tokens in" />
                <Line type="monotone" dataKey="tokensOut" stroke="#FFB347" strokeWidth={2} dot={false} name="Tokens out" />
                <Line type="monotone" dataKey="calls" stroke="#39D353" strokeWidth={2} dot={false} name="Calls" />
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SummaryTile({ label, value, accent }: { label: string; value: string; accent: 'primary' | 'secondary' | 'success' | 'error' }) {
  const color =
    accent === 'primary' ? 'text-primary' : accent === 'secondary' ? 'text-secondary' : accent === 'success' ? 'text-success' : 'text-error';
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-[10px] uppercase tracking-wider text-fg-subtle">{label}</div>
        <div className={`mt-1 font-mono text-xl font-semibold ${color}`}>{value}</div>
      </CardContent>
    </Card>
  );
}

function Empty() {
  return (
    <div className="flex h-[200px] items-center justify-center text-sm text-fg-subtle">
      No data yet.
    </div>
  );
}
