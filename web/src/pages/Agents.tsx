import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  Bot,
  CalendarClock,
  Check,
  Clock3,
  KeyRound,
  Loader2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Send,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  Users,
  Wrench,
  Zap,
} from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Textarea,
} from '../components/ui';
import { CheckRow, EmptyState, ErrorBlock, Field, LoadingBlock, PageHeader } from '../components/common';
import type { Notify } from '../components/common';
import { useApi } from '../lib/useApi';
import type {
  Doc,
  HubAgent,
  HubAgentDetail,
  HubSchedule,
  HubSkill,
  HubStatus,
  McpServer,
} from '../lib/types';
import { fmtDate, timeAgo } from '../lib/types';
import { cn } from '../lib/utils';
import { api } from '../api';
import { MODEL_OPTIONS, getFreeModels } from '../lib/models';

const DEFAULT_MODEL = 'openrouter/openai/gpt-4.1-mini';
const DEFAULT_PROMPT =
  'You are a helpful WhatsApp assistant. Reply clearly and concisely. Prefer short paragraphs and plain text over tables.';

type FormState = {
  name: string;
  title: string;
  model: string;
  systemPrompt: string;
  token: string;
  enabled: boolean;
  autoStart: boolean;
  typingIndicator: boolean;
  readReceipts: boolean;
  roleDescription: string;
  personality: string;
  communicationStyle: string;
  objectives: string;
  operatingPrinciples: string;
  decisionStyle: string;
  avatar: string;
  color: string;
  webfetch: boolean;
  websearch: boolean;
  memoryEnabled: boolean;
  ownerId: string;
};

type SkillDraft = { name: string; description: string; body: string };
type ScheduleDraft = { name: string; cronExpr: string; prompt: string };

const DEFAULT_COLOR = '#22c55e';

function emptyForm(model = DEFAULT_MODEL): FormState {
  return {
    name: '',
    title: '',
    model,
    systemPrompt: DEFAULT_PROMPT,
    token: '',
    enabled: true,
    autoStart: true,
    typingIndicator: true,
    readReceipts: true,
    roleDescription: '',
    personality: '',
    communicationStyle: '',
    objectives: '',
    operatingPrinciples: '',
    decisionStyle: '',
    avatar: '',
    color: DEFAULT_COLOR,
    webfetch: false,
    websearch: false,
    memoryEnabled: true,
    ownerId: '',
  };
}

function preferredModel(value: string | undefined): string {
  const raw = value?.trim();
  if (!raw) return DEFAULT_MODEL;
  if (raw.startsWith('openrouter/')) return raw;
  // The classic bot uses an OpenRouter model ID (for example
  // "nvidia/...:free"). Hub agents talk to OpenCode, which wants the
  // provider prefix, so reuse that model by default when it is available.
  return `openrouter/${raw}`;
}

function formFromAgent(agent: HubAgentDetail): FormState {
  return {
    name: agent.name,
    title: agent.title,
    model: agent.model,
    systemPrompt: agent.systemPrompt,
    token: '',
    enabled: agent.enabled,
    autoStart: agent.autoStart,
    typingIndicator: agent.typingIndicator,
    readReceipts: agent.readReceipts,
    roleDescription: agent.roleDescription,
    personality: agent.personality,
    communicationStyle: agent.communicationStyle,
    objectives: agent.objectives,
    operatingPrinciples: agent.operatingPrinciples,
    decisionStyle: agent.decisionStyle,
    avatar: agent.avatar ?? '',
    color: agent.color || DEFAULT_COLOR,
    webfetch: agent.capabilities.webfetch,
    websearch: agent.capabilities.websearch,
    memoryEnabled: agent.memoryEnabled,
    ownerId: agent.ownerId ?? '',
  };
}

function statusBadge(agent: HubAgent | undefined) {
  if (!agent) return { label: 'Draft', variant: 'outline' as const };
  if (agent.status === 'running') return { label: 'Running', variant: 'success' as const };
  if (agent.status === 'starting') return { label: 'Starting', variant: 'warning' as const };
  if (agent.status === 'error') return { label: 'Error', variant: 'destructive' as const };
  return { label: agent.enabled ? 'Stopped' : 'Disabled', variant: 'outline' as const };
}

export function AgentsPage(props: { notify: Notify; defaultModel?: string }) {
  const agents = useApi<{ agents: HubAgent[] }>('/hub/agents');
  const runtime = useApi<HubStatus>('/hub/status');
  const mcp = useApi<{ servers: McpServer[] }>('/mcp');
  const docs = useApi<{ documents: Doc[] }>('/knowledge');
  const recommendedModel = preferredModel(props.defaultModel);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<HubAgentDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<FormState>(() => emptyForm(recommendedModel));
  const [mcpIds, setMcpIds] = useState<string[]>([]);
  const [knowledgeIds, setKnowledgeIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [testText, setTestText] = useState('Hello! What can you help me with?');
  const [testResult, setTestResult] = useState('');
  const [sendText, setSendText] = useState('Hello from the local agent hub.');
  const [skillDraft, setSkillDraft] = useState<SkillDraft>({ name: '', description: '', body: '' });
  const [scheduleDraft, setScheduleDraft] = useState<ScheduleDraft>({
    name: '',
    cronExpr: '0 9 * * *',
    prompt: '',
  });

  const list = agents.data?.agents ?? [];
  const selected = useMemo(() => list.find((agent) => agent.id === selectedId) ?? null, [list, selectedId]);
  const status = statusBadge(selected ?? undefined);
  const allSchedules = runtime.data?.schedules ?? [];

  const refetchAgents = agents.refetch;
  const refetchRuntime = runtime.refetch;

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refetchAgents(true);
      void refetchRuntime(true);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [refetchAgents, refetchRuntime]);

  const loadDetail = useCallback(
    async (id: string, select = false): Promise<void> => {
      if (select) setSelectedId(id);
      setDetailLoading(true);
      try {
        const response = await api.get<{ agent: HubAgentDetail }>(`/hub/agents/${id}`);
        setDetail(response.agent);
        setForm(formFromAgent(response.agent));
        setMcpIds(response.agent.mcpServerIds);
        setKnowledgeIds(response.agent.knowledgeIds);
        setCreating(false);
      } catch (error) {
        props.notify(error instanceof Error ? error.message : 'Could not load agent', 'error');
      } finally {
        setDetailLoading(false);
      }
    },
    [props.notify],
  );

  const firstId = agents.data?.agents[0]?.id;
  useEffect(() => {
    if (creating || selectedId || !firstId) return;
    void loadDetail(firstId, true);
  }, [creating, firstId, loadDetail, selectedId]);

  useEffect(() => {
    if (!selectedId || !agents.data) return;
    if (!agents.data.agents.some((agent) => agent.id === selectedId)) {
      setSelectedId(null);
      setDetail(null);
    }
  }, [agents.data, selectedId]);

  const patchForm = (patch: Partial<FormState>) => setForm((current) => ({ ...current, ...patch }));

  const createNew = () => {
    setCreating(true);
    setSelectedId(null);
    setDetail(null);
    setForm(emptyForm(recommendedModel));
    setAvatarPreview(null);
    setMcpIds((mcp.data?.servers ?? []).filter((server) => server.enabled).map((server) => server.id));
    setKnowledgeIds([]);
    setTestResult('');
  };

  const cancelCreate = () => {
    setCreating(false);
    setDetail(null);
    if (firstId) void loadDetail(firstId, true);
  };

  const saveAgent = async () => {
    if (!form.name.trim()) {
      props.notify('Give the agent a name first.', 'error');
      return;
    }
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        name: form.name.trim(),
        title: form.title.trim(),
        model: form.model.trim() || DEFAULT_MODEL,
        systemPrompt: form.systemPrompt,
        enabled: form.enabled,
        autoStart: form.autoStart,
        typingIndicator: form.typingIndicator,
        readReceipts: form.readReceipts,
        roleDescription: form.roleDescription.trim(),
        personality: form.personality.trim(),
        communicationStyle: form.communicationStyle.trim(),
        objectives: form.objectives.trim(),
        operatingPrinciples: form.operatingPrinciples.trim(),
        decisionStyle: form.decisionStyle.trim(),
        avatar: form.avatar || null,
        color: form.color || DEFAULT_COLOR,
        capabilities: { webfetch: form.webfetch, websearch: form.websearch },
        memoryEnabled: form.memoryEnabled,
        ownerId: form.ownerId.trim() || null,
        mcpServerIds: mcpIds,
        knowledgeIds,
      };
      if (form.token.trim()) payload.token = form.token.trim();
      if (creating) {
        const response = await api.post<{ agent: HubAgentDetail }>('/hub/agents', payload);
        props.notify('Agent created.');
        await refetchAgents(true);
        await refetchRuntime(true);
        await loadDetail(response.agent.id, true);
      } else if (selectedId) {
        await api.put<{ agent: HubAgentDetail }>(`/hub/agents/${selectedId}`, payload);
        props.notify('Agent saved.');
        await refetchAgents(true);
        await refetchRuntime(true);
        await loadDetail(selectedId);
      }
    } catch (error) {
      props.notify(error instanceof Error ? error.message : 'Could not save agent', 'error');
    } finally {
      setSaving(false);
    }
  };

  const clearToken = async () => {
    if (!selectedId) return;
    if (!window.confirm('Remove the stored WhatsApp token? The agent will stop polling.')) return;
    setBusyAction('token');
    try {
      await api.put(`/hub/agents/${selectedId}`, { token: '' });
      props.notify('Token removed.');
      await refetchAgents(true);
      await loadDetail(selectedId);
    } catch (error) {
      props.notify(error instanceof Error ? error.message : 'Could not remove token', 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const runAction = async (action: 'start' | 'stop' | 'restart' | 'delete') => {
    if (!selectedId) return;
    if (action === 'delete' && !window.confirm(`Delete "${selected?.name ?? 'this agent'}" and its skills, schedules, and session?`)) {
      return;
    }
    setBusyAction(action);
    try {
      if (action === 'delete') {
        await api.del(`/hub/agents/${selectedId}`);
        props.notify('Agent deleted.');
        setSelectedId(null);
        setDetail(null);
      } else {
        await api.post(`/hub/agents/${selectedId}/${action}`);
        props.notify(action === 'start' ? 'Agent started.' : action === 'stop' ? 'Agent stopped.' : 'Session reset and agent restarted.');
      }
      await refetchAgents(true);
      await refetchRuntime(true);
      if (action !== 'delete' && selectedId) await loadDetail(selectedId);
    } catch (error) {
      props.notify(error instanceof Error ? error.message : 'Agent action failed', 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const saveTools = async () => {
    if (!selectedId) return;
    setBusyAction('mcp');
    try {
      await api.put(`/hub/agents/${selectedId}/mcp`, { serverIds: mcpIds });
      props.notify('MCP access saved.');
      await loadDetail(selectedId);
    } catch (error) {
      props.notify(error instanceof Error ? error.message : 'Could not save MCP access', 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const saveKnowledge = async () => {
    if (!selectedId) return;
    setBusyAction('knowledge');
    try {
      await api.put(`/hub/agents/${selectedId}/knowledge`, { documentIds: knowledgeIds });
      props.notify('Knowledge links saved.');
      await loadDetail(selectedId);
    } catch (error) {
      props.notify(error instanceof Error ? error.message : 'Could not save knowledge links', 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const addSkill = async () => {
    if (!selectedId) return;
    if (!skillDraft.name.trim() || !skillDraft.body.trim()) {
      props.notify('A skill needs a name and instructions.', 'error');
      return;
    }
    setBusyAction('skill-add');
    try {
      await api.post(`/hub/agents/${selectedId}/skills`, {
        name: skillDraft.name.trim(),
        description: skillDraft.description.trim(),
        body: skillDraft.body,
      });
      setSkillDraft({ name: '', description: '', body: '' });
      props.notify('Skill added.');
      await refetchAgents(true);
      await loadDetail(selectedId);
    } catch (error) {
      props.notify(error instanceof Error ? error.message : 'Could not add skill', 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const toggleSkill = async (skill: HubSkill) => {
    if (!selectedId) return;
    setBusyAction(`skill-${skill.id}`);
    try {
      await api.put(`/hub/skills/${skill.id}`, { enabled: !skill.enabled });
      await loadDetail(selectedId);
    } catch (error) {
      props.notify(error instanceof Error ? error.message : 'Could not update skill', 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const removeSkill = async (skill: HubSkill) => {
    if (!selectedId || !window.confirm(`Delete skill "${skill.name}"?`)) return;
    setBusyAction(`skill-${skill.id}`);
    try {
      await api.del(`/hub/skills/${skill.id}`);
      props.notify('Skill deleted.');
      await refetchAgents(true);
      await loadDetail(selectedId);
    } catch (error) {
      props.notify(error instanceof Error ? error.message : 'Could not delete skill', 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const addSchedule = async () => {
    if (!selectedId) return;
    if (!scheduleDraft.name.trim() || !scheduleDraft.prompt.trim()) {
      props.notify('A schedule needs a name and prompt.', 'error');
      return;
    }
    setBusyAction('schedule-add');
    try {
      await api.post(`/hub/agents/${selectedId}/schedules`, {
        name: scheduleDraft.name.trim(),
        cronExpr: scheduleDraft.cronExpr.trim(),
        prompt: scheduleDraft.prompt,
      });
      setScheduleDraft({ name: '', cronExpr: '0 9 * * *', prompt: '' });
      props.notify('Schedule added.');
      await refetchAgents(true);
      await refetchRuntime(true);
      await loadDetail(selectedId);
    } catch (error) {
      props.notify(error instanceof Error ? error.message : 'Could not add schedule', 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const toggleSchedule = async (schedule: HubSchedule) => {
    if (!selectedId) return;
    setBusyAction(`schedule-${schedule.id}`);
    try {
      await api.put(`/hub/schedules/${schedule.id}`, { enabled: !schedule.enabled });
      await refetchRuntime(true);
      await loadDetail(selectedId);
    } catch (error) {
      props.notify(error instanceof Error ? error.message : 'Could not update schedule', 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const runSchedule = async (schedule: HubSchedule) => {
    setBusyAction(`schedule-${schedule.id}`);
    try {
      await api.post(`/hub/schedules/${schedule.id}/run`);
      props.notify('Schedule queued. The result will arrive on WhatsApp.');
    } catch (error) {
      props.notify(error instanceof Error ? error.message : 'Could not run schedule', 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const removeSchedule = async (schedule: HubSchedule) => {
    if (!selectedId || !window.confirm(`Delete schedule "${schedule.name}"?`)) return;
    setBusyAction(`schedule-${schedule.id}`);
    try {
      await api.del(`/hub/schedules/${schedule.id}`);
      props.notify('Schedule deleted.');
      await refetchRuntime(true);
      await loadDetail(selectedId);
    } catch (error) {
      props.notify(error instanceof Error ? error.message : 'Could not delete schedule', 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const testAgent = async () => {
    if (!selectedId || !testText.trim()) return;
    setBusyAction('test');
    setTestResult('');
    try {
      const response = await api.post<{ text: string; model: string; sessionId: string }>(
        `/hub/agents/${selectedId}/test`,
        { text: testText },
      );
      setTestResult(response.text);
      props.notify(`Test reply received from ${response.model}.`);
    } catch (error) {
      props.notify(error instanceof Error ? error.message : 'Test failed', 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const sendTestMessage = async () => {
    if (!selectedId || !sendText.trim()) return;
    setBusyAction('send');
    try {
      await api.post(`/hub/agents/${selectedId}/send`, { text: sendText });
      props.notify('Message queued to the creator on WhatsApp.');
    } catch (error) {
      props.notify(error instanceof Error ? error.message : 'Could not send message', 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const enabledMcp = (mcp.data?.servers ?? []).filter((server) => server.enabled);
  const documents = docs.data?.documents ?? [];
  const scheduleNext = (schedule: HubSchedule) =>
    allSchedules.find((item) => item.id === schedule.id)?.nextRun ?? null;
  const hasSelection = creating || Boolean(detail);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Agents"
        description="Run multiple WhatsApp agents locally. Each agent has its own official Agent Platform token, OpenCode model, prompt, tools, knowledge, skills, and schedule."
        actions={
          <>
            <Button
              variant="outline"
              onClick={() => {
                void refetchAgents();
                void refetchRuntime();
              }}
            >
              <RefreshCw className="h-4 w-4" />
              Refresh
            </Button>
            <Button onClick={createNew}>
              <Plus className="h-4 w-4" />
              New agent
            </Button>
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card/50 px-4 py-3 text-xs text-muted-foreground">
        <Badge variant={runtime.data?.runtime.ready ? 'success' : 'outline'}>
          <Zap className="h-3 w-3" />
          OpenCode {runtime.data?.runtime.ready ? 'ready' : 'idle'}
        </Badge>
        <span className="font-mono">{runtime.data?.runtime.baseUrl || 'localhost runtime starts on demand'}</span>
        <span className="hidden sm:inline">·</span>
        <span>
          {runtime.data?.running ?? 0} of {list.length} agents polling
        </span>
        {runtime.data?.schedulerError && (
          <span className="flex items-center gap-1 text-amber-300">
            <AlertTriangle className="h-3.5 w-3.5" />
            Scheduler: {runtime.data.schedulerError}
          </span>
        )}
      </div>

      <UsageProgress />

      {(agents.error || runtime.error) && (
        <ErrorBlock
          message={agents.error || runtime.error || 'Could not load the hub.'}
          onRetry={() => {
            void refetchAgents();
            void refetchRuntime();
          }}
        />
      )}

      <div className="grid gap-4 xl:grid-cols-[320px_minmax(0,1fr)]">
        <div className="space-y-3">
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">Local hub</CardTitle>
              <Badge variant="secondary" size="sm">
                {list.length}
              </Badge>
            </CardHeader>
            <CardContent className="space-y-2">
              {agents.loading && !agents.data ? (
                <LoadingBlock label="Loading agents…" />
              ) : list.length === 0 ? (
                <EmptyState
                  compact
                  icon={Users}
                  title="No hub agents yet"
                  description="Create your first agent, then paste its official WhatsApp Agent Platform token."
                  action={
                    <Button size="sm" onClick={createNew}>
                      <Plus className="h-3.5 w-3.5" />
                      Create agent
                    </Button>
                  }
                />
              ) : (
                list.map((agent) => {
                  const tone = statusBadge(agent);
                  return (
                    <button
                      key={agent.id}
                      type="button"
                      onClick={() => void loadDetail(agent.id, true)}
                      className={cn(
                        'w-full rounded-lg border p-3 text-left transition-colors',
                        selectedId === agent.id
                          ? 'border-primary/50 bg-primary/10'
                          : 'border-border/70 bg-background/30 hover:bg-accent/50',
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
                            <Bot className="h-4 w-4" />
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium">{agent.name}</span>
                            <span className="block truncate font-mono text-[10px] text-muted-foreground">
                              {agent.model}
                            </span>
                          </span>
                        </span>
                        <Badge variant={tone.variant} size="sm">
                          {tone.label}
                        </Badge>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Clock3 className="h-3 w-3" />
                          {agent.lastSeenAt ? timeAgo(agent.lastSeenAt) : 'never seen'}
                        </span>
                        <span className="flex items-center gap-1">
                          <Wrench className="h-3 w-3" />
                          {agent.mcpServerIds.length} MCP
                        </span>
                        <span className="flex items-center gap-1">
                          <CalendarClock className="h-3 w-3" />
                          {agent.scheduleCount}
                        </span>
                        {!agent.hasToken && (
                          <span className="flex items-center gap-1 text-amber-300">
                            <KeyRound className="h-3 w-3" />
                            token needed
                          </span>
                        )}
                      </div>
                      {agent.lastError && (
                        <p className="mt-2 line-clamp-2 text-[11px] text-red-300">{agent.lastError}</p>
                      )}
                    </button>
                  );
                })
              )}
            </CardContent>
          </Card>

          <Card className="border-dashed">
            <CardContent className="space-y-2 p-4 text-xs text-muted-foreground">
              <p className="flex items-center gap-1.5 font-medium text-foreground">
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
                Local-first by design
              </p>
              <p>
                Hub agents use the official WhatsApp Agent Platform. The classic Baileys bot remains available on the
                WhatsApp page, so you can migrate gradually.
              </p>
              <p>Tokens are encrypted with APP_SECRET and never shown again after saving.</p>
            </CardContent>
          </Card>
        </div>

        <div className="min-w-0 space-y-4">
          {!hasSelection ? (
            <Card>
              <CardContent className="p-6">
                <EmptyState
                  icon={Sparkles}
                  title="Pick an agent to configure"
                  description="Choose an agent from the left, or create a new one to connect the official WhatsApp Agent Platform to OpenCode."
                  action={
                    <Button variant="outline" onClick={createNew}>
                      <Plus className="h-4 w-4" />
                      New agent
                    </Button>
                  }
                />
              </CardContent>
            </Card>
          ) : detailLoading && !detail ? (
            <LoadingBlock label="Loading agent configuration…" />
          ) : (
            <>
              <Card>
                <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <CardTitle className="truncate text-xl">{creating ? 'New agent' : detail?.name}</CardTitle>
                      <Badge variant={status.variant}>{status.label}</Badge>
                      {detail?.hasToken ? (
                        <Badge variant="success" size="sm">
                          <KeyRound className="h-3 w-3" />
                          token saved
                        </Badge>
                      ) : (
                        <Badge variant="warning" size="sm">
                          <KeyRound className="h-3 w-3" />
                          token missing
                        </Badge>
                      )}
                      {detail?.avatar && (
                        <img src={detail.avatar} alt="" className="h-8 w-8 rounded-full border border-border object-cover" />
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {creating
                        ? 'Connect a token, choose a model, and write the agent instructions.'
                        : `Created ${timeAgo(detail?.createdAt)} · Last seen ${
                            detail?.lastSeenAt ? timeAgo(detail.lastSeenAt) : 'never'
                          }`}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {!creating && selectedId && (
                      <>
                        {selected?.running ? (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busyAction !== null}
                            onClick={() => void runAction('stop')}
                          >
                            <Square className="h-3.5 w-3.5" />
                            Stop
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            disabled={busyAction !== null || !detail?.hasToken || !detail?.enabled}
                            onClick={() => void runAction('start')}
                          >
                            <Play className="h-3.5 w-3.5" />
                            Start
                          </Button>
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busyAction !== null}
                          onClick={() => void runAction('restart')}
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                          Reset session
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busyAction !== null}
                          onClick={() => void runAction('delete')}
                          className="text-red-300 hover:bg-red-500/10 hover:text-red-200"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          Delete
                        </Button>
                      </>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="space-y-5">
                  {!creating && detail?.lastError && (
                    <div className="flex items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/5 p-3 text-xs text-red-300">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>{detail.lastError}</span>
                    </div>
                  )}

                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Agent name">
                      <Input
                        value={form.name}
                        onChange={(event) => patchForm({ name: event.target.value })}
                        placeholder="Support agent"
                      />
                    </Field>
                    <Field label="Agent model" hint="Choose a categorized model. Green = free tier available. The app passes your OpenRouter key automatically.">
                      <div className="space-y-3">
                        <div className="flex flex-wrap gap-2">
                          {['Chat','Reasoning','Coding','Vision','Fast'].map((cat) => (
                            <span key={cat} className="rounded-full bg-primary/10 px-2.5 py-0.5 text-[10px] font-medium text-primary">{cat}</span>
                          ))}
                        </div>
                        <div className="grid gap-2 sm:grid-cols-2">
                          {MODEL_OPTIONS.map((m) => (
                            <button
                              key={m.id}
                              type="button"
                              onClick={() => patchForm({ model: m.id })}
                              className={cn(
                                'flex flex-col gap-1 rounded-xl border p-3 text-left transition-colors',
                                form.model === m.id ? 'border-primary bg-primary/10 ring-1 ring-primary/30' : 'border-border bg-background/40 hover:bg-accent/40',
                              )}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-sm font-medium">{m.name}</span>
                                {m.free && <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold text-emerald-400">FREE</span>}
                              </div>
                              <span className="text-[10px] text-muted-foreground">{m.provider}</span>
                              <span className="text-[10px] text-muted-foreground">{m.bestFor}</span>
                              <div className="mt-1 flex flex-wrap gap-1">
                                {m.tags.map((tag) => (
                                  <span key={tag} className="rounded bg-muted px-1 py-0.5 text-[9px] text-muted-foreground">{tag}</span>
                                ))}
                              </div>
                            </button>
                          ))}
                        </div>
                      </div>
                    </Field>
                  </div>

                  <Field
                    label="WhatsApp Agent Platform token"
                    hint="Stored encrypted. Leave blank to keep the current token. Create tokens in the official platform."
                  >
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <Input
                        type="password"
                        value={form.token}
                        onChange={(event) => patchForm({ token: event.target.value })}
                        placeholder={detail?.hasToken ? '••••••••  (saved — leave blank to keep)' : 'Paste the per-agent bearer token'}
                        autoComplete="new-password"
                      />
                      {detail?.hasToken && !creating && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="shrink-0"
                          disabled={busyAction !== null}
                          onClick={() => void clearToken()}
                        >
                          Clear token
                        </Button>
                      )}
                    </div>
                  </Field>

                  <div className="grid gap-2 sm:grid-cols-2">
                    <CheckRow
                      checked={form.enabled}
                      onChange={(checked) => patchForm({ enabled: checked })}
                      label="Enabled"
                      hint="Disabled agents cannot be started and are stopped on save."
                    />
                    <CheckRow
                      checked={form.autoStart}
                      onChange={(checked) => patchForm({ autoStart: checked })}
                      label="Start automatically"
                      hint="Start polling when the app boots and after config changes."
                    />
                    <CheckRow
                      checked={form.readReceipts}
                      onChange={(checked) => patchForm({ readReceipts: checked })}
                      label="Read receipts"
                      hint="Mark incoming messages as read."
                    />
                    <CheckRow
                      checked={form.typingIndicator}
                      onChange={(checked) => patchForm({ typingIndicator: checked })}
                      label="Typing indicator"
                      hint="Optional; falls back to read-only if the API rejects it."
                    />
                  </div>

                  <Field
                    label="System prompt"
                    hint="OpenCode also receives the agent's identity and any enabled skills below."
                  >
                    <Textarea
                      value={form.systemPrompt}
                      onChange={(event) => patchForm({ systemPrompt: event.target.value })}
                      rows={7}
                      className="min-h-40 font-mono text-xs"
                      placeholder="Describe the agent's role, tone, and rules…"
                    />
                  </Field>

                  <Card className="border-t border-border pt-4">
                    <CardHeader className="space-y-0">
                      <CardTitle className="flex items-center gap-2 text-base">
                        <Users className="h-4 w-4 text-muted-foreground" />
                        Identity &amp; personality
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Field label="Professional title" hint="Research Analyst, Executive Assistant, …">
                          <Input
                            value={form.title}
                            onChange={(event) => patchForm({ title: event.target.value })}
                            placeholder="Title"
                          />
                        </Field>
                        <Field label="Avatar color">
                          <Input
                            type="color"
                            value={form.color}
                            onChange={(event) => patchForm({ color: event.target.value })}
                            className="h-10 w-full rounded-lg border border-input px-2 py-2 cursor-pointer bg-transparent"
                          />
                        </Field>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        <Field label="Avatar image (optional)" hint="PNG, JPEG, WebP or GIF as a data URL.">
                          <Textarea
                            value={form.avatar}
                            onChange={(event) => {
                              patchForm({ avatar: event.target.value });
                              setAvatarPreview(event.target.value || null);
                            }}
                            rows={2}
                            className="font-mono text-xs"
                            placeholder="data:image/png;base64,…"
                          />
                          {form.avatar && (
                            <img src={form.avatar} alt="avatar preview" className="mt-2 h-16 w-16 rounded-lg border object-cover" />
                          )}
                        </Field>
                        <Field label="Role &amp; responsibilities">
                          <Textarea
                            value={form.roleDescription}
                            onChange={(event) => patchForm({ roleDescription: event.target.value })}
                            rows={3}
                            className="font-mono text-xs"
                            placeholder="What this agent is accountable for…"
                          />
                        </Field>
                        <Field label="Personality">
                          <Textarea
                            value={form.personality}
                            onChange={(event) => patchForm({ personality: event.target.value })}
                            rows={3}
                            className="font-mono text-xs"
                            placeholder="Analytical and detail-oriented…"
                          />
                        </Field>
                        <Field label="Communication style">
                          <Textarea
                            value={form.communicationStyle}
                            onChange={(event) => patchForm({ communicationStyle: event.target.value })}
                            rows={3}
                            className="font-mono text-xs"
                            placeholder="Short, structured answers…"
                          />
                        </Field>
                        <Field label="Objectives">
                          <Textarea
                            value={form.objectives}
                            onChange={(event) => patchForm({ objectives: event.target.value })}
                            rows={3}
                            className="font-mono text-xs"
                            placeholder="What the agent should aim to achieve…"
                          />
                        </Field>
                        <Field label="Operating principles">
                          <Textarea
                            value={form.operatingPrinciples}
                            onChange={(event) => patchForm({ operatingPrinciples: event.target.value })}
                            rows={3}
                            className="font-mono text-xs"
                            placeholder="Never guess; say when unsure…"
                          />
                        </Field>
                        <Field label="Decision-making preferences">
                          <Textarea
                            value={form.decisionStyle}
                            onChange={(event) => patchForm({ decisionStyle: event.target.value })}
                            rows={3}
                            className="font-mono text-xs"
                            placeholder="Evidence first…"
                          />
                        </Field>
                      </div>
                      <div className="grid gap-2 sm:grid-cols-2">
                        <CheckRow
                          checked={form.memoryEnabled}
                          onChange={(checked) => patchForm({ memoryEnabled: checked })}
                          label="Memory enabled"
                          hint="Remembers facts and preferences from its own conversations."
                        />
                        <CheckRow
                          checked={form.webfetch}
                          onChange={(checked) => patchForm({ webfetch: checked })}
                          label="Web fetch"
                          hint="Allow reading web pages."
                        />
                        <CheckRow
                          checked={form.websearch}
                          onChange={(checked) => patchForm({ websearch: checked })}
                          label="Web search"
                          hint="Allow searching the web."
                        />
                      </div>
                      <Field label="Owner peer ID (optional)" hint="Schedules and dashboard sends go to this WhatsApp peer instead of the first sender.">
                        <Input
                          value={form.ownerId}
                          onChange={(event) => patchForm({ ownerId: event.target.value })}
                          placeholder="+15551234567"
                        />
                      </Field>
                    </CardContent>
                  </Card>

                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
                    <p className="text-xs text-muted-foreground">
                      Saving restarts a running agent so the new model, prompt, and tools take effect.
                    </p>
                    <div className="flex gap-2">
                      {creating && list.length > 0 && (
                        <Button variant="ghost" onClick={cancelCreate}>
                          Cancel
                        </Button>
                      )}
                      <Button disabled={saving} onClick={() => void saveAgent()}>
                        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                        {creating ? 'Create agent' : 'Save changes'}
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {!creating && selectedId && detail && (
                <>
                  <div className="grid gap-4 lg:grid-cols-2">
                    <Card>
                      <CardHeader className="flex-row items-center justify-between space-y-0">
                        <CardTitle className="flex items-center gap-2 text-base">
                          <Wrench className="h-4 w-4 text-muted-foreground" />
                          MCP tools
                        </CardTitle>
                        <Badge variant="outline" size="sm">
                          {mcpIds.length}/{enabledMcp.length}
                        </Badge>
                      </CardHeader>
                      <CardContent className="space-y-2">
                        {enabledMcp.length === 0 ? (
                          <p className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
                            No enabled MCP servers. Add one on the MCP Tools page.
                          </p>
                        ) : (
                          <>
                            <div className="max-h-56 space-y-2 overflow-y-auto pr-1">
                              {enabledMcp.map((server) => (
                                <CheckRow
                                  key={server.id}
                                  checked={mcpIds.includes(server.id)}
                                  onChange={(checked) =>
                                    setMcpIds((current) =>
                                      checked
                                        ? [...new Set([...current, server.id])]
                                        : current.filter((id) => id !== server.id),
                                    )
                                  }
                                  label={server.name}
                                  hint={`${server.transport} · ${server.toolCount} tools${server.last_status ? ` · ${server.last_status}` : ''}`}
                                />
                              ))}
                            </div>
                            <div className="flex items-center justify-between gap-2 pt-1">
                              <p className="text-[11px] text-muted-foreground">
                                Unselected servers are denied with per-agent OpenCode permissions.
                              </p>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={busyAction !== null}
                                onClick={() => void saveTools()}
                              >
                                {busyAction === 'mcp' ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Check className="h-3.5 w-3.5" />
                                )}
                                Save tools
                              </Button>
                            </div>
                          </>
                        )}
                      </CardContent>
                    </Card>

                    <Card>
                      <CardHeader className="flex-row items-center justify-between space-y-0">
                        <CardTitle className="flex items-center gap-2 text-base">
                          <BookOpen className="h-4 w-4 text-muted-foreground" />
                          Knowledge
                        </CardTitle>
                        <Badge variant="outline" size="sm">
                          {knowledgeIds.length}
                        </Badge>
                      </CardHeader>
                      <CardContent className="space-y-2">
                        {documents.length === 0 ? (
                          <p className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
                            No knowledge documents yet. Add them on the Knowledge page.
                          </p>
                        ) : (
                          <>
                            <div className="max-h-56 space-y-2 overflow-y-auto pr-1">
                              {documents.map((document) => (
                                <CheckRow
                                  key={document.id}
                                  checked={knowledgeIds.includes(document.id)}
                                  onChange={(checked) =>
                                    setKnowledgeIds((current) =>
                                      checked
                                        ? [...new Set([...current, document.id])]
                                        : current.filter((id) => id !== document.id),
                                    )
                                  }
                                  label={document.title}
                                  hint={`${document.chunk_count} chunks · ${document.status}`}
                                />
                              ))}
                            </div>
                            <div className="flex items-center justify-between gap-2 pt-1">
                              <p className="text-[11px] text-muted-foreground">
                                Relevant chunks are retrieved per message and injected into the prompt.
                              </p>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={busyAction !== null}
                                onClick={() => void saveKnowledge()}
                              >
                                {busyAction === 'knowledge' ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Check className="h-3.5 w-3.5" />
                                )}
                                Save knowledge
                              </Button>
                            </div>
                          </>
                        )}
                      </CardContent>
                    </Card>
                  </div>

                  <Card>
                    <CardHeader className="flex-row items-center justify-between space-y-0">
                      <CardTitle className="flex items-center gap-2 text-base">
                        <Sparkles className="h-4 w-4 text-muted-foreground" />
                        Skills
                      </CardTitle>
                      <Badge variant="outline" size="sm">
                        {detail.skills.length}
                      </Badge>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      {detail.skills.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          Skills are reusable Markdown instructions. They are written to <span className="font-mono">.opencode/skills</span> and included in this agent's system prompt.
                        </p>
                      ) : (
                        <div className="space-y-2">
                          {detail.skills.map((skill) => (
                            <div
                              key={skill.id}
                              className="flex flex-col gap-2 rounded-lg border border-border/70 bg-background/30 p-3 sm:flex-row sm:items-start sm:justify-between"
                            >
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  <p className="text-sm font-medium">{skill.name}</p>
                                  <Badge variant={skill.enabled ? 'success' : 'outline'} size="sm">
                                    {skill.enabled ? 'enabled' : 'disabled'}
                                  </Badge>
                                </div>
                                {skill.description && (
                                  <p className="mt-0.5 text-xs text-muted-foreground">{skill.description}</p>
                                )}
                                <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-[11px] text-muted-foreground">
                                  {skill.body}
                                </p>
                              </div>
                              <div className="flex shrink-0 gap-1.5">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={busyAction !== null}
                                  onClick={() => void toggleSkill(skill)}
                                >
                                  {busyAction === `skill-${skill.id}` ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                  ) : skill.enabled ? (
                                    <Pause className="h-3.5 w-3.5" />
                                  ) : (
                                    <Play className="h-3.5 w-3.5" />
                                  )}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={busyAction !== null}
                                  onClick={() => void removeSkill(skill)}
                                  className="text-red-300 hover:bg-red-500/10 hover:text-red-200"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}

                      <div className="space-y-3 rounded-lg border border-dashed border-border p-3">
                        <p className="text-xs font-medium">Add a skill</p>
                        <div className="grid gap-2 sm:grid-cols-2">
                          <Input
                            value={skillDraft.name}
                            onChange={(event) => setSkillDraft((current) => ({ ...current, name: event.target.value }))}
                            placeholder="Skill name"
                          />
                          <Input
                            value={skillDraft.description}
                            onChange={(event) =>
                              setSkillDraft((current) => ({ ...current, description: event.target.value }))
                            }
                            placeholder="Short description (optional)"
                          />
                        </div>
                        <Textarea
                          value={skillDraft.body}
                          onChange={(event) => setSkillDraft((current) => ({ ...current, body: event.target.value }))}
                          rows={4}
                          placeholder="Instructions the agent should follow when this skill is relevant…"
                          className="font-mono text-xs"
                        />
                        <div className="flex justify-end">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busyAction !== null}
                            onClick={() => void addSkill()}
                          >
                            {busyAction === 'skill-add' ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Plus className="h-3.5 w-3.5" />
                            )}
                            Add skill
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader className="flex-row items-center justify-between space-y-0">
                      <CardTitle className="flex items-center gap-2 text-base">
                        <CalendarClock className="h-4 w-4 text-muted-foreground" />
                        Schedules
                      </CardTitle>
                      <Badge variant="outline" size="sm">
                        {detail.schedules.length}
                      </Badge>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      {detail.schedules.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          Schedules run a prompt on a cron timer and send the reply to the agent's creator on WhatsApp.
                        </p>
                      ) : (
                        <div className="space-y-2">
                          {detail.schedules.map((schedule) => (
                            <div
                              key={schedule.id}
                              className="flex flex-col gap-2 rounded-lg border border-border/70 bg-background/30 p-3 sm:flex-row sm:items-start sm:justify-between"
                            >
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  <p className="text-sm font-medium">{schedule.name}</p>
                                  <Badge variant={schedule.enabled ? 'success' : 'outline'} size="sm">
                                    {schedule.enabled ? 'enabled' : 'paused'}
                                  </Badge>
                                  <code className="rounded bg-accent px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                    {schedule.cronExpr}
                                  </code>
                                </div>
                                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{schedule.prompt}</p>
                                <p className="mt-1 text-[11px] text-muted-foreground">
                                  Last run {schedule.lastRun ? fmtDate(schedule.lastRun) : 'never'}
                                  {scheduleNext(schedule) ? ` · Next ${fmtDate(scheduleNext(schedule))}` : ''}
                                </p>
                                {schedule.lastError && (
                                  <p className="mt-1 text-[11px] text-red-300">{schedule.lastError}</p>
                                )}
                              </div>
                              <div className="flex shrink-0 gap-1.5">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={busyAction !== null}
                                  onClick={() => void runSchedule(schedule)}
                                  title="Run now"
                                >
                                  {busyAction === `schedule-${schedule.id}` ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                  ) : (
                                    <Zap className="h-3.5 w-3.5" />
                                  )}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={busyAction !== null}
                                  onClick={() => void toggleSchedule(schedule)}
                                  title={schedule.enabled ? 'Pause' : 'Enable'}
                                >
                                  {schedule.enabled ? (
                                    <Pause className="h-3.5 w-3.5" />
                                  ) : (
                                    <Play className="h-3.5 w-3.5" />
                                  )}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={busyAction !== null}
                                  onClick={() => void removeSchedule(schedule)}
                                  className="text-red-300 hover:bg-red-500/10 hover:text-red-200"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}

                      <div className="space-y-3 rounded-lg border border-dashed border-border p-3">
                        <p className="text-xs font-medium">Add a schedule</p>
                        <div className="grid gap-2 sm:grid-cols-[1fr_180px]">
                          <Input
                            value={scheduleDraft.name}
                            onChange={(event) =>
                              setScheduleDraft((current) => ({ ...current, name: event.target.value }))
                            }
                            placeholder="Morning briefing"
                          />
                          <Input
                            value={scheduleDraft.cronExpr}
                            onChange={(event) =>
                              setScheduleDraft((current) => ({ ...current, cronExpr: event.target.value }))
                            }
                            placeholder="0 9 * * *"
                            className="font-mono text-xs"
                          />
                        </div>
                        <Textarea
                          value={scheduleDraft.prompt}
                          onChange={(event) =>
                            setScheduleDraft((current) => ({ ...current, prompt: event.target.value }))
                          }
                          rows={3}
                          placeholder="What should the agent do when this schedule fires?"
                        />
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-[11px] text-muted-foreground">
                            Standard cron syntax, evaluated in the app timezone.
                          </p>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busyAction !== null}
                            onClick={() => void addSchedule()}
                          >
                            {busyAction === 'schedule-add' ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Plus className="h-3.5 w-3.5" />
                            )}
                            Add schedule
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader className="space-y-0">
                      <CardTitle className="flex items-center gap-2 text-base">
                        <Zap className="h-4 w-4 text-muted-foreground" />
                        Test and send
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="grid gap-5 lg:grid-cols-2">
                      <div className="space-y-3">
                        <Field label="Test the OpenCode agent" hint="Runs a prompt without sending anything to WhatsApp.">
                          <Textarea
                            value={testText}
                            onChange={(event) => setTestText(event.target.value)}
                            rows={3}
                          />
                        </Field>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busyAction !== null}
                          onClick={() => void testAgent()}
                        >
                          {busyAction === 'test' ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Sparkles className="h-3.5 w-3.5" />
                          )}
                          Run test
                        </Button>
                        {testResult && (
                          <div className="max-h-56 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border bg-background/40 p-3 text-xs">
                            {testResult}
                          </div>
                        )}
                      </div>
                      <div className="space-y-3">
                        <Field
                          label="Send a WhatsApp message"
                          hint={
                            detail.creatorId
                              ? `Sends to the creator: ${detail.creatorId}`
                              : 'The agent has not received a message yet, so there is no creator to send to.'
                          }
                        >
                          <Textarea
                            value={sendText}
                            onChange={(event) => setSendText(event.target.value)}
                            rows={3}
                          />
                        </Field>
                        <Button
                          size="sm"
                          disabled={busyAction !== null || !detail.creatorId}
                          onClick={() => void sendTestMessage()}
                        >
                          {busyAction === 'send' ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Send className="h-3.5 w-3.5" />
                          )}
                          Send via WhatsApp
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function UsageProgress() {
  const [usage, setUsage] = useState<{ ok: boolean; label?: string; limit?: number; usage?: number; error?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const fetchUsage = async () => {
    setLoading(true);
    try {
      const result = await api.post<{ ok: boolean; label?: string; limit?: number; usage?: number; error?: string }>('/settings/test-openrouter');
      setUsage(result);
    } catch {
      setUsage({ ok: false, error: 'Could not fetch usage.' });
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void fetchUsage(); }, []);
  const hasData = usage && usage.ok && typeof usage.limit === 'number';
  const pct = hasData ? Math.min(100, Math.round(((usage.usage ?? 0) / usage.limit!) * 100)) : 0;
  return (
    <Card className="mb-4 border-dashed">
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-medium">OpenRouter key usage</p>
            <p className="text-[11px] text-muted-foreground">Limit hits and token consumption for this key.</p>
          </div>
          <Button size="sm" variant="outline" onClick={() => void fetchUsage()} disabled={loading}>
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            Refresh
          </Button>
        </div>
        {usage && usage.ok && (
          <div className="mt-3">
            <div className="flex items-center justify-between text-xs mb-1">
              <span className="text-muted-foreground">Used / Limit</span>
              <span className="font-mono font-medium">{usage.usage ?? 0} / {usage.limit ?? '--'}</span>
            </div>
            <div className="h-2 w-full rounded-full bg-border overflow-hidden">
              <div className="h-full rounded-full bg-gradient-to-r from-emerald-400 via-amber-400 to-red-400 transition-all duration-500" style={{ width: `${pct}%` }} />
            </div>
            {pct > 80 && <p className="mt-1.5 text-[10px] text-amber-300">Usage approaching limit. Consider rotating the key or reducing concurrency.</p>}
          </div>
        )}
        {usage && !usage.ok && usage.error && (
          <p className="mt-3 text-xs text-red-300">{usage.error}</p>
        )}
      </CardContent>
    </Card>
  );
}
