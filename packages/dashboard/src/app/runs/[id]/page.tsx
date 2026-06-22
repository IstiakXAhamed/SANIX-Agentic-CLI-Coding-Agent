'use client';

import * as React from 'react';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Loader2, Octagon, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { AuthGuard } from '@/components/AuthGuard';
import { EventStream } from '@/components/EventStream';
import { TokenMeter } from '@/components/TokenMeter';
import { useRunEvents } from '@/hooks/useRunEvents';
import { runsApi } from '@/lib/api';
import { qk } from '@/lib/query-client';
import { cn, formatUSD, formatDuration, formatRelative, prettyJSON, truncate } from '@/lib/utils';
import { toast } from 'sonner';
import type { RunState } from '@/lib/types';

const STATUS_VARIANT: Record<RunState['status'], 'default' | 'secondary' | 'success' | 'destructive' | 'warning' | 'muted'> = {
  starting: 'warning',
  running: 'default',
  completed: 'success',
  failed: 'destructive',
  aborted: 'muted',
};

export default function RunDetailPage() {
  const params = useParams<{ id: string }>();
  const runId = params?.id ?? '';

  const runQ = useQuery({
    queryKey: qk.runs.detail(runId),
    queryFn: ({ signal }) => runsApi.get(runId, signal),
    enabled: !!runId,
    refetchInterval: (q) => {
      const r = q.state.data?.run;
      if (r && (r.status === 'running' || r.status === 'starting')) return 2000;
      return false;
    },
  });

  const { events, status: streamStatus, error: streamError } = useRunEvents(runId);

  const run = runQ.data?.run;

  const handleAbort = async () => {
    try {
      await runsApi.abort(runId);
      toast.success('Abort signal sent.');
      void runQ.refetch();
    } catch (err) {
      toast.error('Abort failed', { description: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <AuthGuard>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Button asChild variant="ghost" size="sm">
              <Link href="/runs"><ArrowLeft className="h-4 w-4" /> Runs</Link>
            </Button>
            <h1 className="font-mono text-xl font-semibold text-fg">{truncate(runId, 16)}</h1>
            {run ? (
              <Badge variant={STATUS_VARIANT[run.status]} className="gap-1">
                {run.status === 'running' ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                {run.status}
              </Badge>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => runQ.refetch()}>
              <RefreshCw className={cn('h-3.5 w-3.5', runQ.isFetching && 'animate-spin')} />
              Refresh
            </Button>
            {run && (run.status === 'running' || run.status === 'starting') ? (
              <Button variant="destructive" size="sm" onClick={handleAbort}>
                <Octagon className="h-3.5 w-3.5" />
                Abort
              </Button>
            ) : null}
          </div>
        </div>

        {runQ.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : runQ.isError ? (
          <Card>
            <CardContent className="py-12 text-center text-sm text-error">
              {runQ.error instanceof Error ? runQ.error.message : 'Run not found.'}
            </CardContent>
          </Card>
        ) : run ? (
          <>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Goal</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-fg">{run.goal}</p>
              </CardContent>
            </Card>

            <div className="grid gap-3 md:grid-cols-4">
              <StatTile label="Iteration" value={String(run.iteration)} />
              <StatTile label="Cost" value={formatUSD(run.totalCostUsd)} accent="success" />
              <StatTile
                label="Duration"
                value={formatDuration((run.endedAt ?? Date.now()) - run.startedAt)}
                accent="primary"
              />
              <StatTile label="Started" value={formatRelative(run.startedAt)} />
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Token usage</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <TokenMeter
                  used={run.totalTokensIn + run.totalTokensOut}
                  total={Math.max(run.totalTokensIn + run.totalTokensOut, 1) * 2}
                  label="Total tokens (in + out)"
                />
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <div className="text-fg-subtle">In</div>
                    <div className="font-mono text-fg">{run.totalTokensIn.toLocaleString()}</div>
                  </div>
                  <div>
                    <div className="text-fg-subtle">Out</div>
                    <div className="font-mono text-fg">{run.totalTokensOut.toLocaleString()}</div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {run.error ? (
              <Card className="border-error/40">
                <CardContent className="py-3 text-sm text-error">
                  <span className="font-semibold">Error:</span> {run.error}
                </CardContent>
              </Card>
            ) : null}

            {run.result !== undefined ? (
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Result</CardTitle>
                </CardHeader>
                <CardContent>
                  <pre className="overflow-x-auto rounded-md border border-border bg-bg p-3 font-mono text-xs text-fg-muted">
                    {prettyJSON(run.result)}
                  </pre>
                </CardContent>
              </Card>
            ) : null}
          </>
        ) : null}

        <div>
          <div className="mb-2 flex items-center gap-2 text-xs text-fg-subtle">
            <span className="uppercase tracking-wider">Event stream</span>
            <Badge variant={streamStatus === 'open' ? 'success' : streamStatus === 'error' ? 'destructive' : 'muted'}>
              {streamStatus}
            </Badge>
            {streamError ? <span className="text-error">{streamError.message}</span> : null}
          </div>
          <EventStream events={events} live={streamStatus === 'open'} maxHeight="50vh" />
        </div>
      </div>
    </AuthGuard>
  );
}

function StatTile({ label, value, accent }: { label: string; value: string; accent?: 'primary' | 'secondary' | 'success' }) {
  const color = accent === 'primary' ? 'text-primary' : accent === 'secondary' ? 'text-secondary' : accent === 'success' ? 'text-success' : 'text-fg';
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-[10px] uppercase tracking-wider text-fg-subtle">{label}</div>
        <div className={cn('mt-1 font-mono text-lg font-semibold', color)}>{value}</div>
      </CardContent>
    </Card>
  );
}
