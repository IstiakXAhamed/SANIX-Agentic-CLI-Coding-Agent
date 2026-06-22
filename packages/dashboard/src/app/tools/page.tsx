'use client';

import * as React from 'react';
import { Wrench } from 'lucide-react';
import { AuthGuard } from '@/components/AuthGuard';
import { ToolList } from '@/components/ToolList';

export default function ToolsPage() {
  return (
    <AuthGuard>
      <div className="space-y-6">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-fg">
            <Wrench className="h-6 w-6 text-primary" />
            Tools
          </h1>
          <p className="text-sm text-fg-muted">Browse and execute tools registered in the SANIX tool registry.</p>
        </div>
        <ToolList />
      </div>
    </AuthGuard>
  );
}
