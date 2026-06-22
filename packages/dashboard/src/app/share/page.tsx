'use client';

import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { Copy, ExternalLink, Paperclip, Share2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { AuthGuard } from '@/components/AuthGuard';
import { shareApi } from '@/lib/api';
import { formatBytes } from '@/lib/utils';
import { toast } from 'sonner';
import type { ShareResponse } from '@/lib/types';

const PROVIDERS = ['gist', 'transfer.sh', '0x0.st', 'paste.rs', 'nullx', 'file'];

export default function SharePage() {
  const [content, setContent] = React.useState('');
  const [fileName, setFileName] = React.useState('');
  const [provider, setProvider] = React.useState<string>('gist');
  const [password, setPassword] = React.useState('');
  const [expiresIn, setExpiresIn] = React.useState<string>('3600');
  const [file, setFile] = React.useState<File | null>(null);
  const [result, setResult] = React.useState<ShareResponse['share'] | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      const req: Record<string, unknown> = { provider };
      if (expiresIn) req.expiresIn = Number(expiresIn);
      if (password) req.password = password;
      if (file) {
        req.filePath = file.name;
        req.fileName = file.name;
        req.fileSize = file.size;
        req.fileType = file.type;
        const text = await file.text();
        req.content = text;
      } else if (content) {
        req.content = content;
        if (fileName) req.filePath = fileName;
      }
      return shareApi.share(req);
    },
    onSuccess: (data) => {
      setResult(data.share);
      toast.success('Shared!');
    },
    onError: (err: unknown) => {
      toast.error('Share failed', { description: err instanceof Error ? err.message : String(err) });
    },
  });

  return (
    <AuthGuard>
      <div className="space-y-6">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-fg">
            <Share2 className="h-6 w-6 text-primary" />
            Share
          </h1>
          <p className="text-sm text-fg-muted">Upload a file or text snippet and get a shareable link via /v1/share.</p>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Content</CardTitle>
              <CardDescription>Upload a file or paste text to share.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="file">File (optional)</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="file"
                    type="file"
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                    className="text-xs"
                  />
                  {file ? (
                    <Badge variant="muted" className="shrink-0">
                      {formatBytes(file.size)}
                    </Badge>
                  ) : null}
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="content">Or paste text</Label>
                <Textarea
                  id="content"
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder="Paste text content to share…"
                  rows={6}
                  disabled={!!file}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="filename">File name (for text content)</Label>
                <Input
                  id="filename"
                  value={fileName}
                  onChange={(e) => setFileName(e.target.value)}
                  placeholder="snippet.txt"
                  disabled={!!file}
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Options</CardTitle>
              <CardDescription>Provider and access controls.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="provider">Provider</Label>
                <Select value={provider} onValueChange={setProvider}>
                  <SelectTrigger id="provider"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PROVIDERS.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="expires">Expires in (seconds)</Label>
                <Input
                  id="expires"
                  type="number"
                  value={expiresIn}
                  onChange={(e) => setExpiresIn(e.target.value)}
                  placeholder="3600"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="password">Password (optional)</Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Leave empty for no password"
                />
              </div>

              <Button
                className="w-full"
                onClick={() => mutation.mutate()}
                disabled={mutation.isPending || (!file && !content.trim())}
              >
                <Paperclip className="h-4 w-4" />
                {mutation.isPending ? 'Sharing…' : 'Share'}
              </Button>
            </CardContent>
          </Card>
        </div>

        {result ? (
          <Card className="border-success/40">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm text-success">
                <Share2 className="h-4 w-4" />
                Shared successfully
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {result.url ? (
                <div className="space-y-1.5">
                  <Label>URL</Label>
                  <div className="flex items-center gap-2">
                    <Input value={result.url} readOnly className="font-mono text-xs" />
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => {
                        navigator.clipboard.writeText(result.url ?? '');
                        toast.success('URL copied.');
                      }}
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                    <Button asChild variant="outline" size="icon">
                      <a href={result.url} target="_blank" rel="noreferrer">
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    </Button>
                  </div>
                </div>
              ) : null}
              {result.id ? (
                <div className="text-xs text-fg-muted">
                  <span className="text-fg-subtle">ID:</span> <span className="font-mono">{result.id}</span>
                </div>
              ) : null}
              {result.provider ? (
                <Badge variant="muted">{result.provider}</Badge>
              ) : null}
            </CardContent>
          </Card>
        ) : null}
      </div>
    </AuthGuard>
  );
}
