import { db, transaction } from './db.js';
import { createLogger } from './logger.js';
import { cosine, decodeEmbedding, encodeEmbedding, rag, tokenize } from './rag.js';
import { getSettings } from './settings.js';
import { errorMessage, newId, nowIso, truncate } from './util.js';

/**
 * Per-agent memory.
 *
 * Tiers
 *  - short-term:  the OpenCode session history for one conversation (owned by OpenCode).
 *  - working:     short-lived notes about open tasks in one conversation (expire after a TTL).
 *  - summary:     a rolling summary per conversation (agent_conversation_state.summary).
 *  - long-term:   durable facts/preferences/commitments with embeddings for retrieval.
 *
 * Isolation
 *  - Every query is filtered by agent_id. There is no API that reads memory across agents.
 *  - Long-term memories learned from a WhatsApp contact are scoped to that contact's
 *    conversation_key, so one customer's details never surface in another customer's chat.
 *  - Memories learned in the owner's channels (dashboard test, schedules) or added manually
 *    without a conversation are agent-wide (conversation_key = '').
 */

const log = createLogger('memory');

export type MemoryTier = 'long_term' | 'working';
export const MEMORY_KINDS = ['fact', 'preference', 'task', 'relationship', 'note'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export type AgentMemory = {
  id: string;
  agentId: string;
  conversationKey: string;
  tier: MemoryTier;
  kind: MemoryKind;
  content: string;
  importance: number;
  source: 'auto' | 'manual';
  accessCount: number;
  lastAccessedAt: string | null;
  expiresAt: string | null;
  hasEmbedding: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ScoredMemory = AgentMemory & { score: number; relevance: number };

export type ConversationState = {
  agentId: string;
  conversationKey: string;
  summary: string;
  turns: number;
  pendingTurns: number;
  lastConsolidatedAt: string | null;
  lastError: string | null;
  updatedAt: string;
};

type MemoryRow = {
  id: string;
  agent_id: string;
  conversation_key: string;
  tier: string;
  kind: string;
  content: string;
  importance: number;
  source: string;
  embedding: Uint8Array | null;
  access_count: number;
  last_accessed_at: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
};

type StateRow = {
  agent_id: string;
  conversation_key: string;
  summary: string;
  turns: number;
  pending_turns: number;
  last_consolidated_at: string | null;
  last_error: string | null;
  updated_at: string;
};

/** Conversation keys that belong to the agent's owner rather than to an outside contact. */
const OWNER_CHANNELS = new Set(['', 'test', 'schedule']);

export function longTermScope(conversationKey: string): string {
  return OWNER_CHANNELS.has(conversationKey) ? '' : conversationKey;
}

const SECRET_PATTERN =
  /(sk-[a-z0-9_-]{10,}|\bpass(word|code)?\s*[:=]|\bapi[_ -]?key\b|\btoken\s*[:=]|\b\d{13,19}\b|\bcvv\b|\botp\b|\bpin\s*[:=])/i;

function toMemory(row: MemoryRow): AgentMemory {
  return {
    id: row.id,
    agentId: row.agent_id,
    conversationKey: row.conversation_key,
    tier: row.tier === 'working' ? 'working' : 'long_term',
    kind: normalizeKind(row.kind),
    content: row.content,
    importance: Number(row.importance),
    source: row.source === 'manual' ? 'manual' : 'auto',
    accessCount: Number(row.access_count),
    lastAccessedAt: row.last_accessed_at,
    expiresAt: row.expires_at,
    hasEmbedding: Boolean(row.embedding),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toState(row: StateRow): ConversationState {
  return {
    agentId: row.agent_id,
    conversationKey: row.conversation_key,
    summary: row.summary,
    turns: Number(row.turns),
    pendingTurns: Number(row.pending_turns),
    lastConsolidatedAt: row.last_consolidated_at,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
}

function normalizeKind(value: unknown): MemoryKind {
  return MEMORY_KINDS.includes(value as MemoryKind) ? (value as MemoryKind) : 'fact';
}

function clampImportance(value: unknown): number {
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? Math.min(5, Math.max(1, number)) : 3;
}

function cleanContent(value: unknown): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
}

function similarity(a: string, b: string): number {
  const left = new Set(tokenize(a));
  const right = new Set(tokenize(b));
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const text = raw.replace(/```(?:json)?/gi, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function hoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 3_600_000).toISOString();
}

export class MemoryService {
  private readonly versions = new Map<string, number>();
  private readonly cache = new Map<string, { at: number; version: number; value: string }>();
  private readonly consolidating = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  private bump(agentId: string): void {
    this.versions.set(agentId, (this.versions.get(agentId) ?? 0) + 1);
  }

  private version(agentId: string): number {
    return this.versions.get(agentId) ?? 0;
  }

  /* ---------------- CRUD (always scoped by agent) ---------------- */

  list(
    agentId: string,
    filter: { conversationKey?: string; tier?: MemoryTier; query?: string; limit?: number } = {},
  ): AgentMemory[] {
    const clauses = ['agent_id = ?', '(expires_at IS NULL OR expires_at > ?)'];
    const params: Array<string | number> = [agentId, nowIso()];
    if (filter.conversationKey !== undefined) {
      clauses.push('conversation_key = ?');
      params.push(filter.conversationKey);
    }
    if (filter.tier) {
      clauses.push('tier = ?');
      params.push(filter.tier);
    }
    if (filter.query?.trim()) {
      clauses.push('content LIKE ?');
      params.push(`%${filter.query.trim()}%`);
    }
    params.push(Math.min(1000, Math.max(1, filter.limit ?? 300)));
    const rows = db
      .prepare(
        `SELECT * FROM agent_memories WHERE ${clauses.join(' AND ')}
         ORDER BY tier ASC, importance DESC, updated_at DESC LIMIT ?`,
      )
      .all(...params) as unknown as MemoryRow[];
    return rows.map(toMemory);
  }

  get(agentId: string, id: string): AgentMemory | null {
    const row = db.prepare('SELECT * FROM agent_memories WHERE id = ? AND agent_id = ?').get(id, agentId) as
      | MemoryRow
      | undefined;
    return row ? toMemory(row) : null;
  }

  add(
    agentId: string,
    input: {
      content: string;
      kind?: string;
      importance?: number;
      conversationKey?: string;
      tier?: MemoryTier;
      source?: 'auto' | 'manual';
      expiresAt?: string | null;
    },
  ): AgentMemory {
    const content = cleanContent(input.content);
    if (!content) throw new Error('Memory content is empty.');
    const id = newId('mem');
    const at = nowIso();
    const tier: MemoryTier = input.tier === 'working' ? 'working' : 'long_term';
    db.prepare(
      `INSERT INTO agent_memories
        (id, agent_id, conversation_key, tier, kind, content, importance, source, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      agentId,
      input.conversationKey ?? '',
      tier,
      normalizeKind(input.kind),
      content,
      clampImportance(input.importance ?? 3),
      input.source ?? 'manual',
      input.expiresAt ?? (tier === 'working' ? hoursFromNow(getSettings().memoryWorkingTtlHours) : null),
      at,
      at,
    );
    this.bump(agentId);
    void this.embed([{ id, content }]);
    return this.get(agentId, id)!;
  }

  update(
    agentId: string,
    id: string,
    patch: { content?: string; kind?: string; importance?: number; conversationKey?: string },
  ): AgentMemory | null {
    const current = this.get(agentId, id);
    if (!current) return null;
    const content = patch.content !== undefined ? cleanContent(patch.content) : current.content;
    if (!content) throw new Error('Memory content is empty.');
    db.prepare(
      `UPDATE agent_memories SET content = ?, kind = ?, importance = ?, conversation_key = ?, updated_at = ?
       ${content !== current.content ? ', embedding = NULL' : ''}
       WHERE id = ? AND agent_id = ?`,
    ).run(
      content,
      patch.kind !== undefined ? normalizeKind(patch.kind) : current.kind,
      patch.importance !== undefined ? clampImportance(patch.importance) : current.importance,
      patch.conversationKey ?? current.conversationKey,
      nowIso(),
      id,
      agentId,
    );
    this.bump(agentId);
    if (content !== current.content) void this.embed([{ id, content }]);
    return this.get(agentId, id);
  }

  delete(agentId: string, id: string): boolean {
    const changes = db.prepare('DELETE FROM agent_memories WHERE id = ? AND agent_id = ?').run(id, agentId).changes;
    if (changes) this.bump(agentId);
    return changes > 0;
  }

  /** Forget everything for one conversation, or for the whole agent when no key is given. */
  clear(agentId: string, conversationKey?: string): number {
    let changes = 0;
    transaction(() => {
      if (conversationKey === undefined) {
        changes = Number(db.prepare('DELETE FROM agent_memories WHERE agent_id = ?').run(agentId).changes);
        db.prepare('DELETE FROM agent_conversation_state WHERE agent_id = ?').run(agentId);
      } else {
        changes = Number(
          db
            .prepare('DELETE FROM agent_memories WHERE agent_id = ? AND conversation_key = ?')
            .run(agentId, conversationKey).changes,
        );
        db.prepare('DELETE FROM agent_conversation_state WHERE agent_id = ? AND conversation_key = ?').run(
          agentId,
          conversationKey,
        );
      }
    });
    this.bump(agentId);
    return changes;
  }

  /** Clears short-lived context (working notes + rolling summary) but keeps long-term memory. */
  clearShortTerm(agentId: string, conversationKey: string): void {
    transaction(() => {
      db.prepare("DELETE FROM agent_memories WHERE agent_id = ? AND conversation_key = ? AND tier = 'working'").run(
        agentId,
        conversationKey,
      );
      db.prepare('DELETE FROM agent_conversation_state WHERE agent_id = ? AND conversation_key = ?').run(
        agentId,
        conversationKey,
      );
    });
    this.bump(agentId);
  }

  private async embed(items: Array<{ id: string; content: string }>): Promise<void> {
    if (!items.length) return;
    try {
      const vectors = await rag.embed(items.map((item) => item.content));
      if (!vectors) return;
      const update = db.prepare('UPDATE agent_memories SET embedding = ? WHERE id = ?');
      items.forEach((item, index) => {
        const vector = vectors[index];
        if (vector) update.run(encodeEmbedding(vector), item.id);
      });
    } catch (error) {
      log.debug({ error: errorMessage(error) }, 'Memory embedding skipped');
    }
  }

  /* ---------------- conversation state ---------------- */

  getState(agentId: string, conversationKey: string): ConversationState | null {
    const row = db
      .prepare('SELECT * FROM agent_conversation_state WHERE agent_id = ? AND conversation_key = ?')
      .get(agentId, conversationKey) as StateRow | undefined;
    return row ? toState(row) : null;
  }

  listStates(agentId: string): ConversationState[] {
    const rows = db
      .prepare('SELECT * FROM agent_conversation_state WHERE agent_id = ? ORDER BY updated_at DESC LIMIT 200')
      .all(agentId) as unknown as StateRow[];
    return rows.map(toState);
  }

  /** Records one completed exchange and returns how many are waiting for consolidation. */
  recordTurn(agentId: string, conversationKey: string): number {
    db.prepare(
      `INSERT INTO agent_conversation_state (agent_id, conversation_key, summary, turns, pending_turns, updated_at)
       VALUES (?, ?, '', 1, 1, ?)
       ON CONFLICT(agent_id, conversation_key) DO UPDATE SET
         turns = turns + 1, pending_turns = pending_turns + 1, updated_at = excluded.updated_at`,
    ).run(agentId, conversationKey, nowIso());
    return this.getState(agentId, conversationKey)?.pendingTurns ?? 1;
  }

  stats(agentId: string): { longTerm: number; working: number; conversations: number } {
    const counts = db
      .prepare(
        `SELECT tier, COUNT(*) AS n FROM agent_memories
         WHERE agent_id = ? AND (expires_at IS NULL OR expires_at > ?) GROUP BY tier`,
      )
      .all(agentId, nowIso()) as Array<{ tier: string; n: number }>;
    const conversations = db
      .prepare('SELECT COUNT(*) AS n FROM agent_conversation_state WHERE agent_id = ?')
      .get(agentId) as { n: number };
    return {
      longTerm: Number(counts.find((row) => row.tier === 'long_term')?.n ?? 0),
      working: Number(counts.find((row) => row.tier === 'working')?.n ?? 0),
      conversations: Number(conversations.n),
    };
  }

  totalCount(): number {
    return Number((db.prepare('SELECT COUNT(*) AS n FROM agent_memories').get() as { n: number }).n);
  }

  /* ---------------- retrieval ---------------- */

  async retrieve(
    agentId: string,
    conversationKey: string,
    query: string,
    limit = getSettings().memoryRetrieveLimit,
  ): Promise<{ longTerm: ScoredMemory[]; working: AgentMemory[] }> {
    const now = nowIso();
    const scope = longTermScope(conversationKey);
    const rows = db
      .prepare(
        `SELECT * FROM agent_memories
         WHERE agent_id = ? AND tier = 'long_term' AND conversation_key IN ('', ?)
           AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY updated_at DESC LIMIT 2000`,
      )
      .all(agentId, scope, now) as unknown as MemoryRow[];
    const working = (
      db
        .prepare(
          `SELECT * FROM agent_memories
           WHERE agent_id = ? AND tier = 'working' AND conversation_key = ? AND (expires_at IS NULL OR expires_at > ?)
           ORDER BY updated_at DESC LIMIT 8`,
        )
        .all(agentId, conversationKey, now) as unknown as MemoryRow[]
    ).map(toMemory);

    if (!rows.length) return { longTerm: [], working };

    const queryTokens = new Set(tokenize(query));
    const vector = query.trim() ? (await rag.embed([query]))?.[0] : null;
    const queryVector = vector ? new Float32Array(vector) : null;

    const scored: ScoredMemory[] = rows.map((row) => {
      const tokens = tokenize(row.content);
      const overlap = tokens.filter((token) => queryTokens.has(token)).length;
      const lexical = queryTokens.size ? Math.min(1, overlap / queryTokens.size) : 0;
      const semantic =
        queryVector && row.embedding ? Math.max(0, cosine(queryVector, decodeEmbedding(row.embedding))) : 0;
      const ageDays = (Date.now() - Date.parse(row.last_accessed_at || row.updated_at)) / 86_400_000;
      const recency = Math.exp(-Math.max(0, ageDays) / 30);
      const relevance = queryVector && row.embedding ? 0.65 * semantic + 0.35 * lexical : lexical;
      const score = 0.6 * relevance + 0.25 * (Number(row.importance) / 5) + 0.15 * recency;
      return { ...toMemory(row), relevance: Number(relevance.toFixed(4)), score: Number(score.toFixed(4)) };
    });

    const longTerm = scored
      .filter(
        (item) =>
          item.relevance >= 0.25 ||
          item.importance >= 5 ||
          (item.source === 'manual' && item.importance >= 4),
      )
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, limit));

    if (longTerm.length) {
      const touch = db.prepare(
        'UPDATE agent_memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ? AND agent_id = ?',
      );
      for (const item of longTerm) touch.run(now, item.id, agentId);
    }
    return { longTerm, working };
  }

  /** Builds the private memory block injected into a prompt. Cached briefly per agent/conversation/query. */
  async buildContext(agentId: string, conversationKey: string, query: string): Promise<string> {
    const cacheKey = `${agentId}\u0000${conversationKey}\u0000${query.slice(0, 400)}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.version === this.version(agentId) && Date.now() - cached.at < 120_000) return cached.value;

    const state = this.getState(agentId, conversationKey);
    const { longTerm, working } = await this.retrieve(agentId, conversationKey, query);
    const parts: string[] = [];
    if (state?.summary) parts.push(`Conversation so far (summary): ${state.summary}`);
    if (working.length) parts.push(`Working notes for this conversation:\n${working.map((item) => `- ${item.content}`).join('\n')}`);
    if (longTerm.length) {
      parts.push(`Things you remember:\n${longTerm.map((item) => `- (${item.kind}) ${item.content}`).join('\n')}`);
    }
    const value = parts.length
      ? `Your private memory (only you can see this; use it when it is relevant and do not recite it):\n\n${parts.join('\n\n')}`
      : '';

    this.cache.set(cacheKey, { at: Date.now(), version: this.version(agentId), value });
    if (this.cache.size > 500) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return value;
  }

  /* ---------------- consolidation ---------------- */

  /**
   * Asks the agent's own model (via the conversation's OpenCode session, without touching its
   * history) to summarize the conversation and propose memory updates, then applies them.
   */
  async consolidate(
    agentId: string,
    conversationKey: string,
    generate: (prompt: string) => Promise<string>,
    options: { throwOnError?: boolean } = {},
  ): Promise<{ added: number; updated: number; forgotten: number; working: number } | null> {
    const lock = `${agentId}\u0000${conversationKey}`;
    if (this.consolidating.has(lock)) return null;
    this.consolidating.add(lock);
    const scope = longTermScope(conversationKey);
    try {
      const state = this.getState(agentId, conversationKey);
      const existing = db
        .prepare(
          `SELECT * FROM agent_memories
           WHERE agent_id = ? AND tier = 'long_term' AND conversation_key IN ('', ?)
           ORDER BY importance DESC, updated_at DESC LIMIT 40`,
        )
        .all(agentId, scope) as unknown as MemoryRow[];

      const prompt = [
        'MEMORY MAINTENANCE (internal; this is not a message from the user and nothing you write here is sent to anyone).',
        'Review the conversation so far and update your private memory.',
        '',
        `Previous summary: ${state?.summary || '(none)'}`,
        'Existing memories:',
        existing.length ? existing.map((row) => `- ${row.id}: (${row.kind}) ${row.content}`).join('\n') : '- (none)',
        '',
        'Reply with ONLY one JSON object, no prose, in exactly this shape:',
        '{"summary":"rolling summary of this conversation, max 120 words",',
        ' "working":["short-lived notes about open tasks or pending follow-ups in this conversation"],',
        ' "add":[{"kind":"fact|preference|task|relationship|note","content":"one durable, self-contained statement","importance":1-5}],',
        ' "update":[{"id":"existing memory id","content":"corrected statement","importance":1-5}],',
        ' "forget":["existing memory id that is wrong or obsolete"]}',
        'Rules: store only durable, useful information (who the person is, their needs, preferences, decisions, commitments).',
        'Do not duplicate existing memories. Never store passwords, tokens, payment card numbers or other secrets. Use empty arrays when nothing applies.',
      ].join('\n');

      const raw = await generate(prompt);
      const parsed = parseJsonObject(raw);
      if (!parsed) throw new Error('The model did not return valid memory JSON.');

      const editable = new Map(
        existing.filter((row) => row.conversation_key === scope && row.source === 'auto').map((row) => [row.id, row]),
      );
      const ttl = getSettings().memoryWorkingTtlHours;
      const toEmbed: Array<{ id: string; content: string }> = [];
      const result = { added: 0, updated: 0, forgotten: 0, working: 0 };
      const at = nowIso();

      transaction(() => {
        if (typeof parsed.summary === 'string') {
          db.prepare(
            `INSERT INTO agent_conversation_state (agent_id, conversation_key, summary, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(agent_id, conversation_key) DO UPDATE SET summary = excluded.summary, updated_at = excluded.updated_at`,
          ).run(agentId, conversationKey, truncate(cleanContent(parsed.summary) || '', 1200), at);
        }

        if (Array.isArray(parsed.working)) {
          db.prepare("DELETE FROM agent_memories WHERE agent_id = ? AND conversation_key = ? AND tier = 'working'").run(
            agentId,
            conversationKey,
          );
          const insert = db.prepare(
            `INSERT INTO agent_memories
              (id, agent_id, conversation_key, tier, kind, content, importance, source, expires_at, created_at, updated_at)
             VALUES (?, ?, ?, 'working', 'task', ?, 3, 'auto', ?, ?, ?)`,
          );
          for (const note of parsed.working.slice(0, 6)) {
            const content = cleanContent(note);
            if (!content || SECRET_PATTERN.test(content)) continue;
            insert.run(newId('mem'), agentId, conversationKey, content, hoursFromNow(ttl), at, at);
            result.working += 1;
          }
        }

        const updateRow = db.prepare(
          `UPDATE agent_memories SET content = ?, importance = ?, embedding = NULL, updated_at = ?
           WHERE id = ? AND agent_id = ?`,
        );

        if (Array.isArray(parsed.add)) {
          const insert = db.prepare(
            `INSERT INTO agent_memories
              (id, agent_id, conversation_key, tier, kind, content, importance, source, created_at, updated_at)
             VALUES (?, ?, ?, 'long_term', ?, ?, ?, 'auto', ?, ?)`,
          );
          for (const item of parsed.add.slice(0, 8)) {
            if (!item || typeof item !== 'object') continue;
            const entry = item as Record<string, unknown>;
            const content = cleanContent(entry.content);
            if (content.length < 4 || SECRET_PATTERN.test(content)) continue;
            const importance = clampImportance(entry.importance);
            const duplicate = existing.find((row) => similarity(row.content, content) >= 0.8);
            if (duplicate) {
              if (editable.has(duplicate.id)) {
                updateRow.run(content, Math.max(importance, Number(duplicate.importance)), at, duplicate.id, agentId);
                toEmbed.push({ id: duplicate.id, content });
                result.updated += 1;
              }
              continue;
            }
            const id = newId('mem');
            insert.run(id, agentId, scope, normalizeKind(entry.kind), content, importance, at, at);
            existing.push({ ...({} as MemoryRow), id, content, conversation_key: scope, importance, source: 'auto', kind: 'fact' });
            toEmbed.push({ id, content });
            result.added += 1;
          }
        }

        if (Array.isArray(parsed.update)) {
          for (const item of parsed.update.slice(0, 8)) {
            if (!item || typeof item !== 'object') continue;
            const entry = item as Record<string, unknown>;
            const id = String(entry.id ?? '');
            const current = editable.get(id);
            const content = cleanContent(entry.content);
            if (!current || !content || SECRET_PATTERN.test(content)) continue;
            updateRow.run(content, clampImportance(entry.importance ?? current.importance), at, id, agentId);
            toEmbed.push({ id, content });
            result.updated += 1;
          }
        }

        if (Array.isArray(parsed.forget)) {
          const remove = db.prepare('DELETE FROM agent_memories WHERE id = ? AND agent_id = ?');
          for (const value of parsed.forget.slice(0, 8)) {
            const id = String(value ?? '');
            if (!editable.has(id)) continue;
            result.forgotten += Number(remove.run(id, agentId).changes);
          }
        }

        db.prepare(
          `UPDATE agent_conversation_state SET pending_turns = 0, last_consolidated_at = ?, last_error = NULL, updated_at = ?
           WHERE agent_id = ? AND conversation_key = ?`,
        ).run(at, at, agentId, conversationKey);
      });

      this.bump(agentId);
      void this.embed(toEmbed);
      this.prune(agentId);
      log.info({ agentId, conversation: conversationKey || 'agent', ...result }, 'Agent memory consolidated');
      return result;
    } catch (error) {
      const message = errorMessage(error);
      db.prepare(
        `INSERT INTO agent_conversation_state (agent_id, conversation_key, last_error, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(agent_id, conversation_key) DO UPDATE SET last_error = excluded.last_error, updated_at = excluded.updated_at`,
      ).run(agentId, conversationKey, truncate(message, 500), nowIso());
      log.warn({ agentId, error: message }, 'Memory consolidation failed');
      if (options.throwOnError) throw error;
      return null;
    } finally {
      this.consolidating.delete(lock);
    }
  }

  /* ---------------- forgetting ---------------- */

  /** Removes expired working notes, stale low-value memories, and enforces the per-agent cap. */
  prune(agentId?: string): number {
    const now = nowIso();
    const stale = new Date(Date.now() - 60 * 86_400_000).toISOString();
    const max = getSettings().memoryMaxPerAgent;
    let removed = 0;
    const agentFilter = agentId ? ' AND agent_id = ?' : '';
    const args = agentId ? [agentId] : [];
    removed += Number(
      db.prepare(`DELETE FROM agent_memories WHERE expires_at IS NOT NULL AND expires_at <= ?${agentFilter}`).run(now, ...args)
        .changes,
    );
    removed += Number(
      db
        .prepare(
          `DELETE FROM agent_memories
           WHERE source = 'auto' AND tier = 'long_term' AND importance <= 2
             AND COALESCE(last_accessed_at, updated_at) < ?${agentFilter}`,
        )
        .run(stale, ...args).changes,
    );
    const agents = agentId
      ? [agentId]
      : (db.prepare('SELECT DISTINCT agent_id FROM agent_memories').all() as Array<{ agent_id: string }>).map(
          (row) => row.agent_id,
        );
    for (const id of agents) {
      const count = Number(
        (db.prepare("SELECT COUNT(*) AS n FROM agent_memories WHERE agent_id = ? AND source = 'auto'").get(id) as { n: number }).n,
      );
      if (count > max) {
        removed += Number(
          db
            .prepare(
              `DELETE FROM agent_memories WHERE id IN (
                 SELECT id FROM agent_memories WHERE agent_id = ? AND source = 'auto'
                 ORDER BY importance ASC, COALESCE(last_accessed_at, updated_at) ASC LIMIT ?
               )`,
            )
            .run(id, count - max).changes,
        );
      }
      this.bump(id);
    }
    if (removed) log.debug({ removed }, 'Pruned agent memories');
    return removed;
  }

  startMaintenance(): void {
    if (this.timer) return;
    try {
      this.prune();
    } catch (error) {
      log.warn({ error: errorMessage(error) }, 'Initial memory prune failed');
    }
    this.timer = setInterval(() => {
      try {
        this.prune();
      } catch (error) {
        log.warn({ error: errorMessage(error) }, 'Memory prune failed');
      }
    }, 3_600_000);
    this.timer.unref?.();
  }

  stopMaintenance(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export const memory = new MemoryService();
