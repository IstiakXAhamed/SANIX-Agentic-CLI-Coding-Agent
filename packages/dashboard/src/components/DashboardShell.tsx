'use client';

import * as React from 'react';
import { Sidebar } from '@/components/Sidebar';
import { Topbar } from '@/components/Topbar';
import { CommandPalette } from '@/components/CommandPalette';
import { ServerStatusPill } from '@/components/ServerStatusPill';
import { TooltipProvider } from '@/components/ui/tooltip';

/**
 * DashboardShell — the persistent layout (sidebar + topbar + command palette)
 * wrapping every page. The page content is rendered via `children`.
 */
export function DashboardShell({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = React.useState(false);

  return (
    <TooltipProvider delayDuration={150}>
      <div className="min-h-screen bg-bg bg-grid">
        <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

        <div className="flex min-h-screen flex-col md:pl-64">
          <Topbar onOpenSidebar={() => setSidebarOpen(true)} />
          <div className="flex items-center justify-end gap-3 border-b border-border bg-bg/60 px-4 py-2 md:px-6">
            <ServerStatusPill />
          </div>

          <main className="flex-1 px-4 py-6 md:px-6 md:py-8" id="main-content">
            {children}
          </main>

          <footer className="mt-auto border-t border-border bg-bg/60 px-4 py-3 text-center text-xs text-fg-subtle md:px-6">
            <span className="font-mono">SANIX</span> · Dashboard ·{' '}
            <a
              href="https://github.com/sanix"
              target="_blank"
              rel="noreferrer"
              className="text-fg-muted hover:text-primary"
            >
              v1.0.0
            </a>
          </footer>
        </div>

        <CommandPalette />
      </div>
    </TooltipProvider>
  );
}
