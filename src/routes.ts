import fs from 'node:fs';
import path from 'node:path';
import express, { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { Cron } from 'croner';
import { z } from 'zod';
import { bus } from './bus.js';
import {
  checkPassword,
  clearLoginFailures,
  clearSessionCookie,
  issueSession,
  loginRateLimited,
  readSession,
  recordLoginFailure,
  requireAuth,
  sealLegacyPasswordAfterLogin,
  sessionCookie,
  setAdminPassword,
  setupRequired,
  verifySession,
  originGuard,
} from './auth.js';
import { config } from './config.js';
import { extractFile } from './extract.js';
import { hub, parseChatId, testChatId } from './hub.js';
import {
  addSchedule,
  addSkill,
  createAgent,
  deleteAgent,
  deleteSchedule,
  deleteSkill,
  getAgent,
  getAgentDetail,
  getSchedule,
  getSkill,
  listAgents,
  listAllSchedules,
  setAgentKnowledge,
  setAgentMcpServers,
  updateAgent,
  updateSchedule,
  updateSkill,
} from './hub-store.js';
import { logger } from './logger.js';
import { mcp } from './mcp.js';
import { MEMORY_KINDS, memory } from './memory.js';
import { opencode } from './opencode-runtime.js';
import { getOpenRouterApiKey, listOpenRouterModels, testOpenRouterKey } from './openrouter.js';
import { getSettings, updateSettings } from './settings.js';
import { rag } from './rag.js';
import { deleteSecret, setSecret } from './secrets.js';
import { deleteChat, getMessages, listAgentRuns, listChats, resetChat } from './store.js';
import { getAppStatus } from './status.js';

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'HttpError';
  }
}

function asyncRoute(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function respond<T>(res: Response, statusCode: number, body: T): void {
  res.status(statusCode).type('application/json').send(JSON.stringify(body));
}

function nextHttpError(res: Response, status: number, message: string): void {
  respond(res, status, { error: message });
}

function extractClientIp(req: Request): string {
  return req.ip || req.socket?.remoteAddress || '0.0.0.0';
}

function param(req: Request, name: string): string {
  return decodeURIComponent(String(req.params[name]));
}

function assertCron(expression: string): void {
  try {
    new Cron(expression, { paused: true }).stop();
  } catch (error) {
    throw new HttpError(400, `Invalid cron expression: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function requireHubAgent(id: string) {
  const found = getAgent(id);
  if (!found) throw new HttpError(404, 'Agent not found.');
  return found;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fieldSize: 500_000, fileSize: 25_000_000, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = (file.originalname || '').split('.').pop()?.toLowerCase() || '';
    const allowed = ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'yaml', 'yml', 'log', 'xml', 'html', 'htm', 'pdf', 'docx'];
    cb(null, allowed.includes(ext));
  },
});

const profileText = (max = 5_000) => z.string().max(max).optional();

const agentSchema = z.object({
  name: z.string().trim().min(1).max(80),
  model: z.string().trim().min(1).max(200).optional(),
  systemPrompt: z.string().max(50_000).optional(),
  token: z.string().max(2_000).optional().nullable(),
  enabled: z.boolean().optional(),
  autoStart: z.boolean().optional(),
  typingIndicator: z.boolean().optional(),
  readReceipts: z.boolean().optional(),
  mcpServerIds: z.array(z.string()).optional(),
  knowledgeIds: z.array(z.string()).optional(),
  title: profileText(120),
  roleDescription: profileText(),
  personality: profileText(),
  communicationStyle: profileText(),
  objectives: profileText(),
  operatingPrinciples: profileText(),
  decisionStyle: profileText(),
  avatar: z
    .string()
    .max(400_000)
    .refine(
      (value) => value === '' || /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(value),
      'Avatar must be a PNG, JPEG, WebP or GIF image.',
    )
    .nullable()
    .optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  capabilities: z.object({ webfetch: z.boolean().optional(), websearch: z.boolean().optional() }).optional(),
  memoryEnabled: z.boolean().optional(),
  ownerId: z.string().trim().max(120).nullable().optional(),
});

const memoryInputSchema = z.object({
  content: z.string().trim().min(1).max(600),
  kind: z.enum(MEMORY_KINDS).optional(),
  importance: z.coerce.number().int().min(1).max(5).optional(),
  conversationKey: z.string().max(200).optional(),
  tier: z.enum(['long_term', 'working']).optional(),
});

export function createRouter() {
  const router = express.Router();

  router.use(express.json({ limit: '2mb' }));
  router.use(express.urlencoded({ extended: true, limit: '2mb' }));
  router.use(originGuard);

  /* ---------------- public auth ---------------- */
  router.get('/auth/me', (_req, res) => {
    return respond(res, 200, {
      authenticated: verifySession(readSession(_req)),
      setupRequired: setupRequired(),
    });
  });

  router.post('/auth/setup', asyncRoute(async (req, res) => {
    if (!setupRequired()) {
      return nextHttpError(res, 403, 'An admin password already exists. Use change password instead.');
    }
    const ip = extractClientIp(req);
    if (loginRateLimited(ip)) return nextHttpError(res, 429, 'Too many attempts. Try again in 15 minutes.');
    const { password } = req.body as { password?: unknown };
    if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
      return nextHttpError(res, 400, 'Password must be 8–200 characters.');
    }
    setAdminPassword(password);
    clearLoginFailures(ip);
    res.setHeader('Set-Cookie', sessionCookie(issueSession()));
    return respond(res, 200, { ok: true });
  }));

  router.post('/auth/login', asyncRoute(async (req, res) => {
    if (setupRequired()) {
      return nextHttpError(res, 503, 'No admin password exists yet. Complete the first-run setup.');
    }
    const ip = extractClientIp(req);
    if (loginRateLimited(ip)) return nextHttpError(res, 429, 'Too many login attempts. Try again in 15 minutes.');
    const { password } = req.body as { password?: string };
    if (!password) return nextHttpError(res, 400, 'Password is required.');
    if (!checkPassword(password)) {
      recordLoginFailure(ip);
      return nextHttpError(res, 401, 'Invalid password.');
    }
    clearLoginFailures(ip);
    sealLegacyPasswordAfterLogin();
    res.setHeader('Set-Cookie', sessionCookie(issueSession()));
    return respond(res, 200, { ok: true });
  }));

  router.post('/auth/change-password', asyncRoute(async (req, res) => {
    if (setupRequired()) return nextHttpError(res, 503, 'No admin password exists yet. Complete the first-run setup.');
    const { currentPassword, newPassword } = req.body as { currentPassword?: unknown; newPassword?: unknown };
    if (typeof currentPassword !== 'string' || !checkPassword(currentPassword)) {
      return nextHttpError(res, 401, 'Current password is incorrect.');
    }
    if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 200) {
      return nextHttpError(res, 400, 'New password must be 8–200 characters.');
    }
    setAdminPassword(newPassword); // bumps the auth version → invalidates every session
    res.setHeader('Set-Cookie', sessionCookie(issueSession()));
    return respond(res, 200, { ok: true });
  }));

  router.post('/auth/logout', asyncRoute(async (_req, res) => {
    res.setHeader('Set-Cookie', clearSessionCookie());
    return respond(res, 200, { ok: true });
  }));

  /* ---------------- protected routes ---------------- */
  router.use(requireAuth);

  router.get('/health', asyncRoute(async (_req, res) => {
    return respond(res, 200, { ok: true, version: '2.0.0', uptime: Math.floor(process.uptime()) });
  }));

  router.get('/status', asyncRoute(async (_req, res) => respond(res, 200, getAppStatus())));

  /* settings (manager-level only) */
  router.get('/settings', asyncRoute(async (_req, res) => {
    const key = getOpenRouterApiKey();
    return respond(res, 200, {
      settings: getSettings(),
      openrouter: {
        configured: Boolean(key),
        source: key ? 'dashboard/env' : 'none',
        maskedKey: key ? key.slice(0, 4) + '••••••••' + key.slice(-4) : '',
      },
    });
  }));

  router.put('/settings', asyncRoute(async (req, res) => {
    const patch = z
      .object({
        model: z.string().trim().min(1).max(200).optional(),
        timezone: z.string().max(100).optional(),
        provider: z.enum(['openrouter', 'groq']).optional(),
        groqApiKey: z.string().max(200).optional(),
        memoryConsolidateEvery: z.coerce.number().int().min(1).max(50).optional(),
        memoryMaxPerAgent: z.coerce.number().int().min(50).max(5000).optional(),
        memoryWorkingTtlHours: z.coerce.number().int().min(1).max(720).optional(),
        memoryRetrieveLimit: z.coerce.number().int().min(1).max(30).optional(),
      })
      .parse(req.body);
    const merged = updateSettings(patch);
    if (patch.timezone !== undefined) await hub.refreshConfig();
    return respond(res, 200, { settings: merged });
  }));

  router.post('/settings/openrouter-key', asyncRoute(async (req, res) => {
    const settings = getSettings();
    const body = z.object({ apiKey: z.string().optional() }).parse(req.body);
    const apiKey = body.apiKey?.trim();
    const secretKey = settings.provider === 'groq' ? 'groq_api_key' : 'openrouter_api_key';
    if (!apiKey) {
      deleteSecret(secretKey);
      return respond(res, 200, { ok: true, configured: false });
    }
    const test = await testOpenRouterKey(apiKey);
    if (!test.ok) return respond(res, 400, { error: test.error || 'Invalid API key.' });
    setSecret(secretKey, apiKey);
    return respond(res, 200, { ok: true, configured: true, label: test.label });
  }));

  router.post('/settings/test-openrouter', asyncRoute(async (req, res) => {
    const body = z.object({ apiKey: z.string().optional() }).parse(req.body ?? {});
    const result = await testOpenRouterKey(body.apiKey?.trim());
    return respond(res, result.ok ? 200 : 400, result);
  }));

  router.get('/openrouter/models', asyncRoute(async (req, res) => {
    const models = await listOpenRouterModels((req.query.q as string | undefined) || '');
    return respond(res, 200, { models: models.map((m) => ({ id: m.id, name: m.name, context_length: m.context_length })) });
  }));

  /* developer design annotations */
  router.get('/annotations', asyncRoute(async (_req, res) => {
    const annotationsPath = path.resolve(config.dataDir, 'annotations.json');
    try {
      const data = fs.existsSync(annotationsPath) ? JSON.parse(fs.readFileSync(annotationsPath, 'utf8')) : { annotations: [] };
      return respond(res, 200, data);
    } catch {
      return respond(res, 200, { annotations: [] });
    }
  }));

  router.post('/annotations', asyncRoute(async (req, res) => {
    const body = z.object({ annotations: z.array(z.object({ selector: z.string(), comment: z.string() })).optional() }).parse(req.body);
    const annotationsPath = path.resolve(config.dataDir, 'annotations.json');
    const current = fs.existsSync(annotationsPath) ? JSON.parse(fs.readFileSync(annotationsPath, 'utf8')) : { annotations: [] };
    const updated = { annotations: body.annotations ?? current.annotations };
    fs.mkdirSync(path.dirname(annotationsPath), { recursive: true });
    fs.writeFileSync(annotationsPath, JSON.stringify(updated, null, 2), 'utf8');
    return respond(res, 200, updated);
  }));

  /* conversations: read-only transcripts of what each agent handled */
  router.get('/conversations', asyncRoute(async (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : '';
    const chats = listChats(agentId ? 500 : limit).filter((chat) => {
      const parsed = parseChatId(chat.chat_id);
      return agentId ? parsed?.agentId === agentId : true;
    });
    return respond(
      res,
      200,
      chats.slice(0, limit).map((chat) => ({ ...chat, agent_id: parseChatId(chat.chat_id)?.agentId ?? null })),
    );
  }));

  router.get('/conversations/:chatId/messages', asyncRoute(async (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 100)));
    return respond(res, 200, getMessages(param(req, 'chatId'), limit));
  }));

  router.delete('/conversations/:chatId', asyncRoute(async (req, res) => {
    const chatId = param(req, 'chatId');
    const parsed = parseChatId(chatId);
    if (parsed) hub.resetConversation(parsed.agentId, parsed.conversationKey);
    deleteChat(chatId);
    return respond(res, 200, { ok: true });
  }));

  router.post('/conversations/:chatId/reset', asyncRoute(async (req, res) => {
    const chatId = param(req, 'chatId');
    const parsed = parseChatId(chatId);
    if (parsed) hub.resetConversation(parsed.agentId, parsed.conversationKey);
    resetChat(chatId);
    return respond(res, 200, { ok: true });
  }));

  /* shared knowledge library */
  router.get('/knowledge', asyncRoute(async (_req, res) => {
    return respond(res, 200, {
      documents: rag.listDocuments(),
      stats: rag.getStats(),
      embeddings: rag.getEmbeddingStatus(),
    });
  }));

  router.get('/knowledge/:id', asyncRoute(async (req, res) => {
    const doc = rag.getDocument(param(req, 'id'));
    if (!doc) return nextHttpError(res, 404, 'Document not found');
    return respond(res, 200, { document: doc });
  }));

  router.post('/knowledge', asyncRoute(async (req, res) => {
    const body = z.object({ title: z.string().min(1).max(200), text: z.string().min(1).max(5_000_000) }).parse(req.body);
    const doc = await rag.addDocumentAndWait({ title: body.title, content: body.text, sourceType: 'text', sourceName: 'Dashboard' });
    return respond(res, 201, { document: doc });
  }));

  router.post('/knowledge/upload', upload.single('file'), asyncRoute(async (req, res) => {
    if (!req.file) return nextHttpError(res, 400, 'No file uploaded.');
    const extracted = await extractFile(req.file.originalname, req.file.buffer);
    const doc = await rag.addDocumentAndWait({
      title: extracted.title,
      content: extracted.text,
      sourceType: 'file',
      sourceName: req.file.originalname,
      mimeType: extracted.mimeType,
    });
    return respond(res, 201, { document: doc, preview: extracted.text.slice(0, 1000) });
  }));

  router.post('/knowledge/:id/reindex', asyncRoute(async (req, res) => {
    const id = param(req, 'id');
    const doc = rag.getDocument(id);
    if (!doc) return nextHttpError(res, 404, 'Document not found');
    void rag.indexDocument(id);
    return respond(res, 202, { document: doc });
  }));

  router.delete('/knowledge/:id', asyncRoute(async (req, res) => {
    if (!rag.deleteDocument(param(req, 'id'))) return nextHttpError(res, 404, 'Document not found');
    return respond(res, 200, { ok: true });
  }));

  router.post('/knowledge/search', asyncRoute(async (req, res) => {
    const body = z
      .object({ query: z.string().min(1), k: z.coerce.number().int().min(1).max(20).default(5), agentId: z.string().optional() })
      .parse(req.body);
    const scope = body.agentId ? { documentIds: requireHubAgent(body.agentId).knowledgeIds } : {};
    const results = await rag.search(body.query, body.k, 0.05, scope);
    return respond(res, 200, {
      results: results.map(({ chunkId, documentId, title, content, score, lexicalScore, vectorScore }) => ({
        chunkId, documentId, title, content: content.slice(0, 1200), score, lexicalScore, vectorScore,
      })),
    });
  }));

  /* mcp */
  router.get('/mcp', asyncRoute(async (_req, res) => {
    return respond(res, 200, {
      servers: mcp.listServers().map((s) => {
        const tools = mcp.getCachedTools(s.id);
        return {
          id: s.id,
          name: s.name,
          transport: s.transport,
          command: s.command,
          args: s.args.join(' '),
          env: Object.entries(s.env).map(([k, v]) => `${k}=${v}`).join('\n'),
          cwd: s.cwd,
          url: s.url,
          headers: Object.entries(s.headers).map(([k, v]) => `${k}=${v}`).join('\n'),
          enabled: s.enabled,
          disabledTools: s.disabled_tools,
          last_status: s.last_status,
          last_error: s.last_error,
          updated_at: s.updated_at,
          toolCount: tools.length,
          tools: tools.map((tool) => tool.name),
        };
      }),
    });
  }));

  const mcpBody = {
    name: z.string().min(1).max(100),
    transport: z.enum(['stdio', 'sse', 'http']),
    command: z.string().optional(),
    args: z.string().optional(),
    env: z.string().optional(),
    cwd: z.string().optional(),
    url: z.string().optional(),
    headers: z.string().optional(),
  };

  router.post('/mcp', asyncRoute(async (req, res) => {
    const body = z
      .object({ ...mcpBody, enabled: z.boolean().default(true), disabledTools: z.array(z.string()).default([]) })
      .parse(req.body);
    const server = mcp.createServer(body);
    await hub.refreshConfig();
    return respond(res, 201, server);
  }));

  router.put('/mcp/:id', asyncRoute(async (req, res) => {
    const body = z
      .object({ ...mcpBody, enabled: z.boolean(), disabledTools: z.array(z.string()) })
      .partial()
      .parse(req.body);
    const server = mcp.updateServer(param(req, 'id'), body);
    await hub.refreshConfig();
    return respond(res, 200, server);
  }));

  router.delete('/mcp/:id', asyncRoute(async (req, res) => {
    if (!mcp.deleteServer(param(req, 'id'))) return nextHttpError(res, 404, 'Server not found');
    await hub.refreshConfig();
    return respond(res, 200, { ok: true });
  }));

  router.patch('/mcp/:id/toggle', asyncRoute(async (req, res) => {
    const body = z.object({ enabled: z.boolean() }).parse(req.body);
    const server = mcp.updateServer(param(req, 'id'), { enabled: body.enabled });
    await hub.refreshConfig();
    return respond(res, 200, server);
  }));

  router.post('/mcp/:id/test', asyncRoute(async (req, res) => respond(res, 200, await mcp.testServer(param(req, 'id')))));

  router.post('/mcp/reload', asyncRoute(async (_req, res) => {
    await mcp.closeAll();
    const { tools, errors } = await mcp.getAllTools();
    return respond(res, 200, { tools: tools.map(({ function: fn }) => ({ name: fn.name, description: fn.description })), errors });
  }));

  router.get('/mcp/tools', asyncRoute(async (_req, res) => {
    const { tools, errors } = await mcp.getAllTools();
    return respond(res, 200, { tools: tools.map(({ function: fn }) => ({ name: fn.name, description: fn.description })), errors });
  }));

  router.patch('/mcp/:id/tools', asyncRoute(async (req, res) => {
    const body = z.object({ disabledTools: z.array(z.string()) }).parse(req.body);
    return respond(res, 200, mcp.updateServer(param(req, 'id'), { disabledTools: body.disabledTools }));
  }));

  /* ---------------- agents ---------------- */

  router.get('/hub/status', asyncRoute(async (_req, res) => respond(res, 200, hub.getStatus())));

  router.get('/hub/agents', asyncRoute(async (_req, res) => {
    return respond(res, 200, { agents: listAgents().map((item) => hub.getAgentSnapshot(item)) });
  }));

  router.post('/hub/agents', asyncRoute(async (req, res) => {
    const body = agentSchema.parse(req.body);
    const created = createAgent({
      ...body,
      token: body.token || null,
      // New agents get no tools until the manager grants them explicitly.
      mcpServerIds: body.mcpServerIds ?? [],
      knowledgeIds: body.knowledgeIds ?? [],
    });
    await hub.applyAgentChange(created.id);
    return respond(res, 201, { agent: getAgentDetail(created.id) });
  }));

  router.get('/hub/agents/:id', asyncRoute(async (req, res) => {
    const detail = getAgentDetail(param(req, 'id'));
    if (!detail) throw new HttpError(404, 'Agent not found.');
    return respond(res, 200, { agent: detail });
  }));

  router.put('/hub/agents/:id', asyncRoute(async (req, res) => {
    const id = param(req, 'id');
    requireHubAgent(id);
    const body = agentSchema.partial().parse(req.body);
    if (!updateAgent(id, body)) throw new HttpError(404, 'Agent not found.');
    await hub.applyAgentChange(id);
    return respond(res, 200, { agent: getAgentDetail(id) });
  }));

  router.delete('/hub/agents/:id', asyncRoute(async (req, res) => {
    const id = param(req, 'id');
    requireHubAgent(id);
    await hub.stopAgent(id);
    for (const documentId of rag.listOwnedDocumentIds(id)) rag.deleteDocument(documentId);
    if (!deleteAgent(id)) throw new HttpError(404, 'Agent not found.');
    resetChat(testChatId(id));
    opencode.removeAgentWorkspace(id);
    void hub.refreshConfig();
    return respond(res, 200, { ok: true });
  }));

  router.post('/hub/agents/:id/start', asyncRoute(async (req, res) => {
    const id = param(req, 'id');
    const found = requireHubAgent(id);
    if (!found.hasToken) throw new HttpError(400, 'Add a WhatsApp Agent Platform token first.');
    try {
      return respond(res, 200, { agent: await hub.startAgent(id) });
    } catch (error) {
      return nextHttpError(res, 400, error instanceof Error ? error.message : 'Could not start agent.');
    }
  }));

  router.post('/hub/agents/:id/stop', asyncRoute(async (req, res) => {
    const id = param(req, 'id');
    requireHubAgent(id);
    await hub.stopAgent(id);
    return respond(res, 200, { ok: true });
  }));

  router.post('/hub/agents/:id/restart', asyncRoute(async (req, res) => {
    const id = param(req, 'id');
    requireHubAgent(id);
    try {
      return respond(res, 200, { agent: await hub.restartAgent(id) });
    } catch (error) {
      return nextHttpError(res, 400, error instanceof Error ? error.message : 'Could not restart agent.');
    }
  }));

  /* dashboard conversation with an agent (never sent to WhatsApp) */
  router.post('/hub/agents/:id/test', asyncRoute(async (req, res) => {
    const id = param(req, 'id');
    requireHubAgent(id);
    const body = z.object({ text: z.string().trim().min(1).max(20_000) }).parse(req.body);
    try {
      return respond(res, 200, await hub.testAgent(id, body.text));
    } catch (error) {
      return nextHttpError(res, 400, error instanceof Error ? error.message : 'Agent test failed.');
    }
  }));

  router.get('/hub/agents/:id/test/messages', asyncRoute(async (req, res) => {
    const id = param(req, 'id');
    requireHubAgent(id);
    return respond(res, 200, { messages: getMessages(testChatId(id), 200) });
  }));

  router.post('/hub/agents/:id/test/reset', asyncRoute(async (req, res) => {
    const id = param(req, 'id');
    requireHubAgent(id);
    hub.resetTest(id);
    return respond(res, 200, { ok: true });
  }));

  router.post('/hub/agents/:id/send', asyncRoute(async (req, res) => {
    const id = param(req, 'id');
    requireHubAgent(id);
    const body = z.object({ text: z.string().trim().min(1).max(4_000) }).parse(req.body);
    try {
      return respond(res, 200, { ok: true, messageIds: await hub.sendToCreator(id, body.text) });
    } catch (error) {
      return nextHttpError(res, 400, error instanceof Error ? error.message : 'Could not send message.');
    }
  }));

  router.put('/hub/agents/:id/mcp', asyncRoute(async (req, res) => {
    const id = param(req, 'id');
    requireHubAgent(id);
    const body = z.object({ serverIds: z.array(z.string()) }).parse(req.body);
    setAgentMcpServers(id, body.serverIds);
    await hub.refreshConfig();
    return respond(res, 200, { agent: getAgentDetail(id) });
  }));

  /* per-agent knowledge */
  router.put('/hub/agents/:id/knowledge', asyncRoute(async (req, res) => {
    const id = param(req, 'id');
    requireHubAgent(id);
    const body = z.object({ documentIds: z.array(z.string()) }).parse(req.body);
    setAgentKnowledge(id, body.documentIds);
    return respond(res, 200, { agent: getAgentDetail(id) });
  }));

  router.post('/hub/agents/:id/knowledge/upload', upload.single('file'), asyncRoute(async (req, res) => {
    const id = param(req, 'id');
    requireHubAgent(id);
    if (!req.file) return nextHttpError(res, 400, 'No supported file uploaded.');
    const extracted = await extractFile(req.file.originalname, req.file.buffer);
    const doc = await rag.addDocumentAndWait({
      title: extracted.title,
      content: extracted.text,
      sourceType: 'file',
      sourceName: req.file.originalname,
      mimeType: extracted.mimeType,
      ownerAgentId: id,
    });
    return respond(res, 201, { document: doc });
  }));

  router.post('/hub/agents/:id/knowledge/text', asyncRoute(async (req, res) => {
    const id = param(req, 'id');
    requireHubAgent(id);
    const body = z.object({ title: z.string().trim().min(1).max(200), text: z.string().min(1).max(5_000_000) }).parse(req.body);
    const doc = await rag.addDocumentAndWait({
      title: body.title,
      content: body.text,
      sourceType: 'text',
      sourceName: 'Dashboard',
      ownerAgentId: id,
    });
    return respond(res, 201, { document: doc });
  }));

  /* per-agent memory (every call is scoped by agent id) */
  router.get('/hub/agents/:id/memory', asyncRoute(async (req, res) => {
    const id = param(req, 'id');
    requireHubAgent(id);
    const conversationKey = typeof req.query.conversation === 'string' ? req.query.conversation : undefined;
    const tier = req.query.tier === 'working' || req.query.tier === 'long_term' ? req.query.tier : undefined;
    const query = typeof req.query.q === 'string' ? req.query.q : undefined;
    return respond(res, 200, {
      memories: memory.list(id, { conversationKey, tier, query }),
      conversations: memory.listStates(id),
      stats: memory.stats(id),
    });
  }));

  router.post('/hub/agents/:id/memory', asyncRoute(async (req, res) => {
    const id = param(req, 'id');
    requireHubAgent(id);
    const body = memoryInputSchema.parse(req.body);
    return respond(res, 201, { memory: memory.add(id, { ...body, source: 'manual' }) });
  }));

  router.put('/hub/agents/:id/memory/:memoryId', asyncRoute(async (req, res) => {
    const id = param(req, 'id');
    requireHubAgent(id);
    const body = memoryInputSchema.partial().parse(req.body);
    const updated = memory.update(id, param(req, 'memoryId'), body);
    if (!updated) throw new HttpError(404, 'Memory not found.');
    return respond(res, 200, { memory: updated });
  }));

  router.delete('/hub/agents/:id/memory/:memoryId', asyncRoute(async (req, res) => {
    const id = param(req, 'id');
    requireHubAgent(id);
    if (!memory.delete(id, param(req, 'memoryId'))) throw new HttpError(404, 'Memory not found.');
    return respond(res, 200, { ok: true });
  }));

  router.post('/hub/agents/:id/memory/clear', asyncRoute(async (req, res) => {
    const id = param(req, 'id');
    requireHubAgent(id);
    const body = z.object({ conversationKey: z.string().max(200).optional() }).parse(req.body ?? {});
    return respond(res, 200, { removed: memory.clear(id, body.conversationKey) });
  }));

  router.post('/hub/agents/:id/memory/consolidate', asyncRoute(async (req, res) => {
    const id = param(req, 'id');
    requireHubAgent(id);
    const body = z.object({ conversationKey: z.string().max(200).default('test') }).parse(req.body ?? {});
    try {
      return respond(res, 200, { result: await hub.consolidateNow(id, body.conversationKey) });
    } catch (error) {
      return nextHttpError(res, 400, error instanceof Error ? error.message : 'Consolidation failed.');
    }
  }));

  router.post('/hub/agents/:id/memory/search', asyncRoute(async (req, res) => {
    const id = param(req, 'id');
    requireHubAgent(id);
    const body = z.object({ query: z.string().trim().min(1).max(2_000), conversationKey: z.string().max(200).default('test') }).parse(req.body);
    return respond(res, 200, await memory.retrieve(id, body.conversationKey, body.query));
  }));

  /* skills */
  router.get('/hub/agents/:id/skills', asyncRoute(async (req, res) => {
    const detail = getAgentDetail(param(req, 'id'));
    if (!detail) throw new HttpError(404, 'Agent not found.');
    return respond(res, 200, { skills: detail.skills });
  }));

  router.post('/hub/agents/:id/skills', asyncRoute(async (req, res) => {
    const id = param(req, 'id');
    requireHubAgent(id);
    const body = z
      .object({
        name: z.string().trim().min(1).max(100),
        description: z.string().max(500).optional(),
        body: z.string().min(1).max(100_000),
        enabled: z.boolean().optional(),
      })
      .parse(req.body);
    const skill = addSkill({ agentId: id, ...body });
    await hub.applyAgentChange(id);
    return respond(res, 201, { skill });
  }));

  router.put('/hub/skills/:id', asyncRoute(async (req, res) => {
    const id = param(req, 'id');
    const current = getSkill(id);
    if (!current) throw new HttpError(404, 'Skill not found.');
    const body = z
      .object({
        name: z.string().trim().min(1).max(100).optional(),
        description: z.string().max(500).optional(),
        body: z.string().min(1).max(100_000).optional(),
        enabled: z.boolean().optional(),
      })
      .parse(req.body);
    const skill = updateSkill(id, body);
    await hub.applyAgentChange(current.agentId);
    return respond(res, 200, { skill });
  }));

  router.delete('/hub/skills/:id', asyncRoute(async (req, res) => {
    const id = param(req, 'id');
    const current = getSkill(id);
    if (!current) throw new HttpError(404, 'Skill not found.');
    deleteSkill(id);
    await hub.applyAgentChange(current.agentId);
    return respond(res, 200, { ok: true });
  }));

  /* schedules */
  router.get('/hub/schedules', asyncRoute(async (_req, res) => respond(res, 200, { schedules: listAllSchedules() })));

  router.get('/hub/agents/:id/schedules', asyncRoute(async (req, res) => {
    const detail = getAgentDetail(param(req, 'id'));
    if (!detail) throw new HttpError(404, 'Agent not found.');
    return respond(res, 200, { schedules: detail.schedules });
  }));

  router.post('/hub/agents/:id/schedules', asyncRoute(async (req, res) => {
    const id = param(req, 'id');
    requireHubAgent(id);
    const body = z
      .object({
        name: z.string().trim().min(1).max(100),
        cronExpr: z.string().trim().min(1).max(120),
        prompt: z.string().trim().min(1).max(20_000),
        enabled: z.boolean().optional(),
      })
      .parse(req.body);
    assertCron(body.cronExpr);
    const schedule = addSchedule({ agentId: id, ...body });
    await hub.refreshConfig();
    return respond(res, 201, { schedule });
  }));

  router.put('/hub/schedules/:id', asyncRoute(async (req, res) => {
    const id = param(req, 'id');
    if (!getSchedule(id)) throw new HttpError(404, 'Schedule not found.');
    const body = z
      .object({
        name: z.string().trim().min(1).max(100).optional(),
        cronExpr: z.string().trim().min(1).max(120).optional(),
        prompt: z.string().trim().min(1).max(20_000).optional(),
        enabled: z.boolean().optional(),
      })
      .parse(req.body);
    if (body.cronExpr) assertCron(body.cronExpr);
    const schedule = updateSchedule(id, body);
    await hub.refreshConfig();
    return respond(res, 200, { schedule });
  }));

  router.delete('/hub/schedules/:id', asyncRoute(async (req, res) => {
    const id = param(req, 'id');
    if (!getSchedule(id)) throw new HttpError(404, 'Schedule not found.');
    deleteSchedule(id);
    await hub.refreshConfig();
    return respond(res, 200, { ok: true });
  }));

  router.post('/hub/schedules/:id/run', asyncRoute(async (req, res) => {
    const id = param(req, 'id');
    if (!getSchedule(id)) throw new HttpError(404, 'Schedule not found.');
    void hub.runSchedule(id);
    return respond(res, 202, { ok: true });
  }));

  router.post('/hub/runtime/reload', asyncRoute(async (_req, res) => {
    try {
      await opencode.ensure();
      await opencode.syncConfig(true);
    } catch (error) {
      return nextHttpError(res, 400, error instanceof Error ? error.message : 'Could not reload OpenCode.');
    }
    return respond(res, 200, { runtime: hub.getStatus().runtime });
  }));

  /* logs & runs */
  router.get('/logs', asyncRoute(async (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit || 200)));
    return respond(res, 200, { logs: logger.getHistory(limit) });
  }));

  router.get('/runs', asyncRoute(async (req, res) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
    return respond(res, 200, { runs: listAgentRuns(limit) });
  }));

  /* SSE events */
  router.get('/events', asyncRoute(async (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    const send = (event: string, data: unknown) => {
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        /* ignore */
      }
    };
    send('retry', { retry: 3000 });
    send('hello', { at: new Date().toISOString() });
    const handler = (message: { type: string; data: unknown }) => send(message.type, message.data);
    bus.on('event', handler);
    const timer = setInterval(() => send('heartbeat', { at: new Date().toISOString() }), 20_000);
    const cleanup = () => {
      bus.off('event', handler);
      clearInterval(timer);
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
  }));

  router.use((_req, res) => respond(res, 404, { error: 'Unknown API endpoint' }));

  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return respond(res, err.status, { error: err.message });
    if (err instanceof z.ZodError) {
      const issues = err.issues.slice(0, 10).map((i) => ({ path: i.path.join('.'), message: i.message }));
      const first = issues[0];
      return respond(res, 400, { error: first ? `${first.path || 'request'}: ${first.message}` : 'Validation error', issues });
    }
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ error: message }, 'Unhandled API error');
    return respond(res, 500, { error: 'Internal server error' });
  });

  return router;
}
