import { z } from 'zod';
import { config } from './config.js';
import { db } from './db.js';
import { safeJson, nowIso } from './util.js';

/**
 * Manager-level settings. The manager never talks on WhatsApp itself, so there is no
 * bot persona, auto-reply, or chat filter here: those all live on individual agents.
 * Older stored keys (botName, autoReply, ...) are ignored by the schema.
 */
export const SettingsSchema = z.object({
  /** Default model suggested for new agents (OpenRouter model id, without the `openrouter/` prefix). */
  model: z.string().trim().min(1).max(200).default(config.openRouterModel),
  timezone: z.string().max(100).default(Intl.DateTimeFormat().resolvedOptions().timeZone),
  provider: z.enum(['openrouter', 'groq']).default('openrouter'),
  groqApiKey: z.string().max(200).default(''),
  /** Consolidate memory after this many exchanges in a conversation. */
  memoryConsolidateEvery: z.coerce.number().int().min(1).max(50).default(3),
  /** Hard cap of automatically learned memories per agent; the least useful are forgotten first. */
  memoryMaxPerAgent: z.coerce.number().int().min(50).max(5000).default(500),
  /** How long working-memory notes live before they expire. */
  memoryWorkingTtlHours: z.coerce.number().int().min(1).max(720).default(48),
  /** Maximum long-term memories injected into a single prompt. */
  memoryRetrieveLimit: z.coerce.number().int().min(1).max(30).default(8),
  /** Timeout for MCP connection tests from the dashboard. */
  toolTimeoutMs: z.coerce.number().int().min(5000).max(120000).default(30000),
});

export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});

export function getSettings(): Settings {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'app'").get() as { value?: string } | undefined;
  if (!row?.value) return { ...DEFAULT_SETTINGS };
  const parsed = safeJson<Record<string, unknown>>(row.value, {});
  const result = SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, ...parsed });
  return result.success ? result.data : { ...DEFAULT_SETTINGS };
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const parsed = SettingsSchema.parse({ ...getSettings(), ...patch });
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('app', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(JSON.stringify(parsed), nowIso());
  return parsed;
}
