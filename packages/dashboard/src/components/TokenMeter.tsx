'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

interface TokenMeterProps {
  used: number;
  total: number;
  label?: string;
  showNumbers?: boolean;
  className?: string;
}

/**
 * TokenMeter — horizontal progress bar for token usage.
 * Color shifts: green <60%, amber <85%, red ≥85%.
 */
export function TokenMeter({ used, total, label = 'Tokens', showNumbers = true, className }: TokenMeterProps) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  const color = pct < 60 ? 'bg-success' : pct < 85 ? 'bg-secondary' : 'bg-error';
  const glow = pct < 60 ? 'shadow-[0_0_8px_rgba(57,211,83,0.4)]' : pct < 85 ? 'shadow-[0_0_8px_rgba(255,179,71,0.4)]' : 'shadow-[0_0_8px_rgba(255,77,77,0.4)]';

  return (
    <div className={cn('w-full', className)}>
      {showNumbers ? (
        <div className="mb-1 flex items-center justify-between text-xs">
          <span className="text-fg-subtle">{label}</span>
          <span className="font-mono text-fg-muted">
            {used.toLocaleString()} <span className="text-fg-subtle">/ {total.toLocaleString()}</span>
            <span className="ml-1 text-fg-subtle">({pct.toFixed(1)}%)</span>
          </span>
        </div>
      ) : null}
      <div className="h-2 w-full overflow-hidden rounded-full border border-border bg-bg-subtle">
        <div
          className={cn('h-full rounded-full transition-all duration-300', color, glow)}
          style={{ width: `${pct}%` }}
          role="progressbar"
          aria-valuenow={used}
          aria-valuemin={0}
          aria-valuemax={total}
          aria-label={label}
        />
      </div>
    </div>
  );
}
