import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Loader2,
  MessageSquare,
  RefreshCw,
  Search,
  Trash2,
  Users,
  Wrench,
} from 'lucide-react';
import { Badge, Button, Card, CardContent, Input } from '../components/ui';
import { EmptyState, ErrorBlock, LoadingBlock, PageHeader } from '../components/common';
import type { Notify } from '../components/common';
import { RichText } from '../lib/markdown';
import { useApi } from '../lib/useApi';
import { fmtTime, timeAgo } from '../lib/types';
import type { ChatSummary, Message } from '../lib/types';
import { cn } from '../lib/utils';
import { api } from '../api';

export function ConversationsPage({ notify }: { notify: Notify }) {
  const chats = useApi<ChatSummary[]>('/conversations?limit=100');
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const messages = useApi<Message[]>(
    selected ? `/conversations/${encodeURIComponent(selected)}/messages?limit=200` : null,
  );
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const filtered = useMemo(() => {
    const list = chats.data ?? [];
    const needle = query.trim().toLowerCase();
    if (!needle) return list;
    return list.filter(
      (chat) =>
        (chat.name ?? '').toLowerCase().includes(needle) ||
        chat.chat_id.toLowerCase().includes(needle) ||
        shortJid(chat.chat_id).toLowerCase().includes(needle),
    );
  }, [chats.data, query]);

  const activeChat = useMemo(
    () => (chats.data ?? []).find((chat) => chat.chat_id === selected || shortJid(chat.chat_id) === selected) ?? null,
    [chats.data, selected],
  );

  useEffect(() => {
    if (selected) return;
    if (!window.matchMedia('(min-width: 1024px)').matches) return;
    const first = chats.data?.[0];
    if (first) setSelected(first.chat_id);
  }, [chats.data, selected]);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages.data]);

  const openChat = (chatId: string) => {
    setSelected(chatId);
  };

  const resetContext = async () => {
    if (!selected) return;
    if (!window.confirm('Clear the stored conversation context for this chat? Messages stay visible on WhatsApp.')) return;
    setBusy(true);
    try {
      await api.post(`/conversations/${encodeURIComponent(selected)}/reset`);
      await messages.refetch(true);
      await chats.refetch(true);
      notify('Conversation context cleared', 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Reset failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!selected) return;
    if (!window.confirm('Delete this conversation and its stored messages?')) return;
    setBusy(true);
    try {
      await api.del(`/conversations/${encodeURIComponent(selected)}`);
      setSelected(null);
      await chats.refetch(true);
      notify('Conversation deleted', 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Delete failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Conversations"
        description="Browse stored chats, inspect transcripts, and answer from the dashboard."
        actions={
          <Button variant="outline" onClick={() => { void chats.refetch(); void messages.refetch(true); }}>
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[330px_minmax(0,1fr)]">
        <Card className={cn('overflow-hidden', selected && 'hidden lg:block')}>
          <div className="border-b border-border p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search name or JID"
                className="pl-9"
              />
            </div>
          </div>

          <div className="max-h-[calc(100vh-16rem)] min-h-[18rem] overflow-y-auto scrollbar-thin">
            {chats.loading && !chats.data ? (
              <div className="p-3">
                <LoadingBlock label="Loading chats…" />
              </div>
            ) : chats.error ? (
              <div className="p-3">
                <ErrorBlock message={chats.error} onRetry={() => void chats.refetch()} />
              </div>
            ) : filtered.length === 0 ? (
              <div className="p-3">
                <EmptyState
                  compact
                  icon={MessageSquare}
                  title={query ? 'No matches' : 'No conversations yet'}
                  description={
                    query
                      ? 'Try a different name or number.'
                      : 'Chats appear here once someone messages your linked number.'
                  }
                />
              </div>
            ) : (
              <ul className="divide-y divide-border/60">
                {filtered.map((chat) => {
                  const active = chat.chat_id === selected;
                  const display = chat.name || shortJid(chat.chat_id);
                  return (
                    <li key={chat.chat_id}>
                      <button
                        type="button"
                        onClick={() => openChat(chat.chat_id)}
                        className={cn(
                          'flex w-full items-start gap-3 px-3 py-3 text-left transition-colors',
                          active ? 'bg-primary/10' : 'hover:bg-accent/50',
                        )}
                      >
                        <span
                          className={cn(
                            'mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                            chat.is_group
                              ? 'bg-sky-500/15 text-sky-300'
                              : 'bg-primary/15 text-primary',
                          )}
                        >
                          {chat.is_group ? <Users className="h-4 w-4" /> : initials(display)}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium">{display}</span>
                          </span>
                          <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
                            {shortJid(chat.chat_id)}
                          </span>
                          {chat.last_message && (
                            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                              {chat.last_message}
                            </span>
                          )}
                        </span>
                        <span className="shrink-0 text-right">
                          <span className="block text-[10px] text-muted-foreground">
                            {timeAgo(chat.last_message_at)}
                          </span>
                          <span className="mt-1 inline-block rounded-full bg-accent px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            {chat.message_count}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </Card>

        <Card className={cn('flex min-h-[32rem] flex-col overflow-hidden', !selected && 'hidden lg:flex')}>
          {selected ? (
            <>
              <div className="flex flex-wrap items-center gap-3 border-b border-border p-3">
                <button
                  type="button"
                  onClick={() => setSelected(null)}
                  className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground lg:hidden"
                  aria-label="Back to conversations"
                >
                  <ArrowLeft className="h-4 w-4" />
                </button>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 truncate text-sm font-semibold">
                    {activeChat?.name || shortJid(selected)}
                  </p>
                  <p className="truncate font-mono text-[11px] text-muted-foreground">{shortJid(selected)}</p>
                </div>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void resetContext()}>
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  Reset context
                </Button>
                <Button size="sm" variant="destructive" disabled={busy} onClick={() => void remove()}>
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete
                </Button>
              </div>

              <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4 scrollbar-thin">
                {messages.loading && !messages.data ? (
                  <LoadingBlock label="Loading messages…" />
                ) : messages.error ? (
                  <ErrorBlock message={messages.error} onRetry={() => void messages.refetch()} />
                ) : (messages.data?.length ?? 0) === 0 ? (
                  <EmptyState
                    icon={MessageSquare}
                    title="No stored messages"
                    description="Messages appear here as contacts talk to your agents on WhatsApp."
                  />
                ) : (
                  messages.data!.map((message) => <MessageBubble key={message.id} message={message} />)
                )}
              </div>

              <div className="border-t border-border bg-background/40 px-3 py-2.5">
                <p className="text-[11px] text-muted-foreground">
                  Read-only transcript — agents send and receive through their own WhatsApp integrations.
                </p>
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center p-6">
              <EmptyState
                icon={MessageSquare}
                title="Select a conversation"
                description="Pick a chat on the left to read the transcript."
              />
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: Message }) {
  if (message.role === 'tool' || message.role === 'system') {
    return (
      <div className="flex justify-center">
        <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-background/60 px-2.5 py-1 text-[11px] text-muted-foreground">
          <Wrench className="h-3 w-3 shrink-0" />
          <span className="truncate">
            {message.tool_name ? `${message.tool_name}: ` : ''}
            {message.content.slice(0, 140)}
          </span>
        </span>
      </div>
    );
  }

  const fromUser = message.role === 'user';

  return (
    <div className={cn('flex', fromUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-2xl border px-3.5 py-2.5 text-sm shadow-sm sm:max-w-[75%]',
          fromUser
            ? 'rounded-br-md border-primary/25 bg-primary/10'
            : 'rounded-bl-md border-border bg-card',
        )}
      >
        <div className="mb-1 flex items-center gap-2 text-[10px] text-muted-foreground">
          <span className="font-medium">{message.sender_name || (fromUser ? 'User' : 'Agent')}</span>
          <span>{fmtTime(message.created_at)}</span>
        </div>
        {fromUser ? <p className="whitespace-pre-wrap break-words">{message.content}</p> : <RichText text={message.content} />}
      </div>
    </div>
  );
}

function shortJid(chatId: string): string {
  return chatId.replace(/@s\.whatsapp\.net$/, '').replace(/@g\.us$/, '');
}

function initials(value: string): string {
  const parts = value.trim().split(/\s+/).slice(0, 2);
  const text = parts.map((part) => part[0]?.toUpperCase() ?? '').join('');
  return text || '?';
}
