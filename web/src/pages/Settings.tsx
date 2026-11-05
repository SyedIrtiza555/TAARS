import { useEffect, useMemo, useState } from 'react';
import {
  Bot,
  Brain,
  Check,
  Cpu,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  MessageSquare,
  RotateCcw,
  Save,
  ShieldCheck,
  Sparkles,
  Trash2,
  Users,
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
import { CheckRow, Field, PageHeader } from '../components/common';
import type { Notify } from '../components/common';
import { useApi } from '../lib/useApi';
import type { SettingPatch, SettingsResponse } from '../lib/types';
import { cn } from '../lib/utils';
import { api } from '../api';

type FormState = {
  botName: string;
  model: string;
  systemPrompt: string;
  temperature: string;
  maxTokens: string;
  maxHistory: string;
  maxToolSteps: string;
  toolTimeoutMs: string;
  autoReply: boolean;
  autoConnect: boolean;
  groupMode: 'mention' | 'all' | 'off';
  typingIndicator: boolean;
  readReceipts: boolean;
  timezone: string;
  ragEnabled: boolean;
  ragAutoInject: boolean;
  ragTopK: string;
  ragMinScore: string;
  appendSignature: boolean;
  signature: string;
  fallbackMessage: string;
  maxCharsPerMessage: string;
  allowedJids: string;
  blockedJids: string;
};

const MODEL_SUGGESTIONS = [
  'openai/gpt-4.1-mini',
  'anthropic/claude-sonnet-4',
  'google/gemini-2.5-flash',
];

function buildForm(settings: SettingsResponse['settings']): FormState {
  return {
    botName: settings.botName,
    model: settings.model,
    systemPrompt: settings.systemPrompt,
    temperature: String(settings.temperature),
    maxTokens: String(settings.maxTokens),
    maxHistory: String(settings.maxHistory),
    maxToolSteps: String(settings.maxToolSteps),
    toolTimeoutMs: String(settings.toolTimeoutMs),
    autoReply: settings.autoReply,
    autoConnect: settings.autoConnect,
    groupMode: settings.groupMode,
    typingIndicator: settings.typingIndicator,
    readReceipts: settings.readReceipts,
    timezone: settings.timezone,
    ragEnabled: settings.ragEnabled,
    ragAutoInject: settings.ragAutoInject,
    ragTopK: String(settings.ragTopK),
    ragMinScore: String(settings.ragMinScore),
    appendSignature: settings.appendSignature,
    signature: settings.signature,
    fallbackMessage: settings.fallbackMessage,
    maxCharsPerMessage: String(settings.maxCharsPerMessage),
    allowedJids: settings.allowedJids.join(' '),
    blockedJids: settings.blockedJids.join(' '),
  };
}

export function splitList(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function settingsPatch(form: FormState, base: FormState): SettingPatch {
  const patch: Record<string, unknown> = {};

  const strings: Array<keyof FormState> = [
    'botName',
    'model',
    'systemPrompt',
    'signature',
    'fallbackMessage',
    'timezone',
  ];
  for (const key of strings) {
    const value = form[key];
    if (typeof value === 'string' && value !== base[key]) patch[key] = value;
  }

  const booleans: Array<keyof FormState> = [
    'autoReply',
    'autoConnect',
    'typingIndicator',
    'readReceipts',
    'ragEnabled',
    'ragAutoInject',
    'appendSignature',
  ];
  for (const key of booleans) {
    if (form[key] !== base[key]) patch[key] = form[key];
  }

  if (form.groupMode !== base.groupMode) patch.groupMode = form.groupMode;

  const numbers: Array<keyof FormState> = [
    'temperature',
    'maxTokens',
    'maxHistory',
    'maxToolSteps',
    'toolTimeoutMs',
    'ragTopK',
    'ragMinScore',
    'maxCharsPerMessage',
  ];
  for (const key of numbers) {
    const raw = String(form[key]).trim();
    if (!raw) continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    if (value !== Number(base[key])) patch[key] = value;
  }

  const allowed = splitList(form.allowedJids);
  if (JSON.stringify(allowed) !== JSON.stringify(splitList(base.allowedJids))) {
    patch.allowedJids = allowed;
  }
  const blocked = splitList(form.blockedJids);
  if (JSON.stringify(blocked) !== JSON.stringify(splitList(base.blockedJids))) {
    patch.blockedJids = blocked;
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

  const base = useMemo(
    () => (settings.data ? buildForm(settings.data.settings) : null),
    [settings.data],
  );

  useEffect(() => {
    if (base) setForm(base);
  }, [base]);

  const patch = useMemo(
    () => (form && base ? settingsPatch(form, base) : ({} as SettingPatch)),
    [form, base],
  );
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
      const response = await api.post<{ label?: string }>('/settings/test-openrouter', {
        apiKey: keyInput.trim() || undefined,
      });
      props.notify(`Key works${response.label ? ` · ${response.label}` : ''}`, 'success');
    } catch (error) {
      props.notify(error instanceof Error ? error.message : 'Key test failed', 'error');
    } finally {
      setKeyBusy(null);
    }
  };

  const removeKey = async () => {
    if (keyBusy) return;
    if (!window.confirm('Remove the stored OpenRouter key? The agent cannot reply until a new key is added.')) return;
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

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="Shape the agent's personality, model, retrieval, and WhatsApp behaviour."
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
            <Bot className="h-4 w-4 text-primary" />
            <CardTitle className="text-base">Persona</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Bot name">
                <Input value={form.botName} onChange={(event) => set('botName', event.target.value)} />
              </Field>
              <Field label="Timezone" hint="IANA name, e.g. Asia/Karachi.">
                <Input value={form.timezone} onChange={(event) => set('timezone', event.target.value)} />
              </Field>
            </div>
            <Field label="System prompt" hint="The core instructions for every conversation.">
              <Textarea
                value={form.systemPrompt}
                onChange={(event) => set('systemPrompt', event.target.value)}
                rows={10}
                className="font-mono text-xs leading-relaxed"
              />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-primary" />
              <CardTitle className="text-base">OpenRouter key</CardTitle>
            </div>
            <Badge variant={current.openrouter.configured ? 'success' : 'destructive'} size="sm">
              {current.openrouter.configured ? 'configured' : 'missing'}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Stored encrypted with <code className="font-mono">APP_SECRET</code>; the environment variable is used as a
              fallback.
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
                {keyBusy === 'test' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
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
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
              Saving a key validates it against OpenRouter before storing.
            </div>
          </CardContent>
        </Card>

        <Card className="xl:col-span-2">
          <CardHeader className="flex-row items-center gap-2 space-y-0">
            <Cpu className="h-4 w-4 text-primary" />
            <CardTitle className="text-base">Model & generation</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field label="Model" hint="Any OpenRouter model id.">
              <Input
                value={form.model}
                onChange={(event) => set('model', event.target.value)}
                list="model-suggestions"
                className="font-mono text-xs"
              />
              <datalist id="model-suggestions">
                {MODEL_SUGGESTIONS.map((model) => (
                  <option key={model} value={model} />
                ))}
              </datalist>
            </Field>
            <div className="flex flex-wrap gap-1.5">
              {MODEL_SUGGESTIONS.map((model) => (
                <button
                  key={model}
                  type="button"
                  onClick={() => set('model', model)}
                  className={cn(
                    'rounded-full border px-2.5 py-1 font-mono text-[10px] transition-colors',
                    form.model === model
                      ? 'border-primary/40 bg-primary/10 text-primary'
                      : 'border-border text-muted-foreground hover:bg-accent',
                  )}
                >
                  {model}
                </button>
              ))}
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Temperature">
                <Input
                  type="number"
                  min={0}
                  max={2}
                  step={0.1}
                  value={form.temperature}
                  onChange={(event) => set('temperature', event.target.value)}
                />
              </Field>
              <Field label="Max tokens">
                <Input
                  type="number"
                  min={128}
                  max={8192}
                  value={form.maxTokens}
                  onChange={(event) => set('maxTokens', event.target.value)}
                />
              </Field>
              <Field label="History turns">
                <Input
                  type="number"
                  min={2}
                  max={100}
                  value={form.maxHistory}
                  onChange={(event) => set('maxHistory', event.target.value)}
                />
              </Field>
              <Field label="Tool steps">
                <Input
                  type="number"
                  min={1}
                  max={10}
                  value={form.maxToolSteps}
                  onChange={(event) => set('maxToolSteps', event.target.value)}
                />
              </Field>
            </div>
            <Field label="Tool timeout (ms)" hint="5,000 to 120,000 ms.">
              <Input
                type="number"
                min={5000}
                max={120000}
                step={1000}
                value={form.toolTimeoutMs}
                onChange={(event) => set('toolTimeoutMs', event.target.value)}
                className="max-w-48"
              />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center gap-2 space-y-0">
            <Brain className="h-4 w-4 text-primary" />
            <CardTitle className="text-base">Knowledge & RAG</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <CheckRow
              checked={form.ragEnabled}
              onChange={(value) => set('ragEnabled', value)}
              label="Enable retrieval"
              hint="Let the agent search stored knowledge."
            />
            <CheckRow
              checked={form.ragAutoInject}
              onChange={(value) => set('ragAutoInject', value)}
              label="Auto-inject context"
              hint="Add relevant passages to every reply."
            />
            <div className="grid grid-cols-2 gap-3">
              <Field label="Top K">
                <Input
                  type="number"
                  min={1}
                  max={12}
                  value={form.ragTopK}
                  onChange={(event) => set('ragTopK', event.target.value)}
                />
              </Field>
              <Field label="Min score">
                <Input
                  type="number"
                  min={0}
                  max={1}
                  step={0.01}
                  value={form.ragMinScore}
                  onChange={(event) => set('ragMinScore', event.target.value)}
                />
              </Field>
            </div>
          </CardContent>
        </Card>

        <Card className="xl:col-span-2">
          <CardHeader className="flex-row items-center gap-2 space-y-0">
            <MessageSquare className="h-4 w-4 text-primary" />
            <CardTitle className="text-base">WhatsApp behaviour</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <CheckRow
                checked={form.autoReply}
                onChange={(value) => set('autoReply', value)}
                label="Auto-reply"
                hint="Respond to incoming messages automatically."
              />
              <CheckRow
                checked={form.autoConnect}
                onChange={(value) => set('autoConnect', value)}
                label="Auto-connect on startup"
                hint="Restore the WhatsApp session when the server boots."
              />
              <CheckRow
                checked={form.typingIndicator}
                onChange={(value) => set('typingIndicator', value)}
                label="Typing indicator"
                hint="Show 'typing…' while the agent thinks."
              />
              <CheckRow
                checked={form.readReceipts}
                onChange={(value) => set('readReceipts', value)}
                label="Read receipts"
                hint="Mark incoming messages as read."
              />
              <CheckRow
                checked={form.appendSignature}
                onChange={(value) => set('appendSignature', value)}
                label="Append signature"
                hint="Add the signature below to each reply."
              />
              <Field label="Group mode" hint="When the bot should answer in groups.">
                <Select
                  value={form.groupMode}
                  onValueChange={(value) => set('groupMode', value as FormState['groupMode'])}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="mention">Only when mentioned</SelectItem>
                    <SelectItem value="all">Every group message</SelectItem>
                    <SelectItem value="off">Never</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Signature">
                <Input
                  value={form.signature}
                  onChange={(event) => set('signature', event.target.value)}
                  placeholder="— sent by your agent"
                />
              </Field>
              <Field label="Max characters per message" hint="Long replies are split safely.">
                <Input
                  type="number"
                  min={500}
                  max={6000}
                  step={100}
                  value={form.maxCharsPerMessage}
                  onChange={(event) => set('maxCharsPerMessage', event.target.value)}
                />
              </Field>
            </div>
            <Field label="Fallback message" hint="Sent when the model or tools fail.">
              <Textarea
                value={form.fallbackMessage}
                onChange={(event) => set('fallbackMessage', event.target.value)}
                rows={2}
              />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center gap-2 space-y-0">
            <Users className="h-4 w-4 text-primary" />
            <CardTitle className="text-base">Access lists</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field label="Allowed JIDs" hint="Space- or comma-separated. Empty allows everyone.">
              <Textarea
                value={form.allowedJids}
                onChange={(event) => set('allowedJids', event.target.value)}
                rows={3}
                placeholder="923001234567@s.whatsapp.net"
                className="font-mono text-xs"
              />
            </Field>
            <Field label="Blocked JIDs" hint="Always ignored, even if auto-reply is on.">
              <Textarea
                value={form.blockedJids}
                onChange={(event) => set('blockedJids', event.target.value)}
                rows={3}
                placeholder="120363000000000000@g.us"
                className="font-mono text-xs"
              />
            </Field>
            <p className="text-[11px] text-muted-foreground">
              Group JIDs end in <code className="font-mono">@g.us</code>; direct chats end in{' '}
              <code className="font-mono">@s.whatsapp.net</code>.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
