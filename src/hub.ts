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
  listAgents,
  listAllSchedules,
  listSchedules,
  markAgentSeen,
  markScheduleRun,
  recordHubMessage,
  setAgentOffset,
  setAgentStatus,
  type HubAgent,
  type HubSchedule,
} from './hub-store.js';
import { opencode } from './opencode-runtime.js';
import { rag } from './rag.js';
import { getSettings } from './settings.js';
import { ensureChat, recordAgentRun, saveMessage } from './store.js';
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
    this.syncScheduler();
    for (const agent of getAutoStartAgents()) {
      void this.startAgent(agent.id).catch((error) =>
        log.error({ agent: agent.name, error: errorMessage(error) }, 'Could not auto-start WhatsApp agent'),
      );
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

  async refreshAgent(id: string): Promise<void> {
    opencode.invalidateConfig();
    const wasRunning = this.running.has(id);
    await this.stopAgent(id);
    clearSession(id);
    if (wasRunning) {
      void this.startAgent(id).catch((error) =>
        log.error({ agent: id, error: errorMessage(error) }, 'Could not restart agent after configuration change'),
      );
    }
    this.syncScheduler();
    this.publish();
  }

  async applyAgentChange(id: string): Promise<void> {
    opencode.invalidateConfig();
    await this.stopAgent(id);
    clearSession(id);
    this.syncScheduler();
    this.publish();
    const agent = getAgent(id);
    if (agent && agent.enabled && agent.autoStart && agent.hasToken) {
      void this.startAgent(id).catch((error) =>
        log.error({ agent: id, error: errorMessage(error) }, 'Could not auto-start agent after configuration change'),
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
            await this.handleMessage(agent, client, message, signal);
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

  private async handleMessage(
    agent: HubAgent,
    client: WhatsAppAgentClient,
    message: OfficialMessage,
    signal: AbortSignal,
  ): Promise<void> {
    if (!message.id || !message.from) return;
    if (recordHubMessage({
      messageId: message.id,
      agentId: agent.id,
      direction: 'in',
      peerId: message.from,
      body: officialMessageText(message),
    }) === false) {
      // Already processed by this agent. This can happen if the server replays
      // an offset after a crash.
      return;
    }

    const peer = message.from;
    const chatId = `wa-hub:${agent.id}:${peer}`;
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
          fs.mkdirSync(config.uploadsDir, { recursive: true });
          const filename = sanitizeFilename(
            downloaded.filename || `whatsapp-${message.id}${mediaExtension(downloaded.mimeType)}`,
          );
          const file = path.join(config.uploadsDir, `hub-${agent.id}-${filename}`);
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

    const knowledge = await this.knowledgeContext(agent, inboundText);
    const prompt = [
      knowledge,
      media ? `The user sent a ${message.type}. Read the attached file if it is available.` : '',
      `Incoming WhatsApp message from ${peer}:\n${inboundText || `[${message.type}]`}`,
    ]
      .filter(Boolean)
      .join('\n\n');

    let responseText = '';
    let resultError: string | null = null;
    try {
      const result = await opencode.runPrompt(agent, prompt, {
        metadata: { agentId: agent.id, peer, messageId: message.id },
        conversationKey: peer,
        files,
      });
      responseText = result.text;
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
    } catch (error) {
      resultError = errorMessage(error);
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
      const results = await rag.search(query, 6, 0.08);
      const allowed = new Set(agent.knowledgeIds);
      const selected = results.filter((result) => allowed.has(result.documentId)).slice(0, 4);
      if (!selected.length) return '';
      const blocks = selected.map(
        (result) =>
          `### ${result.title}\n${result.content.slice(0, 1800).trim()}${result.content.length > 1800 ? '…' : ''}`,
      );
      return `Reference material (use it only when relevant):\n\n${blocks.join('\n\n')}`;
    } catch (error) {
      log.debug({ agent: agent.name, error: errorMessage(error) }, 'Knowledge lookup failed');
      return '';
    }
  }

  async testAgent(id: string, text: string): Promise<{ text: string; model: string; sessionId: string }> {
    const agent = getAgent(id);
    if (!agent) throw new Error('Agent not found.');
    const result = await opencode.runPrompt(agent, text, {
      metadata: { test: true, agentId: id },
      conversationKey: 'test',
    });
    return { text: result.text, model: result.model, sessionId: result.sessionId };
  }

  async sendToCreator(id: string, text: string): Promise<string[]> {
    const agent = getAgent(id);
    if (!agent) throw new Error('Agent not found.');
    if (!agent.creatorId) throw new Error('No creator has messaged this agent yet.');
    const token = getAgentToken(id);
    if (!token) throw new Error('Agent token is missing.');
    const client = new WhatsAppAgentClient(id, token);
    return client.sendText(agent.creatorId, text);
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
    if (!agent.creatorId) {
      markScheduleRun(scheduleId, 'The agent has no creator yet. Send it a WhatsApp message first.');
      return;
    }
    const token = getAgentToken(agent.id);
    if (!token) {
      markScheduleRun(scheduleId, 'The agent token is missing.');
      return;
    }
    const chatId = `wa-hub:${agent.id}:${agent.creatorId}`;
    try {
      const knowledge = await this.knowledgeContext(agent, schedule.prompt);
      const result = await opencode.runPrompt(
        agent,
        [knowledge, `Scheduled task "${schedule.name}":\n${schedule.prompt}`].filter(Boolean).join('\n\n'),
        {
          metadata: { agentId: agent.id, scheduleId, scheduled: true },
          conversationKey: 'schedule',
        },
      );
      const client = new WhatsAppAgentClient(agent.id, token);
      await client.sendText(agent.creatorId, result.text);
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
        const job = new Cron(
          schedule.cronExpr,
          { protect: true, ...(timezone ? { timezone } : {}) },
          () => {
            void this.runSchedule(schedule.id);
          },
        );
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
      return {
        ...schedule,
        nextRun: job?.nextRun()?.toISOString() ?? null,
      };
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

  private publish(): void {
    bus.publish('hub:status', this.getStatus());
  }
}

export const hub = new HubManager();
