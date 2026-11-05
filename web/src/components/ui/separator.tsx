import * as React from 'react';
import { cn } from '@/lib/utils';

export function Separator(props: {
  className?: string;
  children?: React.ReactNode;
  orientation?: 'horizontal' | 'vertical';
  decorative?: boolean;
}) {
  const {
    className,
    children,
    orientation = 'horizontal',
    decorative = false,
  } = props;
  return (
    <div
      className={cn(
        'relative flex w-full shrink-0',
        orientation === 'horizontal'
          ? 'h-[1px] items-center'
          : 'h-full w-[1px] justify-center',
        className,
      )}
    >
      <span
        className={cn(
          'border-t border-border',
          orientation === 'horizontal' && 'w-full mx-6',
          orientation === 'vertical' && 'h-full my-6',
        )}
      />
      {children && (
        <span
          className={cn(
            'border-border bg-background p-px text-xs font-semibold leading-none',
            orientation === 'horizontal' ? 'mx-2' : 'my-2',
          )}
        >
          {children}
        </span>
      )}
    </div>
  );
}
