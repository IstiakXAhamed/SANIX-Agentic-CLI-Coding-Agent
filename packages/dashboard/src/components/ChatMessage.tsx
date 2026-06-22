'use client';

import * as React from 'react';
import { cn, prettyJSON } from '@/lib/utils';
import type { ChatMessage } from '@/lib/types';
import { Bot, User, Wrench } from 'lucide-react';

interface ChatMessageBubbleProps {
  message: ChatMessage;
  /** Optional timestamp (ms). */
  timestamp?: number;
  /** Token usage for assistant messages. */
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

/**
 * ChatMessage — message bubble with role-based styling.
 * - user: right-aligned, primary border
 * - assistant: left-aligned, card bg, optional usage footer
 * - system: centered, muted bg
 * - tool: monospace, with Wrench icon
 */
export function ChatMessage({ message, timestamp, usage }: ChatMessageBubbleProps) {
  const content = typeof message.content === 'string'
    ? message.content
    : prettyJSON(message.content);

  if (message.role === 'system') {
    return (
      <div className="my-2 flex justify-center">
        <div className="max-w-2xl rounded-md border border-border bg-bg-subtle/50 px-3 py-1.5 text-center text-xs text-fg-muted">
          <span className="font-semibold uppercase tracking-wider text-fg-subtle">system</span>
          <span className="ml-2">{content}</span>
        </div>
      </div>
    );
  }

  if (message.role === 'tool') {
    return (
      <div className="my-2 flex justify-start">
        <div className="max-w-2xl rounded-md border border-border bg-bg px-3 py-2">
          <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-fg-subtle">
            <Wrench className="h-3 w-3" /> tool {message.name ? `· ${message.name}` : ''}
          </div>
          <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs text-fg-muted">{content}</pre>
        </div>
      </div>
    );
  }

  const isUser = message.role === 'user';
  const Icon = isUser ? User : Bot;

  return (
    <div className={cn('my-2 flex gap-3', isUser ? 'justify-end' : 'justify-start')}>
      {!isUser ? (
        <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-primary/30 bg-primary/10">
          <Icon className="h-3.5 w-3.5 text-primary" />
        </div>
      ) : null}
      <div
        className={cn(
          'max-w-[80%] rounded-lg px-4 py-2.5 text-sm',
          isUser
            ? 'border border-primary/30 bg-primary/10 text-fg'
            : 'border border-border bg-card text-fg',
        )}
      >
        <div className="mb-0.5 flex items-center gap-2 text-[10px] uppercase tracking-wider text-fg-subtle">
          {isUser ? 'You' : 'Assistant'}
          {timestamp ? <span className="tabular-nums">{new Date(timestamp).toLocaleTimeString('en-US', { hour12: false })}</span> : null}
        </div>
        <div className="whitespace-pre-wrap break-words">{content}</div>
        {!isUser && usage ? (
          <div className="mt-2 flex items-center gap-3 border-t border-border pt-1.5 text-[10px] text-fg-subtle">
            {typeof usage.inputTokens === 'number' ? <span>↑ {usage.inputTokens}</span> : null}
            {typeof usage.outputTokens === 'number' ? <span>↓ {usage.outputTokens}</span> : null}
            {typeof usage.totalTokens === 'number' ? <span>Σ {usage.totalTokens}</span> : null}
          </div>
        ) : null}
      </div>
      {isUser ? (
        <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-secondary/30 bg-secondary/10">
          <Icon className="h-3.5 w-3.5 text-secondary" />
        </div>
      ) : null}
    </div>
  );
}
