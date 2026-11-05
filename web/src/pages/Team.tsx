import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  Bot,
  Clock3,
  KeyRound,
  Loader2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Square,
  Trash2,
  Users,
  Zap,
} from 'lucide-react';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from '../components/ui';
import { EmptyState, ErrorBlock, PageHeader } from '../components/common';
import type { Notify } from '../components/common';
import { useApi } from '../lib/useApi';
import { fmtDate, timeAgo } from '../lib/types';
import type { AppStatus, HubAgent } from '../lib/types';
import type { PageKey } from '../components/Layout';
import { cn } from '../lib/utils';
import { api } from '../api';

export function TeamPage(props: { status: AppStatus; onNavigate: (page: PageKey) => void; notify: Notify }) {
  const runtime = useApi<{ agents: HubAgent[]; running: number; schedulerError: string | null }>('/hub/status');
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const list = runtime.data?.agents ?? [];
  const refetchAgents = runtime.refetch;

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refetchAgents(true);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [refetchAgents]);

  const statusBadge = (agent: HubAgent) => {
    if (agent.status === 'running') return { label: 'Running', variant: 'success' as const };
    if (agent.status === 'starting') return { label: 'Starting', variant: 'warning' as const };
    if (agent.status === 'error') return { label: 'Error', variant: 'destructive' as const };
    return { label: agent.enabled ? 'Stopped' : 'Disabled', variant: 'outline' as const };
  };

  const runAction = async (agent: HubAgent, action: 'start' | 'stop' | 'restart' | 'delete') => {
    setBusyAction(action);
    try {
      if (action === 'delete') {
        if (!window.confirm(`Delete "${agent.name}" and its memory, knowledge, and session?`)) return;
        await api.del(`/hub/agents/${agent.id}`);
        props.notify('Agent deleted.');
      } else {
        await api.post(`/hub/agents/${agent.id}/${action}`);
        props.notify(action === 'start' ? 'Agent started.' : action === 'stop' ? 'Agent stopped.' : 'Session reset and agent restarted.');
      }
      void refetchAgents();
    } catch (error) {
      props.notify(error instanceof Error ? error.message : 'Agent action failed', 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const profilePill = (label: string, value: string) => (
    <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/40 px-2 py-0.5 text-[10px] text-muted-foreground">
      <span className="font-semibold text-foreground">{label}</span>{value}
    </span>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Your AI team"
        description="Each agent is independent: its own identity, memory, knowledge, tools, and WhatsApp integration."
        actions={
          <>
            <Button variant="outline" onClick={() => { void runtime.refetch(); }}>
              <RefreshCw className="h-4 w-4" />
              Refresh
            </Button>
            <Button onClick={() => props.onNavigate('agents')}>
              <Plus className="h-4 w-4" />
              New agent
            </Button>
          </>
        }
      />

      {(runtime.error) && (
        <ErrorBlock message={runtime.error || 'Could not load the team.'} onRetry={() => void runtime.refetch()} />
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {list.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No agents yet"
            description="Create your first agent from the Agents page. Give it a WhatsApp Agent Platform token to let it talk on WhatsApp."
            action={
              <Button variant="outline" onClick={() => props.onNavigate('agents')}>
                <Plus className="h-3.5 w-3.5" />
                Create agent
              </Button>
            }
          />
        ) : (
          list.map((agent) => {
            const tone = statusBadge(agent);
            return (
              <Card key={agent.id} className="group hover:border-primary/50 transition-colors">
                <CardHeader className="flex-row items-start justify-between space-y-2">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <CardTitle className="truncate text-lg">{agent.name}</CardTitle>
                      <span className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold ${agent.color.replace('#', 'text-') || 'text-primary'} bg-${agent.color.replace('#', '') || 'primary'}/10`}>
                        {agent.name.slice(0, 2).toUpperCase()}
                      </span>
                      <Badge variant={tone.variant} size="sm">{tone.label}</Badge>
                      {agent.hasToken ? (
                        <Badge variant="success" size="sm">
                          <KeyRound className="h-3 w-3" />
                          token
                        </Badge>
                      ) : (
                        <Badge variant="warning" size="sm">token needed</Badge>
                      )}
                    </div>
                    {agent.title && (
                      <p className="mt-0.5 text-xs text-muted-foreground truncate">{agent.title}</p>
                    )}
                    <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">
                      {agent.objectives || agent.personality || agent.roleDescription}
                    </p>
                  </div>
                  <div className="flex items-end gap-2">
                    {agent.status === 'running' ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busyAction !== null}
                        onClick={() => void runAction(agent, 'stop')}
                      >
                        <Square className="h-3.5 w-3.5" />
                        Stop
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        disabled={busyAction !== null || !agent.hasToken || !agent.enabled}
                        onClick={() => void runAction(agent, 'start')}
                      >
                        <Play className="h-3.5 w-3.5" />
                        Start
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busyAction !== null}
                      onClick={() => void runAction(agent, 'restart')}
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="grid gap-2 sm:grid-cols-2 text-[10px] text-muted-foreground">
                    {profilePill('Model', agent.model.split('/').pop() ?? agent.model)}
                    {profilePill('Memory', `${agent.memoryCount} saved`)}
                    {profilePill('Knowledge', `${agent.privateKnowledgeCount} docs`)}
                    {profilePill('MCP', agent.mcpServerIds.length.toString())}
                    <span className="flex items-center gap-1">
                      <Clock3 className="h-3 w-3 shrink-0" />
                      {agent.lastSeenAt ? timeAgo(agent.lastSeenAt) : 'never seen'}
                    </span>
                    {agent.lastError && (
                      <span className="flex items-center gap-1 text-[10px] text-red-300 truncate">
                        <AlertCircle className="h-3 w-3 shrink-0" />
                        {agent.lastError.slice(0, 60)}
                      </span>
                    )}
                  </div>

                  <div className="border-t border-border pt-3 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busyAction !== null || !agent.enabled}
                      onClick={() => props.onNavigate('agents')}
                    >
                      Configure
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busyAction !== null}
                      onClick={() => void runAction(agent, 'delete')}
                      className="text-red-300 hover:bg-red-500/10 hover:text-red-200"
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Users className="h-4 w-4 text-muted-foreground" />
              Team summary
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-3">
              <div className="rounded-lg border border-border/60 p-3 bg-background/30">
                <p className="text-[10px] text-muted-foreground">Total agents</p>
                <p className="text-2xl font-semibold">{list.length}</p>
              </div>
              <div className="rounded-lg border border-border/60 p-3 bg-background/30">
                <p className="text-[10px] text-muted-foreground">Polling WhatsApp</p>
                <p className={`text-2xl font-semibold ${runtime.data?.running ? 'text-emerald-400' : 'text-muted-foreground'}`}>
                  {runtime.data?.running ?? 0}
                </p>
              </div>
              <div className="rounded-lg border border-border/60 p-3 bg-background/30">
                <p className="text-[10px] text-muted-foreground">With WhatsApp token</p>
                <p className="text-2xl font-semibold">{list.filter((a) => a.hasToken).length}</p>
              </div>
            </div>
            {runtime.data?.schedulerError && (
              <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 p-3 text-[11px] text-amber-300">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                Scheduler: {runtime.data.schedulerError}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Zap className="h-4 w-4 text-muted-foreground" />
              Runtime
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>OpenCode</span>
              <Badge variant={props.status.hub.runtimeReady ? 'success' : 'outline'} size="sm">
                {props.status.hub.runtimeReady ? 'ready' : 'idle'}
              </Badge>
            </div>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Default model</span>
              <span className="font-mono text-[10px]">{props.status.manager.defaultModel}</span>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
