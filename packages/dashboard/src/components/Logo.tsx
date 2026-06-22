/**
 * @file components/Logo.tsx — SANIX brand logo (SVG mark + wordmark).
 */
import { cn } from '@/lib/utils';

interface LogoProps {
  size?: number;
  withWordmark?: boolean;
  className?: string;
}

/** The SANIX diamond mark — a stylized "S" inside a hexagon. */
export function LogoMark({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      className={cn('shrink-0', className)}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="sanix-grad" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
          <stop stopColor="#00D4FF" />
          <stop offset="1" stopColor="#FFB347" />
        </linearGradient>
      </defs>
      <path
        d="M24 2 L42 12 V36 L24 46 L6 36 V12 Z"
        stroke="url(#sanix-grad)"
        strokeWidth="2"
        fill="rgba(0, 212, 255, 0.05)"
      />
      <path
        d="M30 18 C30 15.791 26.418 14 22 14 C17.582 14 14 15.791 14 18 C14 20.209 17.582 22 22 22 C26.418 22 30 23.791 30 26 C30 28.209 26.418 30 22 30 C17.582 30 14 28.209 14 26"
        stroke="url(#sanix-grad)"
        strokeWidth="2.5"
        strokeLinecap="round"
        fill="none"
      />
      <circle cx="24" cy="24" r="1.5" fill="#00D4FF" />
    </svg>
  );
}

export function Logo({ size = 32, withWordmark = true, className }: LogoProps) {
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <LogoMark size={size} />
      {withWordmark ? (
        <div className="flex flex-col leading-none">
          <span className="logo-gradient text-lg font-bold tracking-widest">SANIX</span>
          <span className="text-[10px] uppercase tracking-[0.2em] text-fg-subtle">Dashboard</span>
        </div>
      ) : null}
    </div>
  );
}
