import 'dotenv/config';
import readline from 'node:readline';
import { stdin, stdout } from 'node:process';
import { config } from './config.js';

type HubAgent = {
  id: string;
  name: string;
  model: string;
  status: string;
  running: boolean;
  hasToken: boolean;
  enabled: boolean;
  autoStart: boolean;
  lastSeenAt: string | null;
  lastError: string | null;
  creatorId: string | null;
  mcpServerIds: string[];
  scheduleCount: number;
};

type HubStatus = {
  runtime: { ready: boolean; baseUrl: string | null };
  agents: HubAgent[];
  running: number;
  schedulerError: string | null;
};

type AppStatus = {
  memory: { total: number };
  agent: { botName: string; model: string };
  server: { uptime: number };
};

class ApiClient {
  private cookie = '';

  constructor(private readonly baseUrl: string) {}

  async login(password: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || 'Login failed');
    }
    const cookies =
      typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [response.headers.get('set-cookie') || ''].filter(Boolean);
    this.cookie = cookies.map((value) => value.split(';')[0]).join('; ');
    if (!this.cookie) throw new Error('Login succeeded but no session cookie was returned.');
  }

  private async request<T>(path: string, method = 'GET'): Promise<T> {
    const response = await fetch(`${this.baseUrl}/api${path}`, {
      method,
      headers: {
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
      },
    });
    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (!response.ok) {
      const message =
        body && typeof body === 'object' && 'error' in body
          ? String((body as { error: unknown }).error)
          : text || `HTTP ${response.status}`;
      throw new Error(message);
    }
    return body as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>(path);
  }

  post<T>(path: string): Promise<T> {
    return this.request<T>(path, 'POST');
  }
}

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const CLEAR = '\x1b[2J\x1b[H';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

function colorFor(status: string, running: boolean): string {
  if (!running && status !== 'error') return DIM;
  if (status === 'running') return GREEN;
  if (status === 'error') return RED;
  if (status === 'starting') return YELLOW;
  return DIM;
}

function truncate(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 1) return value.slice(0, width);
  return `${value.slice(0, width - 1)}…`;
}

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function line(text = ''): string {
  return `${text}${RESET}\n`;
}

async function promptHidden(question: string): Promise<string> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question(question, resolve);
  });
  rl.close();
  return answer.trim();
}

async function main(): Promise<void> {
  const api = new ApiClient(config.appUrl);
  const password = config.adminPassword || (await promptHidden('Admin password: '));
  await api.login(password);

  let status: HubStatus = await api.get<HubStatus>('/hub/status');
  let app: AppStatus = await api.get<AppStatus>('/status');
  let selected = 0;
  let message = '';
  let busy = false;

  const refresh = async (): Promise<void> => {
    try {
      [status, app] = await Promise.all([
        api.get<HubStatus>('/hub/status'),
        api.get<AppStatus>('/status'),
      ]);
      if (selected >= status.agents.length) selected = Math.max(0, status.agents.length - 1);
      message = '';
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
  };

  const render = (): void => {
    const width = Math.max(70, Math.min(120, stdout.columns || 100));
    const agent = status.agents[selected];
    const out: string[] = [];
    out.push(line(`${BOLD}${CYAN}WhatsApp Agent Hub${RESET} ${DIM}· ${config.appUrl}${RESET}`));
    out.push(
      line(
        `${DIM}memories:${RESET} ${app.memory.total}` +
          `   ${DIM}OpenCode:${RESET} ${status.runtime.ready ? `${GREEN}ready${RESET}` : `${YELLOW}idle${RESET}`}` +
          `   ${DIM}polling:${RESET} ${status.running}/${status.agents.length}`,
      ),
    );
    out.push(line(`${DIM}${'─'.repeat(width)}${RESET}`));

    if (!status.agents.length) {
      out.push(line(''));
      out.push(line(`${YELLOW}No hub agents yet.${RESET} Create one in the dashboard: ${config.appUrl}/#agents`));
      out.push(line(''));
    } else {
      out.push(
        line(
          `${DIM}  ${'Agent'.padEnd(24)} ${'Status'.padEnd(10)} ${'Model'.padEnd(34)} ${'Last seen'.padEnd(10)} MCP  Schedules${RESET}`,
        ),
      );
      status.agents.forEach((item, index) => {
        const marker = index === selected ? `${CYAN}▸${RESET}` : ' ';
        const color = colorFor(item.status, item.running);
        const token = item.hasToken ? '' : ` ${YELLOW}[token]${RESET}`;
        out.push(
          line(
            `${marker} ${truncate(item.name, 24).padEnd(24)} ${color}${truncate(item.status, 10).padEnd(10)}${RESET} ` +
              `${truncate(item.model, 34).padEnd(34)} ${ago(item.lastSeenAt).padEnd(10)} ` +
              `${String(item.mcpServerIds.length).padEnd(4)} ${item.scheduleCount}${token}`,
          ),
        );
      });
      out.push(line(''));
      if (agent) {
        out.push(line(`${BOLD}${agent.name}${RESET}`));
        out.push(line(`${DIM}id:${RESET} ${agent.id}`));
        out.push(line(`${DIM}model:${RESET} ${agent.model}`));
        out.push(
          line(
            `${DIM}creator:${RESET} ${agent.creatorId || 'waiting for the first message'}   ` +
              `${DIM}auto-start:${RESET} ${agent.autoStart ? 'yes' : 'no'}   ` +
              `${DIM}enabled:${RESET} ${agent.enabled ? 'yes' : 'no'}`,
          ),
        );
        if (agent.lastError) out.push(line(`${RED}error: ${agent.lastError}${RESET}`));
      }
    }

    if (status.schedulerError) out.push(line(`${YELLOW}scheduler: ${status.schedulerError}${RESET}`));
    if (message) out.push(line(`${RED}${message}${RESET}`));
    out.push(line(`${DIM}${'─'.repeat(width)}${RESET}`));
    out.push(
      line(
        `${DIM}↑/↓ select  ·  s ${agent?.running ? 'stop' : 'start'}  ·  r restart  ·  R refresh  ·  q quit${RESET}` +
          (busy ? `  ${YELLOW}working…${RESET}` : ''),
      ),
    );

    stdout.write(`${CLEAR}${out.join('')}`);
  };

  const runAction = async (path: string): Promise<void> => {
    const agent = status.agents[selected];
    if (!agent || busy) return;
    busy = true;
    message = path.includes('/start') && !agent.hasToken ? 'Add a token in the dashboard first.' : '';
    render();
    try {
      if (!message) {
        await api.post(`/hub/agents/${agent.id}/${path}`);
        await refresh();
        message = path === 'stop' ? 'Agent stopped.' : 'Agent started.';
      }
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
      render();
    }
  };

  readline.emitKeypressEvents(stdin);
  const wasRaw = stdin.isRaw;
  if (stdin.isTTY) stdin.setRawMode(true);
  stdout.write(HIDE_CURSOR);
  render();

  const timer = setInterval(() => {
    void refresh().then(render);
  }, 5000);

  const cleanup = (): void => {
    clearInterval(timer);
    if (stdin.isTTY) stdin.setRawMode(Boolean(wasRaw));
    stdout.write(SHOW_CURSOR);
  };

  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });

  await new Promise<void>((resolve) => {
    const onKey = (_input: string, key: readline.Key) => {
      if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
        cleanup();
        resolve();
        return;
      }
      if (key.name === 'up' || key.name === 'k') {
        selected = Math.max(0, selected - 1);
        render();
        return;
      }
      if (key.name === 'down' || key.name === 'j') {
        selected = Math.min(status.agents.length - 1, selected + 1);
        render();
        return;
      }
      if (key.name === 's') {
        const agent = status.agents[selected];
        if (agent) void runAction(agent.running ? 'stop' : 'start');
        return;
      }
      if (key.name === 'r') {
        void runAction('restart');
        return;
      }
      if (key.name === 'R') {
        void refresh().then(render);
      }
    };
    stdin.on('keypress', onKey);
  });

  cleanup();
  stdin.off('keypress', () => undefined);
}

main().catch((error) => {
  stdout.write(`${SHOW_CURSOR}${RED}${error instanceof Error ? error.message : String(error)}${RESET}\n`);
  process.exit(1);
});
