import OpenAI from 'openai';
import { config } from './config.js';
import { getSecret } from './secrets.js';
import { getSettings } from './settings.js';

export function getOpenRouterApiKey(): string {
  const settings = getSettings();
  if (settings.provider === 'groq') {
    return getSecret('groq_api_key') || config.groqApiKey;
  }
  return getSecret('openrouter_api_key') || config.openRouterApiKey;
}

export function getOpenRouterClient(): OpenAI {
  const settings = getSettings();
  const apiKey = getOpenRouterApiKey();
  if (!apiKey) throw new Error(`${settings.provider === 'groq' ? 'Groq' : 'OpenRouter'} API key is not configured.`);
  const baseUrl = settings.provider === 'groq' ? config.groqBaseUrl : config.openRouterBaseUrl;
  const headers = settings.provider === 'groq' ? {} : {
    'HTTP-Referer': config.appUrl,
    'X-Title': 'WhatsApp Agent',
  };
  return new OpenAI({
    apiKey,
    baseURL: baseUrl,
    defaultHeaders: headers,
    timeout: 90_000,
    maxRetries: 1,
  });
}

export function getModel(): string {
  return getSettings().model || config.openRouterModel;
}

export async function testOpenRouterKey(apiKey?: string): Promise<{ ok: boolean; label?: string; error?: string; limit?: number; usage?: number }> {
  const settings = getSettings();
  const key = apiKey?.trim() || getOpenRouterApiKey();
  if (!key) return { ok: false, error: `No ${settings.provider === 'groq' ? 'Groq' : 'OpenRouter'} API key configured.` };
  try {
    const baseUrl = settings.provider === 'groq' ? config.groqBaseUrl : config.openRouterBaseUrl;
    const endpoint = settings.provider === 'groq' ? '/models' : '/key';
    const response = await fetch(`${baseUrl}${endpoint}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      const text = await response.text();
      return { ok: false, error: `${settings.provider === 'groq' ? 'Groq' : 'OpenRouter'} returned ${response.status}: ${text.slice(0, 300)}` };
    }
    if (settings.provider === 'groq') {
      return { ok: true, label: `Groq key (${key.slice(0, 8)}...)` };
    }
    const data = (await response.json()) as { data?: { label?: string; limit?: number | null; usage?: number } };
    return { ok: true, label: data.data?.label || 'OpenRouter key', limit: data.data?.limit ?? undefined, usage: data.data?.usage ?? undefined };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

type OpenRouterModel = {
  id: string;
  name: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
};

let modelCache: { at: number; models: OpenRouterModel[] } | null = null;

export async function listOpenRouterModels(query = ''): Promise<OpenRouterModel[]> {
  const settings = getSettings();
  const baseUrl = settings.provider === 'groq' ? config.groqBaseUrl : config.openRouterBaseUrl;
  if (!modelCache || Date.now() - modelCache.at > 10 * 60 * 1000) {
    const response = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`Failed to load models (${response.status}).`);
    const payload = (await response.json()) as { data?: OpenRouterModel[] };
    modelCache = { at: Date.now(), models: payload.data || [] };
  }
  const q = query.trim().toLowerCase();
  return modelCache.models
    .filter((model) => (model.architecture?.output_modalities ?? ['text']).includes('text'))
    .filter((model) => !q || model.id.toLowerCase().includes(q) || model.name.toLowerCase().includes(q))
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, 60);
}
