import { splitForWhatsApp, sleep } from './util.js';

export const WHATSAPP_AGENT_BASE_URL =
  process.env.WHATSAPP_AGENT_API_BASE || 'https://api.whatsapp.com/agent/v1';

export type OfficialMedia = {
  id?: string;
  mime_type?: string;
  filename?: string;
  caption?: string;
  sha256?: string;
  file_size?: number;
};

export type OfficialMessage = {
  id: string;
  from: string;
  timestamp?: string | number;
  type: string;
  text?: { body?: string };
  image?: OfficialMedia;
  audio?: OfficialMedia;
  video?: OfficialMedia;
  document?: OfficialMedia;
  sticker?: OfficialMedia;
  button?: { text?: string; payload?: string };
  interactive?: {
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string };
  };
  reaction?: { emoji?: string; message_id?: string };
  location?: { name?: string; address?: string; latitude?: number; longitude?: number };
  [key: string]: unknown;
};

export type OfficialPollResult =
  | {
      status: 204;
      nextOffset: string | null;
      messages: OfficialMessage[];
      statuses: unknown[];
      contacts: unknown[];
    }
  | {
      status: 200;
      nextOffset: string | null;
      messages: OfficialMessage[];
      statuses: unknown[];
      contacts: unknown[];
    };

export class WhatsAppApiError extends Error {
  status: number;
  code?: number | string;
  retryAfterMs?: number;
  body?: unknown;

  constructor(message: string, status: number, options: { code?: number | string; retryAfterMs?: number; body?: unknown } = {}) {
    super(message);
    this.name = 'WhatsAppApiError';
    this.status = status;
    this.code = options.code;
    this.retryAfterMs = options.retryAfterMs;
    this.body = options.body;
  }
}

export class SlidingWindowLimiter {
  private stamps: number[] = [];

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs = 60_000,
  ) {}

  async acquire(signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw new Error('Aborted');
      const now = Date.now();
      this.stamps = this.stamps.filter((stamp) => now - stamp < this.windowMs);
      if (this.stamps.length < this.maxRequests) {
        this.stamps.push(now);
        return;
      }
      const wait = Math.max(25, this.windowMs - (now - this.stamps[0]) + 100);
      await abortableSleep(wait, signal);
    }
  }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('Aborted'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function retryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host === '::1' || host === '[::1]') return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) {
    return true;
  }
  const match = /^172\.(\d+)\./.exec(host);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}

function safeMediaUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== 'https:') throw new Error('Media URL must use HTTPS.');
  if (isPrivateHost(url.hostname) || isPrivateHost(url.host)) {
    throw new Error('Media URL points at a private address.');
  }
  return url.toString();
}

export function officialMessageText(message: OfficialMessage): string {
  if (message.type === 'text') return message.text?.body ?? '';
  if (message.type === 'image') return message.image?.caption || '[image]';
  if (message.type === 'video') return message.video?.caption || '[video]';
  if (message.type === 'document') return message.document?.caption || message.document?.filename || '[document]';
  if (message.type === 'audio') return '[voice note]';
  if (message.type === 'sticker') return '[sticker]';
  if (message.type === 'button') return message.button?.text || '[button reply]';
  if (message.type === 'interactive') {
    return (
      message.interactive?.button_reply?.title ||
      message.interactive?.list_reply?.title ||
      '[interactive reply]'
    );
  }
  if (message.type === 'reaction') return message.reaction?.emoji ? `[reaction ${message.reaction.emoji}]` : '[reaction]';
  if (message.type === 'location') {
    return [message.location?.name, message.location?.address, message.location?.latitude, message.location?.longitude]
      .filter(Boolean)
      .join(' · ') || '[location]';
  }
  return `[${message.type || 'unknown'} message]`;
}

export function officialMessageMedia(message: OfficialMessage): OfficialMedia | null {
  for (const type of ['image', 'video', 'document', 'audio', 'sticker'] as const) {
    const media = message[type];
    if (media && typeof media === 'object' && media.id) return media;
  }
  return null;
}

export class WhatsAppAgentClient {
  private readonly pollLimiter: SlidingWindowLimiter;
  private readonly sendLimiter: SlidingWindowLimiter;
  private readonly statusLimiter: SlidingWindowLimiter;
  private readonly mediaLimiter: SlidingWindowLimiter;
  private sendQueue: Promise<unknown> = Promise.resolve();
  private typingSupported = true;

  constructor(
    public readonly agentId: string,
    private readonly token: string,
    private readonly baseUrl = WHATSAPP_AGENT_BASE_URL,
  ) {
    // Keep a small margin under the documented per-minute caps.
    this.pollLimiter = new SlidingWindowLimiter(14);
    this.sendLimiter = new SlidingWindowLimiter(11);
    this.statusLimiter = new SlidingWindowLimiter(11);
    this.mediaLimiter = new SlidingWindowLimiter(11);
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      ...extra,
    };
  }

  private async request(
    path: string,
    init: RequestInit,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Request timed out')), timeoutMs);
    const onAbort = () => controller.abort(signal?.reason ?? new Error('Aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: this.headers({
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(init.headers as Record<string, string> | undefined),
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private async json<T>(response: Response): Promise<T> {
    const text = await response.text();
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new WhatsAppApiError(`Invalid JSON response from WhatsApp (${response.status})`, response.status, {
        body: text.slice(0, 500),
      });
    }
  }

  private async errorFrom(response: Response): Promise<WhatsAppApiError> {
    const text = await response.text().catch(() => '');
    let body: unknown = text;
    let message = text || response.statusText || `HTTP ${response.status}`;
    let code: number | string | undefined;
    try {
      body = JSON.parse(text);
      const parsed = body as {
        error?: { code?: number | string; message?: string; type?: string } | string;
        message?: string;
      };
      if (parsed.error && typeof parsed.error === 'object') {
        code = parsed.error.code;
        message = parsed.error.message || message;
      } else if (typeof parsed.error === 'string') {
        message = parsed.error;
      } else if (parsed.message) {
        message = parsed.message;
      }
    } catch {
      /* keep raw text */
    }
    return new WhatsAppApiError(message, response.status, {
      code,
      retryAfterMs: retryAfterMs(response.headers),
      body,
    });
  }

  async pollUpdates(
    offset: string | null,
    timeoutSeconds = 25,
    signal?: AbortSignal,
  ): Promise<OfficialPollResult> {
    await this.pollLimiter.acquire(signal);
    const query = new URLSearchParams({
      timeout: String(Math.max(1, Math.min(60, timeoutSeconds))),
      limit: '50',
    });
    if (offset) query.set('offset', offset);

    const response = await this.request(
      `/updates?${query.toString()}`,
      { method: 'GET' },
      (timeoutSeconds + 20) * 1000,
      signal,
    );

    if (response.status === 204) {
      return { status: 204, nextOffset: offset, messages: [], statuses: [], contacts: [] };
    }
    if (!response.ok) throw await this.errorFrom(response);

    const raw = await response.text();
    if (!raw.trim()) {
      return { status: 204, nextOffset: offset, messages: [], statuses: [], contacts: [] };
    }

    // next_offset is a 64-bit integer. Keep it as a string so JavaScript never
    // rounds it; JSON.parse alone would lose precision above 2^53.
    const offsetMatch = /"next_offset"\s*:\s*"?(\d+)"?/.exec(raw);
    let parsed: {
      next_offset?: string | number;
      entry?: Array<{ changes?: Array<{ value?: { messages?: OfficialMessage[]; statuses?: unknown[]; contacts?: unknown[] } }> }>;
      messages?: OfficialMessage[];
      statuses?: unknown[];
      contacts?: unknown[];
    };
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new WhatsAppApiError('WhatsApp returned an invalid updates payload.', response.status, {
        body: raw.slice(0, 500),
      });
    }

    const values = (parsed.entry || [])
      .flatMap((entry) => entry.changes || [])
      .map((change) => change.value)
      .filter((value): value is NonNullable<typeof value> => Boolean(value));

    const messages = values.flatMap((value) => value.messages || []).concat(parsed.messages || []);
    const statuses = values.flatMap((value) => value.statuses || []).concat(parsed.statuses || []);
    const contacts = values.flatMap((value) => value.contacts || []).concat(parsed.contacts || []);
    const nextOffset =
      offsetMatch?.[1] ??
      (parsed.next_offset !== undefined && parsed.next_offset !== null ? String(parsed.next_offset) : offset);

    return { status: 200, nextOffset, messages, statuses, contacts };
  }

  async markRead(
    messageId: string,
    options: { typing?: boolean; signal?: AbortSignal } = {},
  ): Promise<void> {
    const typing = Boolean(options.typing && this.typingSupported);
    await this.statusLimiter.acquire(options.signal);
    const response = await this.request(
      '/statuses',
      {
        method: 'POST',
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: messageId,
          ...(typing ? { typing_indicator: { type: 'text' } } : {}),
        }),
      },
      20_000,
      options.signal,
    );

    if (response.ok) return;

    // Some Agent Platform versions accept read receipts but reject the typing
    // indicator. Fall back quietly and remember that for this process.
    if (typing && [400, 404, 422].includes(response.status)) {
      this.typingSupported = false;
      await this.statusLimiter.acquire(options.signal);
      const retry = await this.request(
        '/statuses',
        {
          method: 'POST',
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            status: 'read',
            message_id: messageId,
          }),
        },
        20_000,
        options.signal,
      );
      if (retry.ok) return;
      throw await this.errorFrom(retry);
    }

    throw await this.errorFrom(response);
  }

  sendText(
    to: string,
    body: string,
    options: { quoteMessageId?: string; signal?: AbortSignal } = {},
  ): Promise<string[]> {
    const task = this.sendQueue.then(() => this.sendTextNow(to, body, options));
    this.sendQueue = task.catch(() => undefined);
    return task;
  }

  private async sendTextNow(
    to: string,
    body: string,
    options: { quoteMessageId?: string; signal?: AbortSignal },
  ): Promise<string[]> {
    const chunks = splitForWhatsApp(body, 4000);
    if (chunks.length === 0) return [];
    const sentIds: string[] = [];

    for (let index = 0; index < chunks.length; index += 1) {
      await this.sendLimiter.acquire(options.signal);
      const payload: Record<string, unknown> = {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: chunks[index], preview_url: true },
      };
      if (options.quoteMessageId && index === 0) {
        payload.context = { message_id: options.quoteMessageId };
      }

      let response = await this.request(
        '/messages',
        { method: 'POST', body: JSON.stringify(payload) },
        30_000,
        options.signal,
      );

      if (response.status === 429) {
        const error = await this.errorFrom(response);
        const wait = Math.max(1_000, error.retryAfterMs ?? 5_000);
        await sleep(wait);
        await this.sendLimiter.acquire(options.signal);
        response = await this.request(
          '/messages',
          { method: 'POST', body: JSON.stringify(payload) },
          30_000,
          options.signal,
        );
      }

      if (!response.ok) throw await this.errorFrom(response);
      const data = (await this.json<{ messages?: Array<{ id?: string }> }>(response)) || {};
      for (const message of data.messages || []) {
        if (message.id) sentIds.push(message.id);
      }
    }

    return sentIds;
  }

  async downloadMedia(
    mediaId: string,
    signal?: AbortSignal,
  ): Promise<{ bytes: Uint8Array; mimeType: string; filename?: string }> {
    await this.mediaLimiter.acquire(signal);
    const metaResponse = await this.request(`/media/${encodeURIComponent(mediaId)}`, { method: 'GET' }, 30_000, signal);
    if (!metaResponse.ok) throw await this.errorFrom(metaResponse);
    const meta = await this.json<{ url?: string; mime_type?: string; filename?: string }>(metaResponse);
    if (!meta.url) throw new Error('WhatsApp media metadata did not include a download URL.');

    const url = safeMediaUrl(meta.url);
    await this.mediaLimiter.acquire(signal);
    const fileResponse = await fetch(url, { signal });
    if (!fileResponse.ok) {
      throw new WhatsAppApiError(`Media download failed (${fileResponse.status})`, fileResponse.status);
    }
    return {
      bytes: new Uint8Array(await fileResponse.arrayBuffer()),
      mimeType: meta.mime_type || fileResponse.headers.get('content-type') || 'application/octet-stream',
      filename: meta.filename,
    };
  }
}

/**
 * Test hook: keeps rate-limiter math deterministic without sleeping a minute.
 */
export function createTestLimiter(maxRequests: number, windowMs = 60_000): SlidingWindowLimiter {
  return new SlidingWindowLimiter(maxRequests, windowMs);
}
