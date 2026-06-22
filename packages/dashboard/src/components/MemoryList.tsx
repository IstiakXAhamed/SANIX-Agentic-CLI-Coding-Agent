'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Brain, Clock, Hash, Search, Tag, Trash2 } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { memoryApi } from '@/lib/api';
import { qk } from '@/lib/query-client';
import { cn, formatRelative, formatDateTime, prettyJSON, truncate } from '@/lib/utils';
import { toast } from 'sonner';
import type { MemoryItem } from '@/lib/types';

interface MemoryListProps {
  /** Trigger a refetch when this changes (e.g. after delete). */
  refreshKey?: number;
  onSelect?: (item: MemoryItem) => void;
}

const TIER_COLORS: Record<string, 'default' | 'secondary' | 'success' | 'warning' | 'muted'> = {
  working: 'warning',
  episodic: 'default',
  semantic: 'success',
  procedural: 'secondary',
};

export function MemoryList({ refreshKey = 0, onSelect }: MemoryListProps) {
  const [search, setSearch] = React.useState('');
  const [tier, setTier] = React.useState<string>('all');
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const debouncedSearch = useDebouncedValue(search, 300);

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: qk.memory.list(debouncedSearch, tier),
    queryFn: ({ signal }) =>
      memoryApi.list(
        { query: debouncedSearch || undefined, tier: tier === 'all' ? undefined : tier },
        signal,
      ),
    refetchInterval: 15_000,
  });

  React.useEffect(() => {
    void refetch();
  }, [refreshKey, refetch]);

  const memories = data?.memories ?? [];
  const selected = memories.find((m) => (m.id ?? '') === selectedId) ?? null;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_1.4fr]">
      {/* List */}
      <Card className="flex flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-subtle" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search memories…"
              className="h-8 pl-7 text-xs"
            />
          </div>
          <Select value={tier} onValueChange={setTier}>
            <SelectTrigger className="h-8 w-32 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All tiers</SelectItem>
              <SelectItem value="working">Working</SelectItem>
              <SelectItem value="episodic">Episodic</SelectItem>
              <SelectItem value="semantic">Semantic</SelectItem>
              <SelectItem value="procedural">Procedural</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <ScrollArea className="max-h-[70vh] flex-1">
          {isLoading ? (
            <div className="space-y-2 p-3">
              {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}
            </div>
          ) : memories.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 py-12 text-center text-sm text-fg-subtle">
              <Brain className="h-8 w-8 opacity-40" />
              No memories found.
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {memories.map((m, i) => {
                const id = m.id ?? `idx-${i}`;
                const isSelected = selectedId === id;
                return (
                  <li key={id}>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedId(id);
                        onSelect?.(m);
                      }}
                      className={cn(
                        'flex w-full flex-col gap-1 px-3 py-2.5 text-left transition-colors',
                        isSelected ? 'bg-primary/10' : 'hover:bg-bg-subtle/50',
                      )}
                    >
                      <div className="flex items-center gap-2">
                        {m.tier ? (
                          <Badge variant={TIER_COLORS[m.tier] ?? 'muted'} className="text-[10px]">
                            {m.tier}
                          </Badge>
                        ) : null}
                        {typeof m.score === 'number' ? (
                          <span className="text-[10px] text-fg-subtle">score {m.score.toFixed(2)}</span>
                        ) : null}
                        <span className="ml-auto text-[10px] text-fg-subtle">
                          {m.createdAt ? formatRelative(m.createdAt) : ''}
                        </span>
                      </div>
                      <p className="line-clamp-2 text-xs text-fg">
                        {m.content ?? m.text ?? truncate(prettyJSON(m), 120)}
                      </p>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {isFetching ? <div className="px-3 py-1 text-center text-[10px] text-fg-subtle">Refreshing…</div> : null}
        </ScrollArea>
      </Card>

      {/* Detail */}
      <Card className="flex flex-col">
        {selected ? (
          <DetailView
            item={selected}
            onDeleted={() => {
              setSelectedId(null);
              void refetch();
            }}
          />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-sm text-fg-subtle">
            <Brain className="h-10 w-10 opacity-30" />
            Select a memory to view its full content.
          </div>
        )}
      </Card>
    </div>
  );
}

function DetailView({ item, onDeleted }: { item: MemoryItem; onDeleted: () => void }) {
  const [deleting, setDeleting] = React.useState(false);

  const handleDelete = async () => {
    if (!item.id) {
      toast.error('This memory has no ID — cannot delete.');
      return;
    }
    setDeleting(true);
    try {
      await memoryApi.delete(item.id);
      toast.success('Memory deleted.');
      onDeleted();
    } catch (err) {
      toast.error('Delete failed', { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <div className="flex items-center justify-between gap-2 border-b border-border p-4">
        <div className="flex items-center gap-2">
          {item.tier ? <Badge variant={TIER_COLORS[item.tier] ?? 'muted'}>{item.tier}</Badge> : null}
          {item.id ? <span className="font-mono text-xs text-fg-subtle">{truncate(item.id, 16)}</span> : null}
        </div>
        <Button variant="destructive" size="sm" onClick={handleDelete} disabled={deleting || !item.id}>
          <Trash2 className="h-3.5 w-3.5" />
          {deleting ? 'Deleting…' : 'Delete'}
        </Button>
      </div>
      <ScrollArea className="flex-1" style={{ maxHeight: '70vh' }}>
        <div className="space-y-4 p-4 text-sm">
          <div>
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-fg-subtle">Content</h3>
            <p className="whitespace-pre-wrap break-words text-fg">{item.content ?? item.text ?? prettyJSON(item)}</p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {typeof item.score === 'number' ? (
              <Detail icon={<Hash className="h-3 w-3" />} label="Score" value={item.score.toFixed(3)} />
            ) : null}
            {typeof item.importance === 'number' ? (
              <Detail icon={<Hash className="h-3 w-3" />} label="Importance" value={item.importance.toFixed(3)} />
            ) : null}
            {item.createdAt ? (
              <Detail icon={<Clock className="h-3 w-3" />} label="Created" value={formatDateTime(item.createdAt)} />
            ) : null}
            {item.tier ? <Detail icon={<Brain className="h-3 w-3" />} label="Tier" value={item.tier} /> : null}
          </div>

          {item.tags && item.tags.length > 0 ? (
            <div>
              <h3 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-fg-subtle">
                <Tag className="h-3 w-3" /> Tags
              </h3>
              <div className="flex flex-wrap gap-1">
                {item.tags.map((t, i) => (
                  <Badge key={i} variant="muted" className="text-[10px]">{t}</Badge>
                ))}
              </div>
            </div>
          ) : null}

          {item.metadata && Object.keys(item.metadata).length > 0 ? (
            <div>
              <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-fg-subtle">Metadata</h3>
              <pre className="overflow-x-auto rounded-md border border-border bg-bg p-3 font-mono text-xs text-fg-muted">
                {prettyJSON(item.metadata)}
              </pre>
            </div>
          ) : null}
        </div>
      </ScrollArea>
    </>
  );
}

function Detail({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-bg-subtle/50 px-3 py-2">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-fg-subtle">
        {icon}
        {label}
      </div>
      <div className="mt-0.5 font-mono text-xs text-fg">{value}</div>
    </div>
  );
}

/** Tiny debounce hook. */
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}
