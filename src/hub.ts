import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Cron } from 'croner';
import { config } from './config.js';
import { bus } from './events.js';
import { createLogger } from './logger.js';
import {
  clearSession,
  getAgent,
  getAgentDetail,
  getAgentToken,
  getAutoStartAgents,
  getSchedule,
  getSession,
  listAgents,
  listAllSchedules,
  listSchedules,
  markAgentSeen,
  markScheduleRun,
  recordHubMessage,
  setAgentOffset,
  setAgentStatus,
  type HubAgent,
} from './hub-store.js';
import { memory } from './memory.js';
import { agentInbox, opencode } from './opencode-runtime.js';
import { rag } from './rag.js';
import { getSettings } from './settings.js';
import { ensureChat, recordAgentRun, resetChat, saveMessage } from './store.js';
import { errorMessage } from './util.js';
import {
  WhatsAppAgentClient,
  WhatsAppApiError,
  officialMessageMedia,
  officialMessageText,
  type OfficialMessage,
} from './wa-platform.js';

const log = createLogger('hub');

type RunningAgent = {
  client: WhatsAppAgentClient;
  controller: AbortController;
  startedAt: string;
  task: Promise<void>;
};

type HubAgentSnapshot = ReturnType<typeof listAgents>[number] & {
  running: boolean;
  runtimeStartedAt: string | null;
  nextRun: string | null;
};

export function testChatId(agentId: string): string {
  return `hub-test:${agentId}`;
}

export function peerChatId(agentId: string, peer: string): string {
  return `wa-hub:${agentId}:${peer}`;
}

/** Maps a stored chat id back to its agent and conversation key. */
export function parseChatId(chatId: string): { agentId: string; conversationKey: string } | null {
  const peer = /^wa-hub:([^:]+):(.+)$/.exec(chatId);
  if (peer) return { agentId: peer[1], conversationKey: peer[2] };
  const test = /^hub-test:(.+)$/.exec(chatId);
  if (test) return { agentId: test[1], conversationKey: 'test' };
  return null;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function errorStatus(error: unknown): number | null {
  return error instanceof WhatsAppApiError ? error.status : null;
}

function isAuthError(error: unknown): boolean {
  const status = errorStatus(error);
  return status === 401 || status === 403;
}

function sanitizeFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'media';
}

function mediaExtension(mime: string, filename?: string): string {
  const fromName = filename?.match(/\.[A-Za-z0-9]{1,8}$/)?.[0];
  if (fromName) return fromName;
  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'video/mp4': '.mp4',
    'audio/ogg': '.ogg',
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a',
    'application/pdf': '.pdf',
  };
  return map[mime] || '.bin';
}

export class HubManager {
  private readonly running = new Map<string, RunningAgent>();
  private readonly jobs = new Map<string, Cron>();
  private started = false;
  private schedulerError: string | null = null;

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    memory.startMaintenance();
    this.syncScheduler();
    if (!config.hubAutoStart) {
      log.warn('HUB_AUTOSTART=0: agents will not start polling automatically');
    } else {
      for (const agent of getAutoStartAgents()) {
        void this.startAgent(agent.id).catch((error) =>
          log.error({ agent: agent.name, error: errorMessage(error) }, 'Could not auto-start WhatsApp agent'),
        );
      }
    }
    this.publish();
  }

  async stop(): Promise<void> {
    this.started = false;
    for (const id of [...this.running.keys()]) {
      await this.stopAgent(id);
    }
    for (const job of this.jobs.values()) job.stop();
    this.jobs.clear();
    memory.stopMaintenance();
    await opencode.stop();
    this.publish();
  }

  async startAgent(id: string): Promise<HubAgentSnapshot> {
    const agent = getAgent(id);
    if (!agent) throw new Error('Agent not found.');
    if (!agent.enabled) throw new Error('This agent is disabled. Enable it before starting.');
    if (this.running.has(id)) return this.getAgentSnapshot(agent);
    if (!agent.hasToken) throw new Error('Add a WhatsApp Agent Platform token before starting this agent.');

    setAgentStatus(id, 'starting');
    this.publish();

    try {
      await opencode.ensure();
      await opencode.syncConfig();
    } catch (error) {
      const message = errorMessage(error);
      setAgentStatus(id, 'error', message);
      this.publish();
      throw error;
    }

    const token = getAgentToken(id);
    if (!token) {
      setAgentStatus(id, 'error', 'The WhatsApp token could not be decrypted. Re-enter it.');
      this.publish();
      throw new Error('The WhatsApp token could not be decrypted.');
    }

    const client = new WhatsAppAgentClient(id, token);
    const controller = new AbortController();
    const runtime: RunningAgent = {
      client,
      controller,
      startedAt: new Date().toISOString(),
      task: Promise.resolve(),
    };
    runtime.task = this.pollLoop(agent, client, controller.signal).finally(() => {
      const current = this.running.get(id);
      if (current === runtime) this.running.delete(id);
      if (controller.signal.aborted) setAgentStatus(id, 'stopped');
      this.publish();
    });
    this.running.set(id, runtime);
    setAgentStatus(id, 'running');
    log.info({ agent: agent.name }, 'WhatsApp poller started');
    this.publish();
    return this.getAgentSnapshot(getAgent(id) || agent);
  }

  async stopAgent(id: string, error: string | null = null): Promise<void> {
    const runtime = this.running.get(id);
    if (!runtime) {
      const agent = getAgent(id);
      if (agent) setAgentStatus(id, 'stopped', error);
      this.publish();
      return;
    }
    runtime.controller.abort();
    this.running.delete(id);
    try {
      await runtime.task;
    } catch {
      /* the loop logs its own failures */
    }
    setAgentStatus(id, error ? 'error' : 'stopped', error);
    log.info({ agent: id }, 'WhatsApp poller stopped');
    this.publish();
  }

  async restartAgent(id: string): Promise<HubAgentSnapshot> {
    const wasRunning = this.running.has(id);
    await this.stopAgent(id);
    clearSession(id);
    if (wasRunning) return this.startAgent(id);
    const agent = getAgent(id);
    if (!agent) throw new Error('Agent not found.');
    return this.getAgentSnapshot(agent);
  }

  async applyAgentChange(id: string): Promise<void> {
    opencode.invalidateConfig();
    const wasRunning = this.running.has(id);
    await this.stopAgent(id);
    this.syncScheduler();
    this.publish();
    const agent = getAgent(id);
    // Configuration changes reload OpenCode; conversations keep their sessions and memory.
    if (agent && agent.enabled && agent.hasToken && (agent.autoStart || wasRunning) && config.hubAutoStart) {
      void this.startAgent(id).catch((error) =>
        log.error({ agent: id, error: errorMessage(error) }, 'Could not restart agent after configuration change'),
      );
    } else if (opencode.isReady()) {
      void opencode.syncConfig().catch((error) =>
        log.warn({ error: errorMessage(error) }, 'Could not resync OpenCode after configuration change'),
      );
    }
  }

  async refreshConfig(): Promise<void> {
    opencode.invalidateConfig();
    try {
      if (listAgents().length > 0 || opencode.hasManagedConfig()) {
        await opencode.syncConfig(true);
      }
    } catch (error) {
      log.error({ error: errorMessage(error) }, 'Could not reload OpenCode configuration');
    }
    this.syncScheduler();
    this.publish();
  }

  private async pollLoop(agent: HubAgent, client: WhatsAppAgentClient, signal: AbortSignal): Promise<void> {
    let offset = agent.nextOffset;
    let lastError: string | null = null;

    while (!signal.aborted) {
      try {
        const poll = await client.pollUpdates(offset, 25, signal);
        if (signal.aborted) break;
        if (poll.status === 204) {
          if (lastError) {
            lastError = null;
            setAgentStatus(agent.id, 'running', null);
            this.publish();
          }
          continue;
        }

        markAgentSeen(agent.id);
        for (const message of poll.messages) {
          if (signal.aborted) break;
          try {
            // Always use the latest saved configuration for this agent.
            await this.handleMessage(getAgent(agent.id) || agent, client, message, signal);
          } catch (error) {
            log.error(
              { agent: agent.name, messageId: message.id, error: errorMessage(error) },
              'Failed to handle WhatsApp message',
            );
          }
        }

        if (poll.nextOffset && poll.nextOffset !== offset) {
          offset = poll.nextOffset;
          setAgentOffset(agent.id, offset);
        }
        if (lastError) {
          lastError = null;
          setAgentStatus(agent.id, 'running', null);
          this.publish();
        }
      } catch (error) {
        if (signal.aborted) break;
        const message = errorMessage(error);
        const status = errorStatus(error);

        if (isAuthError(error)) {
          setAgentStatus(agent.id, 'error', `WhatsApp rejected the token (HTTP ${status}). Re-enter the token in the dashboard.`);
          log.error({ agent: agent.name, status }, 'WhatsApp authentication failed; poller stopped');
          this.publish();
          return;
        }

        if (status === 409) {
          lastError = 'Another poller is already using this token (HTTP 409). Stop the other process, then restart this agent.';
          setAgentStatus(agent.id, 'error', lastError);
          log.warn({ agent: agent.name }, 'WhatsApp poll conflict (409)');
          this.publish();
          await abortableSleep(60_000, signal);
          continue;
        }

        if (status === 429) {
          const wait = (error as WhatsAppApiError).retryAfterMs ?? 15_000;
          lastError = 'WhatsApp rate limit reached; retrying automatically.';
          setAgentStatus(agent.id, 'running', lastError);
          log.warn({ agent: agent.name, wait }, 'WhatsApp rate limited');
          this.publish();
          await abortableSleep(Math.max(1_000, wait), signal);
          continue;
        }

        lastError = message;
        setAgentStatus(agent.id, 'running', message);
        log.warn({ agent: agent.name, error: message }, 'WhatsApp poll failed; backing off');
        this.publish();
        await abortableSleep(5_000, signal);
      }
    }

    setAgentStatus(agent.id, 'stopped');
    this.publish();
  }

  /** Builds the context blocks (agent-scoped knowledge + agent-scoped memory) for one prompt. */
  private async contextFor(agent: HubAgent, conversationKey: string, query: string): Promise<{ knowledge: string; memory: string }> {
    const [knowledge, memoryBlock] = await Promise.all([
      this.knowledgeContext(agent, query),
      agent.memoryEnabled
        ? memory.buildContext(agent.id, conversationKey, query).catch((error) => {
            log.debug({ agent: agent.name, error: errorMessage(error) }, 'Memory lookup failed');
            return '';
          })
        : Promise.resolve(''),
    ]);
    return { knowledge, memory: memoryBlock };
  }

  private afterTurn(agent: HubAgent, conversationKey: string, sessionId: string): void {
    if (!agent.memoryEnabled) return;
    try {
      const pending = memory.recordTurn(agent.id, conversationKey);
      if (pending < getSettings().memoryConsolidateEvery) return;
      void memory
        .consolidate(agent.id, conversationKey, (prompt) => opencode.generate(sessionId, prompt))
        .then(() => this.publish())
        .catch((error) => log.debug({ agent: agent.name, error: errorMessage(error) }, 'Memory consolidation skipped'));
    } catch (error) {
      log.debug({ agent: agent.name, error: errorMessage(error) }, 'Could not record memory turn');
    }
  }

  async consolidateNow(agentId: string, conversationKey: string) {
    const agent = getAgent(agentId);
    if (!agent) throw new Error('Agent not found.');
    const session = getSession(agentId, conversationKey);
    if (!session) throw new Error('This conversation has no active session yet. Send a message first.');
    const result = await memory.consolidate(
      agentId,
      conversationKey,
      (prompt) => opencode.generate(session.sessionId, prompt),
      { throwOnError: true },
    );
    this.publish();
    return result;
  }

  private async handleMessage(
    agent: HubAgent,
    client: WhatsAppAgentClient,
    message: OfficialMessage,
    signal: AbortSignal,
  ): Promise<void> {
    if (!message.id || !message.from) return;
    if (
      recordHubMessage({
        messageId: message.id,
        agentId: agent.id,
        direction: 'in',
        peerId: message.from,
        body: officialMessageText(message),
      }) === false
    ) {
      // Already processed by this agent (the server can replay an offset after a crash).
      return;
    }

    const peer = message.from;
    const chatId = peerChatId(agent.id, peer);
    const inboundText = officialMessageText(message);
    markAgentSeen(agent.id, peer);
    ensureChat(chatId, `${agent.name} · ${peer}`, false);
    saveMessage({
      chatId,
      role: 'user',
      content: inboundText || `[${message.type}]`,
      messageId: message.id,
      senderName: peer,
      meta: { agentId: agent.id, type: message.type },
    });

    if (agent.readReceipts) {
      void client
        .markRead(message.id, { typing: agent.typingIndicator, signal })
        .catch((error) => log.debug({ agent: agent.name, error: errorMessage(error) }, 'Read receipt failed'));
    }

    const files: Array<{ uri: string; name?: string; description?: string }> = [];
    const media = officialMessageMedia(message);
    if (media?.id) {
      try {
        const downloaded = await client.downloadMedia(media.id, signal);
        if (downloaded.bytes.byteLength > 20 * 1024 * 1024) {
          log.warn({ agent: agent.name, bytes: downloaded.bytes.byteLength }, 'Skipping oversized WhatsApp media');
        } else {
          // Media is written into this agent's own inbox; no other agent can read it.
          const inbox = agentInbox(agent.id);
          fs.mkdirSync(inbox, { recursive: true });
          const filename = sanitizeFilename(
            downloaded.filename || `whatsapp-${message.id}${mediaExtension(downloaded.mimeType)}`,
          );
          const file = path.join(inbox, `${Date.now()}-${filename}`);
          fs.writeFileSync(file, downloaded.bytes);
          files.push({
            uri: pathToFileURL(file).href,
            name: filename,
            description: `${message.type} sent over WhatsApp`,
          });
        }
      } catch (error) {
        log.warn({ agent: agent.name, error: errorMessage(error) }, 'Could not download WhatsApp media');
      }
    }

    const context = await this.contextFor(agent, peer, inboundText);
    const prompt = [
      context.knowledge,
      context.memory,
      media ? `The user sent a ${message.type}. Read the attached file if it is available.` : '',
      `Incoming WhatsApp message from ${peer}:\n${inboundText || `[${message.type}]`}`,
    ]
      .filter(Boolean)
      .join('\n\n');

    try {
      const result = await opencode.runPrompt(agent, prompt, {
        metadata: { agentId: agent.id, peer, messageId: message.id },
        conversationKey: peer,
        files,
      });
      saveMessage({
        chatId,
        role: 'assistant',
        content: result.text,
        messageId: null,
        senderName: agent.name,
        meta: {
          agentId: agent.id,
          model: result.model,
          sessionId: result.sessionId,
          latencyMs: result.latencyMs,
          toolCalls: result.toolCalls,
          usedMemory: Boolean(context.memory),
          usedKnowledge: Boolean(context.knowledge),
        },
      });
      recordAgentRun({
        chatId,
        source: 'whatsapp-agent-platform',
        model: result.model,
        userText: inboundText,
        response: result.text,
        toolCalls: result.toolCalls,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        latencyMs: result.latencyMs,
      });
      await client.sendText(peer, result.text, { quoteMessageId: message.id, signal });
      recordHubMessage({
        messageId: `out:${message.id}`,
        agentId: agent.id,
        direction: 'out',
        peerId: peer,
        body: result.text.slice(0, 500),
      });
      log.info({ agent: agent.name, chars: result.text.length }, 'WhatsApp reply sent');
      this.afterTurn(agent, peer, result.sessionId);
    } catch (error) {
      const resultError = errorMessage(error);
      log.error({ agent: agent.name, error: resultError }, 'OpenCode reply failed');
      recordAgentRun({
        chatId,
        source: 'whatsapp-agent-platform',
        model: agent.model,
        userText: inboundText,
        response: '',
        toolCalls: [],
        tokensIn: 0,
        tokensOut: 0,
        latencyMs: 0,
        error: resultError,
      });
      const fallback = 'Sorry, I could not handle that message right now. Please try again in a moment.';
      try {
        await client.sendText(peer, fallback, { quoteMessageId: message.id, signal });
      } catch (sendError) {
        log.error({ agent: agent.name, error: errorMessage(sendError) }, 'Could not send fallback reply');
      }
      saveMessage({
        chatId,
        role: 'assistant',
        content: fallback,
        senderName: agent.name,
        meta: { agentId: agent.id, error: resultError },
      });
    }
  }

  private async knowledgeContext(agent: HubAgent, query: string): Promise<string> {
    if (!agent.knowledgeIds.length || !query.trim()) return '';
    try {
      // Ranking happens only inside this agent's own documents.
      const selected = await rag.search(query, 4, 0.08, { documentIds: agent.knowledgeIds });
      if (!selected.length) return '';
      const blocks = selected.map(
        (result) =>
          `### ${result.title}\n${result.content.slice(0, 1800).trim()}${result.content.length > 1800 ? '…' : ''}`,
      );
      return `Reference material from your knowledge base (use it only when relevant):\n\n${blocks.join('\n\n')}`;
    } catch (error) {
      log.debug({ agent: agent.name, error: errorMessage(error) }, 'Knowledge lookup failed');
      return '';
    }
  }

  /** Dashboard conversation with an agent. Never touches WhatsApp. */
  async testAgent(id: string, text: string) {
    const agent = getAgent(id);
    if (!agent) throw new Error('Agent not found.');
    const chatId = testChatId(id);
    ensureChat(chatId, `${agent.name} · dashboard`, false);
    saveMessage({ chatId, role: 'user', content: text, senderName: 'You', meta: { agentId: id, test: true } });

    const context = await this.contextFor(agent, 'test', text);
    const prompt = [context.knowledge, context.memory, `Message from your manager (dashboard):\n${text}`]
      .filter(Boolean)
      .join('\n\n');
    try {
      const result = await opencode.runPrompt(agent, prompt, {
        metadata: { test: true, agentId: id },
        conversationKey: 'test',
      });
      saveMessage({
        chatId,
        role: 'assistant',
        content: result.text,
        senderName: agent.name,
        meta: {
          agentId: id,
          model: result.model,
          latencyMs: result.latencyMs,
          toolCalls: result.toolCalls,
          usedMemory: Boolean(context.memory),
          usedKnowledge: Boolean(context.knowledge),
        },
      });
      recordAgentRun({
        chatId,
        source: 'dashboard',
        model: result.model,
        userText: text,
        response: result.text,
        toolCalls: result.toolCalls,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        latencyMs: result.latencyMs,
      });
      this.afterTurn(agent, 'test', result.sessionId);
      return {
        text: result.text,
        model: result.model,
        sessionId: result.sessionId,
        latencyMs: result.latencyMs,
        toolCalls: result.toolCalls,
        usedMemory: Boolean(context.memory),
        usedKnowledge: Boolean(context.knowledge),
      };
    } catch (error) {
      saveMessage({
        chatId,
        role: 'system',
        content: `Error: ${errorMessage(error)}`,
        senderName: agent.name,
        meta: { agentId: id, error: true },
      });
      throw error;
    }
  }

  /** Clears the dashboard conversation's short-term context (session, transcript, working notes). */
  resetTest(id: string): void {
    clearSession(id, 'test');
    resetChat(testChatId(id));
    memory.clearShortTerm(id, 'test');
  }

  /** Clears one contact's short-term context. Long-term memory is kept unless forgotten separately. */
  resetConversation(agentId: string, conversationKey: string): void {
    clearSession(agentId, conversationKey);
    memory.clearShortTerm(agentId, conversationKey);
  }

  private recipientFor(agent: HubAgent): string | null {
    return agent.ownerId || agent.creatorId;
  }

  async sendToCreator(id: string, text: string): Promise<string[]> {
    const agent = getAgent(id);
    if (!agent) throw new Error('Agent not found.');
    const recipient = this.recipientFor(agent);
    if (!recipient) throw new Error('Set an owner ID for this agent (or wait for its first WhatsApp message).');
    const token = getAgentToken(id);
    if (!token) throw new Error('Agent token is missing.');
    const client = new WhatsAppAgentClient(id, token);
    return client.sendText(recipient, text);
  }

  async runSchedule(scheduleId: string): Promise<void> {
    const schedule = getSchedule(scheduleId);
    if (!schedule) return;
    const agent = getAgent(schedule.agentId);
    if (!agent) {
      markScheduleRun(scheduleId, 'Agent not found.');
      return;
    }
    if (!schedule.enabled) return;
    const recipient = this.recipientFor(agent);
    if (!recipient) {
      markScheduleRun(scheduleId, 'Set an owner ID for this agent, or send it a WhatsApp message first.');
      return;
    }
    const token = getAgentToken(agent.id);
    if (!token) {
      markScheduleRun(scheduleId, 'The agent token is missing.');
      return;
    }
    const chatId = peerChatId(agent.id, recipient);
    try {
      const context = await this.contextFor(agent, 'schedule', schedule.prompt);
      const result = await opencode.runPrompt(
        agent,
        [context.knowledge, context.memory, `Scheduled task "${schedule.name}":\n${schedule.prompt}`]
          .filter(Boolean)
          .join('\n\n'),
        {
          metadata: { agentId: agent.id, scheduleId, scheduled: true },
          conversationKey: 'schedule',
        },
      );
      const client = new WhatsAppAgentClient(agent.id, token);
      await client.sendText(recipient, result.text);
      markScheduleRun(scheduleId, null);
      saveMessage({
        chatId,
        role: 'assistant',
        content: result.text,
        senderName: agent.name,
        meta: { agentId: agent.id, scheduleId, scheduled: true },
      });
      recordAgentRun({
        chatId,
        source: 'schedule',
        model: result.model,
        userText: schedule.prompt,
        response: result.text,
        toolCalls: result.toolCalls,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        latencyMs: result.latencyMs,
      });
      this.afterTurn(agent, 'schedule', result.sessionId);
      log.info({ agent: agent.name, schedule: schedule.name }, 'Scheduled WhatsApp message sent');
    } catch (error) {
      markScheduleRun(scheduleId, errorMessage(error));
      log.error({ agent: agent.name, schedule: schedule.name, error: errorMessage(error) }, 'Scheduled task failed');
    }
    this.publish();
    this.syncScheduler();
  }

  private syncScheduler(): void {
    for (const job of this.jobs.values()) job.stop();
    this.jobs.clear();
    this.schedulerError = null;
    const timezone = getSettings().timezone?.trim();
    for (const schedule of listAllSchedules().filter((item) => item.enabled)) {
      try {
        const job = new Cron(schedule.cronExpr, { protect: true, ...(timezone ? { timezone } : {}) }, () => {
          void this.runSchedule(schedule.id);
        });
        this.jobs.set(schedule.id, job);
      } catch (error) {
        const message = errorMessage(error);
        this.schedulerError = `${schedule.name}: ${message}`;
        log.warn({ schedule: schedule.name, error: message }, 'Invalid schedule cron expression');
      }
    }
  }

  getAgentSnapshot(agent: HubAgent): HubAgentSnapshot {
    const runtime = this.running.get(agent.id);
    const schedule = listSchedules(agent.id).find((item) => item.enabled);
    const job = schedule ? this.jobs.get(schedule.id) : null;
    let nextRun: string | null = null;
    try {
      nextRun = job?.nextRun()?.toISOString() ?? null;
    } catch {
      nextRun = null;
    }
    return {
      ...agent,
      running: Boolean(runtime),
      runtimeStartedAt: runtime?.startedAt ?? null,
      nextRun,
    };
  }

  getStatus() {
    const agents = listAgents().map((agent) => this.getAgentSnapshot(agent));
    const schedules = listAllSchedules().map((schedule) => {
      const job = this.jobs.get(schedule.id);
      return { ...schedule, nextRun: job?.nextRun()?.toISOString() ?? null };
    });
    return {
      runtime: {
        ready: opencode.isReady(),
        baseUrl: opencode.getBaseUrl(),
        logTail: opencode.getLogTail().slice(-12),
      },
      agents,
      schedules,
      schedulerError: this.schedulerError,
      running: agents.filter((agent) => agent.running).length,
    };
  }

  getAgentDetail(id: string) {
    return getAgentDetail(id);
  }

  publish(): void {
    bus.publish('hub:status', this.getStatus());
  }
}

export const hub = new HubManager();
