'use client';

import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { Eraser, MessageSquare, Sparkles, Zap } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { AuthGuard } from '@/components/AuthGuard';
import { ChatMessage } from '@/components/ChatMessage';
import { ChatInput, type ChatAttachment } from '@/components/ChatInput';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { chatApi } from '@/lib/api';
import { useSettings } from '@/lib/settings';
import { prettyJSON } from '@/lib/utils';
import { toast } from 'sonner';
import type { ChatMessage as ChatMessageType, ChatResponse } from '@/lib/types';

interface ConversationMessage extends ChatMessageType {
  timestamp: number;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  model?: string;
}

export default function ChatPage() {
  const { serverUrl, authToken } = useSettings();
  const [messages, setMessages] = React.useState<ConversationMessage[]>([]);
  const [provider, setProvider] = React.useState<string>('');
  const [maxTokens, setMaxTokens] = React.useState<string>('4096');
  const [temperature, setTemperature] = React.useState<string>('0.7');
  const scrollRef = React.useRef<HTMLDivElement>(null);

  const abortRef = React.useRef<AbortController | null>(null);

  const sendMutation = useMutation({
    mutationFn: async ({
      text,
      attachments,
    }: {
      text: string;
      attachments: ChatAttachment[];
    }) => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      const userMsg: ConversationMessage = {
        role: 'user',
        content: text + (attachments.length > 0
          ? `\n\n[Attached: ${attachments.map((a) => a.name).join(', ')}]`
          : ''),
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, userMsg]);

      const apiMessages: ChatMessageType[] = [
        {
          role: 'system',
          content:
            'You are SANIX, an agentic neural intelligence executor. Be concise and precise. Use markdown when useful.',
        },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
        { role: 'user', content: userMsg.content },
      ];

      const res = await chatApi.send(
        {
          messages: apiMessages,
          provider: provider || undefined,
          maxTokens: maxTokens ? Number(maxTokens) : undefined,
          temperature: temperature ? Number(temperature) : undefined,
        },
        ctrl.signal,
      );
      return res;
    },
    onSuccess: (data: ChatResponse) => {
      const r = data.response;
      const content =
        typeof r.content === 'string'
          ? r.content
          : prettyJSON(r.content ?? '');
      const assistant: ConversationMessage = {
        role: 'assistant',
        content: content || '(no response)',
        timestamp: Date.now(),
        model: r.model,
        usage: r.usage
          ? {
              inputTokens: r.usage.inputTokens,
              outputTokens: r.usage.outputTokens,
              totalTokens: r.usage.totalTokens,
            }
          : undefined,
      };
      setMessages((prev) => [...prev, assistant]);
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (err instanceof Error && err.name === 'AbortError') return;
      toast.error('Chat failed', { description: msg });
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: `⚠️ Error: ${msg}`,
          timestamp: Date.now(),
        },
      ]);
    },
  });

  React.useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length, sendMutation.isPending]);

  const isStreaming = sendMutation.isPending;

  return (
    <AuthGuard>
      <div className="flex h-[calc(100vh-9rem)] flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-fg">
              <MessageSquare className="h-6 w-6 text-primary" />
              Chat
            </h1>
            <p className="text-sm text-fg-muted">Single-turn LLM conversation via /v1/chat.</p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setMessages([])} disabled={messages.length === 0}>
            <Eraser className="h-3.5 w-3.5" />
            Clear
          </Button>
        </div>

        <div className="grid flex-1 gap-4 lg:grid-cols-[1fr_240px]">
          <Card className="flex flex-col">
            <ScrollArea className="flex-1" style={{ maxHeight: 'calc(100vh - 18rem)' }}>
              <div ref={scrollRef} className="min-h-full p-4">
                {messages.length === 0 ? (
                  <div className="flex h-full flex-col items-center justify-center gap-3 py-16 text-center">
                    <Sparkles className="h-10 w-10 text-primary opacity-50" />
                    <p className="text-sm text-fg-muted">Send a message to start the conversation.</p>
                    <p className="text-xs text-fg-subtle">
                      Tip: <kbd className="rounded border border-border bg-bg-subtle px-1.5 py-0.5 font-mono text-[10px]">⌘↵</kbd> to send
                    </p>
                  </div>
                ) : (
                  messages.map((m, i) => <ChatMessage key={i} message={m} timestamp={m.timestamp} usage={m.usage} />)
                )}
              </div>
            </ScrollArea>
            <div className="border-t border-border p-3">
              <ChatInput
                onSubmit={(text, atts) => sendMutation.mutate({ text, attachments: atts })}
                onCancel={() => abortRef.current?.abort()}
                isStreaming={isStreaming}
                placeholder="Ask SANIX anything…  (⌘↵ to send)"
              />
            </div>
          </Card>

          <Card className="hidden flex-col lg:flex">
            <CardContent className="space-y-3 p-4">
              <div className="flex items-center gap-2 text-sm font-medium text-fg">
                <Zap className="h-4 w-4 text-secondary" />
                Parameters
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="provider" className="text-xs">Provider</Label>
                <Input id="provider" value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="auto" className="h-8 text-xs" />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="maxTokens" className="text-xs">Max tokens</Label>
                <Input id="maxTokens" type="number" value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} className="h-8 text-xs" />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="temperature" className="text-xs">Temperature</Label>
                <Input id="temperature" type="number" step="0.1" min="0" max="2" value={temperature} onChange={(e) => setTemperature(e.target.value)} className="h-8 text-xs" />
              </div>

              <div className="space-y-1.5 border-t border-border pt-3">
                <div className="text-[10px] uppercase tracking-wider text-fg-subtle">Connection</div>
                <div className="font-mono text-[10px] text-fg-muted">{serverUrl}</div>
                <Badge variant={authToken ? 'success' : 'muted'} className="text-[10px]">
                  {authToken ? 'Token set' : 'No token'}
                </Badge>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </AuthGuard>
  );
}
