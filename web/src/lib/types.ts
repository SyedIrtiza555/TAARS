export type SettingPatch = Partial<{
  botName: string;
  systemPrompt: string;
  model: string;
  temperature: number;
  maxTokens: number;
  maxHistory: number;
  autoReply: boolean;
  autoConnect: boolean;
  groupMode: 'mention' | 'all' | 'off';
  allowedJids: string[];
  blockedJids: string[];
  ragEnabled: boolean;
  ragAutoInject: boolean;
  ragTopK: number;
  ragMinScore: number;
  typingIndicator: boolean;
  readReceipts: boolean;
  maxToolSteps: number;
  toolTimeoutMs: number;
  appendSignature: boolean;
  signature: string;
  fallbackMessage: string;
  maxCharsPerMessage: number;
  timezone: string;
  status: 'available' | 'away';
}>;

export type McpServer = {
  id: string;
  name: string;
  transport: 'stdio' | 'sse' | 'http';
  command: string;
  args: string;
  env: string;
  cwd: string;
  url: string;
  headers: string;
  enabled: boolean;
  disabledTools: string[];
  last_status: string | null;
  last_error: string | null;
  updated_at: string;
  toolCount: number;
  tools: string[];
};

export type Doc = {
  id: string;
  title: string;
  source_type: string;
  source_name: string | null;
  mime_type: string | null;
  status: string;
  error: string | null;
  char_count: number;
  chunk_count: number;
  created_at: string;
  updated_at: string;
};

export type Run = {
  id: string;
  chat_id: string;
  source: string;
  model: string;
  user_text: string;
  response: string;
  tool_calls: string;
  tokens_in: number;
  tokens_out: number;
  latency_ms: number;
  error: string | null;
  created_at: string;
};

export type LogEntry = {
  id: number;
  at: string;
  level: string;
  message: string;
  meta?: Record<string, unknown>;
};

export type WhatsAppSnapshot = {
  state: 'disconnected' | 'connecting' | 'qr' | 'connected' | 'logged_out' | 'error';
  phoneNumber: string | null;
  name: string | null;
  qrDataUrl: string | null;
  qrIssuedAt: string | null;
  lastError: string | null;
  connectedAt: string | null;
  startedAt: string | null;
};

export type AppStatus = {
  server: { version: string; uptime: number; host: string; port: number; appUrl: string };
  whatsapp: WhatsAppSnapshot;
  agent: {
    configured: boolean;
    model: string;
    botName: string;
    autoReply: boolean;
    groupMode: string;
    status: 'available' | 'away';
    mcp: { servers: number; enabled: number; connected: number; tools: number };
    knowledge: {
      documents: number;
      chunks: number;
      embeddedChunks: number;
      embeddingsReady: boolean;
      embeddingsError: string | null;
    };
  };
  hub: { agents: number; running: number; runtimeReady: boolean };
  stats: { chats: number; messages: number; agentRuns: number; tokensIn: number; tokensOut: number };
};

export type ChatSummary = {
  chat_id: string;
  name: string | null;
  is_group: number;
  message_count: number;
  last_message_at: string | null;
  created_at: string;
  last_message?: string | null;
};

export type Message = {
  id: string;
  chat_id: string;
  message_id: string | null;
  role: string;
  content: string;
  sender_name: string | null;
  tool_name: string | null;
  created_at: string;
  meta: Record<string, unknown> | null;
};

export type ToolCall = {
  id: string;
  name: string;
  args: unknown;
  result?: string;
  error?: string;
  source: 'mcp' | 'knowledge';
};

export type Source = {
  chunkId: number;
  documentId: string;
  title: string;
  content: string;
  score: number;
  lexicalScore: number;
  vectorScore: number;
};

export type AgentResult = {
  text: string;
  model: string;
  toolCalls: ToolCall[];
  sources: Source[];
  usage: { input: number; output: number };
  latencyMs: number;
  error?: string;
};

export type SettingsShape = Required<SettingPatch>;

export type SettingsResponse = {
  settings: SettingsShape;
  openrouter: { configured: boolean; source: string; maskedKey: string };
};

export function fmtNumber(value: number | null | undefined): string {
  return new Intl.NumberFormat().format(value ?? 0);
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const date = new Date(iso).getTime();
  if (Number.isNaN(date)) return 'never';
  const seconds = Math.max(0, Math.floor((Date.now() - date) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return fmtDate(iso);
}

export function uptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function mask(value: string | null | undefined): string {
  if (!value) return '—';
  if (value.length <= 8) return '••••••••';
  return `${value.slice(0, 4)}••••••••${value.slice(-4)}`;
}

export function parseKeyValues(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index <= 0) continue;
    result[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return result;
}

export function shortJid(chatId: string): string {
  return chatId.replace(/@s\.whatsapp\.net$/, '').replace(/@g\.us$/, '');
}

export type HubAgentBase = {
  id: string;
  name: string;
  model: string;
  systemPrompt: string;
  enabled: boolean;
  autoStart: boolean;
  typingIndicator: boolean;
  readReceipts: boolean;
  creatorId: string | null;
  nextOffset: string | null;
  status: string;
  lastError: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
  hasToken: boolean;
  mcpServerIds: string[];
  knowledgeIds: string[];
  sessionId: string | null;
  skillCount: number;
  scheduleCount: number;
};

export type HubAgent = HubAgentBase & {
  running: boolean;
  runtimeStartedAt: string | null;
  nextRun: string | null;
};

export type HubSkill = {
  id: string;
  agentId: string;
  name: string;
  description: string;
  body: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type HubSchedule = {
  id: string;
  agentId: string;
  name: string;
  cronExpr: string;
  prompt: string;
  enabled: boolean;
  lastRun: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  nextRun?: string | null;
};

export type HubAgentDetail = HubAgentBase & {
  skills: HubSkill[];
  schedules: HubSchedule[];
};

export type HubRuntime = {
  ready: boolean;
  baseUrl: string | null;
  logTail: string[];
};

export type HubStatus = {
  runtime: HubRuntime;
  agents: HubAgent[];
  schedules: HubSchedule[];
  schedulerError: string | null;
  running: number;
};
