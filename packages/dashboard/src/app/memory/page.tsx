'use client';

import * as React from 'react';
import { Brain, Plus } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { AuthGuard } from '@/components/AuthGuard';
import { MemoryList } from '@/components/MemoryList';
import { memoryApi } from '@/lib/api';
import { qk } from '@/lib/query-client';
import { toast } from 'sonner';

export default function MemoryPage() {
  const qc = useQueryClient();
  const [refreshKey, setRefreshKey] = React.useState(0);
  const [open, setOpen] = React.useState(false);

  return (
    <AuthGuard>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-fg">
              <Brain className="h-6 w-6 text-secondary" />
              Memory
            </h1>
            <p className="text-sm text-fg-muted">Browse, search, and delete facts stored in the SANIX memory router.</p>
          </div>
          <CreateMemoryDialog
            open={open}
            onOpenChange={setOpen}
            onCreated={() => {
              setRefreshKey((k) => k + 1);
              void qc.invalidateQueries({ queryKey: qk.memory.all });
            }}
          />
        </div>

        <MemoryList refreshKey={refreshKey} />
      </div>
    </AuthGuard>
  );
}

function CreateMemoryDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: () => void;
}) {
  const [content, setContent] = React.useState('');
  const [tier, setTier] = React.useState<string>('semantic');
  const [tags, setTags] = React.useState('');

  const mutation = useMutation({
    mutationFn: async () => {
      const tagList = tags.split(',').map((t) => t.trim()).filter(Boolean);
      await memoryApi.store({ content: content.trim(), tier, tags: tagList });
    },
    onSuccess: () => {
      toast.success('Memory stored.');
      setContent('');
      setTags('');
      onOpenChange(false);
      onCreated();
    },
    onError: (err: unknown) => {
      toast.error('Failed to store', { description: err instanceof Error ? err.message : String(err) });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button><Plus className="h-4 w-4" /> New memory</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Store a new memory</DialogTitle>
          <DialogDescription>POST /v1/memory — adds a fact to the memory router.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="content">Content</Label>
            <Textarea
              id="content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="The user prefers dark themes and concise answers."
              rows={4}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="tier">Tier</Label>
              <Select value={tier} onValueChange={setTier}>
                <SelectTrigger id="tier"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="working">Working</SelectItem>
                  <SelectItem value="episodic">Episodic</SelectItem>
                  <SelectItem value="semantic">Semantic</SelectItem>
                  <SelectItem value="procedural">Procedural</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tags">Tags (comma-separated)</Label>
              <Input id="tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="preference, theme" />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => mutation.mutate()} disabled={!content.trim() || mutation.isPending}>
            {mutation.isPending ? 'Storing…' : 'Store'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
