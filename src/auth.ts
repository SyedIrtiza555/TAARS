import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config.js';

const COOKIE_NAME = 'wa_agent_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const loginAttempts = new Map<string, number[]>();

function sessionSecret(): Buffer {
  return crypto.createHash('sha256').update(`${config.appSecret}:session`).digest();
}

function sign(value: string): string {
  return crypto.createHmac('sha256', sessionSecret()).update(value).digest('base64url');
}

export function checkPassword(candidate: string): boolean {
  if (!config.adminPassword) return false;
  const left = crypto.createHash('sha256').update(candidate).digest();
  const right = crypto.createHash('sha256').update(config.adminPassword).digest();
  return crypto.timingSafeEqual(left, right);
}

export function issueSession(): string {
  const payload = Buffer.from(
    JSON.stringify({ sub: 'admin', iat: Date.now(), exp: Date.now() + SESSION_TTL_MS }),
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
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub?: string; exp?: number };
    return data.sub === 'admin' && typeof data.exp === 'number' && data.exp > Date.now();
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
