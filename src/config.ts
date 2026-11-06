import crypto from 'node:crypto';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

// `.env` is the default; a per-instance file can be selected with ENV_FILE
// (used by the hosted/second instance so it does not share secrets with the
// developer instance).
dotenv.config({ path: process.env.ENV_FILE || '.env' });

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

const rootDir = process.cwd();
const dataDir = path.resolve(rootDir, process.env.DATA_DIR || './data');

/**
 * Resolves APP_SECRET without requiring a hand-written value in .env:
 * 1. an explicit APP_SECRET env var wins,
 * 2. otherwise the value is read from (or first generated into) the secret
 *    file inside the data directory, so self-hosted instances come up fully
 *    provisioned with zero plaintext secrets in configuration files.
 */
function resolveAppSecret(): string {
  const explicit = process.env.APP_SECRET?.trim();
  if (explicit) return explicit;
  const file = process.env.APP_SECRET_FILE || path.join(dataDir, 'secret.key');
  try {
    const stored = fs.readFileSync(file, 'utf8').trim();
    if (stored.length >= 32) return stored;
  } catch {
    /* first boot on this instance */
  }
  const generated = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${generated}\n`, { mode: 0o600 });
  return generated;
}

export const config = {
  rootDir,
  port: intEnv('PORT', 8787),
  host: process.env.HOST || '127.0.0.1',
  dataDir,
  modelsDir: path.join(dataDir, 'models'),
  /** Legacy shared uploads folder. New media goes into each agent's own workspace inbox. */
  uploadsDir: path.join(dataDir, 'uploads'),
  /** One isolated workspace per agent: data/agents/<agent>/workspace */
  agentsDir: path.join(dataDir, 'agents'),
  publicDir: path.join(rootDir, 'public', 'admin'),
  /** Legacy .env fallback. Preferred flow: set the password in the dashboard. */
  adminPassword: process.env.ADMIN_PASSWORD || '',
  appSecret: resolveAppSecret(),
  openRouterApiKey: process.env.OPENROUTER_API_KEY || '',
  openRouterModel: process.env.OPENROUTER_MODEL || 'openai/gpt-4.1-mini',
  openRouterBaseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
  groqApiKey: process.env.GROQ_API_KEY || '',
  groqModel: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
  groqBaseUrl: process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
  logLevel: process.env.LOG_LEVEL || 'info',
  isProduction: process.env.NODE_ENV === 'production',
  appUrl: process.env.APP_URL || `http://${process.env.HOST || '127.0.0.1'}:${intEnv('PORT', 8787)}`,
  /** Set HUB_AUTOSTART=0 to boot without starting any WhatsApp pollers (useful for testing a copy). */
  hubAutoStart: process.env.HUB_AUTOSTART !== '0',
};

for (const dir of [config.dataDir, config.modelsDir, config.agentsDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

export function validateConfig(): string[] {
  const warnings: string[] = [];
  if (!config.adminPassword) {
    warnings.push('No admin password configured yet — the dashboard will ask you to create one on first visit.');
  } else {
    warnings.push('ADMIN_PASSWORD comes from .env — it will be sealed into an encrypted hash after the first login. Remove it from .env afterwards.');
  }
  if (config.appSecret.length < 24) {
    warnings.push('APP_SECRET is unexpectedly short. Secret storage may be unavailable.');
  }
  if (config.host !== '127.0.0.1' && config.host !== 'localhost') {
    warnings.push(`Server is bound to ${config.host}. Make sure this is behind a trusted network/reverse proxy.`);
  }
  return warnings;
}
