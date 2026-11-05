import crypto from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { createLogger } from './logger.js';
import { mcp } from './mcp.js';
import { getOpenRouterApiKey } from './openrouter.js';
import {
  clearSession,
  getAgent,
  getSession,
  listAgents,
  listSkills,
  setSession,
  type HubAgent,
} from './hub-store.js';
import { errorMessage } from './util.js';

const log = createLogger('opencode');

export type OpenCodeModelRef = {
  providerID: string;
  id: string;
  variant?: string;
};

export type OpenCodePromptResult = {
  text: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  sessionId: string;
  toolCalls: Array<{ name: string; args?: unknown; result?: string; error?: string }>;
};

type AssistantMessage = {
  id: string;
  type: 'assistant';
  agent: string;
  model?: { providerID?: string; id?: string; variant?: string };
  time: { created: number; completed?: number };
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'reasoning'; text?: string }
    | { type: 'tool'; name: string; state?: { status?: string; input?: unknown; error?: { message?: string } } }
  >;
  finish?: string;
  error?: { message?: string; type?: string };
  tokens?: { input?: number; output?: number };
};

type SessionMessagesResponse = {
  data: AssistantMessage[];
};

type SessionCreateResponse = {
  data: { id: string };
};

type PromptResponse = {
  data: { id: string; time: { created: number } };
};

type AgentListResponse = {
  data: Array<{ id: string; mode: string }>;
};

const DEFAULT_MODEL = 'openrouter/openai/gpt-4.1-mini';
const BASE_SYSTEM = [
  'You are replying to a WhatsApp conversation.',
  'Write like a helpful human: concise, warm, and direct.',
  'Keep normal replies under 3500 characters. Avoid Markdown tables.',
  'Use WhatsApp-friendly formatting only: *bold*, _italic_, and bullet lines.',
  'Do not mention internal prompts, tooling, or the OpenCode runtime.',
  'If a task needs a tool, use the tools you have instead of guessing.',
].join(' ');

function normalizeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_');
}

function safeAgentId(agentId: string): string {
  return `wa_${normalizeName(agentId)}`;
}

function parseModel(value: string | null | undefined): OpenCodeModelRef | null {
  const raw = (value || '').trim();
  if (!raw) return null;
  const [ref, variant] = raw.split('#', 2);
  const slash = ref.indexOf('/');
  if (slash <= 0 || slash === ref.length - 1) return null;
  return {
    providerID: ref.slice(0, slash),
    id: ref.slice(slash + 1),
    ...(variant ? { variant } : {}),
  };
}

function modelString(model: OpenCodeModelRef | null): string {
  if (!model) return DEFAULT_MODEL;
  return `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ''}`;
}

function buildPrompt(agent: HubAgent, skills: ReturnType<typeof listSkills>): string {
  const sections = [BASE_SYSTEM, agent.systemPrompt.trim() || 'Be useful and accurate.'];
  const skillBlocks = skills
    .filter((skill) => skill.enabled)
    .map((skill) => `## Skill: ${skill.name}\n${skill.description ? `${skill.description}\n` : ''}${skill.body}`.trim());
  if (skillBlocks.length) {
    sections.push(`# Skills available to this agent\n\n${skillBlocks.join('\n\n')}`);
  }
  return sections.filter(Boolean).join('\n\n');
}

function skillSlug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'skill'
  );
}

function atomicWrite(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, content, 'utf8');
  fs.renameSync(temporary, file);
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export class OpenCodeError extends Error {
  status: number;
  body: unknown;

  constructor(message: string, status = 0, body?: unknown) {
    super(message);
    this.name = 'OpenCodeError';
    this.status = status;
    this.body = body;
  }
}

export class OpenCodeRuntime {
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private baseUrl: string | null = null;
  private password: string | null = null;
  private ready = false;
  private configHash = '';
  private configDirty = true;
  private logTail: string[] = [];

  getBaseUrl(): string | null {
    return this.baseUrl;
  }

  isReady(): boolean {
    return this.ready;
  }

  getLogTail(): string[] {
    return [...this.logTail];
  }

  private pushLog(line: string): void {
    const clean = line.replace(/server password\s+\S+/i, 'server password [redacted]').trim();
    if (!clean) return;
    this.logTail.push(clean);
    if (this.logTail.length > 80) this.logTail.splice(0, this.logTail.length - 80);
  }

  async ensure(): Promise<void> {
    if (this.ready && this.baseUrl) {
      try {
        await this.request('GET', '/api/info', undefined, 5_000);
        return;
      } catch {
        this.ready = false;
      }
    }
    if (this.starting) return this.starting;
    this.starting = this.startServer().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async startServer(): Promise<void> {
    if (this.child && !this.child.killed && this.password) {
      await this.waitUntilReady(10_000);
      return;
    }

    const preferred = Number(process.env.OPENCODE_PORT || 4096);
    const ports = [preferred, ...Array.from({ length: 5 }, (_, index) => preferred + index + 1)];
    let lastError: unknown = null;

    for (const port of [...new Set(ports)]) {
      try {
        await this.spawnAt(port);
        return;
      } catch (error) {
        lastError = error;
        this.killChild();
        const message = errorMessage(error);
        if (!/EADDRINUSE|address already in use|already in use/i.test(message)) {
          // A non-port startup failure is not fixed by trying another port.
          break;
        }
      }
    }
    throw new OpenCodeError(
      `Could not start the OpenCode server. ${errorMessage(lastError)}\n` +
        `Make sure \`opencode\` is installed and set OPENCODE_PORT to a free port if needed.`,
    );
  }

  private async spawnAt(port: number): Promise<void> {
    const executable = process.env.OPENCODE_BIN || 'opencode';
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      OPENCODE_DISABLE_AUTOUPDATE: '1',
    };
    const key = getOpenRouterApiKey();
    if (key) env.OPENROUTER_API_KEY = key;

    log.info({ port, executable }, 'Starting OpenCode server');
    const child = spawn(executable, ['serve', '--port', String(port), '--hostname', '127.0.0.1', '--print-logs'], {
      cwd: config.rootDir,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as unknown as ChildProcessWithoutNullStreams;

    this.child = child;
    this.baseUrl = null;
    this.password = null;
    this.ready = false;
    this.logTail = [];

    let output = '';
    let resolved = false;

    const inspect = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      output += text;
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.pushLog(line);
        const passwordMatch = /server password\s+(\S+)/i.exec(line);
        if (passwordMatch) this.password = passwordMatch[1];
        const urlMatch = /server listening on\s+(https?:\/\/\S+)/i.exec(line);
        if (urlMatch) this.baseUrl = urlMatch[1].replace(/\/+$/, '');
      }
    };

    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);

    const exitPromise = new Promise<never>((_, reject) => {
      child.once('error', (error) => {
        if (!resolved) reject(new OpenCodeError(`OpenCode failed to start: ${error.message}`));
      });
      child.once('exit', (code, signal) => {
        if (resolved) return;
        const detail = output
          .split(/\r?\n/)
          .filter((line) => line.trim() && !/server password/i.test(line))
          .slice(-8)
          .join('\n');
        reject(
          new OpenCodeError(
            `OpenCode exited before it became ready (${signal || code || 'unknown'}).${detail ? `\n${detail}` : ''}`,
          ),
        );
      });
    });

    const readyPromise = (async () => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (this.password && (this.baseUrl || port)) {
          if (!this.baseUrl) this.baseUrl = `http://127.0.0.1:${port}`;
          try {
            await this.request('GET', '/api/info', undefined, 5_000);
            this.ready = true;
            resolved = true;
            log.info({ baseUrl: this.baseUrl }, 'OpenCode server ready');
            return;
          } catch {
            /* keep waiting */
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      throw new OpenCodeError('Timed out waiting for OpenCode to become ready.');
    })();

    await Promise.race([readyPromise, exitPromise]);
  }

  private async waitUntilReady(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        await this.request('GET', '/api/info', undefined, 3_000);
        this.ready = true;
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
    throw new OpenCodeError('OpenCode is not responding.');
  }

  private killChild(): void {
    const child = this.child;
    this.child = null;
    this.ready = false;
    this.password = null;
    this.baseUrl = null;
    if (!child || child.killed) return;
    try {
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      } else {
        child.kill('SIGTERM');
      }
    } catch {
      /* ignore */
    }
  }

  async stop(): Promise<void> {
    this.killChild();
  }

  private async request<T>(
    method: string,
    route: string,
    body?: unknown,
    timeoutMs = 120_000,
  ): Promise<T> {
    if (!this.baseUrl || !this.password) throw new OpenCodeError('OpenCode is not running.');
    const header = `Basic ${Buffer.from(`opencode:${this.password}`).toString('base64')}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('OpenCode request timed out')), timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${route}`, {
        method,
        headers: {
          Authorization: header,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const text = await response.text();
      let data: unknown = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      if (!response.ok) {
        const message =
          data && typeof data === 'object' && 'message' in data
            ? String((data as { message: unknown }).message)
            : typeof data === 'string'
              ? data
              : `OpenCode request failed (${response.status})`;
        throw new OpenCodeError(message, response.status, data);
      }
      return data as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private async reloadConfig(): Promise<void> {
    try {
      await this.request('POST', '/api/location/reload', undefined, 60_000);
    } catch (error) {
      throw new OpenCodeError(
        `OpenCode rejected the generated configuration: ${errorMessage(error)}`,
        error instanceof OpenCodeError ? error.status : 0,
      );
    }
  }

  async syncConfig(force = false): Promise<void> {
    const agents = listAgents();
    const servers = mcp.listServers().filter((server) => server.enabled);
    const serverNames = new Set<string>();

    const mcpConfig: Record<string, unknown> = {};
    for (const server of servers) {
      const name = normalizeName(server.name);
      if (!name || serverNames.has(name)) {
        log.warn({ server: server.name }, 'Skipping MCP server with an empty or duplicate normalized name');
        continue;
      }
      serverNames.add(name);
      if (server.transport === 'stdio') {
        const command = [server.command, ...server.args].filter(Boolean);
        if (!command.length) continue;
        mcpConfig[name] = {
          type: 'local',
          command,
          ...(server.cwd ? { cwd: path.resolve(config.rootDir, server.cwd) } : {}),
          ...(Object.keys(server.env).length ? { environment: server.env } : {}),
          codemode: false,
        };
      } else if (server.url) {
        if (server.transport === 'sse') {
          log.warn(
            { server: server.name },
            'OpenCode v2 expects Streamable HTTP for remote MCP servers; the SSE URL will be tried as-is',
          );
        }
        mcpConfig[name] = {
          type: 'remote',
          url: server.url,
          oauth: false,
          ...(Object.keys(server.headers).length ? { headers: server.headers } : {}),
          codemode: false,
        };
      }
    }

    const agentConfig: Record<string, unknown> = {};
    for (const agent of agents) {
      const skills = listSkills(agent.id);
      const bound = new Set(agent.mcpServerIds);
      const permissions: Array<{ action: string; resource: string; effect: string }> = [];
      for (const [name] of Object.entries(mcpConfig)) {
        if (bound.has(
          servers.find((server) => normalizeName(server.name) === name)?.id || '',
        )) {
          continue;
        }
        permissions.push({ action: `${name}_*`, resource: '*', effect: 'deny' });
        permissions.push({ action: 'opencode_list_mcp_resources', resource: name, effect: 'deny' });
        permissions.push({ action: 'opencode_read_mcp_resource', resource: `${name}:*`, effect: 'deny' });
      }

      const model = parseModel(agent.model);
      agentConfig[safeAgentId(agent.id)] = {
        description: `WhatsApp agent: ${agent.name}`,
        mode: 'primary',
        ...(model ? { model: modelString(model) } : {}),
        system: buildPrompt(agent, skills),
        steps: 12,
        ...(permissions.length ? { permissions } : {}),
      };
    }

    const defaultModel = parseModel(agents[0]?.model || DEFAULT_MODEL) || parseModel(DEFAULT_MODEL);
    const generated = {
      $schema: 'https://opencode.ai/config.json',
      model: modelString(defaultModel),
      ...(Object.keys(mcpConfig).length ? { mcp: { servers: mcpConfig } } : {}),
      ...(Object.keys(agentConfig).length ? { agents: agentConfig } : {}),
    };
    const content = `${JSON.stringify(generated, null, 2)}\n`;
    const hash = sha256(content);
    if (!force && !this.configDirty && hash === this.configHash) return;

    const configPath = path.join(config.rootDir, 'opencode.json');
    const managedPath = path.join(config.dataDir, 'opencode-managed.json');
    let managedHash = '';
    try {
      const managed = JSON.parse(fs.readFileSync(managedPath, 'utf8')) as { hash?: string };
      managedHash = managed.hash || '';
    } catch {
      /* first run */
    }
    if (fs.existsSync(configPath)) {
      try {
        const existing = fs.readFileSync(configPath, 'utf8');
        if (existing !== content && sha256(existing) !== managedHash) {
          const backup = path.join(config.rootDir, `opencode.json.bak-${Date.now()}`);
          fs.writeFileSync(backup, existing, 'utf8');
          log.warn({ backup }, 'Backed up existing opencode.json before syncing the hub configuration');
        }
      } catch {
        /* ignore backup errors */
      }
    }
    atomicWrite(configPath, content);
    atomicWrite(
      managedPath,
      `${JSON.stringify({ hash, configPath, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    );
    this.writeSkills(agents);

    this.configHash = hash;
    this.configDirty = false;
    if (this.baseUrl && this.password) {
      await this.reloadConfig();
    }
    log.info({ agents: agents.length, mcpServers: Object.keys(mcpConfig).length }, 'Synced OpenCode configuration');
  }

  private writeSkills(agents: HubAgent[]): void {
    const root = path.join(config.rootDir, '.opencode', 'skills');
    fs.mkdirSync(root, { recursive: true });
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('wa-hub-')) continue;
      fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
    }
    for (const agent of agents) {
      for (const skill of listSkills(agent.id).filter((item) => item.enabled)) {
        const dir = path.join(root, `wa-hub-${safeAgentId(agent.id)}-${skillSlug(skill.name)}-${skill.id.slice(-6)}`);
        fs.mkdirSync(dir, { recursive: true });
        const frontmatter = [
          '---',
          `name: ${JSON.stringify(skill.name.replace(/\r?\n/g, ' '))}`,
          `description: ${JSON.stringify((skill.description || skill.name).replace(/\r?\n/g, ' '))}`,
          '---',
          '',
          skill.body,
          '',
        ].join('\n');
        fs.writeFileSync(path.join(dir, 'SKILL.md'), frontmatter, 'utf8');
      }
    }
    try {
      const annotationsPath = path.resolve(config.dataDir, 'annotations.json');
      if (fs.existsSync(annotationsPath)) {
        const raw = fs.readFileSync(annotationsPath, 'utf8');
        const parsed = JSON.parse(raw) as { annotations?: Array<{ selector: string; comment: string }> };
        const annotations = parsed.annotations || [];
        if (annotations.length > 0) {
          const dir = path.join(root, 'annotations');
          fs.mkdirSync(dir, { recursive: true });
          const body = annotations.map((a) => `- Selector: \`${a.selector}\`\n  Note: ${a.comment}`).join('\n\n');
          fs.writeFileSync(
            path.join(dir, 'SKILL.md'),
            `---\nname: User Annotations\ndescription: Design feedback and fixes captured by the user through the annotation overlay. OpenCode should reference these when fixing UI issues.\n---\n\n${body}\n`,
            'utf8',
          );
        }
      }
    } catch {
      // ignore annotation injection errors
    }
  }

  invalidateConfig(): void {
    this.configDirty = true;
  }

  hasManagedConfig(): boolean {
    return fs.existsSync(path.join(config.dataDir, 'opencode-managed.json'));
  }

  async listAgentsForLocation(): Promise<string[]> {
    await this.ensure();
    const response = await this.request<AgentListResponse>(
      'GET',
      `/api/agent?location%5Bdirectory%5D=${encodeURIComponent(config.rootDir)}`,
      undefined,
      20_000,
    );
    return (response?.data || []).map((item) => item.id);
  }

  private async createSession(agent: HubAgent, conversationKey: string): Promise<string> {
    const model = parseModel(agent.model);
    const label = conversationKey ? ` · ${conversationKey}` : '';
    const response = await this.request<SessionCreateResponse>('POST', '/api/session', {
      title: `WhatsApp · ${agent.name}${label}`,
      agent: safeAgentId(agent.id),
      location: { directory: config.rootDir },
      ...(model ? { model } : {}),
    }, 30_000);
    const sessionId = response?.data?.id;
    if (!sessionId) throw new OpenCodeError('OpenCode did not return a session id.');
    setSession(agent.id, conversationKey, sessionId, config.rootDir);
    return sessionId;
  }

  private async ensureSession(agent: HubAgent, conversationKey: string): Promise<string> {
    const existing = getSession(agent.id, conversationKey);
    if (existing) return existing.sessionId;
    return this.createSession(agent, conversationKey);
  }

  async runPrompt(
    agent: HubAgent,
    text: string,
    options: {
      metadata?: Record<string, unknown>;
      conversationKey?: string;
      files?: Array<{ uri: string; name?: string; description?: string }>;
    } = {},
  ): Promise<OpenCodePromptResult> {
    const started = Date.now();
    await this.ensure();
    if (this.configDirty) await this.syncConfig();

    const conversationKey = options.conversationKey || '';
    let sessionId = await this.ensureSession(agent, conversationKey);
    const promptBody = {
      text,
      metadata: options.metadata,
      ...(options.files?.length ? { files: options.files } : {}),
    };
    let prompt: PromptResponse;
    try {
      prompt = await this.request<PromptResponse>('POST', `/api/session/${encodeURIComponent(sessionId)}/prompt`, promptBody, 30_000);
    } catch (error) {
      if (error instanceof OpenCodeError && error.status === 404) {
        clearSession(agent.id, conversationKey);
        sessionId = await this.createSession(agent, conversationKey);
        prompt = await this.request<PromptResponse>('POST', `/api/session/${encodeURIComponent(sessionId)}/prompt`, promptBody, 30_000);
      } else {
        throw error;
      }
    }

    const promptCreated = prompt?.data?.time?.created ?? Date.now();
    await this.request('POST', `/api/experimental/session/${encodeURIComponent(sessionId)}/wait`, undefined, 6 * 60 * 1000);

    const messages = await this.readAssistantMessages(sessionId, promptCreated);
    const assistant = messages[messages.length - 1];
    if (!assistant) {
      throw new OpenCodeError('OpenCode finished without returning an assistant message.');
    }
    if (assistant.error) {
      throw new OpenCodeError(assistant.error.message || 'OpenCode returned an agent error.');
    }
    const textParts = assistant.content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
      .trim();
    const toolCalls = assistant.content
      .filter((part): part is { type: 'tool'; name: string; state?: { status?: string; input?: unknown; error?: { message?: string } } } => part.type === 'tool')
      .map((part) => ({
        name: part.name,
        args: part.state?.input,
        ...(part.state?.status === 'error' ? { error: part.state.error?.message || 'Tool failed' } : {}),
      }));

    if (!textParts) {
      throw new OpenCodeError(
        assistant.finish === 'length'
          ? 'The model hit its output limit before producing a reply.'
          : 'The model returned an empty reply.',
      );
    }

    return {
      text: textParts,
      model: assistant.model
        ? `${assistant.model.providerID || ''}/${assistant.model.id || ''}`.replace(/^\/|\/$/g, '')
        : agent.model,
      tokensIn: Number(assistant.tokens?.input || 0),
      tokensOut: Number(assistant.tokens?.output || 0),
      latencyMs: Date.now() - started,
      sessionId,
      toolCalls,
    };
  }

  private async readAssistantMessages(sessionId: string, after: number): Promise<AssistantMessage[]> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await this.request<SessionMessagesResponse>(
        'GET',
        `/api/session/${encodeURIComponent(sessionId)}/message?limit=80&order=desc`,
        undefined,
        30_000,
      );
      const messages = (response?.data || [])
        .filter(
          (message): message is AssistantMessage =>
            message?.type === 'assistant' && Number(message.time?.created || 0) >= after,
        )
        .sort((a, b) => a.time.created - b.time.created);
      if (messages.length) return messages;
      await new Promise((resolve) => setTimeout(resolve, 400 + attempt * 600));
    }
    return [];
  }

  async resetSession(agentId: string): Promise<void> {
    clearSession(agentId);
  }
}

export const opencode = new OpenCodeRuntime();
