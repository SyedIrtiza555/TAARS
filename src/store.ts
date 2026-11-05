import { db, transaction } from './db.js';
import { newId, nowIso, safeJson } from './util.js';

export type StoredMessage = {
  id: string;
  chat_id: string;
  message_id: string | null;
  role: string;
  content: string;
  sender_name: string | null;
  tool_name: string | null;
  created_at: string;
  meta: Record<string, unknown> | null;
};

export type ChatSummary = {
  chat_id: string;
  name: string | null;
  is_group: number;
  message_count: number;
  last_message_at: string | null;
  created_at: string;
  last_message?: string | null;
};

export function ensureChat(chatId: string, name?: string | null, isGroup = false): void {
  db.prepare(
    `INSERT INTO chats (chat_id, name, is_group, message_count, last_message_at, created_at)
     VALUES (?, ?, ?, 0, NULL, ?)
     ON CONFLICT(chat_id) DO UPDATE SET
       name = COALESCE(excluded.name, chats.name),
       is_group = excluded.is_group`,
  ).run(chatId, name || null, isGroup ? 1 : 0, nowIso());
}

export function saveMessage(input: {
  chatId: string;
  role: string;
  content: string;
  messageId?: string | null;
  senderName?: string | null;
  toolName?: string | null;
  meta?: Record<string, unknown> | null;
  createdAt?: string;
}): StoredMessage {
  const at = input.createdAt || nowIso();
  const id = newId('msg');
  transaction(() => {
    ensureChat(input.chatId);
    db.prepare(
      `INSERT INTO messages (id, chat_id, message_id, role, content, sender_name, tool_name, created_at, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.chatId,
      input.messageId || null,
      input.role,
      input.content,
      input.senderName || null,
      input.toolName || null,
      at,
      input.meta ? JSON.stringify(input.meta) : null,
    );
    db.prepare(
      `UPDATE chats SET message_count = message_count + 1, last_message_at = ?,
       name = COALESCE(name, ?) WHERE chat_id = ?`,
    ).run(at, input.senderName || null, input.chatId);
  });
  return getMessage(id)!;
}

export function getMessage(id: string): StoredMessage | null {
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as
    | (Omit<StoredMessage, 'meta'> & { meta: string | null })
    | undefined;
  if (!row) return null;
  return { ...row, meta: row.meta ? safeJson<Record<string, unknown>>(row.meta, {}) : null };
}

export function getHistory(chatId: string, limit: number): StoredMessage[] {
  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT * FROM messages WHERE chat_id = ? AND role IN ('user', 'assistant')
         ORDER BY created_at DESC LIMIT ?
       ) ORDER BY created_at ASC`,
    )
    .all(chatId, limit) as unknown as Array<Omit<StoredMessage, 'meta'> & { meta: string | null }>;
  return rows.map((row) => ({
    ...row,
    meta: row.meta ? safeJson<Record<string, unknown>>(row.meta, {}) : null,
  }));
}

export function getMessages(chatId: string, limit = 100): StoredMessage[] {
  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?
       ) ORDER BY created_at ASC`,
    )
    .all(chatId, limit) as unknown as Array<Omit<StoredMessage, 'meta'> & { meta: string | null }>;
  return rows.map((row) => ({
    ...row,
    meta: row.meta ? safeJson<Record<string, unknown>>(row.meta, {}) : null,
  }));
}

export function listChats(limit = 30): ChatSummary[] {
  return db
    .prepare(
      `SELECT c.*,
        (SELECT content FROM messages m WHERE m.chat_id = c.chat_id ORDER BY m.created_at DESC LIMIT 1) AS last_message
       FROM chats c
       WHERE c.message_count > 0
       ORDER BY COALESCE(c.last_message_at, c.created_at) DESC
       LIMIT ?`,
    )
    .all(limit) as unknown as ChatSummary[];
}

export function resetChat(chatId: string): void {
  transaction(() => {
    db.prepare('DELETE FROM messages WHERE chat_id = ?').run(chatId);
    db.prepare('UPDATE chats SET message_count = 0, last_message_at = NULL WHERE chat_id = ?').run(chatId);
  });
}

export function deleteChat(chatId: string): void {
  db.prepare('DELETE FROM chats WHERE chat_id = ?').run(chatId);
}

export function markProcessed(messageId: string, chatId: string): boolean {
  const result = db
    .prepare('INSERT OR IGNORE INTO processed_messages (message_id, chat_id, created_at) VALUES (?, ?, ?)')
    .run(messageId, chatId, nowIso());
  return result.changes > 0;
}

export function getStats(): {
  chats: number;
  messages: number;
  agentRuns: number;
  tokensIn: number;
  tokensOut: number;
} {
  const chats = db.prepare('SELECT COUNT(*) AS n FROM chats WHERE message_count > 0').get() as { n: number };
  const messages = db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number };
  const runs = db
    .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(tokens_in), 0) AS ti, COALESCE(SUM(tokens_out), 0) AS to_ FROM agent_runs')
    .get() as { n: number; ti: number; to_: number };
  return { chats: chats.n, messages: messages.n, agentRuns: runs.n, tokensIn: runs.ti, tokensOut: runs.to_ };
}

export function recordAgentRun(input: {
  chatId: string;
  source: string;
  model: string;
  userText: string;
  response: string;
  toolCalls: Array<{ name: string; args?: unknown; result?: string; error?: string }>;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  error?: string | null;
}): void {
  db.prepare(
    `INSERT INTO agent_runs
     (id, chat_id, source, model, user_text, response, tool_calls, tokens_in, tokens_out, latency_ms, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId('run'),
    input.chatId,
    input.source,
    input.model,
    input.userText,
    input.response,
    JSON.stringify(input.toolCalls),
    input.tokensIn,
    input.tokensOut,
    input.latencyMs,
    input.error || null,
    nowIso(),
  );
}

export function listAgentRuns(limit = 20): Array<Record<string, unknown>> {
  return db
    .prepare('SELECT * FROM agent_runs ORDER BY created_at DESC LIMIT ?')
    .all(limit) as unknown as Array<Record<string, unknown>>;
}
