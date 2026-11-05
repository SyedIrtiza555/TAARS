import crypto from 'node:crypto';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import parseArgsStringToArgv from 'string-argv';
import { config } from './config.js';
import { db } from './db.js';
import { bus } from './events.js';
import { createLogger } from './logger.js';
import { getSettings } from './settings.js';
import { errorMessage, newId, nowIso, safeJson, truncate } from './util.js';

const log = createLogger('mcp');

export type McpTransport = 'stdio' | 'sse' | 'http';

export type McpServerRecord = {
  id: string;
  name: string;
  transport: McpTransport;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  url: string;
  headers: Record<string, string>;
  enabled: boolean;
  disabled_tools: string[];
  last_status: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export type McpServerInput = {
  name?: string;
  transport?: McpTransport;
  command?: string;
  args?: string[] | string;
  env?: Record<string, string> | string;
  cwd?: string;
  url?: string;
  headers?: Record<string, string> | string;
  enabled?: boolean;
  disabledTools?: string[];
};

export type OpenAiTool = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

type RawTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

type CachedConnection = {
  client: Client;
  transport: Transport;
  tools: RawTool[];
  configStamp: string;
};

type ToolMapping = {
  serverId: string;
  serverName: string;
  toolName: string;
  connection: CachedConnection;
};

type DbRow = {
  id: string;
  name: string;
  transport: string;
  command: string | null;
  args: string;
  env: string;
  cwd: string | null;
  url: string | null;
  headers: string;
  enabled: number;
  disabled_tools: string;
  last_status: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

function normalizeArgs(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value === 'string') {
    try {
      return parseArgsStringToArgv(value).map(String);
    } catch {
      return [];
    }
  }
  return [];
}

export function normalizeStringMap(value: unknown): Record<string, string> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, String(val)]));
  }
  if (typeof value === 'string') {
    const result: Record<string, string> = {};
    for (const rawLine of value.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const index = line.indexOf('=');
      if (index <= 0) continue;
      result[line.slice(0, index).trim()] = line.slice(index + 1).trim();
    }
    return result;
  }
  return {};
}

function rowToRecord(row: DbRow): McpServerRecord {
  const transport = ['stdio', 'sse', 'http'].includes(row.transport)
    ? (row.transport as McpTransport)
    : 'stdio';
  return {
    id: row.id,
    name: row.name,
    transport,
    command: row.command || '',
    args: safeJson<string[]>(row.args, []),
    env: safeJson<Record<string, string>>(row.env, {}),
    cwd: row.cwd || '',
    url: row.url || '',
    headers: safeJson<Record<string, string>>(row.headers, {}),
    enabled: Boolean(row.enabled),
    disabled_tools: safeJson<string[]>(row.disabled_tools, []),
    last_status: row.last_status,
    last_error: row.last_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function configStamp(record: McpServerRecord): string {
  return crypto
    .createHash('sha1')
    .update(
      JSON.stringify({
        transport: record.transport,
        command: record.command,
        args: record.args,
        env: record.env,
        cwd: record.cwd,
        url: record.url,
        headers: record.headers,
      }),
    )
    .digest('hex');
}

function slug(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || 'tool';
}

function stableSuffix(serverId: string, toolName: string): string {
  return crypto.createHash('sha1').update(`${serverId}:${toolName}`).digest('hex').slice(0, 6);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function serializeToolResult(result: unknown): string {
  if (!result || typeof result !== 'object') return String(result ?? '');
  const payload = result as {
    content?: Array<Record<string, unknown>>;
    structuredContent?: unknown;
    isError?: boolean;
  };
  const parts: string[] = [];
  for (const item of payload.content || []) {
    if (item.type === 'text' && typeof item.text === 'string') parts.push(item.text);
    else if (item.type === 'resource' && item.resource) {
      const resource = item.resource as Record<string, unknown>;
      if (typeof resource.text === 'string') parts.push(resource.text);
      else parts.push(JSON.stringify(resource));
    } else if (item.type === 'image') parts.push('[image returned by tool]');
    else parts.push(JSON.stringify(item));
  }
  if (payload.structuredContent) parts.push(JSON.stringify(payload.structuredContent));
  const text = parts.filter(Boolean).join('\n') || JSON.stringify(result);
  return truncate(payload.isError ? `Tool returned an error:\n${text}` : text, 16_000);
}

export class McpManager {
  private connections = new Map<string, CachedConnection>();
  private connecting = new Map<string, Promise<CachedConnection>>();
  private failures = new Map<string, { until: number; message: string }>();
  private toolMap = new Map<string, ToolMapping>();

  listServers(): McpServerRecord[] {
    const rows = db.prepare('SELECT * FROM mcp_servers ORDER BY created_at ASC').all() as unknown as DbRow[];
    return rows.map(rowToRecord);
  }

  getServer(id: string): McpServerRecord | null {
    const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as unknown as DbRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  getCachedTools(serverId: string): RawTool[] {
    return this.connections.get(serverId)?.tools || [];
  }

  createServer(input: McpServerInput): McpServerRecord {
    const name = (input.name || '').trim();
    if (!name) throw new Error('Server name is required.');
    const transport = input.transport || 'stdio';
    if (!['stdio', 'sse', 'http'].includes(transport)) throw new Error('Invalid transport.');
    const command = (input.command || '').trim();
    const url = (input.url || '').trim();
    if (transport === 'stdio' && !command) throw new Error('A command is required for stdio servers.');
    if (transport !== 'stdio' && !/^https?:\/\//i.test(url)) throw new Error('A valid HTTP(S) URL is required.');
    const exists = db.prepare('SELECT id FROM mcp_servers WHERE name = ?').get(name);
    if (exists) throw new Error('A server with that name already exists.');
    const id = newId('mcp');
    const at = nowIso();
    db.prepare(
      `INSERT INTO mcp_servers
       (id, name, transport, command, args, env, cwd, url, headers, enabled, disabled_tools,
        last_status, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'not_connected', NULL, ?, ?)`,
    ).run(
      id,
      name,
      transport,
      command,
      JSON.stringify(normalizeArgs(input.args)),
      JSON.stringify(normalizeStringMap(input.env)),
      (input.cwd || '').trim(),
      url,
      JSON.stringify(normalizeStringMap(input.headers)),
      input.enabled === false ? 0 : 1,
      JSON.stringify((input.disabledTools || []).map(String)),
      at,
      at,
    );
    bus.publish('mcp:changed', { id });
    return this.getServer(id)!;
  }

  updateServer(id: string, input: McpServerInput): McpServerRecord {
    const current = this.getServer(id);
    if (!current) throw new Error('MCP server not found.');
    const name = (input.name ?? current.name).trim();
    if (!name) throw new Error('Server name is required.');
    const duplicate = db.prepare('SELECT id FROM mcp_servers WHERE name = ? AND id <> ?').get(name, id);
    if (duplicate) throw new Error('A server with that name already exists.');
    const transport = input.transport ?? current.transport;
    const command = input.command !== undefined ? input.command.trim() : current.command;
    const url = input.url !== undefined ? input.url.trim() : current.url;
    if (transport === 'stdio' && !command) throw new Error('A command is required for stdio servers.');
    if (transport !== 'stdio' && !/^https?:\/\//i.test(url)) throw new Error('A valid HTTP(S) URL is required.');

    db.prepare(
      `UPDATE mcp_servers SET name = ?, transport = ?, command = ?, args = ?, env = ?, cwd = ?, url = ?,
        headers = ?, enabled = ?, disabled_tools = ?, updated_at = ? WHERE id = ?`,
    ).run(
      name,
      transport,
      command,
      JSON.stringify(input.args !== undefined ? normalizeArgs(input.args) : current.args),
      JSON.stringify(input.env !== undefined ? normalizeStringMap(input.env) : current.env),
      (input.cwd ?? current.cwd).trim(),
      url,
      JSON.stringify(input.headers !== undefined ? normalizeStringMap(input.headers) : current.headers),
      input.enabled !== undefined ? (input.enabled ? 1 : 0) : current.enabled ? 1 : 0,
      JSON.stringify(input.disabledTools ?? current.disabled_tools),
      nowIso(),
      id,
    );
    void this.disconnect(id);
    bus.publish('mcp:changed', { id });
    return this.getServer(id)!;
  }

  deleteServer(id: string): boolean {
    void this.disconnect(id);
    const result = db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
    bus.publish('mcp:changed', { id });
    return result.changes > 0;
  }

  async disconnect(id: string): Promise<void> {
    const cached = this.connections.get(id);
    this.connections.delete(id);
    this.failures.delete(id);
    if (!cached) return;
    try {
      await cached.client.close();
    } catch (error) {
      log.debug({ serverId: id, error: errorMessage(error) }, 'Error while closing MCP client');
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((id) => this.disconnect(id)));
  }

  private markStatus(id: string, status: string, error: string | null): void {
    db.prepare('UPDATE mcp_servers SET last_status = ?, last_error = ?, updated_at = ? WHERE id = ?').run(
      status,
      error,
      nowIso(),
      id,
    );
    bus.publish('mcp:status', { id, status, error });
  }

  private async connect(record: McpServerRecord, force = false): Promise<CachedConnection> {
    const existing = this.connections.get(record.id);
    if (!force && existing && existing.configStamp === configStamp(record)) return existing;
    if (existing) await this.disconnect(record.id);

    const pending = this.connecting.get(record.id);
    if (pending) return pending;

    const promise = (async () => {
      const timeoutMs = getSettings().toolTimeoutMs;
      let transport: Transport;
      if (record.transport === 'stdio') {
        const stdio = new StdioClientTransport({
          command: record.command,
          args: record.args,
          cwd: record.cwd ? path.resolve(config.rootDir, record.cwd) : undefined,
          env: { ...getDefaultEnvironment(), ...record.env },
          stderr: 'pipe',
        });
        transport = stdio;
        const client = new Client(
          { name: 'whatsapp-agent', version: '1.0.0' },
          { capabilities: {} },
        );
        try {
          await withTimeout(client.connect(stdio), timeoutMs, `Timed out connecting to ${record.name}.`);
          if (stdio.stderr) {
            stdio.stderr.on('data', (chunk: Buffer) => {
              const message = chunk.toString('utf8').trim();
              if (message) log.debug({ server: record.name }, `stderr: ${truncate(message, 500)}`);
            });
          }
          const toolsResponse = await withTimeout(
            client.listTools(),
            timeoutMs,
            `Timed out listing tools from ${record.name}.`,
          );
          const cache: CachedConnection = {
            client,
            transport,
            tools: (toolsResponse.tools || []) as RawTool[],
            configStamp: configStamp(record),
          };
          this.connections.set(record.id, cache);
          this.failures.delete(record.id);
          this.markStatus(record.id, 'connected', null);
          log.info({ server: record.name, tools: cache.tools.length }, 'MCP server connected');
          return cache;
        } catch (error) {
          try {
            await client.close();
          } catch {
            // ignore
          }
          throw error;
        }
      }

      if (!record.url) throw new Error('Server URL is missing.');
      const url = new URL(record.url);
      if (record.transport === 'sse') {
        transport = new SSEClientTransport(url);
      } else {
        transport = new StreamableHTTPClientTransport(url, {
          requestInit: { headers: record.headers },
        });
      }
      const client = new Client({ name: 'whatsapp-agent', version: '1.0.0' }, { capabilities: {} });
      try {
        await withTimeout(client.connect(transport), timeoutMs, `Timed out connecting to ${record.name}.`);
        const toolsResponse = await withTimeout(
          client.listTools(),
          timeoutMs,
          `Timed out listing tools from ${record.name}.`,
        );
        const cache: CachedConnection = {
          client,
          transport,
          tools: (toolsResponse.tools || []) as RawTool[],
          configStamp: configStamp(record),
        };
        this.connections.set(record.id, cache);
        this.failures.delete(record.id);
        this.markStatus(record.id, 'connected', null);
        log.info({ server: record.name, tools: cache.tools.length }, 'MCP server connected');
        return cache;
      } catch (error) {
        try {
          await client.close();
        } catch {
          // ignore
        }
        throw error;
      }
    })();

    this.connecting.set(record.id, promise);
    try {
      return await promise;
    } catch (error) {
      const message = errorMessage(error);
      this.failures.set(record.id, { until: Date.now() + 60_000, message });
      this.markStatus(record.id, 'error', truncate(message, 2000));
      log.warn({ server: record.name, error: message }, 'MCP server connection failed');
      throw error;
    } finally {
      this.connecting.delete(record.id);
    }
  }

  async testServer(id: string): Promise<{ server: McpServerRecord; tools: RawTool[] }> {
    const record = this.getServer(id);
    if (!record) throw new Error('MCP server not found.');
    const cache = await this.connect(record, true);
    this.markStatus(id, 'connected', null);
    return { server: { ...record, last_status: 'connected', last_error: null }, tools: cache.tools };
  }

  async getAllTools(): Promise<{ tools: OpenAiTool[]; errors: Array<{ server: string; error: string }> }> {
    const servers = this.listServers().filter((server) => server.enabled);
    const errors: Array<{ server: string; error: string }> = [];
    const mappings = new Map<string, ToolMapping>();
    const tools: OpenAiTool[] = [];

    for (const server of servers) {
      const failed = this.failures.get(server.id);
      if (failed && failed.until > Date.now()) {
        errors.push({ server: server.name, error: failed.message });
        continue;
      }
      try {
        const connection = await this.connect(server);
        for (const tool of connection.tools) {
          if (server.disabled_tools.includes(tool.name)) continue;
          const base = `mcp_${slug(server.name)}_${slug(tool.name)}`;
          let name = base.length <= 64 ? base : `${base.slice(0, 57)}_${stableSuffix(server.id, tool.name)}`;
          if (mappings.has(name)) {
            name = `${base.slice(0, 57)}_${stableSuffix(server.id, tool.name)}`;
          }
          const parameters =
            tool.inputSchema && typeof tool.inputSchema === 'object'
              ? (tool.inputSchema as Record<string, unknown>)
              : { type: 'object', properties: {} };
          tools.push({
            type: 'function',
            function: {
              name,
              description: truncate(
                `${tool.description || 'MCP tool'} [server: ${server.name}]`,
                1000,
              ),
              parameters,
            },
          });
          mappings.set(name, {
            serverId: server.id,
            serverName: server.name,
            toolName: tool.name,
            connection,
          });
        }
      } catch (error) {
        errors.push({ server: server.name, error: errorMessage(error) });
      }
    }
    this.toolMap = mappings;
    return { tools, errors };
  }

  getToolMap(): Array<{
    openAiName: string;
    serverName: string;
    toolName: string;
    description?: string;
  }> {
    return [...this.toolMap.entries()].map(([openAiName, mapping]) => ({
      openAiName,
      serverName: mapping.serverName,
      toolName: mapping.toolName,
      description: mapping.connection.tools.find((tool) => tool.name === mapping.toolName)?.description,
    }));
  }

  async callTool(openAiName: string, args: Record<string, unknown>): Promise<string> {
    let mapping = this.toolMap.get(openAiName);
    if (!mapping) {
      await this.getAllTools();
      mapping = this.toolMap.get(openAiName);
    }
    if (!mapping) throw new Error(`Unknown MCP tool: ${openAiName}`);
    const timeoutMs = getSettings().toolTimeoutMs;
    try {
      const result = await withTimeout(
        mapping.connection.client.callTool({ name: mapping.toolName, arguments: args }),
        timeoutMs,
        `Tool ${mapping.toolName} timed out after ${timeoutMs}ms.`,
      );
      return serializeToolResult(result);
    } catch (error) {
      throw error;
    }
  }
}

export const mcp = new McpManager();
