'use client';

import * as React from 'react';
import { Boxes, RefreshCw } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { AuthGuard } from '@/components/AuthGuard';
import { ProviderList } from '@/components/ProviderList';
import { qk } from '@/lib/query-client';

export default function ProvidersPage() {
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: qk.providers.all });
    void qc.invalidateQueries({ queryKey: ['auth'] });
  };

  return (
    <AuthGuard>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-fg">
              <Boxes className="h-6 w-6 text-primary" />
              Providers
            </h1>
            <p className="text-sm text-fg-muted">Configured LLM providers, their auth status, and availability.</p>
          </div>
          <Button variant="outline" size="sm" onClick={refresh}>
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </Button>
        </div>

        <ProviderList />

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">About provider auth</CardTitle>
            <CardDescription>How SANIX authenticates to each provider.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-fg-muted">
            <p>
              SANIX resolves provider credentials in this order: <span className="font-mono text-fg">$PROVIDER_API_KEY</span> env var →{' '}
              <span className="font-mono text-fg">$PROVIDER_KEY</span> → on-disk secrets file → OAuth tokens (for providers that support it).
            </p>
            <p>
              Local providers (Ollama, LM Studio) require no auth — they&apos;re marked <span className="text-success">available</span> if
              the server can reach their local port.
            </p>
          </CardContent>
        </Card>
      </div>
    </AuthGuard>
  );
}
