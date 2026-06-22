'use client';

import * as React from 'react';
import { CheckCircle2, Eye, EyeOff, RotateCcw, Save, Settings as SettingsIcon } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useSettings } from '@/lib/settings';
import { useQuery } from '@tanstack/react-query';
import { healthApi } from '@/lib/api';
import { qk } from '@/lib/query-client';
import { toast } from 'sonner';

export default function SettingsPage() {
  const {
    serverUrl,
    authToken,
    refreshIntervalMs,
    preferSSE,
    setServerUrl,
    setAuthToken,
    setRefreshIntervalMs,
    setPreferSSE,
    reset,
  } = useSettings();

  const [urlDraft, setUrlDraft] = React.useState(serverUrl);
  const [tokenDraft, setTokenDraft] = React.useState(authToken);
  const [showToken, setShowToken] = React.useState(false);

  const health = useQuery({
    queryKey: qk.health,
    queryFn: ({ signal }) => healthApi.get(signal),
    refetchInterval: 5_000,
    retry: 0,
  });

  const online = health.data?.status === 'ok';

  const saveConnection = () => {
    setServerUrl(urlDraft.trim());
    setAuthToken(tokenDraft.trim());
    toast.success('Settings saved.');
    setTimeout(() => health.refetch(), 200);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-fg">
          <SettingsIcon className="h-6 w-6 text-primary" />
          Settings
        </h1>
        <p className="text-sm text-fg-muted">Configure the SANIX dashboard connection.</p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-sm">Server connection</CardTitle>
              <CardDescription>Where the dashboard sends API requests.</CardDescription>
            </div>
            <Badge variant={online ? 'success' : 'destructive'} className="gap-1">
              {online ? <CheckCircle2 className="h-3 w-3" /> : null}
              {online ? 'Connected' : 'Disconnected'}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="server-url">Server URL</Label>
            <Input
              id="server-url"
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              placeholder="http://127.0.0.1:7331"
              className="font-mono text-xs"
            />
            <p className="text-xs text-fg-subtle">Default: <span className="font-mono">http://127.0.0.1:7331</span></p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="auth-token">Auth token (Bearer)</Label>
            <div className="flex items-center gap-2">
              <Input
                id="auth-token"
                type={showToken ? 'text' : 'password'}
                value={tokenDraft}
                onChange={(e) => setTokenDraft(e.target.value)}
                placeholder="Leave empty if server has no auth"
                className="font-mono text-xs"
              />
              <Button
                variant="outline"
                size="icon"
                onClick={() => setShowToken((v) => !v)}
                aria-label={showToken ? 'Hide token' : 'Show token'}
              >
                {showToken ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </Button>
            </div>
            <p className="text-xs text-fg-subtle">Sent as <span className="font-mono">Authorization: Bearer &lt;token&gt;</span></p>
          </div>

          <div className="flex items-center gap-2">
            <Button onClick={saveConnection}>
              <Save className="h-4 w-4" />
              Save & test
            </Button>
            <Button variant="outline" onClick={() => health.refetch()}>
              <RotateCcw className="h-3.5 w-3.5" />
              Re-test
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Live data preferences</CardTitle>
          <CardDescription>How the dashboard refreshes real-time data.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="refresh-interval">Refresh interval</Label>
            <Select
              value={String(refreshIntervalMs)}
              onValueChange={(v) => setRefreshIntervalMs(Number(v))}
            >
              <SelectTrigger id="refresh-interval"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="2000">2 seconds</SelectItem>
                <SelectItem value="5000">5 seconds (default)</SelectItem>
                <SelectItem value="10000">10 seconds</SelectItem>
                <SelectItem value="30000">30 seconds</SelectItem>
                <SelectItem value="0">Disabled</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between rounded-md border border-border p-3">
            <div>
              <Label htmlFor="prefer-sse" className="text-sm">Prefer SSE for run events</Label>
              <p className="text-xs text-fg-subtle">Stream run events live over Server-Sent Events instead of polling.</p>
            </div>
            <Switch id="prefer-sse" checked={preferSSE} onCheckedChange={setPreferSSE} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Reset</CardTitle>
          <CardDescription>Restore all dashboard settings to defaults.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="destructive"
            onClick={() => {
              reset();
              setUrlDraft('http://127.0.0.1:7331');
              setTokenDraft('');
              toast.success('Settings reset to defaults.');
            }}
          >
            <RotateCcw className="h-4 w-4" />
            Reset to defaults
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
