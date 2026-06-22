'use client';

import * as React from 'react';
import { cn, formatTime, prettyJSON, truncate } from '@/lib/utils';
import type { RunEvent, RunEventType } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Filter } from 'lucide-react';

const EVENT_VARIANT: Partial<Record<RunEventType, 'default' | 'secondary' | 'success' | 'destructive' | 'warning' | 'muted'>> = {
  ready: 'muted',
  'iteration:before': 'secondary',
  'iteration:after': 'secondary',
  'plan:created': 'default',
  'task:started': 'default',
  'task:completed': 'success',
  'task:failed': 'destructive',
  'tool:before': 'secondary',
  'tool:after': 'success',
  'llm:before': 'secondary',
  'llm:after': 'default',
  'cost:recorded': 'warning',
  'subagent:spawn': 'default',
  'subagent:complete': 'success',
  progress: 'default',
  status: 'muted',
  complete: 'success',
  aborted: 'muted',
  error: 'destructive',
  done: 'muted',
};

interface EventStreamProps {
  events: RunEvent[];
  live?: boolean;
  className?: string;
  maxHeight?: string;
}

/**
 * EventStream — live SSE event feed with filtering.
 * Shows a colored badge per event type + collapsible JSON data.
 */
export function EventStream({ events, live = false, className, maxHeight = '60vh' }: EventStreamProps) {
  const [filter, setFilter] = React.useState<'all' | 'errors' | 'tools' | 'llm' | 'plan'>('all');
  const [search, setSearch] = React.useState('');

  const filtered = React.useMemo(() => {
    let out = events;
    if (filter === 'errors') out = out.filter((e) => e.type === 'error' || e.type === 'task:failed' || e.type === 'aborted');
    else if (filter === 'tools') out = out.filter((e) => e.type.startsWith('tool:'));
    else if (filter === 'llm') out = out.filter((e) => e.type.startsWith('llm:') || e.type === 'cost:recorded');
    else if (filter === 'plan') out = out.filter((e) => e.type.startsWith('plan:') || e.type.startsWith('task:') || e.type.startsWith('iteration:'));
    if (search.trim()) {
      const q = search.toLowerCase();
      out = out.filter((e) => e.type.toLowerCase().includes(q) || JSON.stringify(e.data).toLowerCase().includes(q));
    }
    return out;
  }, [events, filter, search]);

  return (
    <div className={cn('flex flex-col rounded-lg border border-border bg-card', className)}>
      <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
        <div className="flex items-center gap-2 text-sm font-medium text-fg">
          {live ? (
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
            </span>
          ) : null}
          Events
          <Badge variant="muted" className="ml-1 tabular-nums">{filtered.length}</Badge>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <Filter className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-fg-subtle" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search events…"
              className="h-8 w-40 pl-7 text-xs md:w-56"
            />
          </div>
          <Select value={filter} onValueChange={(v) => setFilter(v as typeof filter)}>
            <SelectTrigger className="h-8 w-32 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="errors">Errors</SelectItem>
              <SelectItem value="plan">Plan / Tasks</SelectItem>
              <SelectItem value="tools">Tools</SelectItem>
              <SelectItem value="llm">LLM / Cost</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <ScrollArea className="flex-1" style={{ maxHeight }}>
        <div className="divide-y divide-border">
          {filtered.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-fg-subtle">No events match your filter.</div>
          ) : (
            filtered.map((e, i) => <EventRow key={`${e.timestamp}-${i}`} event={e} />)
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function EventRow({ event }: { event: RunEvent }) {
  const [expanded, setExpanded] = React.useState(false);
  const variant = EVENT_VARIANT[event.type] ?? 'muted';
  const dataStr = prettyJSON(event.data);

  return (
    <button
      type="button"
      onClick={() => setExpanded((v) => !v)}
      className="flex w-full items-start gap-3 px-3 py-2 text-left text-xs transition-colors hover:bg-bg-subtle/50"
    >
      <span className="mt-0.5 font-mono text-fg-subtle tabular-nums">{formatTime(event.timestamp)}</span>
      <Badge variant={variant} className="shrink-0 font-mono text-[10px]">
        {truncate(event.type, 22)}
      </Badge>
      <span className="min-w-0 flex-1 break-words text-fg-muted">
        {expanded ? (
          <pre className="mt-1 overflow-x-auto rounded bg-bg p-2 font-mono text-[11px] text-fg">{dataStr}</pre>
        ) : (
          <span className="line-clamp-1">{dataStr.replace(/\s+/g, ' ')}</span>
        )}
      </span>
    </button>
  );
}
