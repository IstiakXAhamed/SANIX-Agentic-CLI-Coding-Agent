'use client';

import * as React from 'react';
import { Coins } from 'lucide-react';
import { AuthGuard } from '@/components/AuthGuard';
import { CostChart } from '@/components/CostChart';

export default function CostPage() {
  return (
    <AuthGuard>
      <div className="space-y-6">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-fg">
            <Coins className="h-6 w-6 text-success" />
            Cost
          </h1>
          <p className="text-sm text-fg-muted">Daily spend, per-provider breakdown, and token usage analytics.</p>
        </div>
        <CostChart />
      </div>
    </AuthGuard>
  );
}
