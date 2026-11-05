import fs from 'node:fs';
import path from 'node:path';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  getContentType,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  isJidStatusBroadcast,
  normalizeMessageContent,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { agent } from './agent.js';
import { config } from './config.js';
import { bus } from './events.js';
import { createLogger } from './logger.js';
import { getSettings, updateSettings } from './settings.js';
import { markProcessed, resetChat } from './store.js';
import {
  digits,
  errorMessage,
  jidToNumber,
  nowIso,
  sleep,
  splitForWhatsApp,
} from './util.js';

const log = createLogger('whatsapp');

// Baileys logs the full pairing payload at info level, including device keys.
// Keep its output on warn/error so normal dev logs stay readable and secrets
// do not end up in the log viewer.
const baileysLogger = {
  level: 'warn',
  child: () => baileysLogger,
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: (...args: unknown[]) => log.warn(...args),
  error: (...args: unknown[]) => log.error(...args),
  fatal: (...args: unknown[]) => log.error(...args),
};

export type WhatsAppState =
  | 'disconnected'
  | 'connecting'
  | 'qr'
  | 'connected'
  | 'logged_out'
  | 'error';

export type WhatsAppSnapshot = {
  state: WhatsAppState;
  phoneNumber: string | null;
  name: string | null;
  qrDataUrl: string | null;
  qrIssuedAt: string | null;
  lastError: string | null;
  connectedAt: string | null;
  startedAt: string | null;
};

type MessageContext = {
  chatId: string;
  isGroup: boolean;
  senderJid: string;
  senderName: string;
  text: string;
  mentioned: boolean;
  message: WAMessage;
};

function timestampMs(value: unknown): number {
  if (typeof value === 'number') return value > 10_000_000_000 ? value : value * 1000;
  if (value && typeof (value as { toNumber?: () => number }).toNumber === 'function') {
    return (value as { toNumber: () => number }).toNumber() * 1000;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : Date.now();
}

function getText(message: WAMessage): string {
  const content = normalizeMessageContent(message.message);
  if (!content) return '';
  const type = getContentType(content);
  if (!type) return '';
  const node = (content as Record<string, unknown>)[type] as Record<string, unknown> | string | undefined;
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object') return '';

  switch (type) {
    case 'conversation':
      return String(node.text || '');
    case 'extendedTextMessage':
      return String(node.text || '');
    case 'imageMessage':
    case 'videoMessage':
    case 'documentMessage':
    case 'audioMessage':
      return String(node.caption || '');
    case 'buttonsResponseMessage':
      return String(node.selectedButtonId || node.selectedDisplayText || '');
    case 'listResponseMessage':
      return String(node.title || '');
    case 'templateButtonReplyMessage':
      return String(node.selectedId || node.selectedDisplayText || '');
    case 'interactiveResponseMessage': {
      const flow = node.nativeFlowResponseMessage as Record<string, unknown> | undefined;
      return String(flow?.paramsJson || '');
    }
    case 'locationMessage':
      return `Shared a location: ${node.degreesLatitude ?? ''}, ${node.degreesLongitude ?? ''}`;
    default:
      return '';
  }
}

function getContextInfo(message: WAMessage): Record<string, unknown> | null {
  const content = normalizeMessageContent(message.message);
  if (!content) return null;
  const type = getContentType(content);
  if (!type) return null;
  const node = (content as Record<string, unknown>)[type] as Record<string, unknown> | undefined;
  return node && typeof node.contextInfo === 'object'
    ? (node.contextInfo as Record<string, unknown>)
    : null;
}

function sendHelp(botNumber: string | null): string {
  return [
    '🤖 *WhatsApp Agent*',
    '',
    'Just send me a message and I will answer using AI, my knowledge base, and any connected tools.',
    '',
    '*Commands*',
    '• /reset — clear this conversation’s context',
    '• /help — show this message',
    '• /id — show this chat ID',
    '',
    botNumber ? `In groups, mention me with @${botNumber} (or use the mention picker).` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export class WhatsAppManager {
  private sock: WASocket | null = null;
  private state: WhatsAppState = 'disconnected';
  private qrDataUrl: string | null = null;
  private qrIssuedAt: string | null = null;
  private lastError: string | null = null;
  private connectedAt: string | null = null;
  private startedAt: string | null = null;
  private generation = 0;
  private manualStop = false;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private startPromise: Promise<void> | null = null;
  private queues = new Map<string, Promise<void>>();
  private messageCache = new Map<string, WAMessage>();
  private groupNames = new Map<string, { name: string; at: number }>();
  private typingTimers = new Map<string, NodeJS.Timeout>();
  private commandStates = new Map<string, { state: 'awaiting' | 'timeout' | 'done' | 'error'; targetJid: string; originalChatId: string; timeout: NodeJS.Timeout; startedAt: number }>();
  private awayReplied = new Set<string>();

  getSnapshot(): WhatsAppSnapshot {
    return {
      state: this.state,
      phoneNumber: this.phoneNumber(),
      name: this.sock?.user?.name || this.sock?.user?.verifiedName || null,
      qrDataUrl: this.state === 'qr' ? this.qrDataUrl : null,
      qrIssuedAt: this.qrIssuedAt,
      lastError: this.lastError,
      connectedAt: this.connectedAt,
      startedAt: this.startedAt,
    };
  }

  phoneNumber(): string | null {
    const id = this.sock?.user?.id;
    return id ? jidToNumber(id) : null;
  }

  isConnected(): boolean {
    return this.state === 'connected';
  }

  private setState(state: WhatsAppState, error: string | null = null): void {
    this.state = state;
    this.lastError = error;
    bus.publish('whatsapp:status', this.getSnapshot());
  }

  async start(): Promise<void> {
    if (this.sock || this.startPromise) return this.startPromise || undefined;
    this.manualStop = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.startPromise = this.launch().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async launch(): Promise<void> {
    const generation = ++this.generation;
    this.setState('connecting');
    this.startedAt = nowIso();
    log.info('Starting WhatsApp connection');

    try {
      const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
      let version: [number, number, number] | undefined;
      try {
        const latest = await fetchLatestBaileysVersion();
        version = latest.version as [number, number, number];
      } catch {
        log.debug('Could not fetch latest WhatsApp Web version; using bundled default');
      }

      const sock = makeWASocket({
        auth: state,
        ...(version ? { version } : {}),
        browser: Browsers.ubuntu('Chrome'),
        logger: baileysLogger as never,
        printQRInTerminal: false,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        emitOwnEvents: false,
        connectTimeoutMs: 60_000,
        defaultQueryTimeoutMs: 60_000,
        keepAliveIntervalMs: 25_000,
        retryRequestDelayMs: 500,
        maxMsgRetryCount: 3,
      });
      this.sock = sock;

      sock.ev.on('creds.update', saveCreds);

      sock.ev.on('connection.update', (update) => {
        if (generation !== this.generation) return;
        void this.handleConnectionUpdate(update);
      });

      sock.ev.on('messages.upsert', (event) => {
        if (generation !== this.generation) return;
        if (event.type !== 'notify') return;
        for (const message of event.messages) {
          if (message.key.id) {
            this.messageCache.set(message.key.id, message);
            if (this.messageCache.size > 500) {
              const first = this.messageCache.keys().next().value;
              if (first) this.messageCache.delete(first);
            }
          }
          void this.onMessage(message);
        }
      });

      log.info('WhatsApp socket created; waiting for QR or session restore');
    } catch (error) {
      const message = errorMessage(error);
      log.error({ error: message }, 'Failed to start WhatsApp');
      this.sock = null;
      this.setState('error', message);
      this.scheduleReconnect();
    }
  }

  private async handleConnectionUpdate(update: {
    connection?: 'open' | 'connecting' | 'close';
    lastDisconnect?: { error?: unknown; date?: Date };
    qr?: string;
    isNewLogin?: boolean;
  }): Promise<void> {
    if (update.qr) {
      const firstQr = !this.qrDataUrl;
      try {
        this.qrDataUrl = await QRCode.toDataURL(update.qr, {
          margin: 1,
          width: 360,
          color: { dark: '#0b141a', light: '#ffffff' },
        });
        this.qrIssuedAt = nowIso();
        this.setState('qr');
        if (firstQr) {
          log.info('WhatsApp QR code generated - scan it from Linked devices');
        } else {
          log.debug('WhatsApp QR code refreshed');
        }
      } catch (error) {
        log.warn({ error: errorMessage(error) }, 'Could not render WhatsApp QR');
      }
    }

    if (update.connection === 'connecting') {
      this.setState('connecting');
    }

    if (update.connection === 'open') {
      this.connectedAt = nowIso();
      this.reconnectAttempts = 0;
      this.qrDataUrl = null;
      this.qrIssuedAt = null;
      this.setState('connected');
      const number = this.phoneNumber();
      log.info({ number, name: this.sock?.user?.name }, 'WhatsApp connected');
    }

    if (update.connection === 'close') {
      const statusCode = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)
        ?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      const qrExpired = statusCode === DisconnectReason.timedOut && Boolean(this.qrDataUrl);
      const reason = update.lastDisconnect?.error
        ? errorMessage(update.lastDisconnect.error)
        : 'Connection closed';
      log.warn({ statusCode, reason }, 'WhatsApp connection closed');
      this.sock = null;
      this.qrDataUrl = null;
      this.connectedAt = null;
      this.stopTypingAll();

      if (loggedOut) {
        this.setState('logged_out', 'This WhatsApp session was logged out. Link the device again.');
        return;
      }
      if (this.manualStop) {
        this.setState('disconnected');
        return;
      }
      if (qrExpired) {
        this.setState('disconnected', 'The pairing QR expired. Connect again to generate a fresh one.');
        return;
      }
      this.setState('disconnected', reason);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.manualStop || this.reconnectTimer) return;
    this.reconnectAttempts++;
    const delay = Math.min(30_000, 1_500 * 2 ** Math.min(5, this.reconnectAttempts));
    log.info({ delay, attempt: this.reconnectAttempts }, 'Reconnecting to WhatsApp');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.manualStop) return;
      void this.start();
    }, delay);
  }

  async stop(): Promise<void> {
    this.manualStop = true;
    this.generation++;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopTypingAll();
    const sock = this.sock;
    this.sock = null;
    if (sock) {
      try {
        await sock.end(undefined);
      } catch (error) {
        log.debug({ error: errorMessage(error) }, 'Error while closing WhatsApp socket');
      }
    }
    this.setState('disconnected');
  }

  async logout(): Promise<void> {
    await this.stop();
    try {
      fs.rmSync(config.authDir, { recursive: true, force: true });
      fs.mkdirSync(config.authDir, { recursive: true });
    } catch (error) {
      log.warn({ error: errorMessage(error) }, 'Could not clear WhatsApp auth directory');
    }
    this.qrDataUrl = null;
    this.qrIssuedAt = null;
    this.connectedAt = null;
    this.setState('logged_out', null);
    log.info('WhatsApp session removed');
  }

  async reconnect(): Promise<void> {
    await this.stop();
    this.manualStop = false;
    await this.start();
  }

  private botNumbers(): Set<string> {
    const values = [
      this.sock?.user?.id,
      this.sock?.user?.lid,
      (this.sock?.authState?.creds?.me as { id?: string; lid?: string } | undefined)?.id,
      (this.sock?.authState?.creds?.me as { id?: string; lid?: string } | undefined)?.lid,
    ];
    return new Set(values.filter(Boolean).map((jid) => digits(String(jid))));
  }

  private async onMessage(message: WAMessage): Promise<void> {
    try {
      const chatId = message.key.remoteJid;
      if (!chatId) return;
      if (message.key.fromMe) {
        // User chatting with themselves (or sending from the linked account) triggers command mode.
        await this.handleUserCommand(chatId, message);
        return;
      }
      if (isJidStatusBroadcast(chatId)) return;
      if (isJidBroadcast(chatId) || isJidNewsletter(chatId)) return;
      const isGroup = Boolean(isJidGroup(chatId));
      const senderJid = isGroup
        ? message.key.participant || message.key.participantPn || chatId
        : message.key.remoteJid;
      if (!senderJid) return;

      const messageId = message.key.id || '';
      if (!messageId) return;

      const age = Date.now() - timestampMs(message.messageTimestamp);
      if (age > 10 * 60 * 1000) {
        log.debug({ chatId, age }, 'Ignoring old WhatsApp message');
        return;
      }

      const settings = getSettings();
      const jidAllow = chatId.toLowerCase();
      const senderAllow = senderJid.toLowerCase();
      const allowed =
        settings.allowedJids.length === 0 ||
        settings.allowedJids.some((entry) => {
          const entryDigits = digits(entry);
          return (
            entry.toLowerCase() === jidAllow ||
            entry.toLowerCase() === senderAllow ||
            (entryDigits.length > 4 && (digits(jidAllow) === entryDigits || digits(senderAllow) === entryDigits))
          );
        });
      if (!allowed) {
        log.debug({ chatId, senderJid }, 'Ignoring message from a number not on the allowlist');
        return;
      }
      const blocked = settings.blockedJids.some((entry) => {
        const entryDigits = digits(entry);
        return (
          entry.toLowerCase() === jidAllow ||
          entry.toLowerCase() === senderAllow ||
          (entryDigits.length > 4 && (digits(jidAllow) === entryDigits || digits(senderAllow) === entryDigits))
        );
      });
      if (blocked) return;

      if (isGroup) {
        if (settings.groupMode === 'off') return;
      }

      const rawText = getText(message).trim();
      if (!rawText) return;

      const contextInfo = getContextInfo(message);
      const mentions = (contextInfo?.mentionedJid as string[] | undefined) || [];
      const botNumbers = this.botNumbers();
      const mentioned =
        mentions.some((jid) => botNumbers.has(digits(jid))) ||
        [...botNumbers].some((number) => number.length > 3 && new RegExp(`@${number}\\b`).test(rawText));

      if (isGroup && settings.groupMode === 'mention' && !mentioned) return;

      let text = rawText;
      for (const number of botNumbers) {
        if (number.length > 3) text = text.replace(new RegExp(`@${number}\\b`, 'g'), '');
      }
      text = text.replace(/^[\s\u200e\u200f]+|[\s\u200e\u200f]+$/g, '').trim();
      if (!text) return;

      // State machine: collect replies for orchestrator commands.
      const activeState = Array.from(this.commandStates.values()).find(
        (s) => s.state === 'awaiting' && s.targetJid === senderJid,
      );
      if (activeState) {
        clearTimeout(activeState.timeout);
        this.commandStates.delete(activeState.originalChatId);
        try {
          await this.sendText(activeState.originalChatId, [
            '✅ *Reply collected:*',
            '',
            text,
            '',
            '*Next steps:*',
            '• Confirm the answer with the contact directly.',
            '• If incomplete, send a follow-up message.',
            '• Update your records or calendar based on this response.',
          ].join('\n'));
        } catch {
          // best effort
        }
        return;
      }

      // Away mode: reply once per new chat when status is away and auto-reply is on.
      if (settings.status === 'away' && settings.autoReply && !message.key.fromMe && !this.awayReplied.has(chatId) && !isGroup) {
        this.awayReplied.add(chatId);
        try {
          await this.sendText(chatId, 'I am away for a moment. I will get back to you shortly.');
        } catch {
          // best effort
        }
      }

      if (!markProcessed(messageId, chatId)) return;

      if (settings.readReceipts && !isGroup && this.sock) {
        try {
          await this.sock.readMessages([message.key]);
        } catch {
          // read receipts are best effort
        }
      }

      const senderName = message.pushName || (isGroup ? jidToNumber(senderJid) : 'Contact');
      const chatName = isGroup ? await this.getGroupName(chatId) : senderName;
      const command = text.toLowerCase().trim();

      if (command === '/help' || command === '/reset' || command === '/new' || command === '/id') {
        this.processCommand(
          command,
          { chatId, isGroup, senderJid, senderName, text, mentioned, message },
          chatName,
        );
        return;
      }

      if (!settings.autoReply) {
        log.debug({ chatId }, 'Auto-reply is disabled; ignoring message');
        return;
      }

      this.enqueue(chatId, async () => {
        await this.withTyping(chatId, async () => {
          const result = await agent.respond({
            chatId,
            userText: text,
            senderName,
            source: 'whatsapp',
            isGroup,
            chatName,
          });
          await this.sendText(chatId, result.text, message);
          if (result.error) log.warn({ chatId, error: result.error }, 'Agent returned fallback response');
        });
      });
    } catch (error) {
      const msg = errorMessage(error);
      if (!message.key.fromMe || !(msg.includes('No matching sessions') || msg.includes('Bad MAC') || msg.includes('Failed to decrypt message'))) {
        log.error({ error: msg }, 'Error handling WhatsApp message');
      }
    }
  }

  private processCommand(
    command: string,
    context: MessageContext,
    chatName: string,
  ): void {
    this.enqueue(context.chatId, async () => {
      try {
        if (command === '/reset' || command === '/new') {
          resetChat(context.chatId);
          await this.sendText(context.chatId, '🧼 Fresh conversation started. What’s next?');
          return;
        }
        if (command === '/id') {
          await this.sendText(
            context.chatId,
            `🪪 *Chat:* ${context.chatId}\n*You:* ${context.senderJid}\n*Group:* ${context.isGroup ? 'yes' : 'no'}`,
          );
          return;
        }
        await this.sendText(context.chatId, sendHelp(this.phoneNumber()));
      } catch (error) {
        log.error({ error: errorMessage(error), chatName }, 'Command failed');
      }
    });
  }

  private async handleUserCommand(chatId: string, message: WAMessage): Promise<void> {
    const rawText = getText(message).trim();
    if (!rawText) return;
    const settings = getSettings();

    // Status commands
    const lower = rawText.toLowerCase();
    if (lower === 'status away') {
      updateSettings({ status: 'away' });
      this.awayReplied = new Set(); // reset away replies on status change
      await this.sendText(chatId, 'Status set to away. I will reply once to new chats.');
      return;
    }
    if (lower === 'status available') {
      updateSettings({ status: 'available' });
      this.awayReplied = new Set();
      await this.sendText(chatId, 'Status set to available.');
      return;
    }

    // Ask command: ask <target>: <message> or ask <target> <message>
    const askPattern = /^ask\s+(.+?)(?::\s*|\s+)([\s\S]*)$/i;
    const match = rawText.match(askPattern);
    if (match) {
      const targetRaw = match[1].trim();
      const messageText = match[2].trim();
      const digitsOnly = targetRaw.replace(/\D/g, '');
      if (!messageText) {
        await this.sendText(chatId, 'Specify the message too. Example: ask 1234567890: Where are you?');
        return;
      }
      if (!digitsOnly) {
        await this.sendText(chatId, `Could not identify target from "${targetRaw}". Use the number, for example: ask 1234567890: message`);
        return;
      }
      const targetJid = digitsOnly.endsWith('@s.whatsapp.net') ? digitsOnly : `${digitsOnly}@s.whatsapp.net`;
      await this.runAskCommand(chatId, targetJid, messageText);
      return;
    }

    // Default help for command mode
    await this.sendText(chatId, [
      '🤖 *Orchestrator commands:*',
      '',
      '• ask <number>: <message> — send a message to a contact and collect the reply.',
      '• status away — set away; reply once to new chats.',
      '• status available — back to normal.',
    ].join('\n'));
  }

  private async runAskCommand(originalChatId: string, targetJid: string, question: string): Promise<void> {
    // State machine: sending -> awaiting -> done/timeout/error
    // Clean up any previous state for this user chat to avoid locked states.
    const existing = this.commandStates.get(originalChatId);
    if (existing) {
      clearTimeout(existing.timeout);
      this.commandStates.delete(originalChatId);
    }

    try {
      await this.sendText(originalChatId, `Sending message to ${targetJid.replace('@s.whatsapp.net', '')}...`);
      await this.sendText(targetJid, question);
    } catch (error) {
      await this.sendText(originalChatId, `Failed to send message: ${errorMessage(error)}`);
      return;
    }

    const timeoutMs = 5 * 60 * 1000; // 5 minutes
    const timer = setTimeout(async () => {
      const state = this.commandStates.get(originalChatId);
      if (!state || state.state !== 'awaiting') return;
      this.commandStates.delete(originalChatId);
      try {
        await this.sendText(originalChatId, '⏱ No reply received from the contact within 5 minutes. You can try again or follow up manually.');
      } catch {
        // best effort
      }
    }, timeoutMs);

    this.commandStates.set(originalChatId, {
      state: 'awaiting',
      targetJid,
      originalChatId,
      timeout: timer,
      startedAt: Date.now(),
    });
  }

  private async collectReply(originalChatId: string, targetJid: string, replyText: string): Promise<void> {
    const state = this.commandStates.get(originalChatId);
    if (!state || state.state !== 'awaiting' || state.targetJid !== targetJid) return;
    clearTimeout(state.timeout);
    this.commandStates.delete(originalChatId);
    try {
      await this.sendText(originalChatId, [
        '✅ *Reply collected:*',
        '',
        replyText,
        '',
        '*Next steps:*',
        '• Confirm the answer with the contact directly.',
        '• If incomplete, send a follow-up message.',
        '• Update your records or calendar based on this response.',
      ].join('\n'));
    } catch {
      // best effort
    }
  }

  private enqueue(chatId: string, task: () => Promise<void>): void {
    const previous = this.queues.get(chatId) || Promise.resolve();
    const next = previous
      .then(task)
      .catch((error) => {
        log.error({ chatId, error: errorMessage(error) }, 'Chat task failed');
      })
      .finally(() => {
        if (this.queues.get(chatId) === next) this.queues.delete(chatId);
      });
    this.queues.set(chatId, next);
  }

  private async sendText(chatId: string, text: string, quoted?: WAMessage): Promise<void> {
    if (!this.sock) throw new Error('WhatsApp is not connected.');
    const parts = splitForWhatsApp(text, getSettings().maxCharsPerMessage);
    for (let i = 0; i < parts.length; i++) {
      const payload = i === 0 && quoted ? { text: parts[i], quoted } : { text: parts[i] };
      await this.sock.sendMessage(chatId, payload);
      if (parts.length > 1) await sleep(250);
    }
  }

  private async withTyping<T>(chatId: string, task: () => Promise<T>): Promise<T> {
    if (!this.sock || !getSettings().typingIndicator) return task();
    try {
      await this.sock.sendPresenceUpdate('composing', chatId);
    } catch {
      // best effort
    }
    const timer = setInterval(() => {
      void this.sock?.sendPresenceUpdate('composing', chatId).catch(() => undefined);
    }, 10_000);
    this.typingTimers.set(chatId, timer);
    try {
      return await task();
    } finally {
      clearInterval(timer);
      this.typingTimers.delete(chatId);
      try {
        await this.sock?.sendPresenceUpdate('paused', chatId);
      } catch {
        // best effort
      }
    }
  }

  private stopTypingAll(): void {
    for (const timer of this.typingTimers.values()) clearInterval(timer);
    this.typingTimers.clear();
  }

  private async getGroupName(jid: string): Promise<string> {
    const cached = this.groupNames.get(jid);
    if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.name;
    try {
      if (!this.sock) return jidToNumber(jid);
      const metadata = await Promise.race([
        this.sock.groupMetadata(jid),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('group metadata timeout')), 5000)),
      ]);
      const name = metadata.subject || jidToNumber(jid);
      this.groupNames.set(jid, { name, at: Date.now() });
      return name;
    } catch {
      return jidToNumber(jid);
    }
  }

  async sendToSelf(text: string): Promise<void> {
    const number = this.phoneNumber();
    if (!number) throw new Error('WhatsApp is not connected.');
    await this.sendText(`${number}@s.whatsapp.net`, text);
  }
}


export const whatsapp = new WhatsAppManager();
