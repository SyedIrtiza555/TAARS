import {
  Activity,
  ArrowRight,
  Bot,
  Brain,
  CheckCircle2,
  Circle,
  FlaskConical,
  KeyRound,
  MessagesSquare,
  PlugZap,
  Plus,
  Settings as SettingsIcon,
  Smartphone,
  Users,
  Zap,
} from 'lucide-react';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from '../components/ui';
import { EmptyState, PageHeader, StatCard } from '../components/common';
import type { PageKey } from '../components/Layout';
import { useApi } from '../lib/useApi';
import { fmtNumber, timeAgo, uptime } from '../lib/types';
import type { AppStatus, Run } from '../lib/types';
import { cn } from '../lib/utils';

export function DashboardPage(props: {
  status: AppStatus;
  onNavigate: (page: PageKey) => void;
}) {
  const status = props.status;
  const runs = useApi<{ runs: Run[] }>('/runs?limit=6');

  const checklist = [
    {
      label: 'Connect OpenRouter',
      done: status.manager.configured,
      hint: 'Add an API key so agents can think.',
      page: 'settings' as PageKey,
      icon: KeyRound,
    },
    {
      label: 'Create your first agent',
      done: status.hub.agents > 0,
      hint: 'Give it an identity, model, and WhatsApp token.',
      page: 'agents' as PageKey,
      icon: Smartphone,
    },
    {
      label: 'Add knowledge',
      done: status.knowledge.documents > 0,
      hint: 'Upload notes, FAQs, or documents agents can use.',
      page: 'knowledge' as PageKey,
      icon: FlaskConical,
    },
    {
      label: 'Connect an MCP server',
      done: status.mcp.connected > 0,
      hint: 'Give agents real tools and data.',
      page: 'mcp' as PageKey,
      icon: PlugZap,
    },
  ];
  const completed = checklist.filter((item) => item.done).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Overview"
        description="Manager health, agent fleet status, and recent activity."
        actions={
          <>
            <Button variant="outline" onClick={() => props.onNavigate('settings')}>
              <SettingsIcon className="h-4 w-4" />
              Configure
            </Button>
            <Button onClick={() => props.onNavigate('agents')}>
              <Plus className="h-4 w-4" />
              New agent
            </Button>
          </>
        }
      />

      <Card className="relative overflow-hidden">
        <div className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full bg-primary/10 blur-3xl" />
        <div className="relative flex flex-col gap-5 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
          <div className="flex items-start gap-4">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-primary/15 text-primary ring-1 ring-primary/25">
              <Bot className="h-6 w-6" />
            </span>
            <div className="min-w-0 space-y-1">
              <h2 className="text-lg font-semibold tracking-tight">Agent manager</h2>
              <Badge variant={status.manager.configured ? 'success' : 'warning'}>
                {status.manager.configured ? 'Model ready' : 'API key missing'}
              </Badge>
              <p className="font-mono text-xs text-muted-foreground">
                Default model: {status.manager.defaultModel}
              </p>
              <p className="text-sm text-muted-foreground">
                Uptime: <span className="text-foreground">{uptime(status.server.uptime)}</span>
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => props.onNavigate('conversations')}>
              <MessagesSquare className="h-4 w-4" />
              Conversations
            </Button>
            <Button variant="outline" onClick={() => props.onNavigate('logs')}>
              <Activity className="h-4 w-4" />
              Activity
            </Button>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatCard
          label="Agents"
          value={fmtNumber(status.hub.agents)}
          hint={`${status.hub.running} polling Â· ${status.hub.withToken} with WhatsApp token`}
          icon={Users}
          tone="sky"
        />
        <StatCard
          label="Agent runs"
          value={fmtNumber(status.stats.agentRuns)}
          hint={`${fmtNumber(status.stats.tokensIn)} in / ${fmtNumber(status.stats.tokensOut)} out`}
          icon={Zap}
          tone="violet"
        />
        <StatCard
          label="Knowledge"
          value={fmtNumber(status.knowledge.documents)}
          hint={`${fmtNumber(status.knowledge.chunks)} chunks indexed`}
          icon={FlaskConical}
          tone="primary"
        />
        <StatCard
          label="MCP tools"
          value={fmtNumber(status.mcp.tools)}
          hint={`${status.mcp.connected} of ${status.mcp.servers} servers connected`}
          icon={PlugZap}
          tone="amber"
        />
        <StatCard
          label="Memories"
          value={fmtNumber(status.memory.total)}
          hint="Per-agent long-term and working memory"
          icon={Brain}
          tone="emerald"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">Recent runs</CardTitle>
            <button
              type="button"
              onClick={() => props.onNavigate('logs')}
              className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              View all
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </CardHeader>
          <CardContent>
            {runs.loading && !runs.data ? (
              <div className="space-y-2">
                {[0, 1, 2].map((key) => (
                  <div key={key} className="h-10 animate-pulse rounded-lg bg-accent/50" />
                ))}
              </div>
            ) : runs.data?.runs.length ? (
              <div className="-mx-2 overflow-x-auto">
                <table className="w-full min-w-[520px]">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="table-th">When</th>
                      <th className="table-th">Source</th>
                      <th className="table-th">Model</th>
                      <th className="table-th">Latency</th>
                      <th className="table-th">Tokens</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.data.runs.map((run) => (
                      <tr key={run.id} className="border-b border-border/60 last:border-0">
                        <td className="table-td whitespace-nowrap text-xs text-muted-foreground">
                          {timeAgo(run.created_at)}
                        </td>
                        <td className="table-td">
                          <Badge
                            variant={
                              run.source === 'whatsapp-agent-platform' ? 'success' : run.source === 'schedule'
                                ? 'warning'
                                : 'secondary'
                            }
                            size="sm"
                          >
                            {run.source}
                          </Badge>
                        </td>
                        <td className="table-td max-w-44 truncate font-mono text-xs">{run.model}</td>
                        <td className="table-td text-xs">{run.latency_ms} ms</td>
                        <td className="table-td text-xs">
                          {run.tokens_in} / {run.tokens_out}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState
                compact
                icon={FlaskConical}
                title="No runs yet"
                description="Start an agent and let it handle WhatsApp messages, or run a schedule to see activity here."
              />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">Setup checklist</CardTitle>
            <Badge variant={completed === checklist.length ? 'success' : 'outline'} size="sm">
              {completed}/{checklist.length}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {checklist.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.label}
                  type="button"
                  onClick={() => props.onNavigate(item.page)}
                  className={cn(
                    'flex w-full items-start gap-2.5 rounded-lg border p-2.5 text-left transition-colors',
                    item.done
                      ? 'border-emerald-500/20 bg-emerald-500/5 hover:bg-emerald-500/10'
                      : 'border-border bg-background/30 hover:bg-accent/50',
                  )}
                >
                  {item.done ? (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                  ) : (
                    <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-sm font-medium">
                      <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                      {item.label}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">{item.hint}</span>
                  </span>
                </button>
              );
            })}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="space-y-0">
          <CardTitle className="text-base">System</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <InfoRow label="Host" value={`${status.server.host}:${status.server.port}`} mono />
          <InfoRow label="App URL" value={status.server.appUrl} mono />
          <InfoRow label="Version" value={status.server.version} />
          <InfoRow label="Provider" value={status.manager.provider} />
          <InfoRow
            label="Embeddings"
            value={status.knowledge.embeddingsReady ? 'Ready (local)' : 'Keyword-only fallback'}
          />
          <InfoRow
            label="Embedded chunks"
            value={`${fmtNumber(status.knowledge.embeddedChunks)} / ${fmtNumber(status.knowledge.chunks)}`}
          />
        </CardContent>
      </Card>
    </div>
  );
}

function InfoRow(props: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border/50 py-1.5 last:border-0 sm:border-0 sm:py-0">
      <span className="text-xs text-muted-foreground">{props.label}</span>
      <span className={cn('truncate text-right text-xs', props.mono && 'font-mono')}>{props.value}</span>
    </div>
  );
}
