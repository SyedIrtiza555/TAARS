import * as React from 'react';
import { cn } from '@/lib/utils';

export function Label(props: React.ComponentProps<'label'> & { className?: string }) {
  const { className, ...rest } = props;
  return (
    <label
      className={cn(
        'text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
        className,
      )}
      {...rest}
    />
  );
}
