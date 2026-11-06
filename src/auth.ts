import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config.js';
import { getSecret, setSecret } from './secrets.js';

const COOKIE_NAME = 'wa_agent_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PASSWORD_KEY = 'admin_password_auth';
const AUTH_VERSION_KEY = 'admin_auth_version';
const loginAttempts = new Map<string, number[]>();

function sessionSecret(): Buffer {
  return crypto.createHash('sha256').update(`${config.appSecret}:session`).digest();
}

function sign(value: string): string {
  return crypto.createHmac('sha256', sessionSecret()).update(value).digest('base64url');
}

/* ------------------------------------------------------------------ */
/* Admin password: scrypt hash in the encrypted secrets store.          */
/* Sessions carry the auth version so password changes log everyone out. */
/* ------------------------------------------------------------------ */

type StoredAuth = { salt: string; hash: string };

function loadStoredAuth(): StoredAuth | null {
  const raw = getSecret(PASSWORD_KEY);
  if (!raw) return null;
  const [version, saltB64, hashB64] = raw.split('|');
  if (version !== 'v1' || !saltB64 || !hashB64) return null;
  return { salt: saltB64, hash: hashB64 };
}

let authVersionCache: number | null = null;

function authVersion(): number {
  if (authVersionCache !== null) return authVersionCache;
  const raw = getSecret(AUTH_VERSION_KEY);
  const value = raw ? Number.parseInt(raw, 10) : 1;
  authVersionCache = Number.isFinite(value) && value > 0 ? value : 1;
  return authVersionCache;
}

function scryptHash(password: string, salt: Buffer): string {
  return crypto.scryptSync(password.normalize('NFKC'), salt, 64, { N: 16_384, r: 8, p: 1 }).toString('base64');
}

/** Sets or replaces the admin password (scrypt hash, encrypted at rest) and invalidates all sessions. */
export function setAdminPassword(password: string): void {
  const salt = crypto.randomBytes(16);
  const record = `v1|${salt.toString('base64')}|${scryptHash(password, salt)}`;
  setSecret(PASSWORD_KEY, record);
  const next = authVersion() + 1;
  setSecret(AUTH_VERSION_KEY, String(next));
  authVersionCache = next;
}

export type AdminAuthMode = 'unset' | 'legacy-env' | 'stored-hash';

export function adminAuthMode(): AdminAuthMode {
  if (loadStoredAuth()) return 'stored-hash';
  if (config.adminPassword) return 'legacy-env';
  return 'unset';
}

export function adminPasswordConfigured(): boolean {
  return adminAuthMode() !== 'unset';
}

export function setupRequired(): boolean {
  return adminAuthMode() === 'unset';
}

export function checkPassword(candidate: string): boolean {
  const stored = loadStoredAuth();
  if (stored) {
    const salt = Buffer.from(stored.salt, 'base64');
    const left = Buffer.from(scryptHash(candidate, salt));
    const right = Buffer.from(stored.hash, 'base64');
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  }
  if (config.adminPassword) {
    const left = crypto.createHash('sha256').update(candidate).digest();
    const right = crypto.createHash('sha256').update(config.adminPassword).digest();
    return crypto.timingSafeEqual(left, right);
  }
  return false;
}

/** One-time migration: after a successful login against the .env password, seal that
 *  password into an encrypted hash so the plaintext does not need to stay in .env. */
export function sealLegacyPasswordAfterLogin(): void {
  if (adminAuthMode() === 'legacy-env' && config.adminPassword) {
    setAdminPassword(config.adminPassword);
  }
}

export function issueSession(): string {
  const payload = Buffer.from(
    JSON.stringify({ sub: 'admin', iat: Date.now(), exp: Date.now() + SESSION_TTL_MS, ver: authVersion() }),
  ).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function verifySession(token: string | undefined): boolean {
  if (!token) return false;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return false;
  const expected = sign(payload);
  try {
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
  } catch {
    return false;
  }
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      sub?: string;
      exp?: number;
      ver?: number;
    };
    return (
      data.sub === 'admin' &&
      typeof data.exp === 'number' &&
      data.exp > Date.now() &&
      data.ver === authVersion()
    );
  } catch {
    return false;
  }
}

export function sessionCookie(token: string): string {
  const secure = config.appUrl.startsWith('https://');
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

export function readSession(req: Request): string | undefined {
  return req.cookies?.[COOKIE_NAME];
}

export function isAuthenticated(req: Request): boolean {
  return verifySession(readSession(req));
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (isAuthenticated(req)) {
    next();
    return;
  }
  res.status(401).json({ error: 'Authentication required.' });
}

export function loginRateLimited(ip: string): boolean {
  const now = Date.now();
  const windowStart = now - 15 * 60 * 1000;
  const attempts = (loginAttempts.get(ip) || []).filter((time) => time > windowStart);
  loginAttempts.set(ip, attempts);
  return attempts.length >= 8;
}

export function recordLoginFailure(ip: string): void {
  const attempts = loginAttempts.get(ip) || [];
  attempts.push(Date.now());
  loginAttempts.set(ip, attempts);
}

export function clearLoginFailures(ip: string): void {
  loginAttempts.delete(ip);
}

export function originGuard(req: Request, res: Response, next: NextFunction): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    next();
    return;
  }
  const origin = req.get('origin');
  if (origin) {
    try {
      const originHost = new URL(origin).host;
      const requestHost = req.get('host');
      const publicHost = safeHost(config.appUrl);
      // The Vite dev server proxies API calls to this backend, so the browser
      // Origin (localhost:5173) intentionally differs from the proxy target.
      const devHosts = new Set(['localhost:5173', '127.0.0.1:5173']);
      const allowed =
        originHost === requestHost ||
        originHost === publicHost ||
        (!config.isProduction && devHosts.has(originHost));
      if (!allowed) {
        res.status(403).json({ error: 'Cross-origin request rejected.' });
        return;
      }
    } catch {
      res.status(403).json({ error: 'Invalid origin.' });
      return;
    }
  }
  next();
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
