import { useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  Bot,
  Check,
  ChevronDown,
  Copy,
  FlaskConical,
  Loader2,
  RotateCcw,
  Send,
  Sparkles,
  Wrench,
} from 'lucide-react';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from '../components/ui';
import { EmptyState, PageHeader } from '../components/common';
import type { Notify } from '../components/common';
import { RichText } from '../lib/markdown';
import { useApi } from '../lib/useApi';
import { fmtTime } from '../lib/types';
import type { AgentResult, Message, Source, ToolCall } from '../lib/types';
import { cn } from '../lib/utils';
import { api } from '../api';

const SUGGESTIONS = [
  'Introduce yourself in one short paragraph.',
  'What can you help me with today?',
  'Search my knowledge base and summarize what you find.',
];

export function PlaygroundPage(props: { notify: Notify; botName: string }) {
  const history = useApi<Message[]>('/conversations/web:playground/messages?limit=100');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [last, setLast] = useState<AgentResult | null>(null);
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [history.data, sending]);

  const send = async (text: string) => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    setDraft('');
    setLast(null);
    try {
      const result = await api.post<AgentResult>('/playground', { message: value });
      setLast(result);
      if (result.error) props.notify(result.error, 'error');
      await history.refetch(true);
    } catch (error) {
      setDraft(value);
      props.notify(error instanceof Error ? error.message : 'Agent request failed', 'error');
    } finally {
      setSending(false);
    }
  };

  const reset = async () => {
    setResetting(true);
    try {
      await api.post('/agent/reset-playground');
      setLast(null);
      await history.refetch(true);
      props.notify('Playground context reset', 'success');
    } catch (error) {
      props.notify(error instanceof Error ? error.message : 'Reset failed', 'error');
    } finally {
      setResetting(false);
    }
  };

  const lastAssistant = [...(history.data ?? [])].reverse().find((message) => message.role === 'assistant');

  const copyLast = async () => {
    const text = last?.text || lastAssistant?.content;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      props.notify('Clipboard is not available in this browser', 'error');
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Playground"
        description="Talk to the agent directly — same model, tools, and knowledge as WhatsApp, without sending a message."
        actions={
          <>
            <Button variant="outline" onClick={() => void copyLast()} disabled={!lastAssistant && !last}>
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              {copied ? 'Copied' : 'Copy reply'}
            </Button>
            <Button variant="outline" onClick={() => void reset()} disabled={resetting || sending}>
              {resetting ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
              Reset
            </Button>
          </>
        }
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Card className="flex min-h-[34rem] flex-col overflow-hidden">
          <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto p-4 scrollbar-thin">
            {history.loading && !history.data ? (
              <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading transcript…
              </div>
            ) : (history.data?.length ?? 0) === 0 && !sending ? (
              <div className="flex h-full flex-col items-center justify-center gap-5 py-8">
                <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/15 text-primary ring-1 ring-primary/25">
                  <FlaskConical className="h-6 w-6" />
                </span>
                <div className="space-y-1 text-center">
                  <p className="text-sm font-medium">Test {props.botName} without WhatsApp</p>
                  <p className="max-w-sm text-xs text-muted-foreground">
                    Messages here use the same system prompt, tools, and knowledge as live chats.
                  </p>
                </div>
                <div className="flex w-full max-w-md flex-col gap-2">
                  {SUGGESTIONS.map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      onClick={() => void send(suggestion)}
                      className="flex items-center gap-2 rounded-lg border border-border bg-background/40 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:border-primary/30 hover:bg-primary/5 hover:text-foreground"
                    >
                      <Sparkles className="h-3.5 w-3.5 shrink-0 text-primary" />
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              history.data!.map((message) => <Bubble key={message.id} message={message} botName={props.botName} />)
            )}

            {sending && (
              <div className="flex items-start gap-2.5">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                  <Bot className="h-4 w-4" />
                </span>
                <div className="flex items-center gap-2 rounded-2xl rounded-tl-md border border-border bg-card px-3.5 py-2.5 text-sm text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Thinking…
                </div>
              </div>
            )}
          </div>

          <div className="border-t border-border p-3">
            <div className="flex items-end gap-2">
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void send(draft);
                  }
                }}
                rows={2}
                disabled={sending}
                placeholder={`Message ${props.botName}… (Enter to send)`}
                className="max-h-40 min-h-[2.75rem] flex-1 resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
              />
              <Button className="h-11" disabled={!draft.trim() || sending} onClick={() => void send(draft)}>
                {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                Send
              </Button>
            </div>
            <p className="mt-1.5 px-1 text-[11px] text-muted-foreground">
              Transcript is stored as <code className="font-mono">web:playground</code>; reset to start fresh.
            </p>
          </div>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader className="space-y-0">
              <CardTitle className="text-base">Last response</CardTitle>
            </CardHeader>
            <CardContent>
              {last ? (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="success" size="sm">{last.latencyMs} ms</Badge>
                    <Badge variant="outline" size="sm">{last.usage.input} in</Badge>
                    <Badge variant="outline" size="sm">{last.usage.output} out</Badge>
                    {last.toolCalls.length > 0 && (
                      <Badge variant="secondary" size="sm">{last.toolCalls.length} tool calls</Badge>
                    )}
                  </div>
                  <p className="break-all font-mono text-[11px] text-muted-foreground">{last.model}</p>
                  {last.error && (
                    <p className="rounded-md border border-red-500/25 bg-red-500/10 p-2 text-xs text-red-300">
                      {last.error}
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Send a message to see latency, token usage, retrieval sources, and tool calls.
                </p>
              )}
            </CardContent>
          </Card>

          {(last?.sources.length ?? 0) > 0 && (
            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <CardTitle className="text-base">Knowledge sources</CardTitle>
                <Badge variant="secondary" size="sm">{last!.sources.length}</Badge>
              </CardHeader>
              <CardContent className="space-y-2">
                {last!.sources.map((source) => (
                  <SourceRow key={`${source.documentId}-${source.chunkId}`} source={source} />
                ))}
              </CardContent>
            </Card>
          )}

          {(last?.toolCalls.length ?? 0) > 0 && (
            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <CardTitle className="text-base">Tool calls</CardTitle>
                <Badge variant="secondary" size="sm">{last!.toolCalls.length}</Badge>
              </CardHeader>
              <CardContent className="space-y-2">
                {last!.toolCalls.map((call) => (
                  <ToolRow key={call.id} call={call} />
                ))}
              </CardContent>
            </Card>
          )}

          {!last && (
            <Card>
              <CardContent className="flex flex-col items-center gap-2 py-8 text-center">
                <BookOpen className="h-5 w-5 text-muted-foreground" />
                <p className="text-xs text-muted-foreground">
                  Retrieval details appear here after the first reply.
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function Bubble({ message, botName }: { message: Message; botName: string }) {
  if (message.role === 'tool' || message.role === 'system') {
    return (
      <div className="flex justify-center">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background/60 px-2.5 py-1 text-[11px] text-muted-foreground">
          <Wrench className="h-3 w-3" />
          {message.tool_name || 'tool'}
        </span>
      </div>
    );
  }

  const fromUser = message.role === 'user';

  return (
    <div className={cn('flex items-start gap-2.5', fromUser ? 'justify-end' : 'justify-start')}>
      {!fromUser && (
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
          <Bot className="h-4 w-4" />
        </span>
      )}
      <div
        className={cn(
          'max-w-[85%] rounded-2xl border px-3.5 py-2.5 text-sm',
          fromUser
            ? 'rounded-tr-md border-primary/25 bg-primary/10'
            : 'rounded-tl-md border-border bg-card',
        )}
      >
        <div className="mb-1 flex items-center gap-2 text-[10px] text-muted-foreground">
          <span className="font-medium">{fromUser ? message.sender_name || 'You' : botName}</span>
          <span>{fmtTime(message.created_at)}</span>
        </div>
        {fromUser ? <p className="whitespace-pre-wrap break-words">{message.content}</p> : <RichText text={message.content} />}
      </div>
    </div>
  );
}

function SourceRow({ source }: { source: Source }) {
  return (
    <details className="group rounded-lg border border-border/70 bg-background/40 p-2.5">
      <summary className="flex cursor-pointer list-none items-center gap-2">
        <BookOpen className="h-3.5 w-3.5 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{source.title}</span>
        <Badge variant="outline" size="sm">{Math.round(source.score * 100)}%</Badge>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <p className="mt-2 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-muted-foreground">
        {source.content}
      </p>
    </details>
  );
}

function ToolRow({ call }: { call: ToolCall }) {
  return (
    <details className="group rounded-lg border border-border/70 bg-background/40 p-2.5">
      <summary className="flex cursor-pointer list-none items-center gap-2">
        <Wrench className="h-3.5 w-3.5 shrink-0 text-amber-400" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{call.name}</span>
        {call.error ? (
          <Badge variant="destructive" size="sm">error</Badge>
        ) : (
          <Badge variant="success" size="sm">ok</Badge>
        )}
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="mt-2 space-y-2">
        <pre className="max-h-40 overflow-auto rounded-md bg-black/40 p-2 font-mono text-[10px] leading-relaxed text-muted-foreground scrollbar-thin">
          {JSON.stringify(call.args, null, 2)}
        </pre>
        {(call.error || call.result) && (
          <p className={cn('whitespace-pre-wrap break-words text-[11px]', call.error ? 'text-red-300' : 'text-muted-foreground')}>
            {call.error || call.result}
          </p>
        )}
      </div>
    </details>
  );
}
