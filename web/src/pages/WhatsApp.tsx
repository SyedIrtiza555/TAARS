import { useState } from 'react';
import type { ComponentType, ReactNode } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  LogOut,
  MessageCircle,
  Power,
  QrCode,
  RefreshCw,
  Send,
  Smartphone,
  WifiOff,
} from 'lucide-react';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input } from '../components/ui';
import { Field, PageHeader } from '../components/common';
import type { Notify } from '../components/common';
import { api } from '../api';
import { timeAgo } from '../lib/types';
import type { AppStatus } from '../lib/types';
import { cn } from '../lib/utils';

export function WhatsAppPage(props: {
  status: AppStatus;
  refresh: () => Promise<void>;
  notify: Notify;
}) {
  const snapshot = props.status.whatsapp;
  const [busy, setBusy] = useState<string | null>(null);
  const [testText, setTestText] = useState('');
  const [sending, setSending] = useState(false);

  const connected = snapshot.state === 'connected';

  const run = async (key: string, fn: () => Promise<unknown>, message: string) => {
    setBusy(key);
    try {
      await fn();
      props.notify(message, 'success');
      await props.refresh();
    } catch (error) {
      props.notify(error instanceof Error ? error.message : 'Action failed', 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="WhatsApp"
        description="Pair your phone, watch the session, and send a quick test message."
        actions={
          <Button variant="outline" onClick={() => void props.refresh()}>
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">Connection</CardTitle>
            <StateBadge state={snapshot.state} />
          </CardHeader>
          <CardContent className="space-y-5">
            {snapshot.state === 'qr' && (
              <div className="flex flex-col items-center gap-3 rounded-xl border border-amber-500/25 bg-amber-500/5 p-5 text-center">
                {snapshot.qrDataUrl ? (
                  <div className="rounded-xl bg-white p-3">
                    <img
                      src={snapshot.qrDataUrl}
                      alt="WhatsApp pairing QR code"
                      className="h-56 w-56"
                    />
                  </div>
                ) : (
                  <div className="flex h-56 w-56 items-center justify-center rounded-xl border border-dashed border-border">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  </div>
                )}
                <div className="space-y-1">
                  <p className="flex items-center justify-center gap-2 text-sm font-medium">
                    <QrCode className="h-4 w-4" />
                    Scan with WhatsApp
                  </p>
                  <p className="text-xs text-muted-foreground">
                    On your phone open WhatsApp → Settings → Linked devices → Link a device.
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    QR issued {timeAgo(snapshot.qrIssuedAt)} · refreshes automatically
                  </p>
                </div>
              </div>
            )}

            {connected && (
              <div className="flex flex-col gap-4 rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-4 sm:flex-row sm:items-center">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400">
                  <CheckCircle2 className="h-5 w-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {snapshot.name || 'WhatsApp connected'}
                  </p>
                  <p className="font-mono text-xs text-muted-foreground">
                    {snapshot.phoneNumber || 'unknown number'}
                  </p>
                </div>
                <p className="text-xs text-muted-foreground">
                  Linked {timeAgo(snapshot.connectedAt)}
                </p>
              </div>
            )}

            {!connected && snapshot.state !== 'qr' && (
              <div className="flex flex-col items-start gap-3 rounded-xl border border-border bg-background/40 p-4 sm:flex-row sm:items-center">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent text-muted-foreground">
                  <WifiOff className="h-5 w-5" />
                </span>
                <div className="flex-1">
                  <p className="text-sm font-medium">
                    {snapshot.state === 'logged_out'
                      ? 'Session logged out'
                      : snapshot.state === 'connecting'
                        ? 'Connecting to WhatsApp…'
                        : 'Not connected'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {snapshot.state === 'logged_out'
                      ? 'Link the device again by scanning a new QR code.'
                      : 'Start a session to generate a pairing QR code.'}
                  </p>
                </div>
                {snapshot.state === 'connecting' && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
              </div>
            )}

            {snapshot.lastError && (
              <div className="flex items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/10 p-3 text-sm text-red-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span className="break-words">{snapshot.lastError}</span>
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <Button
                disabled={connected || busy !== null || snapshot.state === 'connecting'}
                onClick={() => void run('connect', () => api.post('/whatsapp/connect'), 'WhatsApp session starting')}
              >
                {busy === 'connect' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Power className="h-4 w-4" />}
                {busy === 'connect' ? 'Starting…' : 'Connect'}
              </Button>
              <Button
                variant="outline"
                disabled={busy !== null}
                onClick={() => void run('reconnect', () => api.post('/whatsapp/reconnect'), 'Reconnecting')}
              >
                {busy === 'reconnect' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Reconnect
              </Button>
              <Button
                variant="outline"
                disabled={busy !== null || (!connected && snapshot.state !== 'qr')}
                onClick={() =>
                  void run('disconnect', () => api.post('/whatsapp/disconnect'), 'Disconnected')
                }
              >
                <WifiOff className="h-4 w-4" />
                Disconnect
              </Button>
              <Button
                variant="destructive"
                disabled={busy !== null}
                onClick={() => {
                  if (!window.confirm('Log out and unlink this device? You will need to scan the QR code again.')) return;
                  void run('logout', () => api.post('/whatsapp/logout'), 'WhatsApp session cleared');
                }}
              >
                {busy === 'logout' ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
                Log out
              </Button>
            </div>

            <p className="text-xs text-muted-foreground">
              Uses WhatsApp Web multi-device pairing (Baileys). Session credentials are stored locally in{' '}
              <code className="rounded bg-black/30 px-1 py-0.5 font-mono">data/wa-auth</code>.
            </p>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader className="space-y-0">
              <CardTitle className="text-base">Send a test</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Sends a WhatsApp message from your linked account to itself.
              </p>
              <Field label="Message">
                <Input
                  value={testText}
                  onChange={(event) => setTestText(event.target.value)}
                  placeholder="Hello from my agent"
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && testText.trim() && connected && !sending) {
                      event.preventDefault();
                      void sendTest();
                    }
                  }}
                />
              </Field>
              <Button
                className="w-full"
                disabled={!connected || !testText.trim() || sending}
                onClick={() => void sendTest()}
              >
                {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                {sending ? 'Sending…' : 'Send test message'}
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="space-y-0">
              <CardTitle className="text-base">Session</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2.5 text-sm">
              <Row label="State" value={snapshot.state.replace('_', ' ')} />
              <Row label="Auto-reply" value={props.status.agent.autoReply ? 'Enabled' : 'Disabled'} />
              <Row label="Group mode" value={props.status.agent.groupMode} />
              <Row label="Status" value={props.status.agent.status === 'available' ? 'Available' : 'Away'} />
              <Row label="Started" value={snapshot.startedAt ? timeAgo(snapshot.startedAt) : '—'} />
              <Row label="Connected" value={snapshot.connectedAt ? timeAgo(snapshot.connectedAt) : '—'} />
              <div className="mt-3 flex gap-2">
                <Button
                  size="sm"
                  variant={props.status.agent.status === 'available' ? 'default' : 'outline'}
                  onClick={async () => {
                    try {
                      await api.put('/settings', { status: 'available' });
                      props.notify('Status set to available.', 'success');
                      await props.refresh();
                    } catch (e) {
                      props.notify('Could not update status.', 'error');
                    }
                  }}
                >
                  Available
                </Button>
                <Button
                  size="sm"
                  variant={props.status.agent.status === 'away' ? 'default' : 'outline'}
                  onClick={async () => {
                    try {
                      await api.put('/settings', { status: 'away' });
                      props.notify('Status set to away.', 'success');
                      await props.refresh();
                    } catch (e) {
                      props.notify('Could not update status.', 'error');
                    }
                  }}
                >
                  Away
                </Button>
                <Button
                  size="sm"
                  variant={props.status.agent.autoReply ? 'default' : 'outline'}
                  onClick={async () => {
                    try {
                      await api.put('/settings', { autoReply: !props.status.agent.autoReply });
                      props.notify(`Auto-reply ${!props.status.agent.autoReply ? 'enabled' : 'disabled'}.`, 'success');
                      await props.refresh();
                    } catch (e) {
                      props.notify('Could not update auto-reply.', 'error');
                    }
                  }}
                >
                  Auto-reply: {props.status.agent.autoReply ? 'On' : 'Off'}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <Card>
        <CardHeader className="space-y-0">
          <CardTitle className="text-base">How replies work</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm text-muted-foreground sm:grid-cols-3">
          <Explain icon={MessageCircle} title="Direct chats">
            Replies to incoming direct messages when auto-reply is enabled.
          </Explain>
          <Explain icon={Smartphone} title="Groups">
            Honors the group mode setting; mention mode only answers when tagged.
          </Explain>
          <Explain icon={CheckCircle2} title="Allow / block lists">
            Restrict which JIDs the bot may answer from Settings.
          </Explain>
        </CardContent>
      </Card>
    </div>
  );

  async function sendTest() {
    const text = testText.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await api.post('/whatsapp/send-test', { text });
      setTestText('');
      props.notify('Test message sent', 'success');
    } catch (error) {
      props.notify(error instanceof Error ? error.message : 'Could not send message', 'error');
    } finally {
      setSending(false);
    }
  }
}

function StateBadge({ state }: { state: AppStatus['whatsapp']['state'] }) {
  const map = {
    connected: { label: 'Connected', variant: 'success' as const, dot: 'bg-emerald-400' },
    qr: { label: 'Awaiting scan', variant: 'warning' as const, dot: 'bg-amber-400' },
    connecting: { label: 'Connecting', variant: 'secondary' as const, dot: 'bg-sky-400' },
    logged_out: { label: 'Logged out', variant: 'destructive' as const, dot: 'bg-red-400' },
    error: { label: 'Error', variant: 'destructive' as const, dot: 'bg-red-400' },
    disconnected: { label: 'Disconnected', variant: 'outline' as const, dot: 'bg-slate-400' },
  };
  const item = map[state];
  return (
    <Badge variant={item.variant}>
      <span className={cn('h-1.5 w-1.5 rounded-full', item.dot)} />
      {item.label}
    </Badge>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/50 pb-2 last:border-0 last:pb-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="truncate text-xs font-medium capitalize">{value}</span>
    </div>
  );
}

function Explain(props: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  children: ReactNode;
}) {
  const Icon = props.icon;
  return (
    <div className="rounded-lg border border-border/60 bg-background/30 p-3">
      <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-foreground">
        <Icon className="h-3.5 w-3.5 text-primary" />
        {props.title}
      </p>
      <p className="text-xs leading-relaxed">{props.children}</p>
    </div>
  );
}
