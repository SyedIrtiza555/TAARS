import * as React from 'react';
import { cn } from '@/lib/utils';

export function Card({
  className,
  children,
}: React.ComponentProps<'div'> & { children?: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'rounded-xl border border-border bg-card text-card-foreground shadow',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CardHeader(props: {
  className?: string;
  children?: React.ReactNode;
}) {
  const { className, children } = props;
  return (
    <div className={cn('flex flex-col space-y-1.5 p-6', className)}>
      {children}
    </div>
  );
}

export function CardTitle(props: {
  className?: string;
  children?: React.ReactNode;
}) {
  const { className, children } = props;
  return (
    <h3
      className={cn(
        'text-2xl font-semibold leading-none tracking-tight',
        className,
      )}
    >
      {children}
    </h3>
  );
}

export function CardContent(props: {
  className?: string;
  children?: React.ReactNode;
}) {
  const { className, children } = props;
  return (
    <div className={cn('p-6 pt-0', className)}>{children}</div>
  );
}

export function CardFooter(props: {
  className?: string;
  children?: React.ReactNode;
}) {
  const { className, children } = props;
  return (
    <div className={cn('flex items-center p-6 pt-0', className)}>{children}</div>
  );
}
