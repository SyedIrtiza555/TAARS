import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

const rootDir = process.cwd();
const dataDir = path.resolve(rootDir, process.env.DATA_DIR || './data');

export const config = {
  rootDir,
  port: intEnv('PORT', 8787),
  host: process.env.HOST || '127.0.0.1',
  dataDir,
  authDir: path.join(dataDir, 'wa-auth'),
  modelsDir: path.join(dataDir, 'models'),
  uploadsDir: path.join(dataDir, 'uploads'),
  publicDir: path.join(rootDir, 'public', 'admin'),
  adminPassword: process.env.ADMIN_PASSWORD || '',
  appSecret: process.env.APP_SECRET || '',
  openRouterApiKey: process.env.OPENROUTER_API_KEY || '',
  openRouterModel: process.env.OPENROUTER_MODEL || 'openai/gpt-4.1-mini',
  openRouterBaseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
  groqApiKey: process.env.GROQ_API_KEY || '',
  groqModel: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
  groqBaseUrl: process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
  logLevel: process.env.LOG_LEVEL || 'info',
  isProduction: process.env.NODE_ENV === 'production',
  appUrl: process.env.APP_URL || `http://${process.env.HOST || '127.0.0.1'}:${intEnv('PORT', 8787)}`,
};

for (const dir of [config.dataDir, config.authDir, config.modelsDir, config.uploadsDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

export function validateConfig(): string[] {
  const warnings: string[] = [];
  if (!config.adminPassword) warnings.push('ADMIN_PASSWORD is not set. The dashboard will not be accessible.');
  if (!config.appSecret || config.appSecret.length < 24) {
    warnings.push('APP_SECRET is missing or short. Secret storage will be unavailable until a long random value is set.');
  }
  if (config.host !== '127.0.0.1' && config.host !== 'localhost') {
    warnings.push(`Server is bound to ${config.host}. Make sure this is behind a trusted network/reverse proxy.`);
  }
  return warnings;
}
