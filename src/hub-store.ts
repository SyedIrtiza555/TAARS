import { db, transaction } from './db.js';
import { deleteSecret, getSecret, hasSecret, setSecret } from './secrets.js';
import { newId, nowIso } from './util.js';

export type HubAgent = {
  id: string;
  name: string;
  model: string;
  systemPrompt: string;
  enabled: boolean;
  autoStart: boolean;
  typingIndicator: boolean;
  readReceipts: boolean;
  creatorId: string | null;
  nextOffset: string | null;
  status: string;
  lastError: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
  hasToken: boolean;
  mcpServerIds: string[];
  knowledgeIds: string[];
  sessionId: string | null;
  skillCount: number;
  scheduleCount: number;
};

export type HubSkill = {
  id: string;
  agentId: string;
  name: string;
  description: string;
  body: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type HubSchedule = {
  id: string;
  agentId: string;
  name: string;
  cronExpr: string;
  prompt: string;
  enabled: boolean;
  lastRun: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type HubAgentDetail = HubAgent & {
  skills: HubSkill[];
  schedules: HubSchedule[];
};

type AgentRow = {
  id: string;
  name: string;
  model: string;
  system_prompt: string;
  enabled: number;
  auto_start: number;
  typing_indicator: number;
  read_receipts: number;
  creator_id: string | null;
  next_offset: string | null;
  status: string;
  last_error: string | null;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
  skill_count?: number;
  schedule_count?: number;
};

type SkillRow = {
  id: string;
  agent_id: string;
  name: string;
  description: string;
  body: string;
  enabled: number;
  created_at: string;
  updated_at: string;
};

type ScheduleRow = {
  id: string;
  agent_id: string;
  name: string;
  cron_expr: string;
  prompt: string;
  enabled: number;
  last_run: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export type CreateAgentInput = {
  name: string;
  model?: string;
  systemPrompt?: string;
  enabled?: boolean;
  autoStart?: boolean;
  typingIndicator?: boolean;
  readReceipts?: boolean;
  token?: string | null;
  mcpServerIds?: string[];
  knowledgeIds?: string[];
};

export type UpdateAgentInput = Partial<Omit<CreateAgentInput, 'token'>> & {
  token?: string | null;
};

const DEFAULT_MODEL = 'openrouter/openai/gpt-4.1-mini';
const DEFAULT_PROMPT =
  'You are a helpful WhatsApp assistant. Reply clearly and concisely. Prefer short paragraphs and plain text over tables.';

function tokenKey(agentId: string): string {
  return `hub_agent_token:${agentId}`;
}

function agentRowToRecord(row: AgentRow): HubAgent {
  const mcpRows = db
    .prepare('SELECT server_id FROM hub_agent_mcp WHERE agent_id = ? AND enabled = 1')
    .all(row.id) as unknown as Array<{ server_id: string }>;
  const knowledgeRows = db
    .prepare('SELECT document_id FROM hub_agent_knowledge WHERE agent_id = ?')
    .all(row.id) as unknown as Array<{ document_id: string }>;
  const session = db
    .prepare('SELECT session_id FROM hub_sessions WHERE agent_id = ?')
    .get(row.id) as { session_id?: string } | undefined;

  let hasToken = false;
  try {
    hasToken = hasSecret(tokenKey(row.id));
  } catch {
    hasToken = false;
  }

  return {
    id: row.id,
    name: row.name,
    model: row.model,
    systemPrompt: row.system_prompt,
    enabled: Boolean(row.enabled),
    autoStart: Boolean(row.auto_start),
    typingIndicator: Boolean(row.typing_indicator),
    readReceipts: Boolean(row.read_receipts),
    creatorId: row.creator_id,
    nextOffset: row.next_offset,
    status: row.status,
    lastError: row.last_error,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    hasToken,
    mcpServerIds: mcpRows.map((item) => item.server_id),
    knowledgeIds: knowledgeRows.map((item) => item.document_id),
    sessionId: session?.session_id ?? null,
    skillCount: Number(row.skill_count ?? 0),
    scheduleCount: Number(row.schedule_count ?? 0),
  };
}

export function listAgents(): HubAgent[] {
  const rows = db
    .prepare(
      `SELECT a.*,
         (SELECT COUNT(*) FROM hub_skills s WHERE s.agent_id = a.id) AS skill_count,
         (SELECT COUNT(*) FROM hub_schedules c WHERE c.agent_id = a.id) AS schedule_count
       FROM hub_agents a
       ORDER BY a.created_at ASC`,
    )
    .all() as unknown as AgentRow[];
  return rows.map(agentRowToRecord);
}

export function getAgent(id: string): HubAgent | null {
  const row = db
    .prepare(
      `SELECT a.*,
         (SELECT COUNT(*) FROM hub_skills s WHERE s.agent_id = a.id) AS skill_count,
         (SELECT COUNT(*) FROM hub_schedules c WHERE c.agent_id = a.id) AS schedule_count
       FROM hub_agents a WHERE a.id = ?`,
    )
    .get(id) as unknown as AgentRow | undefined;
  return row ? agentRowToRecord(row) : null;
}

export function getAgentDetail(id: string): HubAgentDetail | null {
  const agent = getAgent(id);
  if (!agent) return null;
  return {
    ...agent,
    skills: listSkills(id),
    schedules: listSchedules(id),
  };
}

export function getAgentToken(id: string): string | null {
  try {
    return getSecret(tokenKey(id));
  } catch {
    return null;
  }
}

export function setAgentToken(id: string, token: string | null): void {
  if (!token?.trim()) {
    deleteSecret(tokenKey(id));
    return;
  }
  setSecret(tokenKey(id), token.trim());
}

export function createAgent(input: CreateAgentInput): HubAgent {
  const id = newId('hub');
  const timestamp = nowIso();
  db.prepare(
    `INSERT INTO hub_agents
      (id, name, model, system_prompt, enabled, auto_start, typing_indicator, read_receipts,
       status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'stopped', ?, ?)`,
  ).run(
    id,
    input.name.trim(),
    (input.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL,
    input.systemPrompt ?? DEFAULT_PROMPT,
    input.enabled === false ? 0 : 1,
    input.autoStart === false ? 0 : 1,
    input.typingIndicator === false ? 0 : 1,
    input.readReceipts === false ? 0 : 1,
    timestamp,
    timestamp,
  );
  if (input.token?.trim()) setAgentToken(id, input.token);
  if (input.mcpServerIds) setAgentMcpServers(id, input.mcpServerIds);
  if (input.knowledgeIds) setAgentKnowledge(id, input.knowledgeIds);
  return getAgent(id)!;
}

export function updateAgent(id: string, patch: UpdateAgentInput): HubAgent | null {
  const current = getAgent(id);
  if (!current) return null;
  const next = {
    name: patch.name?.trim() || current.name,
    model: patch.model?.trim() || current.model,
    systemPrompt: patch.systemPrompt ?? current.systemPrompt,
    enabled: patch.enabled ?? current.enabled,
    autoStart: patch.autoStart ?? current.autoStart,
    typingIndicator: patch.typingIndicator ?? current.typingIndicator,
    readReceipts: patch.readReceipts ?? current.readReceipts,
  };
  db.prepare(
    `UPDATE hub_agents SET
       name = ?, model = ?, system_prompt = ?, enabled = ?, auto_start = ?,
       typing_indicator = ?, read_receipts = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    next.name,
    next.model,
    next.systemPrompt,
    next.enabled ? 1 : 0,
    next.autoStart ? 1 : 0,
    next.typingIndicator ? 1 : 0,
    next.readReceipts ? 1 : 0,
    nowIso(),
    id,
  );
  if (patch.token !== undefined) setAgentToken(id, patch.token);
  if (patch.mcpServerIds) setAgentMcpServers(id, patch.mcpServerIds);
  if (patch.knowledgeIds) setAgentKnowledge(id, patch.knowledgeIds);
  return getAgent(id);
}

export function deleteAgent(id: string): boolean {
  deleteSecret(tokenKey(id));
  const result = db.prepare('DELETE FROM hub_agents WHERE id = ?').run(id);
  return result.changes > 0;
}

export function setAgentMcpServers(agentId: string, serverIds: string[]): void {
  const existing = new Set(
    (db.prepare('SELECT id FROM mcp_servers').all() as unknown as Array<{ id: string }>).map((row) => row.id),
  );
  const ids = [...new Set(serverIds)].filter((id) => existing.has(id));
  transaction(() => {
    db.prepare('DELETE FROM hub_agent_mcp WHERE agent_id = ?').run(agentId);
    const insert = db.prepare(
      'INSERT INTO hub_agent_mcp (agent_id, server_id, enabled) VALUES (?, ?, 1)',
    );
    for (const serverId of ids) insert.run(agentId, serverId);
  });
}

export function setAgentKnowledge(agentId: string, documentIds: string[]): void {
  const existing = new Set(
    (db.prepare('SELECT id FROM knowledge_documents').all() as unknown as Array<{ id: string }>).map(
      (row) => row.id,
    ),
  );
  const ids = [...new Set(documentIds)].filter((id) => existing.has(id));
  transaction(() => {
    db.prepare('DELETE FROM hub_agent_knowledge WHERE agent_id = ?').run(agentId);
    const insert = db.prepare(
      'INSERT INTO hub_agent_knowledge (agent_id, document_id) VALUES (?, ?)',
    );
    for (const documentId of ids) insert.run(agentId, documentId);
  });
}

export function setAgentStatus(id: string, status: string, error: string | null = null): void {
  db.prepare('UPDATE hub_agents SET status = ?, last_error = ?, updated_at = ? WHERE id = ?').run(
    status,
    error,
    nowIso(),
    id,
  );
}

export function markAgentSeen(id: string, creatorId: string | null = null): void {
  if (creatorId) {
    db.prepare(
      'UPDATE hub_agents SET creator_id = COALESCE(creator_id, ?), last_seen_at = ?, updated_at = ? WHERE id = ?',
    ).run(creatorId, nowIso(), nowIso(), id);
  } else {
    db.prepare('UPDATE hub_agents SET last_seen_at = ?, updated_at = ? WHERE id = ?').run(
      nowIso(),
      nowIso(),
      id,
    );
  }
}

export function setAgentOffset(id: string, offset: string | null): void {
  db.prepare('UPDATE hub_agents SET next_offset = ?, updated_at = ? WHERE id = ?').run(
    offset,
    nowIso(),
    id,
  );
}

export function getSession(
  agentId: string,
  conversationKey = '',
): { sessionId: string; directory: string } | null {
  const row = db
    .prepare('SELECT session_id, working_directory FROM hub_sessions WHERE agent_id = ? AND conversation_key = ?')
    .get(agentId, conversationKey) as { session_id?: string; working_directory?: string } | undefined;
  if (!row?.session_id || !row.working_directory) return null;
  return { sessionId: row.session_id, directory: row.working_directory };
}

export function setSession(
  agentId: string,
  conversationKey: string,
  sessionId: string,
  directory: string,
): void {
  db.prepare(
    `INSERT INTO hub_sessions (agent_id, conversation_key, session_id, working_directory, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(agent_id, conversation_key) DO UPDATE SET
       session_id = excluded.session_id,
       working_directory = excluded.working_directory,
       updated_at = excluded.updated_at`,
  ).run(agentId, conversationKey, sessionId, directory, nowIso());
}

export function clearSession(agentId: string, conversationKey?: string): void {
  if (conversationKey === undefined) {
    db.prepare('DELETE FROM hub_sessions WHERE agent_id = ?').run(agentId);
    return;
  }
  db.prepare('DELETE FROM hub_sessions WHERE agent_id = ? AND conversation_key = ?').run(agentId, conversationKey);
}

export function hasHubMessage(messageId: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM hub_messages WHERE message_id = ?').get(messageId));
}

export function recordHubMessage(input: {
  messageId: string;
  agentId: string;
  direction: 'in' | 'out';
  peerId: string;
  body?: string | null;
}): boolean {
  const result = db.prepare(
    `INSERT OR IGNORE INTO hub_messages (message_id, agent_id, direction, peer_id, body, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.messageId,
    input.agentId,
    input.direction,
    input.peerId,
    input.body ?? null,
    nowIso(),
  );
  return result.changes > 0;
}

export function listSkills(agentId: string): HubSkill[] {
  const rows = db
    .prepare('SELECT * FROM hub_skills WHERE agent_id = ? ORDER BY created_at ASC')
    .all(agentId) as unknown as SkillRow[];
  return rows.map((row) => ({
    id: row.id,
    agentId: row.agent_id,
    name: row.name,
    description: row.description,
    body: row.body,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function addSkill(input: {
  agentId: string;
  name: string;
  description?: string;
  body: string;
  enabled?: boolean;
}): HubSkill {
  const id = newId('skill');
  const timestamp = nowIso();
  db.prepare(
    `INSERT INTO hub_skills (id, agent_id, name, description, body, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.agentId,
    input.name.trim(),
    input.description?.trim() || '',
    input.body,
    input.enabled === false ? 0 : 1,
    timestamp,
    timestamp,
  );
  return getSkill(id)!;
}

export function getSkill(id: string): HubSkill | null {
  const row = db.prepare('SELECT * FROM hub_skills WHERE id = ?').get(id) as
    | SkillRow
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    agentId: row.agent_id,
    name: row.name,
    description: row.description,
    body: row.body,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function updateSkill(
  id: string,
  patch: Partial<{ name: string; description: string; body: string; enabled: boolean }>,
): HubSkill | null {
  const current = getSkill(id);
  if (!current) return null;
  db.prepare(
    `UPDATE hub_skills SET name = ?, description = ?, body = ?, enabled = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    patch.name?.trim() || current.name,
    patch.description ?? current.description,
    patch.body ?? current.body,
    (patch.enabled ?? current.enabled) ? 1 : 0,
    nowIso(),
    id,
  );
  return getSkill(id);
}

export function deleteSkill(id: string): boolean {
  return db.prepare('DELETE FROM hub_skills WHERE id = ?').run(id).changes > 0;
}

export function listSchedules(agentId: string): HubSchedule[] {
  const rows = db
    .prepare('SELECT * FROM hub_schedules WHERE agent_id = ? ORDER BY created_at ASC')
    .all(agentId) as unknown as ScheduleRow[];
  return rows.map((row) => ({
    id: row.id,
    agentId: row.agent_id,
    name: row.name,
    cronExpr: row.cron_expr,
    prompt: row.prompt,
    enabled: Boolean(row.enabled),
    lastRun: row.last_run,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function listAllSchedules(): HubSchedule[] {
  const rows = db
    .prepare('SELECT * FROM hub_schedules ORDER BY created_at ASC')
    .all() as unknown as ScheduleRow[];
  return rows.map((row) => ({
    id: row.id,
    agentId: row.agent_id,
    name: row.name,
    cronExpr: row.cron_expr,
    prompt: row.prompt,
    enabled: Boolean(row.enabled),
    lastRun: row.last_run,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function getSchedule(id: string): HubSchedule | null {
  const row = db.prepare('SELECT * FROM hub_schedules WHERE id = ?').get(id) as
    | ScheduleRow
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    agentId: row.agent_id,
    name: row.name,
    cronExpr: row.cron_expr,
    prompt: row.prompt,
    enabled: Boolean(row.enabled),
    lastRun: row.last_run,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function addSchedule(input: {
  agentId: string;
  name: string;
  cronExpr: string;
  prompt: string;
  enabled?: boolean;
}): HubSchedule {
  const id = newId('schedule');
  const timestamp = nowIso();
  db.prepare(
    `INSERT INTO hub_schedules
      (id, agent_id, name, cron_expr, prompt, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.agentId,
    input.name.trim(),
    input.cronExpr.trim(),
    input.prompt,
    input.enabled === false ? 0 : 1,
    timestamp,
    timestamp,
  );
  return getSchedule(id)!;
}

export function updateSchedule(
  id: string,
  patch: Partial<{ name: string; cronExpr: string; prompt: string; enabled: boolean }>,
): HubSchedule | null {
  const current = getSchedule(id);
  if (!current) return null;
  db.prepare(
    `UPDATE hub_schedules SET name = ?, cron_expr = ?, prompt = ?, enabled = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    patch.name?.trim() || current.name,
    patch.cronExpr?.trim() || current.cronExpr,
    patch.prompt ?? current.prompt,
    (patch.enabled ?? current.enabled) ? 1 : 0,
    nowIso(),
    id,
  );
  return getSchedule(id);
}

export function markScheduleRun(id: string, error: string | null): void {
  db.prepare('UPDATE hub_schedules SET last_run = ?, last_error = ?, updated_at = ? WHERE id = ?').run(
    nowIso(),
    error,
    nowIso(),
    id,
  );
}

export function deleteSchedule(id: string): boolean {
  return db.prepare('DELETE FROM hub_schedules WHERE id = ?').run(id).changes > 0;
}

export function getAutoStartAgents(): HubAgent[] {
  return listAgents().filter((agent) => agent.enabled && agent.autoStart && agent.hasToken);
}
