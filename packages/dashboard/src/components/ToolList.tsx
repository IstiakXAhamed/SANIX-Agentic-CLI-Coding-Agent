'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Play, Shield, Wrench } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { toolsApi } from '@/lib/api';
import { qk } from '@/lib/query-client';
import { truncate, prettyJSON } from '@/lib/utils';
import { toast } from 'sonner';
import type { ToolDef } from '@/lib/types';

export function ToolList() {
  const { data, isLoading } = useQuery({
    queryKey: qk.tools.all,
    queryFn: ({ signal }) => toolsApi.list(signal),
    refetchInterval: 30_000,
  });

  const [search, setSearch] = React.useState('');
  const [executeTool, setExecuteTool] = React.useState<ToolDef | null>(null);

  const tools = (data?.tools ?? []).filter((t) =>
    !search.trim() ? true : t.name.toLowerCase().includes(search.toLowerCase()) || t.description.toLowerCase().includes(search.toLowerCase()),
  );

  if (isLoading) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-40 w-full" />)}
      </div>
    );
  }

  return (
    <>
      <Input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Filter tools by name or description…"
        className="mb-3"
      />
      {tools.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-12 text-center text-sm text-fg-subtle">
          <Wrench className="h-8 w-8 opacity-40" />
          No tools registered.
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {tools.map((t) => (
            <ToolCard key={t.name} tool={t} onExecute={() => setExecuteTool(t)} />
          ))}
        </div>
      )}

      {executeTool ? (
        <ExecuteDialog tool={executeTool} onClose={() => setExecuteTool(null)} />
      ) : null}
    </>
  );
}

function ToolCard({ tool, onExecute }: { tool: ToolDef; onExecute: () => void }) {
  return (
    <Card className="flex flex-col transition-colors hover:border-primary/40">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10">
              <Wrench className="h-4 w-4 text-primary" />
            </div>
            <CardTitle className="font-mono text-sm">{tool.name}</CardTitle>
          </div>
          {tool.permissions && tool.permissions.length > 0 ? (
            <Badge variant="warning" className="gap-1 text-[10px]">
              <Shield className="h-2.5 w-2.5" />
              {tool.permissions.length}
            </Badge>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        <p className="line-clamp-3 flex-1 text-xs text-fg-muted">{tool.description}</p>
        {tool.permissions && tool.permissions.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {tool.permissions.slice(0, 4).map((p) => (
              <Badge key={p} variant="muted" className="text-[10px]">{p}</Badge>
            ))}
            {tool.permissions.length > 4 ? (
              <Badge variant="muted" className="text-[10px]">+{tool.permissions.length - 4}</Badge>
            ) : null}
          </div>
        ) : null}
        <Button size="sm" variant="outline" onClick={onExecute} className="mt-auto w-full">
          <Play className="h-3.5 w-3.5" />
          Execute
        </Button>
      </CardContent>
    </Card>
  );
}

function ExecuteDialog({ tool, onClose }: { tool: ToolDef; onClose: () => void }) {
  const qc = useQueryClient();
  const [inputText, setInputText] = React.useState('{\n  \n}');

  const mutation = useMutation({
    mutationFn: async () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(inputText);
      } catch {
        throw new Error('Input must be valid JSON.');
      }
      return toolsApi.execute(tool.name, { input: parsed as Record<string, unknown> });
    },
    onSuccess: (data) => {
      toast.success('Tool executed.');
      void qc.invalidateQueries({ queryKey: qk.tools.all });
      setResult(data.result);
    },
    onError: (err: unknown) => {
      toast.error('Execute failed', { description: err instanceof Error ? err.message : String(err) });
    },
  });

  const [result, setResult] = React.useState<unknown>(undefined);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-mono">{tool.name}</DialogTitle>
          <DialogDescription>{truncate(tool.description, 160)}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label htmlFor="tool-input">Input (JSON)</Label>
            <Textarea
              id="tool-input"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              rows={8}
              className="mt-1.5 font-mono text-xs"
            />
          </div>

          {result !== undefined ? (
            <div>
              <Label>Result</Label>
              <pre className="mt-1.5 max-h-60 overflow-auto rounded-md border border-border bg-bg p-3 font-mono text-xs text-fg-muted">
                {prettyJSON(result)}
              </pre>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            {mutation.isPending ? 'Running…' : 'Run tool'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
