import crypto from 'node:crypto';
import { config } from './config.js';
import { db } from './db.js';
import { nowIso } from './util.js';

function key(): Buffer {
  if (!config.appSecret || config.appSecret.length < 16) {
    throw new Error('APP_SECRET must be set to a long random value before secrets can be stored.');
  }
  return crypto.createHash('sha256').update(config.appSecret).digest();
}

export function setSecret(name: string, value: string): void {
  if (!value) {
    deleteSecret(name);
    return;
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = `v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${encrypted.toString('base64url')}`;
  db.prepare(
    `INSERT INTO secrets (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(name, payload, nowIso());
}

export function getSecret(name: string): string | null {
  const row = db.prepare('SELECT value FROM secrets WHERE key = ?').get(name) as { value?: string } | undefined;
  if (!row?.value) return null;
  try {
    const [version, ivB64, tagB64, dataB64] = row.value.split(':');
    if (version !== 'v1' || !ivB64 || !tagB64 || !dataB64) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64url')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch {
    return null;
  }
}

export function deleteSecret(name: string): void {
  db.prepare('DELETE FROM secrets WHERE key = ?').run(name);
}

export function hasSecret(name: string): boolean {
  return Boolean(getSecret(name));
}
