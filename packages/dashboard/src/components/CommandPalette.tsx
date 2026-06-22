'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  Activity,
  Brain,
  Coins,
  Command as CommandIcon,
  LayoutDashboard,
  MessageSquare,
  Settings,
  Share2,
  Sliders,
  Boxes,
  Wrench,
} from 'lucide-react';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/ui/command';

interface NavTarget {
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  keywords?: string[];
}

const TARGETS: NavTarget[] = [
  { label: 'Overview', href: '/', icon: LayoutDashboard, keywords: ['home', 'dashboard', 'status'] },
  { label: 'Chat', href: '/chat', icon: MessageSquare, keywords: ['llm', 'ask', 'message'] },
  { label: 'Runs', href: '/runs', icon: Activity, keywords: ['agent', 'run', 'goal', 'loop'] },
  { label: 'Memory', href: '/memory', icon: Brain, keywords: ['recall', 'fact', 'forget'] },
  { label: 'Tools', href: '/tools', icon: Wrench, keywords: ['execute', 'registry'] },
  { label: 'Providers', href: '/providers', icon: Boxes, keywords: ['auth', 'llm', 'model'] },
  { label: 'Cost', href: '/cost', icon: Coins, keywords: ['analytics', 'spend', 'tokens'] },
  { label: 'Config', href: '/config', icon: Sliders, keywords: ['server', 'settings'] },
  { label: 'Share', href: '/share', icon: Share2, keywords: ['file', 'gist', 'upload'] },
  { label: 'Settings', href: '/settings', icon: Settings, keywords: ['token', 'url', 'preferences'] },
];

/**
 * CommandPalette — Cmd+K / Ctrl+K quick-nav dialog.
 *
 * Listens for the global shortcut and lets the user fuzzy-search any page.
 */
export function CommandPalette() {
  const [open, setOpen] = React.useState(false);
  const router = useRouter();

  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Type a command or search…" />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        <CommandGroup heading="Navigate">
          {TARGETS.map((t) => {
            const Icon = t.icon;
            return (
              <CommandItem
                key={t.href}
                value={`${t.label} ${(t.keywords ?? []).join(' ')}`}
                onSelect={() => go(t.href)}
              >
                <Icon className="h-4 w-4 text-fg-muted" />
                <span>{t.label}</span>
                <CommandShortcut>
                  <CommandIcon className="h-3 w-3" />
                </CommandShortcut>
              </CommandItem>
            );
          })}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
