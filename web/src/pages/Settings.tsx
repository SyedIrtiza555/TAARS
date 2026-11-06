import { useEffect, useMemo, useState } from 'react';
import { Brain, Check, Eye, EyeOff, KeyRound, Loader2, RotateCcw, Save, ShieldCheck, Trash2 } from 'lucide-react';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea } from '../components/ui';
import { CheckRow, Field, PageHeader } from '../components/common';
import type { Notify } from '../components/common';
import { useApi } from '../lib/useApi';
import type { SettingPatch, SettingsResponse } from '../lib/types';
import { cn } from '../lib/utils';
import { api } from '../api';

type FormState = {
  model: string;
  timezone: string;
  provider: 'openrouter' | 'groq';
  groqApiKey: string;
  memoryConsolidateEvery: string;
  memoryMaxPerAgent: string;
  memoryWorkingTtlHours: string;
  memoryRetrieveLimit: string;
};

function buildForm(settings: SettingsResponse['settings']): FormState {
  return {
    model: settings.model,
    timezone: settings.timezone,
    provider: settings.provider,
    groqApiKey: '',
    memoryConsolidateEvery: String(settings.memoryConsolidateEvery),
    memoryMaxPerAgent: String(settings.memoryMaxPerAgent),
    memoryWorkingTtlHours: String(settings.memoryWorkingTtlHours),
    memoryRetrieveLimit: String(settings.memoryRetrieveLimit),
  };
}

export function settingsPatch(form: FormState, base: FormState): SettingPatch {
  const patch: Record<string, unknown> = {};

  const strings: Array<keyof FormState> = ['model', 'timezone', 'provider'];
  for (const key of strings) {
    const value = form[key];
    if (typeof value === 'string' && value !== base[key]) patch[key] = value;
  }

  const numbers: Array<keyof FormState> = ['memoryConsolidateEvery', 'memoryMaxPerAgent', 'memoryWorkingTtlHours', 'memoryRetrieveLimit'];
  for (const key of numbers) {
    const raw = String(form[key]).trim();
    if (!raw) continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    if (value !== Number(base[key])) patch[key] = value;
  }

  return patch as SettingPatch;
}

export function SettingsPage(props: {
  notify: Notify;
  refreshStatus: () => Promise<void>;
}) {
  const settings = useApi<SettingsResponse>('/settings');
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [keyVisible, setKeyVisible] = useState(false);
  const [keyBusy, setKeyBusy] = useState<'save' | 'test' | 'remove' | null>(null);
  const [pwState, setPwState] = useState({ current: '', next: '', confirm: '' });
  const [pwBusy, setPwBusy] = useState(false);

  const base = useMemo(() => (settings.data ? buildForm(settings.data.settings) : null), [settings.data]);

  useEffect(() => {
    if (base) setForm(base);
  }, [base]);

  const patch = useMemo(() => (form && base ? settingsPatch(form, base) : ({} as SettingPatch)), [form, base]);
  const changes = Object.keys(patch).length;

  if (settings.loading && !settings.data) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-xl border border-border bg-card/40 px-4 py-20 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading settings…
      </div>
    );
  }

  if (settings.error || !settings.data || !form || !base) {
    return <p className="text-sm text-red-300">{settings.error || 'Settings unavailable'}</p>;
  }

  const current = settings.data;
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((state) => (state ? { ...state, [key]: value } : state));

  const save = async () => {
    if (!form || changes === 0 || saving) return;
    setSaving(true);
    try {
      await api.put('/settings', patch);
      await settings.refetch(true);
      await props.refreshStatus();
      props.notify(`${changes} setting${changes === 1 ? '' : 's'} saved`, 'success');
    } catch (error) {
      props.notify(error instanceof Error ? error.message : 'Could not save settings', 'error');
    } finally {
      setSaving(false);
    }
  };

  const saveKey = async () => {
    if (!keyInput.trim() || keyBusy) return;
    setKeyBusy('save');
    try {
      await api.post('/settings/openrouter-key', { apiKey: keyInput.trim() });
      setKeyInput('');
      await settings.refetch(true);
      await props.refreshStatus();
      props.notify('OpenRouter key saved', 'success');
    } catch (error) {
      props.notify(error instanceof Error ? error.message : 'Key was rejected', 'error');
    } finally {
      setKeyBusy(null);
    }
  };

  const testKey = async () => {
    if (keyBusy) return;
    setKeyBusy('test');
    try {
      const response = await api.post<{ label?: string }>('/settings/test-openrouter', { apiKey: keyInput.trim() || undefined });
      props.notify(`Key works${response.label ? ` · ${response.label}` : ''}`, 'success');
    } catch (error) {
      props.notify(error instanceof Error ? error.message : 'Key test failed', 'error');
    } finally {
      setKeyBusy(null);
    }
  };

  const removeKey = async () => {
    if (keyBusy) return;
    if (!window.confirm('Remove the stored OpenRouter key? Agents cannot reply until a new key is added.')) return;
    setKeyBusy('remove');
    try {
      await api.post('/settings/openrouter-key', {});
      await settings.refetch(true);
      await props.refreshStatus();
      props.notify('OpenRouter key removed', 'success');
    } catch (error) {
      props.notify(error instanceof Error ? error.message : 'Could not remove key', 'error');
    } finally {
      setKeyBusy(null);
    }
  };

  const changePassword = async () => {
    if (pwBusy) return;
    setPwBusy(true);
    try {
      await api.post('/auth/change-password', {
        currentPassword: pwState.current,
        newPassword: pwState.next,
      });
      setPwState({ current: '', next: '', confirm: '' });
      props.notify('Admin password updated. Other devices were signed out.', 'success');
    } catch (error) {
      props.notify(error instanceof Error ? error.message : 'Could not change the password', 'error');
    } finally {
      setPwBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="Manager-level configuration: model, provider, OpenRouter key, and memory defaults."
        actions={
          <>
            <Button variant="ghost" disabled={changes === 0 || saving} onClick={() => setForm(base)}>
              <RotateCcw className="h-4 w-4" />
              Discard
            </Button>
            <Button disabled={changes === 0 || saving} onClick={() => void save()}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {saving ? 'Saving…' : changes > 0 ? `Save ${changes} change${changes === 1 ? '' : 's'}` : 'Saved'}
            </Button>
          </>
        }
      />

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader className="flex-row items-center gap-2 space-y-0">
            <KeyRound className="h-4 w-4 text-primary" />
            <CardTitle className="text-base">OpenRouter key</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Stored encrypted with <code className="font-mono">APP_SECRET</code>; the environment variable is used as a
              fallback. All agents share this key.
            </p>
            <Field label="API key" hint={current.openrouter.configured ? `Current: ${current.openrouter.maskedKey}` : undefined}>
              <div className="relative">
                <Input
                  type={keyVisible ? 'text' : 'password'}
                  value={keyInput}
                  onChange={(event) => setKeyInput(event.target.value)}
                  placeholder="sk-or-v1-…"
                  className="pr-10 font-mono text-xs"
                />
                <button
                  type="button"
                  aria-label={keyVisible ? 'Hide key' : 'Show key'}
                  onClick={() => setKeyVisible((value) => !value)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
                >
                  {keyVisible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
              </div>
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={!keyInput.trim() || keyBusy !== null} onClick={() => void saveKey()}>
                {keyBusy === 'save' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                Save key
              </Button>
              <Button size="sm" variant="outline" disabled={keyBusy !== null} onClick={() => void testKey()}>
                {keyBusy === 'test' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                Test
              </Button>
              {current.openrouter.configured && (
                <Button size="sm" variant="ghost" disabled={keyBusy !== null} onClick={() => void removeKey()}>
                  {keyBusy === 'remove' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  Remove
                </Button>
              )}
            </div>
            <div className="flex items-start gap-2 rounded-lg border border-border/70 bg-background/40 p-2.5 text-[11px] text-muted-foreground">
              <CheckRow checked={current.openrouter.configured} onChange={() => {}} label="Configured" disabled />
            </div>
          </CardContent>
        </Card>

        <Card className="xl:col-span-2">
          <CardHeader className="flex-row items-center gap-2 space-y-0">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Brain className="h-5 w-5" />
            </span>
            <CardTitle className="text-base">Model &amp; generation</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field label="Default model" hint="Any OpenRouter model id, for example openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free. New agents use this by default.">
              <Input
                value={form.model}
                onChange={(event) => set('model', event.target.value)}
                className="font-mono text-xs"
              />
            </Field>
            <Field label="Provider">
              <Select value={form.provider} onValueChange={(value) => set('provider', value as FormState['provider'])}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="openrouter">OpenRouter</SelectItem>
                  <SelectItem value="groq">Groq</SelectItem>
                </SelectContent>
              </Select>
              {form.provider === 'groq' && (
                <Field label="Groq API key" hint="Used when provider is Groq.">
                  <Input type="password" value={form.groqApiKey} onChange={(event) => set('groqApiKey', event.target.value)} className="font-mono text-xs" />
                </Field>
              )}
            </Field>
          </CardContent>
        </Card>

        <Card className="xl:col-span-2">
          <CardHeader className="flex-row items-center gap-2 space-y-0">
            <span className="flex h-4 w-4 items-center justify-center rounded-full bg-primary/10 text-primary">
              <span className="text-[10px] font-bold">🧠</span>
            </span>
            <CardTitle className="text-base">Memory defaults</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Consolidate every N turns" hint="Memory maintenance runs after this many exchanges in a conversation.">
                <Input type="number" min={1} max={50} value={form.memoryConsolidateEvery} onChange={(event) => set('memoryConsolidateEvery', event.target.value)} className="max-w-48 font-mono text-xs" />
              </Field>
              <Field label="Max memories per agent" hint="Least useful auto-learned memories are forgotten first.">
                <Input type="number" min={50} max={5000} value={form.memoryMaxPerAgent} onChange={(event) => set('memoryMaxPerAgent', event.target.value)} className="max-w-48 font-mono text-xs" />
              </Field>
              <Field label="Working memory TTL (hours)" hint="Short-lived working notes expire after this long.">
                <Input type="number" min={1} max={720} value={form.memoryWorkingTtlHours} onChange={(event) => set('memoryWorkingTtlHours', event.target.value)} className="max-w-48 font-mono text-xs" />
              </Field>
              <Field label="Memories per prompt" hint="How many long-term memories are injected into each reply.">
                <Input type="number" min={1} max={30} value={form.memoryRetrieveLimit} onChange={(event) => set('memoryRetrieveLimit', event.target.value)} className="max-w-48 font-mono text-xs" />
              </Field>
            </div>
          </CardContent>
        </Card>

        <Card className="xl:col-span-2">
          <CardHeader className="flex-row items-center gap-2 space-y-0">
            <ShieldCheck className="h-4 w-4 text-primary" />
            <CardTitle className="text-base">Security</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Change the admin password. The new value is stored as an encrypted scrypt hash only — all other
              sessions are signed out.
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Current password">
                <Input
                  type="password"
                  value={pwState.current}
                  onChange={(event) => setPwState((state) => ({ ...state, current: event.target.value }))}
                  autoComplete="current-password"
                />
              </Field>
              <Field label="New password" hint="Minimum 8 characters.">
                <Input
                  type="password"
                  value={pwState.next}
                  onChange={(event) => setPwState((state) => ({ ...state, next: event.target.value }))}
                  autoComplete="new-password"
                />
              </Field>
              <Field label="Confirm new password">
                <Input
                  type="password"
                  value={pwState.confirm}
                  onChange={(event) => setPwState((state) => ({ ...state, confirm: event.target.value }))}
                  autoComplete="new-password"
                />
              </Field>
            </div>
            <div className="flex items-center gap-3">
              <Button
                size="sm"
                disabled={pwBusy || pwState.next.length < 8 || pwState.next !== pwState.confirm || !pwState.current}
                onClick={() => void changePassword()}
              >
                {pwBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                Update password
              </Button>
              {pwState.next && pwState.next !== pwState.confirm && (
                <span className="text-xs text-amber-300">Passwords do not match.</span>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="xl:col-span-2">
          <CardHeader className="flex-row items-center gap-2 space-y-0">
            <span className="flex h-4 w-4 items-center justify-center rounded-full bg-primary/10 text-primary">
              <span className="text-[10px] font-bold">🌍</span>
            </span>
            <CardTitle className="text-base">Timezone</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field label="Timezone" hint="IANA name, e.g. Asia/Karachi. Used for cron schedules.">
              <Input value={form.timezone} onChange={(event) => set('timezone', event.target.value)} />
            </Field>
            <p className="text-[11px] text-muted-foreground">
              Schedules are evaluated in this timezone. OpenCode runs locally on this machine.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
