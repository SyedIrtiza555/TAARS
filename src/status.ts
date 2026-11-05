import { config } from './config.js';
import { listAgents } from './hub-store.js';
import { mcp } from './mcp.js';
import { memory } from './memory.js';
import { getModel, getOpenRouterApiKey } from './openrouter.js';
import { opencode } from './opencode-runtime.js';
import { rag } from './rag.js';
import { getSettings } from './settings.js';
import { getStats } from './store.js';

export function getAppStatus() {
  const settings = getSettings();
  const servers = mcp.listServers();
  const knowledge = rag.getStats();
  const embeddings = rag.getEmbeddingStatus();
  const agents = listAgents();
  return {
    server: {
      version: '2.0.0',
      uptime: Math.floor(process.uptime()),
      host: config.host,
      port: config.port,
      appUrl: config.appUrl,
    },
    manager: {
      configured: Boolean(getOpenRouterApiKey()),
      provider: settings.provider,
      defaultModel: getModel(),
      hubAutoStart: config.hubAutoStart,
    },
    mcp: {
      servers: servers.length,
      enabled: servers.filter((server) => server.enabled).length,
      connected: servers.filter((server) => server.last_status === 'connected').length,
      tools: servers.reduce((sum, server) => sum + mcp.getCachedTools(server.id).length, 0),
    },
    knowledge: {
      ...knowledge,
      embeddingsReady: embeddings.ready,
      embeddingsError: embeddings.error,
    },
    hub: {
      agents: agents.length,
      running: agents.filter((agent) => agent.status === 'running').length,
      withToken: agents.filter((agent) => agent.hasToken).length,
      runtimeReady: opencode.isReady(),
    },
    memory: { total: memory.totalCount() },
    stats: getStats(),
  };
}

export type AppStatus = ReturnType<typeof getAppStatus>;
