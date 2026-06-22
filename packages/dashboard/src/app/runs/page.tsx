'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { Activity, ArrowLeft, Loader2, Play } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { AuthGuard } from '@/components/AuthGuard';
import { runsApi } from '@/lib/api';
import { toast } from 'sonner';

export default function RunsPage() {
  const router = useRouter();
  const [goal, setGoal] = React.useState('');

  const startRun = useMutation({
    mutationFn: async (g: string) => runsApi.start({ goal: g }),
    onSuccess: (data) => {
      toast.success('Run started.');
      router.push(`/runs/${data.runId}`);
    },
    onError: (err: unknown) => {
      toast.error('Failed to start run', { description: err instanceof Error ? err.message : String(err) });
    },
  });

  return (
    <AuthGuard>
      <div className="space-y-6">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-fg">
            <Activity className="h-6 w-6 text-primary" />
            Runs
          </h1>
          <p className="text-sm text-fg-muted">Start a new agent run, or open an existing one to view its live event stream.</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Start a new run</CardTitle>
            <CardDescription>POST /v1/run — kicks off the SANIX agent loop with your goal.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="goal">Goal</Label>
              <Textarea
                id="goal"
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder="e.g. Refactor the auth module to use the new token store, then run all tests."
                rows={4}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    if (goal.trim() && !startRun.isPending) startRun.mutate(goal.trim());
                  }
                }}
              />
              <p className="text-xs text-fg-subtle">Tip: <kbd className="rounded border border-border bg-bg-subtle px-1.5 py-0.5 font-mono text-[10px]">⌘↵</kbd> to start.</p>
            </div>
            <Button
              onClick={() => startRun.mutate(goal.trim())}
              disabled={!goal.trim() || startRun.isPending}
            >
              {startRun.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              Start run
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Open existing run</CardTitle>
            <CardDescription>Have a run ID? Paste it below to view its detail page.</CardDescription>
          </CardHeader>
          <CardContent>
            <OpenRunForm />
          </CardContent>
        </Card>
      </div>
    </AuthGuard>
  );
}

function OpenRunForm() {
  const router = useRouter();
  const [id, setId] = React.useState('');
  return (
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (id.trim()) router.push(`/runs/${id.trim()}`);
      }}
    >
      <Input
        value={id}
        onChange={(e) => setId(e.target.value)}
        placeholder="Run ID (e.g. abc123XYZ)"
        className="flex-1 font-mono text-xs"
      />
      <Button type="submit" variant="outline" disabled={!id.trim()}>
        <ArrowLeft className="h-3.5 w-3.5 rotate-180" />
        Open
      </Button>
    </form>
  );
}
