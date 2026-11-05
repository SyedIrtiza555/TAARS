import { Fragment, useEffect, useMemo, useState } from 'react';
import type { ComponentType } from 'react';
import {
  ChevronDown,
  ClipboardList,
  Loader2,
  RefreshCw,
  ScrollText,
  Search,
  Zap,
} from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui';
import { EmptyState, ErrorBlock, PageHeader } from '../components/common';
import { useApi } from '../lib/useApi';
import { fmtTime, timeAgo } from '../lib/types';
import type { LogEntry, Run } from '../lib/types';
import { cn } from '../lib/utils';

type Tab = 'logs' | 'runs';

const LEVELS = ['all', 'debug', 'info', 'warn', 'error'] as const;
type LevelFilter = (typeof LEVELS)[number];

export function LogsPage() {
  const [tab, setTab] = useState<Tab>('logs');
  const [level, setLevel] = useState<LevelFilter>('all');
  const [query, setQuery] = useState('');
  const [auto, setAuto] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  const logs = useApi<{ logs: LogEntry[] }>('/logs?limit=400');
  const runs = useApi<{ runs: Run[] }>('/runs?limit=50');

  useEffect(() => {
    if (!auto || tab !== 'logs') return;
    const timer = window.setInterval(() => void logs.refetch(true), 5000);
    return () => window.clearInterval(timer);
  }, [auto, tab, logs.refetch]);

  const filteredLogs = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (logs.data?.logs ?? [])
      .filter((entry) => (level === 'all' ? true : entry.level === level))
      .filter((entry) =>
        needle
          ? entry.message.toLowerCase().includes(needle) ||
            JSON.stringify(entry.meta ?? {}).toLowerCase().includes(needle)
          : true,
      );
  }, [logs.data, level, query]);

  const filteredRuns = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return runs.data?.runs ?? [];
    return (runs.data?.runs ?? []).filter(
      (run) =>
        run.model.toLowerCase().includes(needle) ||
        run.user_text.toLowerCase().includes(needle) ||
        run.source.toLowerCase().includes(needle),
    );
  }, [runs.data, query]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Logs & runs"
        description="Follow server activity and inspect every agent invocation, including tokens and errors."
        actions={
          <Button
            variant="outline"
            onClick={() => {
              if (tab === 'logs') void logs.refetch();
              else void runs.refetch();
            }}
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
        }
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="inline-flex rounded-lg border border-border bg-card/60 p-1">
          <TabButton active={tab === 'logs'} onClick={() => setTab('logs')} icon={ScrollText} label="Application logs" />
          <TabButton active={tab === 'runs'} onClick={() => setTab('runs')} icon={ClipboardList} label="Agent runs" />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter…"
              className="h-9 w-48 pl-9"
            />
          </div>
          {tab === 'logs' && (
            <>
              <Select value={level} onValueChange={(value) => setLevel(value as LevelFilter)}>
                <SelectTrigger className="h-9 w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LEVELS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value === 'all' ? 'All levels' : value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <label className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={auto}
                  onChange={(event) => setAuto(event.target.checked)}
                  className="h-3.5 w-3.5 accent-[hsl(var(--primary))]"
                />
                Live
              </label>
            </>
          )}
        </div>
      </div>

      {tab === 'logs' ? (
        <Card>
          <CardContent className="p-0">
            {logs.loading && !logs.data ? (
              <div className="flex items-center justify-center gap-2 p-16 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading logs…
              </div>
            ) : logs.error ? (
              <div className="p-4">
                <ErrorBlock message={logs.error} onRetry={() => void logs.refetch()} />
              </div>
            ) : filteredLogs.length === 0 ? (
              <div className="p-4">
                <EmptyState
                  icon={ScrollText}
                  title="No log entries"
                  description={query || level !== 'all' ? 'No entries match the current filter.' : 'Server activity will appear here.'}
                />
              </div>
            ) : (
              <div className="max-h-[calc(100vh-18rem)] overflow-auto rounded-xl bg-[#05070b] p-3 font-mono text-[11px] leading-relaxed scrollbar-thin">
                {filteredLogs.map((entry) => (
                  <div key={entry.id} className="flex gap-2 border-b border-white/5 py-1 last:border-0">
                    <span className="shrink-0 text-muted-foreground">{entry.at.slice(11, 19)}</span>
                    <span
                      className={cn(
                        'w-12 shrink-0 font-semibold uppercase',
                        levelColor(entry.level),
                      )}
                    >
                      {entry.level}
                    </span>
                    <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-foreground/90">
                      {entry.message}
                      {entry.meta && (
                        <span className="ml-1 text-muted-foreground/70">{JSON.stringify(entry.meta)}</span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            {runs.loading && !runs.data ? (
              <div className="flex items-center justify-center gap-2 p-16 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading runs…
              </div>
            ) : runs.error ? (
              <div className="p-4">
                <ErrorBlock message={runs.error} onRetry={() => void runs.refetch()} />
              </div>
            ) : filteredRuns.length === 0 ? (
              <div className="p-4">
                <EmptyState
                  icon={Zap}
                  title="No agent runs"
                  description="Every playground request and WhatsApp reply is recorded here with token usage."
                />
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[840px]">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="table-th w-8" />
                      <th className="table-th">When</th>
                      <th className="table-th">Source</th>
                      <th className="table-th">Model</th>
                      <th className="table-th">Latency</th>
                      <th className="table-th">Tokens in / out</th>
                      <th className="table-th">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRuns.map((run) => {
                      const open = expanded === run.id;
                      return (
                        <Fragment key={run.id}>
                          <tr
                            className="cursor-pointer border-b border-border/60 transition-colors hover:bg-accent/30 last:border-0"
                            onClick={() => setExpanded(open ? null : run.id)}
                          >
                            <td className="table-td">
                              <ChevronDown
                                className={cn(
                                  'h-3.5 w-3.5 text-muted-foreground transition-transform',
                                  open && 'rotate-180',
                                )}
                              />
                            </td>
                            <td className="table-td whitespace-nowrap text-xs text-muted-foreground">
                              {timeAgo(run.created_at)}
                            </td>
                            <td className="table-td">
                              <Badge variant={run.source === 'whatsapp' ? 'success' : 'secondary'} size="sm">
                                {run.source}
                              </Badge>
                            </td>
                            <td className="table-td max-w-52 truncate font-mono text-xs">{run.model}</td>
                            <td className="table-td text-xs">{run.latency_ms} ms</td>
                            <td className="table-td text-xs">
                              {run.tokens_in} / {run.tokens_out}
                            </td>
                            <td className="table-td">
                              <Badge variant={run.error ? 'destructive' : 'success'} size="sm">
                                {run.error ? 'error' : 'ok'}
                              </Badge>
                            </td>
                          </tr>
                          {open && (
                            <tr className="border-b border-border/60 bg-background/40">
                              <td />
                              <td colSpan={6} className="px-3 pb-4 pt-1">
                                <div className="grid gap-3 lg:grid-cols-2">
                                  <div className="space-y-1">
                                    <p className="field-label">Input</p>
                                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-black/30 p-2.5 font-mono text-[11px] text-muted-foreground scrollbar-thin">
                                      {run.user_text}
                                    </pre>
                                  </div>
                                  <div className="space-y-1">
                                    <p className="field-label">Reply</p>
                                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-black/30 p-2.5 font-mono text-[11px] text-muted-foreground scrollbar-thin">
                                      {run.response || '—'}
                                    </pre>
                                  </div>
                                </div>
                                {run.error && (
                                  <p className="mt-2 text-xs text-red-300">{run.error}</p>
                                )}
                                <p className="mt-2 text-[10px] text-muted-foreground">
                                  {fmtTime(run.created_at)} · chat {run.chat_id}
                                </p>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function TabButton(props: {
  active: boolean;
  onClick: () => void;
  icon: ComponentType<{ className?: string }>;
  label: string;
}) {
  const Icon = props.icon;
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={cn(
        'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
        props.active ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {props.label}
    </button>
  );
}

function levelColor(level: string): string {
  if (level === 'error' || level === 'fatal') return 'text-red-400';
  if (level === 'warn') return 'text-amber-400';
  if (level === 'info') return 'text-sky-400';
  if (level === 'debug' || level === 'trace') return 'text-violet-400';
  return 'text-muted-foreground';
}
