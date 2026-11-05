import crypto from 'node:crypto';

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix = ''): string {
  const id = crypto.randomUUID();
  return prefix ? `${prefix}_${id}` : id;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

export function safeJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function digits(value: string): string {
  return value.replace(/\D/g, '');
}

export function jidToNumber(jid: string): string {
  return digits(jid.split('@')[0]?.split(':')[0] ?? '');
}

export function normalizeJid(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.includes('@')) return trimmed;
  const number = digits(trimmed);
  return number ? `${number}@s.whatsapp.net` : '';
}

export function normalizeJidList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => normalizeJid(String(value))).filter(Boolean))];
}

export function splitForWhatsApp(text: string, maxChars = 3500): string[] {
  const clean = text.trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];

  const parts: string[] = [];
  let remaining = clean;
  while (remaining.length > maxChars) {
    let cut = remaining.lastIndexOf('\n\n', maxChars);
    if (cut < maxChars * 0.55) cut = remaining.lastIndexOf('\n', maxChars);
    if (cut < maxChars * 0.55) cut = remaining.lastIndexOf('. ', maxChars);
    if (cut < maxChars * 0.55) cut = remaining.lastIndexOf(' ', maxChars);
    if (cut <= 0) cut = maxChars;
    parts.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) parts.push(remaining);
  return parts.filter(Boolean);
}

export function toWhatsAppMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/\*\*(.+?)\*\*/gs, '*$1*')
    .replace(/__(.+?)__/gs, '_$1_')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

export function parseKeyValueLines(value: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    const val = line.slice(index + 1).trim();
    if (key) result[key] = val;
  }
  return result;
}

export function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch {
      return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    }
  }
  return [];
}

export function maskSecret(value: string | null | undefined): string {
  if (!value) return '';
  if (value.length <= 8) return '••••••••';
  return `${value.slice(0, 4)}••••••••${value.slice(-4)}`;
}
