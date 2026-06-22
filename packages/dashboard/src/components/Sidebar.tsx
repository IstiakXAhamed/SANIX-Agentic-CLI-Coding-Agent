'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Activity,
  Boxes,
  Brain,
  Coins,
  LayoutDashboard,
  MessageSquare,
  Settings,
  Share2,
  Sliders,
  TerminalSquare,
  Wrench,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Logo } from '@/components/Logo';
import { Button } from '@/components/ui/button';

export interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  description?: string;
  external?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { href: '/', label: 'Overview', icon: LayoutDashboard, description: 'Server status & quick actions' },
  { href: '/chat', label: 'Chat', icon: MessageSquare, description: 'Single-turn LLM chat' },
  { href: '/runs', label: 'Runs', icon: Activity, description: 'Agent runs (live)' },
  { href: '/memory', label: 'Memory', icon: Brain, description: 'Memory browser' },
  { href: '/tools', label: 'Tools', icon: Wrench, description: 'Tool registry' },
  { href: '/providers', label: 'Providers', icon: Boxes, description: 'Providers & auth' },
  { href: '/cost', label: 'Cost', icon: Coins, description: 'Cost analytics' },
  { href: '/config', label: 'Config', icon: Sliders, description: 'Server config' },
  { href: '/share', label: 'Share', icon: Share2, description: 'File sharing' },
  { href: '/settings', label: 'Settings', icon: Settings, description: 'Dashboard settings' },
];

interface SidebarProps {
  open?: boolean;
  onClose?: () => void;
}

export function Sidebar({ open = false, onClose }: SidebarProps) {
  const pathname = usePathname();

  const isActive = (href: string): boolean => {
    if (href === '/') return pathname === '/';
    return pathname === href || pathname.startsWith(`${href}/`);
  };

  return (
    <>
      {/* Mobile backdrop */}
      {open ? (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm md:hidden"
          aria-hidden="true"
          onClick={onClose}
        />
      ) : null}

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-border bg-sidebar text-sidebar-foreground transition-transform duration-200 md:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
        aria-label="Main navigation"
      >
        {/* Logo */}
        <div className="flex h-16 items-center justify-between border-b border-border px-4">
          <Link href="/" className="flex items-center" aria-label="SANIX dashboard home">
            <Logo size={32} />
          </Link>
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            onClick={onClose}
            aria-label="Close sidebar"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto px-2 py-4">
          <ul className="space-y-1">
            {NAV_ITEMS.map((item) => {
              const active = isActive(item.href);
              const Icon = item.icon;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onClose}
                    className={cn(
                      'group flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-all',
                      active
                        ? 'bg-primary/10 text-primary glow-primary'
                        : 'text-fg-muted hover:bg-bg-subtle hover:text-fg',
                    )}
                    aria-current={active ? 'page' : undefined}
                  >
                    <Icon className={cn('h-4 w-4 shrink-0', active ? 'text-primary' : 'text-fg-subtle group-hover:text-fg')} />
                    <span className="flex-1">{item.label}</span>
                    {active ? <span className="h-1.5 w-1.5 rounded-full bg-primary shadow-[0_0_6px_var(--color-primary)]" /> : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* Footer */}
        <div className="border-t border-border p-3">
          <div className="flex items-center gap-2 rounded-md bg-bg-subtle/50 px-3 py-2 text-xs text-fg-subtle">
            <TerminalSquare className="h-3.5 w-3.5 shrink-0" />
            <span className="font-mono">v1.0.0 · port 7332</span>
          </div>
        </div>
      </aside>
    </>
  );
}

export { NAV_ITEMS };
