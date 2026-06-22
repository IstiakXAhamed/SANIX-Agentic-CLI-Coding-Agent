'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Copy, RefreshCw, Sliders } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { AuthGuard } from '@/components/AuthGuard';
import { configApi } from '@/lib/api';
import { qk } from '@/lib/query-client';
import { prettyJSON } from '@/lib/utils';
import { toast } from 'sonner';

export default function ConfigPage() {
  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: qk.config.all,
    queryFn: ({ signal }) => configApi.get(signal),
    refetchInterval: 60_000,
  });

  const configStr = prettyJSON(data?.config ?? {});
  const redactedCount = React.useMemo(() => {
    const m = configStr.match(/<redacted>/g);
    return m ? m.length : 0;
  }, [configStr]);

  return (
    <AuthGuard>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-fg">
              <Sliders className="h-6 w-6 text-primary" />
              Config
            </h1>
            <p className="text-sm text-fg-muted">Live SANIX server configuration (secrets already redacted).</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            <RefreshCw className={isFetching ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
            Refresh
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="warning" className="gap-1">
            {redactedCount} redacted
          </Badge>
          <Badge variant="muted">GET /v1/config</Badge>
        </div>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm">Server configuration</CardTitle>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  navigator.clipboard.writeText(configStr);
                  toast.success('Copied to clipboard.');
                }}
              >
                <Copy className="h-3.5 w-3.5" />
                Copy
              </Button>
            </div>
            <CardDescription>Secrets are redacted server-side via the <code className="font-mono text-fg-muted">redactSecrets()</code> helper.</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-64 w-full" />
            ) : (
              <pre className="max-h-[60vh] overflow-auto rounded-md border border-border bg-bg p-4 font-mono text-xs leading-relaxed text-fg-muted">
                {configStr}
              </pre>
            )}
          </CardContent>
        </Card>
      </div>
    </AuthGuard>
  );
}
