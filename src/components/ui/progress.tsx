import * as React from 'react';
import { cn } from '@/lib/utils';

export function Progress({ value, className }: { value: number; className?: string }) {
  const percentage = Math.min(100, Math.max(0, value));
  return (
    <div className={cn('relative h-2 w-full overflow-hidden rounded-full bg-neutral-800', className)}>
      <div
        className="h-full bg-rose-600 transition-all duration-300 ease-in-out"
        style={{ width: `${percentage}%` }}
      />
    </div>
  );
}
