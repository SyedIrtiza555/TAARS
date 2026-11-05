import { config } from './config.js';
import { listAgents } from './hub-store.js';
import { mcp } from './mcp.js';
import { getOpenRouterApiKey, getModel } from './openrouter.js';
import { opencode } from './opencode-runtime.js';
import { rag } from './rag.js';
import { getSettings } from './settings.js';
import { getStats } from './store.js';
import { whatsapp } from './whatsapp.js';

export type AppStatus = {
  server: {
    version: string;
    uptime: number;
    host: string;
    port: number;
    appUrl: string;
  };
  whatsapp: ReturnType<typeof whatsapp.getSnapshot>;
  agent: {
    configured: boolean;
    model: string;
    botName: string;
    autoReply: boolean;
    groupMode: string;
    status: 'available' | 'away';
    mcp: {
      servers: number;
      enabled: number;
      connected: number;
      tools: number;
    };
    knowledge: {
      documents: number;
      chunks: number;
      embeddedChunks: number;
      embeddingsReady: boolean;
      embeddingsError: string | null;
    };
  };
  hub: {
    agents: number;
    running: number;
    runtimeReady: boolean;
  };
  stats: ReturnType<typeof getStats>;
};

export function getAppStatus(): AppStatus {
  const settings = getSettings();
  const servers = mcp.listServers();
  const knowledge = rag.getStats();
  const embeddings = rag.getEmbeddingStatus();
  const connected = servers.filter((server) => server.last_status === 'connected').length;
  const tools = servers.reduce((sum, server) => sum + mcp.getCachedTools(server.id).length, 0);
  const hubAgents = listAgents();
  return {
    server: {
      version: '1.0.0',
      uptime: Math.floor(process.uptime()),
      host: config.host,
      port: config.port,
      appUrl: config.appUrl,
    },
    whatsapp: whatsapp.getSnapshot(),
    agent: {
      configured: Boolean(getOpenRouterApiKey()),
      model: getModel(),
      botName: settings.botName,
      autoReply: settings.autoReply,
      groupMode: settings.groupMode,
      status: settings.status,
      mcp: {
        servers: servers.length,
        enabled: servers.filter((server) => server.enabled).length,
        connected,
        tools,
      },
      knowledge: {
        ...knowledge,
        embeddingsReady: embeddings.ready,
        embeddingsError: embeddings.error,
      },
    },
    hub: {
      agents: hubAgents.length,
      running: hubAgents.filter((agent) => agent.status === 'running').length,
      runtimeReady: opencode.isReady(),
    },
    stats: getStats(),
  };
}
