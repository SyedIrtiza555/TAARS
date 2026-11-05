import type { ComponentType, ReactNode } from 'react';
import { CheckCircle2, Loader2, X } from 'lucide-react';
import { Card } from './ui';
import { cn } from '../lib/utils';

export type Notify = (message: string, kind?: 'success' | 'error' | 'info') => void;

export function PageHeader(props: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{props.title}</h1>
        {props.description && (
          <p className="max-w-2xl text-sm text-muted-foreground">{props.description}</p>
        )}
      </div>
      {props.actions && <div className="flex flex-wrap items-center gap-2">{props.actions}</div>}
    </div>
  );
}

export function StatCard(props: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon: ComponentType<{ className?: string }>;
  tone?: 'primary' | 'sky' | 'violet' | 'amber';
}) {
  const tones = {
    primary: 'bg-primary/10 text-primary',
    sky: 'bg-sky-500/10 text-sky-400',
    violet: 'bg-violet-500/10 text-violet-400',
    amber: 'bg-amber-500/10 text-amber-400',
  } as const;
  const Icon = props.icon;

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {props.label}
          </p>
          <div className="mt-2 truncate text-2xl font-semibold tracking-tight">{props.value}</div>
          {props.hint && <div className="mt-1 text-xs text-muted-foreground">{props.hint}</div>}
        </div>
        <span
          className={cn(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
            tones[props.tone ?? 'primary'],
          )}
        >
          <Icon className="h-4 w-4" />
        </span>
      </div>
    </Card>
  );
}

export function EmptyState(props: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  const Icon = props.icon;
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-xl border border-dashed border-border text-center',
        props.compact ? 'gap-2 px-4 py-8' : 'gap-3 px-6 py-14',
      )}
    >
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-accent text-muted-foreground">
        <Icon className="h-5 w-5" />
      </span>
      <div className="space-y-1">
        <p className="text-sm font-medium">{props.title}</p>
        {props.description && (
          <p className="mx-auto max-w-md text-xs text-muted-foreground">{props.description}</p>
        )}
      </div>
      {props.action}
    </div>
  );
}

export function LoadingBlock({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 rounded-xl border border-border bg-card/40 px-4 py-16 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      {label}
    </div>
  );
}

export function ErrorBlock({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-xl border border-red-500/25 bg-red-500/5 p-4 text-sm text-red-300">
      <p>{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md border border-red-500/30 px-2.5 py-1 text-xs font-medium hover:bg-red-500/10"
        >
          Try again
        </button>
      )}
    </div>
  );
}

export function Field(props: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cn('block space-y-2', props.className)}>
      <span className="field-label">{props.label}</span>
      {props.children}
      {props.hint && <span className="block text-xs text-muted-foreground">{props.hint}</span>}
    </label>
  );
}

export function CheckRow(props: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border/60 bg-background/40 p-3 transition-colors hover:bg-accent/40">
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(event) => props.onChange(event.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-[hsl(var(--primary))]"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium leading-tight">{props.label}</span>
        {props.hint && <span className="mt-0.5 block text-xs text-muted-foreground">{props.hint}</span>}
      </span>
    </label>
  );
}

export type ToastItem = { id: number; message: string; kind: 'success' | 'error' | 'info' };

export function ToastStack(props: { items: ToastItem[]; onDismiss: (id: number) => void }) {
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(92vw,380px)] flex-col gap-2">
      {props.items.map((item) => (
        <div
          key={item.id}
          className={cn(
            'pointer-events-auto flex items-start gap-2.5 rounded-xl border bg-card/95 p-3 shadow-2xl backdrop-blur animate-toast',
            item.kind === 'success' && 'border-emerald-500/30',
            item.kind === 'error' && 'border-red-500/30',
            item.kind === 'info' && 'border-border',
          )}
        >
          {item.kind === 'success' ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
          ) : item.kind === 'error' ? (
            <X className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
          ) : (
            <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" />
          )}
          <p className="flex-1 text-sm leading-snug">{item.message}</p>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => props.onDismiss(item.id)}
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
