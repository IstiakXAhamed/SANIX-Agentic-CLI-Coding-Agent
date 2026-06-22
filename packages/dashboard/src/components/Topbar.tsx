'use client';

import * as React from 'react';
import { Menu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { NAV_ITEMS } from '@/components/Sidebar';

interface TopbarProps {
  onOpenSidebar: () => void;
}

/** Top bar — mobile menu trigger + current-page breadcrumb. */
export function Topbar({ onOpenSidebar }: TopbarProps) {
  const pathname = usePathname();
  const current = NAV_ITEMS.find((i) =>
    i.href === '/' ? pathname === '/' : pathname.startsWith(i.href),
  );

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-border bg-bg/80 px-4 backdrop-blur-md md:px-6">
      <Button
        variant="ghost"
        size="icon"
        className="md:hidden"
        onClick={onOpenSidebar}
        aria-label="Open sidebar"
      >
        <Menu className="h-5 w-5" />
      </Button>

      <div className="flex items-center gap-2 text-sm">
        <span className="text-fg-subtle">SANIX</span>
        <span className="text-fg-subtle">/</span>
        <span className={cn('font-medium', current ? 'text-fg' : 'text-fg-muted')}>
          {current?.label ?? 'Page'}
        </span>
      </div>

      <div className="ml-auto hidden items-center gap-2 text-xs text-fg-subtle sm:flex">
        <kbd className="rounded border border-border bg-bg-subtle px-1.5 py-0.5 font-mono text-[10px]">⌘K</kbd>
        <span>Command palette</span>
      </div>
    </header>
  );
}
