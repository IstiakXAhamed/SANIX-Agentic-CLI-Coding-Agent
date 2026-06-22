import { cn } from '@/lib/utils';

/** Lightweight skeleton placeholder for loading states. */
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('animate-pulse rounded-md bg-bg-subtle', className)} {...props} />;
}

export { Skeleton };
