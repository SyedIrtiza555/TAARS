import fs from 'node:fs';
import path from 'node:path';
import express, { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { Cron } from 'croner';
import { z } from 'zod';
import { bus } from './bus.js';
import { agent } from './agent.js';
import { checkPassword, clearLoginFailures, clearSessionCookie, issueSession, loginRateLimited, readSession, recordLoginFailure, requireAuth, sessionCookie, verifySession, originGuard } from './auth.js';
import { config } from './config.js';
import { extractFile } from './extract.js';
import { hub } from './hub.js';
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
import { opencode } from './opencode-runtime.js';
import { getOpenRouterApiKey, listOpenRouterModels, testOpenRouterKey } from './openrouter.js';
import { getSettings, updateSettings } from './settings.js';
import { rag } from './rag.js';
import { deleteSecret, setSecret } from './secrets.js';
import { deleteChat, listAgentRuns, listChats, getMessages, resetChat } from './store.js';
import { getAppStatus } from './status.js';
import { whatsapp } from './whatsapp.js';

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

export function createRouter() {
  const router = express.Router();

  router.use(express.json({ limit: '2mb' }));
  router.use(express.urlencoded({ extended: true, limit: '2mb' }));
  router.use(originGuard);

  /* ---------------- public auth ---------------- */
  router.post('/auth/login', asyncRoute(async (req, res, next) => {
    if (!config.adminPassword) return nextHttpError(res, 503, 'ADMIN_PASSWORD is not configured on this server.');
    const ip = extractClientIp(req);
    if (loginRateLimited(ip)) {
      return nextHttpError(res, 429, 'Too many login attempts. Try again in 15 minutes.');
    }
    const { password } = req.body as { password?: string };
    if (!password) return nextHttpError(res, 400, 'Password is required.');
    if (!checkPassword(password)) {
      recordLoginFailure(ip);
      return nextHttpError(res, 401, 'Invalid password.');
    }
    clearLoginFailures(ip);
    const token = issueSession();
    res.setHeader('Set-Cookie', sessionCookie(token));
    return respond(res, 200, { ok: true });
  }));

  router.post('/auth/logout', asyncRoute(async (_req, res) => {
    res.setHeader('Set-Cookie', clearSessionCookie());
    return respond(res, 200, { ok: true });
  }));

  router.get('/auth/me', asyncRoute(async (req, res) => {
    return respond(res, 200, { authenticated: verifySession(readSession(req)) });
  }));

  /* ---------------- protected routes ---------------- */
  router.use(requireAuth);

  router.get('/health', asyncRoute(async (_req, res) => {
    return respond(res, 200, { ok: true, version: '1.0.0', uptime: Math.floor(process.uptime()) });
  }));

  router.get('/status', asyncRoute(async (_req, res) => {
    return respond(res, 200, getAppStatus());
  }));

  router.get('/settings', asyncRoute(async (_req, res) => {
    const current = getSettings();
    const key = getOpenRouterApiKey();
    return respond(res, 200, {
      settings: current,
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
        botName: z.string().trim().min(1).max(60).optional(),
        systemPrompt: z.string().max(20000).optional(),
        model: z.string().trim().min(1).max(200).optional(),
        temperature: z.coerce.number().min(0).max(2).optional(),
        maxTokens: z.coerce.number().int().min(128).max(8192).optional(),
        maxHistory: z.coerce.number().int().min(2).max(100).optional(),
        autoReply: z.boolean().optional(),
        autoConnect: z.boolean().optional(),
        groupMode: z.enum(['mention', 'all', 'off']).optional(),
        allowedJids: z.array(z.string()).optional(),
        blockedJids: z.array(z.string()).optional(),
        ragEnabled: z.boolean().optional(),
        ragAutoInject: z.boolean().optional(),
        ragTopK: z.coerce.number().int().min(1).max(12).optional(),
        ragMinScore: z.coerce.number().min(0).max(1).optional(),
        typingIndicator: z.boolean().optional(),
        readReceipts: z.boolean().optional(),
        maxToolSteps: z.coerce.number().int().min(1).max(10).optional(),
        toolTimeoutMs: z.coerce.number().int().min(5000).max(120000).optional(),
        appendSignature: z.boolean().optional(),
        signature: z.string().max(500).optional(),
        fallbackMessage: z.string().max(1000).optional(),
        maxCharsPerMessage: z.coerce.number().int().min(500).max(6000).optional(),
        timezone: z.string().max(100).optional(),
        status: z.enum(['available', 'away']).optional(),
        provider: z.enum(['openrouter', 'groq']).optional(),
        groqApiKey: z.string().max(200).optional(),
      })
      .parse(req.body);
    const merged = updateSettings(patch);
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
    if (!test.ok) return respond(res, 400, { error: test.error || `Invalid ${settings.provider === 'groq' ? 'Groq' : 'OpenRouter'} key.` });
    setSecret(secretKey, apiKey);
    return respond(res, 200, { ok: true, configured: true, label: test.label });
  }));

  router.post('/settings/test-openrouter', asyncRoute(async (req, res) => {
    const body = z.object({ apiKey: z.string().optional() }).parse(req.body);
    const result = await testOpenRouterKey(body.apiKey?.trim());
    if (!result.ok) return respond(res, 400, result);
    return respond(res, 200, result);
  }));

  router.get('/openrouter/models', asyncRoute(async (req, res) => {
    const q = (req.query.q as string | undefined) || '';
    const models = await listOpenRouterModels(q);
    return respond(res, 200, {
      models: models.map((m) => ({ id: m.id, name: m.name, context_length: m.context_length })),
    });
  }));

  /* whatsapp */
  router.get('/whatsapp/status', asyncRoute(async (_req, res) => {
    return respond(res, 200, whatsapp.getSnapshot());
  }));

  router.post('/whatsapp/connect', asyncRoute(async (_req, res) => {
    await whatsapp.start();
    return respond(res, 200, { state: whatsapp.getSnapshot().state });
  }));

  router.post('/whatsapp/reconnect', asyncRoute(async (_req, res) => {
    await whatsapp.reconnect();
    return respond(res, 200, { state: whatsapp.getSnapshot().state });
  }));

  router.post('/whatsapp/disconnect', asyncRoute(async (_req, res) => {
    await whatsapp.stop();
    return respond(res, 200, { state: whatsapp.getSnapshot().state });
  }));

  router.post('/whatsapp/logout', asyncRoute(async (_req, res) => {
    await whatsapp.logout();
    return respond(res, 200, { state: whatsapp.getSnapshot().state });
  }));

  router.post('/whatsapp/send-test', asyncRoute(async (req, res) => {
    const body = z.object({ text: z.string().min(1).max(1000) }).parse(req.body);
    await whatsapp.sendToSelf(body.text);
    return respond(res, 200, { ok: true });
  }));

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

  /* conversations */
  router.get('/conversations', asyncRoute(async (req, res) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)));
    const chats = listChats(limit);
    return respond(res, 200, chats);
  }));

  router.get('/conversations/:chatId/messages', asyncRoute(async (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 100)));
    const chatId = decodeURIComponent(String(req.params.chatId));
    const messages = getMessages(chatId, limit);
    return respond(res, 200, messages);
  }));

  router.delete('/conversations/:chatId', asyncRoute(async (req, res) => {
    const chatId = decodeURIComponent(String(req.params.chatId));
    deleteChat(chatId);
    return respond(res, 200, { ok: true });
  }));

  router.post('/conversations/:chatId/reset', asyncRoute(async (req, res) => {
    const chatId = decodeURIComponent(String(req.params.chatId));
    resetChat(chatId);
    return respond(res, 200, { ok: true });
  }));

  router.post('/conversations/:chatId/send', asyncRoute(async (req, res) => {
    const chatId = decodeURIComponent(String(req.params.chatId));
    const body = z.object({ text: z.string().min(1).max(4000), senderName: z.string().optional() }).parse(req.body);
    const result = await agent.respond({ chatId, userText: body.text, senderName: body.senderName || 'Admin', source: 'web' });
    return respond(res, 200, result);
  }));

  /* playground */
  router.post('/playground', asyncRoute(async (req, res) => {
    const body = z.object({ message: z.string().min(1).max(4000), reset: z.boolean().optional() }).parse(req.body);
    const chatId = 'web:playground';
    if (body.reset) resetChat(chatId);
    const result = await agent.respond({ chatId, userText: body.message, source: 'web' });
    return respond(res, 200, result);
  }));

  /* knowledge */
  router.get('/knowledge', asyncRoute(async (_req, res) => {
    const docs = rag.listDocuments();
    const stats = rag.getStats();
    const embeddings = rag.getEmbeddingStatus();
    return respond(res, 200, { documents: docs, stats, embeddings });
  }));

  router.get('/knowledge/:id', asyncRoute(async (req, res, next) => {
    const doc = rag.getDocument(decodeURIComponent(String(req.params.id)));
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
    const doc = await rag.addDocumentAndWait({ title: extracted.title, content: extracted.text, sourceType: 'file', sourceName: req.file.originalname, mimeType: extracted.mimeType });
    return respond(res, 201, { document: doc, preview: extracted.text.slice(0, 1000) });
  }));

  router.post('/knowledge/:id/reindex', asyncRoute(async (req, res) => {
    const id = decodeURIComponent(String(req.params.id));
    const doc = rag.getDocument(id);
    if (!doc) return nextHttpError(res, 404, 'Document not found');
    void rag.indexDocument(id);
    return respond(res, 202, { document: doc });
  }));

  router.delete('/knowledge/:id', asyncRoute(async (req, res) => {
    const id = decodeURIComponent(String(req.params.id));
    const ok = rag.deleteDocument(id);
    if (!ok) return nextHttpError(res, 404, 'Document not found');
    return respond(res, 200, { ok: true });
  }));

  router.post('/knowledge/search', asyncRoute(async (req, res) => {
    const body = z.object({ query: z.string().min(1), k: z.coerce.number().int().min(1).max(20).default(5) }).parse(req.body);
    const results = await rag.search(body.query, body.k, 0.05);
    return respond(res, 200, {
      results: results.map(({ chunkId, documentId, title, content, score, lexicalScore, vectorScore }) => ({
        chunkId, documentId, title, content: content.slice(0, 1200), score, lexicalScore, vectorScore,
      })),
    });
  }));

  /* mcp */
  router.get('/mcp', asyncRoute(async (_req, res) => {
    const servers = mcp.listServers();
    return respond(res, 200, {
      servers: servers.map((s) => {
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

  router.post('/mcp', asyncRoute(async (req, res) => {
    const body = z.object({
      name: z.string().min(1).max(100),
      transport: z.enum(['stdio', 'sse', 'http']),
      command: z.string().optional(),
      args: z.string().optional(),
      env: z.string().optional(),
      cwd: z.string().optional(),
      url: z.string().optional(),
      headers: z.string().optional(),
      enabled: z.boolean().default(true),
      disabledTools: z.array(z.string()).default([]),
    }).parse(req.body);
    const server = mcp.createServer(body);
    await hub.refreshConfig();
    return respond(res, 201, server);
  }));

  router.put('/mcp/:id', asyncRoute(async (req, res) => {
    const body = z.object({
      name: z.string().min(1).max(100).optional(),
      transport: z.enum(['stdio', 'sse', 'http']).optional(),
      command: z.string().optional(),
      args: z.string().optional(),
      env: z.string().optional(),
      cwd: z.string().optional(),
      url: z.string().optional(),
      headers: z.string().optional(),
      enabled: z.boolean().optional(),
      disabledTools: z.array(z.string()).optional(),
    }).parse(req.body);
    const server = mcp.updateServer(decodeURIComponent(String(req.params.id)), body);
    await hub.refreshConfig();
    return respond(res, 200, server);
  }));

  router.delete('/mcp/:id', asyncRoute(async (req, res) => {
    const ok = mcp.deleteServer(decodeURIComponent(String(req.params.id)));
    if (!ok) return nextHttpError(res, 404, 'Server not found');
    await hub.refreshConfig();
    return respond(res, 200, { ok: true });
  }));

  router.patch('/mcp/:id/toggle', asyncRoute(async (req, res) => {
    const body = z.object({ enabled: z.boolean() }).parse(req.body);
    const server = mcp.updateServer(decodeURIComponent(String(req.params.id)), { enabled: body.enabled });
    await hub.refreshConfig();
    return respond(res, 200, server);
  }));

  router.post('/mcp/:id/test', asyncRoute(async (req, res) => {
    const id = decodeURIComponent(String(req.params.id));
    const result = await mcp.testServer(id);
    return respond(res, 200, result);
  }));

  router.post('/mcp/reload', asyncRoute(async (_req, res) => {
    await mcp.closeAll();
    const { tools, errors } = await mcp.getAllTools();
    return respond(res, 200, {
      tools: tools.map(({ function: fn }) => ({ name: fn.name, description: fn.description })),
      errors,
    });
  }));

  router.get('/mcp/tools', asyncRoute(async (_req, res) => {
    const { tools, errors } = await mcp.getAllTools();
    return respond(res, 200, {
      tools: tools.map(({ function: fn }) => ({ name: fn.name, description: fn.description })),
      errors,
    });
  }));

  router.patch('/mcp/:id/tools', asyncRoute(async (req, res) => {
    const body = z.object({ disabledTools: z.array(z.string()) }).parse(req.body);
    const server = mcp.updateServer(decodeURIComponent(String(req.params.id)), { disabledTools: body.disabledTools });
    return respond(res, 200, server);
  }));

  /* ---------------- local hub: official WhatsApp + OpenCode ---------------- */

  router.get('/hub/status', asyncRoute(async (_req, res) => {
    return respond(res, 200, hub.getStatus());
  }));

  router.get('/hub/agents', asyncRoute(async (_req, res) => {
    return respond(res, 200, {
      agents: listAgents().map((item) => hub.getAgentSnapshot(item)),
    });
  }));

  router.post('/hub/agents', asyncRoute(async (req, res) => {
    const body = z
      .object({
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
      })
      .parse(req.body);
    const serverIds =
      body.mcpServerIds ??
      mcp.listServers().filter((server) => server.enabled).map((server) => server.id);
    const created = createAgent({
      ...body,
      token: body.token || null,
      mcpServerIds: serverIds,
      knowledgeIds: body.knowledgeIds ?? [],
    });
    await hub.applyAgentChange(created.id);
    return respond(res, 201, { agent: getAgentDetail(created.id) });
  }));

  router.get('/hub/agents/:id', asyncRoute(async (req, res) => {
    const id = decodeURIComponent(String(req.params.id));
    const detail = getAgentDetail(id);
    if (!detail) throw new HttpError(404, 'Agent not found.');
    return respond(res, 200, { agent: detail });
  }));

  router.put('/hub/agents/:id', asyncRoute(async (req, res) => {
    const id = decodeURIComponent(String(req.params.id));
    requireHubAgent(id);
    const body = z
      .object({
        name: z.string().trim().min(1).max(80).optional(),
        model: z.string().trim().min(1).max(200).optional(),
        systemPrompt: z.string().max(50_000).optional(),
        token: z.string().max(2_000).optional().nullable(),
        enabled: z.boolean().optional(),
        autoStart: z.boolean().optional(),
        typingIndicator: z.boolean().optional(),
        readReceipts: z.boolean().optional(),
        mcpServerIds: z.array(z.string()).optional(),
        knowledgeIds: z.array(z.string()).optional(),
      })
      .parse(req.body);
    const updated = updateAgent(id, body);
    if (!updated) throw new HttpError(404, 'Agent not found.');
    await hub.applyAgentChange(id);
    return respond(res, 200, { agent: getAgentDetail(id) });
  }));

  router.delete('/hub/agents/:id', asyncRoute(async (req, res) => {
    const id = decodeURIComponent(String(req.params.id));
    requireHubAgent(id);
    await hub.stopAgent(id);
    const ok = deleteAgent(id);
    if (!ok) throw new HttpError(404, 'Agent not found.');
    opencode.invalidateConfig();
    void hub.refreshConfig();
    return respond(res, 200, { ok: true });
  }));

  router.post('/hub/agents/:id/start', asyncRoute(async (req, res) => {
    const id = decodeURIComponent(String(req.params.id));
    const found = requireHubAgent(id);
    if (!found.hasToken) throw new HttpError(400, 'Add a WhatsApp Agent Platform token first.');
    try {
      const result = await hub.startAgent(id);
      return respond(res, 200, { agent: result });
    } catch (error) {
      return nextHttpError(res, 400, error instanceof Error ? error.message : 'Could not start agent.');
    }
  }));

  router.post('/hub/agents/:id/stop', asyncRoute(async (req, res) => {
    const id = decodeURIComponent(String(req.params.id));
    requireHubAgent(id);
    await hub.stopAgent(id);
    return respond(res, 200, { ok: true });
  }));

  router.post('/hub/agents/:id/restart', asyncRoute(async (req, res) => {
    const id = decodeURIComponent(String(req.params.id));
    requireHubAgent(id);
    try {
      const result = await hub.restartAgent(id);
      return respond(res, 200, { agent: result });
    } catch (error) {
      return nextHttpError(res, 400, error instanceof Error ? error.message : 'Could not restart agent.');
    }
  }));

  router.post('/hub/agents/:id/test', asyncRoute(async (req, res) => {
    const id = decodeURIComponent(String(req.params.id));
    requireHubAgent(id);
    const body = z.object({ text: z.string().trim().min(1).max(20_000) }).parse(req.body);
    try {
      const result = await hub.testAgent(id, body.text);
      return respond(res, 200, result);
    } catch (error) {
      return nextHttpError(res, 400, error instanceof Error ? error.message : 'Agent test failed.');
    }
  }));

  router.post('/hub/agents/:id/send', asyncRoute(async (req, res) => {
    const id = decodeURIComponent(String(req.params.id));
    requireHubAgent(id);
    const body = z.object({ text: z.string().trim().min(1).max(4_000) }).parse(req.body);
    try {
      const ids = await hub.sendToCreator(id, body.text);
      return respond(res, 200, { ok: true, messageIds: ids });
    } catch (error) {
      return nextHttpError(res, 400, error instanceof Error ? error.message : 'Could not send message.');
    }
  }));

  router.put('/hub/agents/:id/mcp', asyncRoute(async (req, res) => {
    const id = decodeURIComponent(String(req.params.id));
    requireHubAgent(id);
    const body = z.object({ serverIds: z.array(z.string()) }).parse(req.body);
    setAgentMcpServers(id, body.serverIds);
    await hub.refreshConfig();
    return respond(res, 200, { agent: getAgentDetail(id) });
  }));

  router.put('/hub/agents/:id/knowledge', asyncRoute(async (req, res) => {
    const id = decodeURIComponent(String(req.params.id));
    requireHubAgent(id);
    const body = z.object({ documentIds: z.array(z.string()) }).parse(req.body);
    setAgentKnowledge(id, body.documentIds);
    return respond(res, 200, { agent: getAgentDetail(id) });
  }));

  router.get('/hub/agents/:id/skills', asyncRoute(async (req, res) => {
    const id = decodeURIComponent(String(req.params.id));
    const detail = getAgentDetail(id);
    if (!detail) throw new HttpError(404, 'Agent not found.');
    return respond(res, 200, { skills: detail.skills });
  }));

  router.post('/hub/agents/:id/skills', asyncRoute(async (req, res) => {
    const id = decodeURIComponent(String(req.params.id));
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
    const id = decodeURIComponent(String(req.params.id));
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
    const id = decodeURIComponent(String(req.params.id));
    const current = getSkill(id);
    if (!current) throw new HttpError(404, 'Skill not found.');
    deleteSkill(id);
    await hub.applyAgentChange(current.agentId);
    return respond(res, 200, { ok: true });
  }));

  router.get('/hub/schedules', asyncRoute(async (_req, res) => {
    return respond(res, 200, { schedules: listAllSchedules() });
  }));

  router.get('/hub/agents/:id/schedules', asyncRoute(async (req, res) => {
    const id = decodeURIComponent(String(req.params.id));
    const detail = getAgentDetail(id);
    if (!detail) throw new HttpError(404, 'Agent not found.');
    return respond(res, 200, { schedules: detail.schedules });
  }));

  router.post('/hub/agents/:id/schedules', asyncRoute(async (req, res) => {
    const id = decodeURIComponent(String(req.params.id));
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
    const id = decodeURIComponent(String(req.params.id));
    const current = getSchedule(id);
    if (!current) throw new HttpError(404, 'Schedule not found.');
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
    const id = decodeURIComponent(String(req.params.id));
    if (!getSchedule(id)) throw new HttpError(404, 'Schedule not found.');
    deleteSchedule(id);
    await hub.refreshConfig();
    return respond(res, 200, { ok: true });
  }));

  router.post('/hub/schedules/:id/run', asyncRoute(async (req, res) => {
    const id = decodeURIComponent(String(req.params.id));
    if (!getSchedule(id)) throw new HttpError(404, 'Schedule not found.');
    void hub.runSchedule(id);
    return respond(res, 202, { ok: true });
  }));

  router.post('/hub/runtime/reload', asyncRoute(async (_req, res) => {
    await hub.refreshConfig();
    try {
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

  router.post('/agent/reset-playground', asyncRoute(async (_req, res) => {
    resetChat('web:playground');
    return respond(res, 200, { ok: true });
  }));

  /* SSE events */
  router.get('/events', asyncRoute(async (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    const send = (event: string, data: unknown) => {
      try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* ignore */ }
    };
    send('retry', { retry: 3000 });
    send('hello', { at: new Date().toISOString() });
    const handler = (message: { type: string; data: unknown }) => send(message.type, message.data);
    bus.on('event', handler);
    req.on('close', () => { bus.off('event', handler); clearInterval(timer); });
    req.on('error', () => { bus.off('event', handler); clearInterval(timer); });
    const timer = setInterval(() => send('heartbeat', { at: new Date().toISOString() }), 20_000);
  }));

  router.use((_req, res) => respond(res, 404, { error: 'Unknown API endpoint' }));

  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      return respond(res, err.status, { error: err.message });
    }
    if (err instanceof z.ZodError) {
      const issues = err.issues.slice(0, 10).map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      }));
      const first = issues[0];
      return respond(res, 400, {
        error: first ? `${first.path || 'request'}: ${first.message}` : 'Validation error',
        issues,
      });
    }
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ error: message }, 'Unhandled API error');
    return respond(res, 500, { error: 'Internal server error' });
  });

  return router;
}

