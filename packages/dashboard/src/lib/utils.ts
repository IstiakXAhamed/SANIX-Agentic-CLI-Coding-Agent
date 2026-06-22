/**
 * @file lib/utils.ts — shadcn-style cn() helper + small formatting helpers.
 */
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merge Tailwind classes with conflict resolution. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Format a number of USD as a fixed-precision currency string. */
export function formatUSD(value: number | undefined | null, digits = 4): string {
  if (typeof value !== 'number' || !isFinite(value)) return '$0.0000';
  if (value < 0.01 && value > 0) return `$${value.toFixed(6)}`;
  return `$${value.toFixed(digits)}`;
}

/** Format an integer with thousands separators. */
export function formatInt(value: number | undefined | null): string {
  if (typeof value !== 'number' || !isFinite(value)) return '0';
  return value.toLocaleString('en-US');
}

/** Compact number formatter (1.2K, 3.4M). */
export function formatCompact(value: number | undefined | null): string {
  if (typeof value !== 'number' || !isFinite(value)) return '0';
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

/** Format milliseconds as a human-readable duration (e.g. "1m 23s", "432ms"). */
export function formatDuration(ms: number | undefined | null): string {
  if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  const remM = m - h * 60;
  return `${h}h ${remM}m`;
}

/** Format an uptime (ms) as "2d 3h 14m". */
export function formatUptime(ms: number | undefined | null): string {
  if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Format a unix-ms timestamp as a local time string. */
export function formatTime(ts: number | undefined | null): string {
  if (typeof ts !== 'number' || !isFinite(ts)) return '—';
  return new Date(ts).toLocaleTimeString('en-US', { hour12: false });
}

/** Format a unix-ms timestamp as a date + time string. */
export function formatDateTime(ts: number | undefined | null): string {
  if (typeof ts !== 'number' || !isFinite(ts)) return '—';
  return new Date(ts).toLocaleString('en-US', { hour12: false });
}

/** Relative time ("just now", "5s ago", "3m ago", "2h ago", "3d ago"). */
export function formatRelative(ts: number | undefined | null): string {
  if (typeof ts !== 'number' || !isFinite(ts)) return '—';
  const diff = Date.now() - ts;
  if (diff < 0) return formatDateTime(ts);
  const s = Math.floor(diff / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/** Truncate a string to maxLen chars, adding an ellipsis. */
export function truncate(s: string, maxLen: number): string {
  if (typeof s !== 'string') return '';
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + '…';
}

/** Safe JSON.stringify with indentation. */
export function prettyJSON(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Convert a byte count to a human-readable string (KB, MB, GB). */
export function formatBytes(bytes: number | undefined | null): string {
  if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Status → color class (for badges). */
export function statusColor(status: string): string {
  switch (status) {
    case 'online':
    case 'ok':
    case 'completed':
    case 'ready':
    case 'success':
    case 'active':
      return 'text-success';
    case 'running':
    case 'starting':
    case 'pending':
    case 'queued':
    case 'in_progress':
      return 'text-primary';
    case 'failed':
    case 'error':
    case 'offline':
    case 'unauthorized':
    case 'aborted':
      return 'text-error';
    case 'expired':
    case 'warning':
    case 'idle':
    case 'paused':
      return 'text-secondary';
    default:
      return 'text-fg-muted';
  }
}

/** Status → dot color class. */
export function statusDot(status: string): string {
  switch (status) {
    case 'online':
    case 'ok':
    case 'completed':
    case 'ready':
    case 'success':
    case 'active':
      return 'bg-success';
    case 'running':
    case 'starting':
    case 'pending':
    case 'queued':
    case 'in_progress':
      return 'bg-primary';
    case 'failed':
    case 'error':
    case 'offline':
    case 'unauthorized':
    case 'aborted':
      return 'bg-error';
    case 'expired':
    case 'warning':
    case 'idle':
    case 'paused':
      return 'bg-secondary';
    default:
      return 'bg-fg-subtle';
  }
}
