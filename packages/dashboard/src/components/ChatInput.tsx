'use client';

import * as React from 'react';
import { Paperclip, Send, Square, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn, formatBytes } from '@/lib/utils';

export interface ChatAttachment {
  name: string;
  size: number;
  type: string;
  dataUrl?: string;
}

interface ChatInputProps {
  onSubmit: (text: string, attachments: ChatAttachment[]) => void;
  onCancel?: () => void;
  isStreaming?: boolean;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}

/**
 * ChatInput — textarea with submit + file upload for multi-modal chat.
 *
 * Keyboard shortcuts:
 *   Enter          → newline
 *   Cmd/Ctrl+Enter → submit
 *   Shift+Enter    → newline
 */
export function ChatInput({
  onSubmit,
  onCancel,
  isStreaming = false,
  disabled = false,
  placeholder = 'Send a message…  (⌘↵ to send)',
  className,
}: ChatInputProps) {
  const [text, setText] = React.useState('');
  const [attachments, setAttachments] = React.useState<ChatAttachment[]>([]);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  // Auto-grow the textarea up to a max height.
  React.useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  const submit = () => {
    const trimmed = text.trim();
    if ((!trimmed && attachments.length === 0) || disabled) return;
    onSubmit(trimmed, attachments);
    setText('');
    setAttachments([]);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files) return;
    const next: ChatAttachment[] = [];
    for (const file of Array.from(files)) {
      const dataUrl = await new Promise<string | undefined>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : undefined);
        reader.onerror = () => resolve(undefined);
        reader.readAsDataURL(file);
      });
      next.push({ name: file.name, size: file.size, type: file.type, dataUrl });
    }
    setAttachments((prev) => [...prev, ...next]);
  };

  return (
    <div className={cn('rounded-lg border border-border bg-card', className)}>
      {attachments.length > 0 ? (
        <div className="flex flex-wrap gap-2 border-b border-border p-2">
          {attachments.map((a, i) => (
            <div key={i} className="flex items-center gap-2 rounded-md border border-border bg-bg px-2 py-1 text-xs">
              <Paperclip className="h-3 w-3 text-fg-subtle" />
              <span className="max-w-32 truncate text-fg">{a.name}</span>
              <span className="text-fg-subtle">{formatBytes(a.size)}</span>
              <button
                type="button"
                onClick={() => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
                className="text-fg-subtle hover:text-error"
                aria-label={`Remove ${a.name}`}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="flex items-end gap-2 p-2">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            void handleFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-9 w-9 shrink-0"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled}
          aria-label="Attach files"
          title="Attach files"
        >
          <Paperclip className="h-4 w-4" />
        </Button>

        <Textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          className="min-h-[40px] flex-1 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
          aria-label="Chat message"
        />

        {isStreaming && onCancel ? (
          <Button
            type="button"
            variant="destructive"
            size="icon"
            className="h-9 w-9 shrink-0"
            onClick={onCancel}
            aria-label="Stop generation"
            title="Stop"
          >
            <Square className="h-4 w-4 fill-current" />
          </Button>
        ) : (
          <Button
            type="button"
            size="icon"
            className="h-9 w-9 shrink-0"
            onClick={submit}
            disabled={disabled || (!text.trim() && attachments.length === 0)}
            aria-label="Send message"
            title="Send (⌘↵)"
          >
            <Send className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
