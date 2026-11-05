import * as React from 'react';
import { cn } from '@/lib/utils';

type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning';
type BadgeSize = 'default' | 'sm';

const VARIANTS: Record<BadgeVariant, string> = {
  default: 'border-transparent bg-primary/15 text-primary',
  secondary: 'border-transparent bg-secondary text-secondary-foreground',
  destructive: 'border-red-500/25 bg-red-500/10 text-red-400',
  outline: 'border-border bg-transparent text-muted-foreground',
  success: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-400',
  warning: 'border-amber-500/25 bg-amber-500/10 text-amber-400',
};

export function Badge(
  props: React.ComponentProps<'span'> & { variant?: BadgeVariant; size?: BadgeSize },
) {
  const { variant = 'default', size = 'default', className, ...rest } = props;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border font-semibold',
        size === 'sm' ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-0.5 text-xs',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    />
  );
}
