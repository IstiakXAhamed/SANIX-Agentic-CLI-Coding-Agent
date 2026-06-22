'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { healthApi } from '@/lib/api';
import { qk } from '@/lib/query-client';
import { useSettings } from '@/lib/settings';

/**
 * AuthGuard — wraps any page that requires a working server connection
 * (+ optional Bearer token). Renders children only after a successful
 * `/health` probe; otherwise shows a setup screen with a token prompt.
 */
export function AuthGuard({ children }: { children: React.ReactNode }) {
  const { serverUrl, authToken, setAuthToken } = useSettings();
  const [tokenDraft, setTokenDraft] = React.useState(authToken);
  const [showTokenInput, setShowTokenInput] = React.useState(false);

  const health = useQuery({
    queryKey: qk.health,
    queryFn: ({ signal }) => healthApi.get(signal),
    refetchInterval: 10_000,
    retry: 1,
  });

  // Loading
  if (health.isLoading && !health.data) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-fg-muted">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-primary" />
          <p className="text-sm">Connecting to SANIX server…</p>
          <p className="text-xs text-fg-subtle">{serverUrl}</p>
        </div>
      </div>
    );
  }

  // OK
  if (health.data && health.data.status === 'ok') {
    return <>{children}</>;
  }

  // 401 → token prompt
  const isUnauthorized =
    health.isError &&
    health.error &&
    typeof health.error === 'object' &&
    'status' in health.error &&
    (health.error as { status: number }).status === 401;

  // Other errors (server unreachable, 5xx, etc.)
  const errMsg = health.error instanceof Error ? health.error.message : 'Unknown error';

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-error/15">
            {isUnauthorized ? <Lock className="h-6 w-6 text-error" /> : <AlertCircle className="h-6 w-6 text-error" />}
          </div>
          <CardTitle>{isUnauthorized ? 'Authentication required' : 'Cannot reach SANIX server'}</CardTitle>
          <CardDescription>
            {isUnauthorized
              ? 'The server requires a Bearer token. Set it below to continue.'
              : `Make sure \`sanix serve\` is running at ${serverUrl}.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {isUnauthorized || showTokenInput ? (
            <div className="space-y-2">
              <Label htmlFor="token">Auth token</Label>
              <Input
                id="token"
                type="password"
                value={tokenDraft}
                onChange={(e) => setTokenDraft(e.target.value)}
                placeholder="Paste your SANIX bearer token"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && tokenDraft.trim()) {
                    setAuthToken(tokenDraft.trim());
                    health.refetch();
                  }
                }}
              />
              <Button
                className="w-full"
                onClick={() => {
                  setAuthToken(tokenDraft.trim());
                  health.refetch();
                }}
                disabled={!tokenDraft.trim()}
              >
                Save & connect
              </Button>
            </div>
          ) : (
            <div className="space-y-3 text-sm">
              <p className="text-fg-muted">
                Error: <span className="font-mono text-error">{errMsg}</span>
              </p>
              <Button variant="outline" className="w-full" onClick={() => setShowTokenInput(true)}>
                <Lock className="h-4 w-4" />
                Set auth token
              </Button>
              <Button variant="ghost" className="w-full" onClick={() => health.refetch()}>
                Retry connection
              </Button>
              <p className="text-center text-xs text-fg-subtle">
                Tip: visit <span className="text-primary">Settings</span> to change the server URL.
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
