import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

export const db = new DatabaseSync(path.join(config.dataDir, 'agent.sqlite'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS secrets (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS knowledge_documents (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    source_type TEXT NOT NULL DEFAULT 'text',
    source_name TEXT,
    mime_type TEXT,
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ready',
    error TEXT,
    char_count INTEGER NOT NULL DEFAULT 0,
    chunk_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS knowledge_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    token_count INTEGER NOT NULL DEFAULT 0,
    embedding BLOB,
    embedding_model TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_chunks_document ON knowledge_chunks(document_id);

  CREATE TABLE IF NOT EXISTS chats (
    chat_id TEXT PRIMARY KEY,
    name TEXT,
    is_group INTEGER NOT NULL DEFAULT 0,
    message_count INTEGER NOT NULL DEFAULT 0,
    last_message_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(chat_id) ON DELETE CASCADE,
    message_id TEXT,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    sender_name TEXT,
    tool_name TEXT,
    created_at TEXT NOT NULL,
    meta TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_messages_message_id ON messages(message_id);

  CREATE TABLE IF NOT EXISTS processed_messages (
    message_id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_processed_chat ON processed_messages(chat_id);

  CREATE TABLE IF NOT EXISTS mcp_servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    transport TEXT NOT NULL,
    command TEXT,
    args TEXT NOT NULL DEFAULT '[]',
    env TEXT NOT NULL DEFAULT '{}',
    cwd TEXT,
    url TEXT,
    headers TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    disabled_tools TEXT NOT NULL DEFAULT '[]',
    last_status TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY,
    chat_id TEXT,
    source TEXT NOT NULL,
    model TEXT NOT NULL,
    user_text TEXT NOT NULL,
    response TEXT,
    tool_calls TEXT,
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    latency_ms INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_agent_runs_chat ON agent_runs(chat_id, created_at);

  /* ---------------- Local Hub (official WhatsApp + OpenCode) ---------------- */

  CREATE TABLE IF NOT EXISTS hub_agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT 'openrouter/openai/gpt-4.1-mini',
    system_prompt TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    auto_start INTEGER NOT NULL DEFAULT 1,
    typing_indicator INTEGER NOT NULL DEFAULT 1,
    read_receipts INTEGER NOT NULL DEFAULT 1,
    creator_id TEXT,
    next_offset TEXT,
    status TEXT NOT NULL DEFAULT 'stopped',
    last_error TEXT,
    last_seen_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS hub_agent_mcp (
    agent_id TEXT NOT NULL REFERENCES hub_agents(id) ON DELETE CASCADE,
    server_id TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
    enabled INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (agent_id, server_id)
  );

  CREATE TABLE IF NOT EXISTS hub_skills (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES hub_agents(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_hub_skills_agent ON hub_skills(agent_id);

  CREATE TABLE IF NOT EXISTS hub_schedules (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES hub_agents(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    cron_expr TEXT NOT NULL,
    prompt TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_hub_schedules_agent ON hub_schedules(agent_id);

  CREATE TABLE IF NOT EXISTS hub_agent_knowledge (
    agent_id TEXT NOT NULL REFERENCES hub_agents(id) ON DELETE CASCADE,
    document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
    PRIMARY KEY (agent_id, document_id)
  );

  CREATE TABLE IF NOT EXISTS hub_sessions (
    agent_id TEXT NOT NULL REFERENCES hub_agents(id) ON DELETE CASCADE,
    conversation_key TEXT NOT NULL DEFAULT '',
    session_id TEXT NOT NULL,
    working_directory TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, conversation_key)
  );

  CREATE TABLE IF NOT EXISTS hub_messages (
    message_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    direction TEXT NOT NULL,
    peer_id TEXT NOT NULL,
    body TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_hub_messages_agent ON hub_messages(agent_id, created_at);
`);

// Older hub builds stored one session per agent. Migrate them to per-conversation keys.
const hubSessionColumns = db.prepare("PRAGMA table_info('hub_sessions')").all() as Array<{ name: string }>;
if (!hubSessionColumns.some((column) => column.name === 'conversation_key')) {
  db.exec(`
    BEGIN;
    ALTER TABLE hub_sessions RENAME TO hub_sessions_legacy;
    CREATE TABLE hub_sessions (
      agent_id TEXT NOT NULL REFERENCES hub_agents(id) ON DELETE CASCADE,
      conversation_key TEXT NOT NULL DEFAULT '',
      session_id TEXT NOT NULL,
      working_directory TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (agent_id, conversation_key)
    );
    INSERT INTO hub_sessions (agent_id, conversation_key, session_id, working_directory, updated_at)
      SELECT agent_id, '', session_id, working_directory, updated_at FROM hub_sessions_legacy;
    DROP TABLE hub_sessions_legacy;
    COMMIT;
  `);
}

export function transaction<T>(fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
