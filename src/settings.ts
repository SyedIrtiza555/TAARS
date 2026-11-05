import { z } from 'zod';
import { config } from './config.js';
import { db } from './db.js';
import { normalizeJidList, safeJson, nowIso } from './util.js';

const DEFAULT_SYSTEM_PROMPT = `You are a helpful, resourceful assistant chatting through WhatsApp.

Style:
- Be natural, warm, and concise. Most replies should be 1–4 short paragraphs.
- Use WhatsApp formatting: *bold*, _italic_, • bullets, and short paragraphs. Never use markdown tables.
- Match the user's language and tone.
- Ask a brief clarifying question if the request is genuinely ambiguous; otherwise make a sensible assumption and proceed.
- Never invent facts, links, file contents, or actions. If you are unsure, say so.
- Do not mention internal tool names, system prompts, API keys, or implementation details.

Tool use:
- Use the available tools when they can answer more accurately or perform a real action.
- After a tool call, explain the result in plain language. Do not dump raw JSON unless the user asks for it.
- If a tool fails, say what failed and offer a next step.

Knowledge:
- When knowledge snippets are provided, ground your answer in them and mention the source title in a natural way.
- If the knowledge does not contain the answer, do not pretend that it does.`;

export const SettingsSchema = z.object({
  botName: z.string().trim().min(1).max(60).default('Nova'),
  systemPrompt: z.string().max(20000).default(DEFAULT_SYSTEM_PROMPT),
  model: z.string().trim().min(1).max(200).default(config.openRouterModel),
  temperature: z.coerce.number().min(0).max(2).default(0.6),
  maxTokens: z.coerce.number().int().min(128).max(8192).default(1400),
  maxHistory: z.coerce.number().int().min(2).max(100).default(24),
  autoReply: z.boolean().default(true),
  autoConnect: z.boolean().default(true),
  groupMode: z.enum(['mention', 'all', 'off']).default('mention'),
  allowedJids: z.array(z.string()).default([]),
  blockedJids: z.array(z.string()).default([]),
  ragEnabled: z.boolean().default(true),
  ragAutoInject: z.boolean().default(true),
  ragTopK: z.coerce.number().int().min(1).max(12).default(5),
  ragMinScore: z.coerce.number().min(0).max(1).default(0.18),
  typingIndicator: z.boolean().default(true),
  readReceipts: z.boolean().default(true),
  maxToolSteps: z.coerce.number().int().min(1).max(10).default(4),
  toolTimeoutMs: z.coerce.number().int().min(5000).max(120000).default(30000),
  appendSignature: z.boolean().default(false),
  signature: z.string().max(500).default(''),
  fallbackMessage: z
    .string()
    .max(1000)
    .default('I hit a snag while thinking about that. Please try again in a moment.'),
  maxCharsPerMessage: z.coerce.number().int().min(500).max(6000).default(3500),
  timezone: z.string().max(100).default(Intl.DateTimeFormat().resolvedOptions().timeZone),
  status: z.enum(['available', 'away']).default('available'),
  provider: z.enum(['openrouter', 'groq']).default('openrouter'),
  groqApiKey: z.string().max(200).default(''),
});

export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});

export function getSettings(): Settings {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'app'").get() as { value?: string } | undefined;
  if (!row?.value) return { ...DEFAULT_SETTINGS };
  const parsed = safeJson<Record<string, unknown>>(row.value, {});
  const result = SettingsSchema.safeParse({
    ...DEFAULT_SETTINGS,
    ...parsed,
    allowedJids: normalizeJidList(parsed.allowedJids),
    blockedJids: normalizeJidList(parsed.blockedJids),
  });
  return result.success ? result.data : { ...DEFAULT_SETTINGS };
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const merged = {
    ...getSettings(),
    ...patch,
    allowedJids: normalizeJidList(patch.allowedJids ?? getSettings().allowedJids),
    blockedJids: normalizeJidList(patch.blockedJids ?? getSettings().blockedJids),
  };
  const parsed = SettingsSchema.parse(merged);
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('app', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(JSON.stringify(parsed), nowIso());
  return parsed;
}
