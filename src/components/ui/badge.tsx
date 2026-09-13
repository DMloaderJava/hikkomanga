import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center rounded-md px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-rose-600/20 text-rose-400 border border-rose-500/30',
        secondary: 'border-transparent bg-neutral-800 text-neutral-300 border border-neutral-700/50',
        destructive: 'border-transparent bg-red-900/30 text-red-400 border border-red-800/40',
        outline: 'text-neutral-300 border border-neutral-700',
        success: 'border-transparent bg-emerald-950 text-emerald-400 border border-emerald-800/50',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
