import { useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  Loader2,
  Pencil,
  PlugZap,
  Plus,
  RefreshCw,
  Save,
  Server,
  Trash2,
  Wrench,
  X,
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '../components/ui';
import { CheckRow, EmptyState, ErrorBlock, Field, PageHeader } from '../components/common';
import type { Notify } from '../components/common';
import { useApi } from '../lib/useApi';
import { timeAgo } from '../lib/types';
import type { McpServer } from '../lib/types';
import { cn } from '../lib/utils';
import { api } from '../api';

type Draft = {
  name: string;
  transport: 'stdio' | 'sse' | 'http';
  command: string;
  args: string;
  cwd: string;
  url: string;
  env: string;
  headers: string;
  enabled: boolean;
  disabledTools: string[];
};

function emptyDraft(): Draft {
  return {
    name: '',
    transport: 'stdio',
    command: '',
    args: '',
    cwd: '',
    url: '',
    env: '',
    headers: '',
    enabled: true,
    disabledTools: [],
  };
}

function toDraft(server: McpServer): Draft {
  return {
    name: server.name,
    transport: server.transport,
    command: server.command,
    args: server.args,
    cwd: server.cwd,
    url: server.url,
    env: server.env,
    headers: server.headers,
    enabled: server.enabled,
    disabledTools: server.disabledTools,
  };
}

export function McpPage({ notify }: { notify: Notify }) {
  const servers = useApi<{ servers: McpServer[] }>('/mcp');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);

  const list = servers.data?.servers ?? [];
  const set = (patch: Partial<Draft>) => setDraft((current) => (current ? { ...current, ...patch } : current));

  const openCreate = () => {
    setDraft(emptyDraft());
    setEditingId(null);
  };

  const openEdit = (server: McpServer) => {
    setDraft(toDraft(server));
    setEditingId(server.id);
  };

  const closeForm = () => {
    setDraft(null);
    setEditingId(null);
  };

  const save = async () => {
    if (!draft || saving) return;
    if (!draft.name.trim()) {
      notify('Server name is required', 'error');
      return;
    }
    if (draft.transport === 'stdio' && !draft.command.trim()) {
      notify('A command is required for stdio servers', 'error');
      return;
    }
    if (draft.transport !== 'stdio' && !/^https?:\/\//i.test(draft.url.trim())) {
      notify('A valid http(s) URL is required', 'error');
      return;
    }

    const body = {
      ...draft,
      name: draft.name.trim(),
      disabledTools: draft.disabledTools,
    };

    setSaving(true);
    try {
      if (editingId) {
        await api.put(`/mcp/${encodeURIComponent(editingId)}`, body);
        notify('Server updated', 'success');
      } else {
        await api.post('/mcp', body);
        notify('Server added', 'success');
      }
      closeForm();
      await servers.refetch(true);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not save server', 'error');
    } finally {
      setSaving(false);
    }
  };

  const runOnServer = async (server: McpServer, key: string, fn: () => Promise<unknown>, message: string) => {
    setBusyId(server.id);
    try {
      await fn();
      notify(message, 'success');
      await servers.refetch(true);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Action failed', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const test = async (server: McpServer) => {
    setBusyId(server.id);
    try {
      const result = await api.post<{ tools: Array<{ name: string }> }>(
        `/mcp/${encodeURIComponent(server.id)}/test`,
      );
      notify(`${server.name}: ${result.tools?.length ?? 0} tool(s) available`, 'success');
      await servers.refetch(true);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Connection test failed', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const toggleTool = async (server: McpServer, toolName: string) => {
    const disabled = server.disabledTools.includes(toolName)
      ? server.disabledTools.filter((name) => name !== toolName)
      : [...server.disabledTools, toolName];
    setBusyId(server.id);
    try {
      await api.patch(`/mcp/${encodeURIComponent(server.id)}/tools`, { disabledTools: disabled });
      await servers.refetch(true);
      notify(
        server.disabledTools.includes(toolName) ? `Enabled ${toolName}` : `Disabled ${toolName}`,
        'success',
      );
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not update tool', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const reloadAll = async () => {
    setReloading(true);
    try {
      const result = await api.post<{ tools: unknown[]; errors: Array<{ server: string; error: string }> }>('/mcp/reload');
      await servers.refetch(true);
      if (result.errors?.length) {
        notify(`${result.tools.length} tools loaded · ${result.errors.length} server error(s)`, 'error');
      } else {
        notify(`Reloaded ${result.tools.length} tool(s)`, 'success');
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Reload failed', 'error');
    } finally {
      setReloading(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="MCP tools"
        description="Connect Model Context Protocol servers so the agent can read files, query APIs, and take real actions."
        actions={
          <>
            <Button variant="outline" disabled={reloading} onClick={() => void reloadAll()}>
              {reloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Reload tools
            </Button>
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4" />
              Add server
            </Button>
          </>
        }
      />

      {draft && (
        <Card className="animate-fade-up">
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">{editingId ? 'Edit server' : 'New server'}</CardTitle>
            <button
              type="button"
              aria-label="Close form"
              onClick={closeForm}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name" hint="A short identifier used to namespace tools.">
                <Input
                  value={draft.name}
                  onChange={(event) => set({ name: event.target.value })}
                  placeholder="filesystem"
                />
              </Field>
              <Field label="Transport">
                <Select
                  value={draft.transport}
                  onValueChange={(value) => set({ transport: value as Draft['transport'] })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="stdio">stdio (local process)</SelectItem>
                    <SelectItem value="http">Streamable HTTP</SelectItem>
                    <SelectItem value="sse">Server-sent events</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </div>

            {draft.transport === 'stdio' ? (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Command" hint="Executable, for example npx.">
                    <Input
                      value={draft.command}
                      onChange={(event) => set({ command: event.target.value })}
                      placeholder="npx"
                      className="font-mono"
                    />
                  </Field>
                  <Field label="Arguments" hint="Space-separated arguments.">
                    <Input
                      value={draft.args}
                      onChange={(event) => set({ args: event.target.value })}
                      placeholder="-y @modelcontextprotocol/server-filesystem C:\notes"
                      className="font-mono"
                    />
                  </Field>
                </div>
                <Field label="Working directory" hint="Optional. Defaults to the app directory.">
                  <Input
                    value={draft.cwd}
                    onChange={(event) => set({ cwd: event.target.value })}
                    placeholder="C:\Users\you\Documents"
                    className="font-mono"
                  />
                </Field>
              </>
            ) : (
              <Field label="Server URL" hint="Must start with http:// or https://.">
                <Input
                  value={draft.url}
                  onChange={(event) => set({ url: event.target.value })}
                  placeholder="https://mcp.example.com/mcp"
                  className="font-mono"
                />
              </Field>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Environment" hint="KEY=VALUE, one per line. Stored locally.">
                <Textarea
                  value={draft.env}
                  onChange={(event) => set({ env: event.target.value })}
                  rows={3}
                  placeholder="API_TOKEN=…"
                  className="font-mono text-xs"
                />
              </Field>
              <Field label="Headers" hint="KEY=VALUE, one per line. HTTP transports only.">
                <Textarea
                  value={draft.headers}
                  onChange={(event) => set({ headers: event.target.value })}
                  rows={3}
                  placeholder="Authorization=Bearer …"
                  className="font-mono text-xs"
                />
              </Field>
            </div>

            <CheckRow
              checked={draft.enabled}
              onChange={(enabled) => set({ enabled })}
              label="Enabled"
              hint="Disabled servers stay saved but their tools are not offered to the model."
            />

            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={closeForm}>
                Cancel
              </Button>
              <Button onClick={() => void save()} disabled={saving}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                {saving ? 'Saving…' : editingId ? 'Save changes' : 'Add server'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {servers.loading && !servers.data ? (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-border bg-card/40 px-4 py-16 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading servers…
        </div>
      ) : servers.error ? (
        <ErrorBlock message={servers.error} onRetry={() => void servers.refetch()} />
      ) : list.length === 0 ? (
        <EmptyState
          icon={PlugZap}
          title="No MCP servers yet"
          description="Add a stdio server such as the filesystem server, or connect to a remote HTTP MCP endpoint."
          action={
            <Button size="sm" onClick={openCreate}>
              <Plus className="h-4 w-4" />
              Add your first server
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {list.map((server) => {
            const busy = busyId === server.id;
            const connected = server.last_status === 'connected';
            return (
              <Card key={server.id} className={cn('transition-colors', !server.enabled && 'opacity-75')}>
                <CardHeader className="flex-row items-start justify-between space-y-0">
                  <div className="flex min-w-0 items-start gap-3">
                    <span
                      className={cn(
                        'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
                        connected ? 'bg-emerald-500/10 text-emerald-400' : 'bg-accent text-muted-foreground',
                      )}
                    >
                      <Server className="h-4 w-4" />
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{server.name}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <Badge variant="outline" size="sm">{server.transport}</Badge>
                        <Badge
                          variant={connected ? 'success' : server.last_status === 'error' ? 'destructive' : 'outline'}
                          size="sm"
                        >
                          {server.last_status || 'not tested'}
                        </Badge>
                        <span className="text-[11px] text-muted-foreground">
                          {server.toolCount} tool{server.toolCount === 1 ? '' : 's'}
                        </span>
                      </div>
                    </div>
                  </div>

                  <button
                    type="button"
                    role="switch"
                    aria-checked={server.enabled}
                    aria-label={`Toggle ${server.name}`}
                    disabled={busy}
                    onClick={() =>
                      void runOnServer(
                        server,
                        'toggle',
                        () => api.patch(`/mcp/${encodeURIComponent(server.id)}/toggle`, { enabled: !server.enabled }),
                        server.enabled ? 'Server disabled' : 'Server enabled',
                      )
                    }
                    className={cn(
                      'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50',
                      server.enabled ? 'bg-primary' : 'bg-accent',
                    )}
                  >
                    <span
                      className={cn(
                        'block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform',
                        server.enabled ? 'translate-x-[1.15rem]' : 'translate-x-[0.15rem]',
                      )}
                    />
                  </button>
                </CardHeader>

                <CardContent className="space-y-3">
                  <p className="truncate rounded-md bg-background/60 px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
                    {server.transport === 'stdio'
                      ? `${server.command} ${server.args}`.trim()
                      : server.url || 'No URL configured'}
                  </p>

                  {server.last_error && (
                    <div className="flex items-start gap-2 rounded-md border border-red-500/25 bg-red-500/10 p-2 text-[11px] text-red-300">
                      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                      <span className="break-words">{server.last_error}</span>
                    </div>
                  )}

                  {server.tools.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {server.tools.map((tool) => {
                        const disabled = server.disabledTools.includes(tool);
                        return (
                          <button
                            key={tool}
                            type="button"
                            disabled={busy}
                            title={disabled ? 'Click to enable this tool' : 'Click to disable this tool'}
                            onClick={() => void toggleTool(server, tool)}
                            className={cn(
                              'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] transition-colors disabled:opacity-50',
                              disabled
                                ? 'border-border bg-transparent text-muted-foreground line-through'
                                : 'border-amber-500/25 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20',
                            )}
                          >
                            <Wrench className="h-2.5 w-2.5" />
                            {tool}
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <Zap className="h-3 w-3" />
                      Run a connection test to discover tools.
                    </p>
                  )}

                  <div className="flex items-center justify-between border-t border-border/60 pt-3">
                    <span className="text-[11px] text-muted-foreground">Updated {timeAgo(server.updated_at)}</span>
                    <div className="flex gap-1.5">
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => void test(server)}>
                        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlugZap className="h-3.5 w-3.5" />}
                        Test
                      </Button>
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => openEdit(server)}>
                        <Pencil className="h-3.5 w-3.5" />
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={busy}
                        onClick={() => {
                          if (!window.confirm(`Remove MCP server "${server.name}"?`)) return;
                          void runOnServer(
                            server,
                            'delete',
                            () => api.del(`/mcp/${encodeURIComponent(server.id)}`),
                            'Server removed',
                          );
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <details className="group rounded-xl border border-border bg-card/50 p-4 text-sm">
        <summary className="flex cursor-pointer list-none items-center gap-2 font-medium">
          <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" />
          Example: filesystem server
        </summary>
        <div className="mt-3 space-y-2 text-xs text-muted-foreground">
          <p>Use transport <strong className="text-foreground">stdio</strong> with:</p>
          <pre className="overflow-x-auto rounded-lg bg-black/40 p-3 font-mono text-[11px] text-emerald-200/90">
{`command: npx
args:    -y @modelcontextprotocol/server-filesystem C:\\Users\\you\\Documents`}
          </pre>
          <p>Node.js must be available on PATH. Test the server after saving to load its tools.</p>
        </div>
      </details>
    </div>
  );
}
