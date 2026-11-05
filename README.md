# WhatsApp Agent

A self-hosted WhatsApp AI agent platform with two ways to run:

- **Classic bot** — link a phone with a QR code (Baileys), chat through OpenRouter, and use MCP tools plus a local RAG knowledge base.
- **Multi-agent hub** — run several independent agents through the official **WhatsApp Agent Platform**, with each agent backed by its own **OpenCode** runtime, model, prompt, tools, knowledge, skills, and schedule.

Everything runs locally: SQLite for state, the dashboard on `127.0.0.1`, and a terminal UI for monitoring the hub.

## What it does

### Classic bot (Baileys)

- **WhatsApp** (via Baileys): Link your phone by scanning a QR code. The bot auto-replies to private chats and (optionally) group mentions. Session persists so you don't rescan every time.
- **AI** (OpenRouter): GPT-4.1 Mini, Gemini 2.5 Flash, Claude Sonnet 4.x, DeepSeek, etc. Configurable model, temperature, max tokens, system prompt.
- **MCP tools**: Connect stdio, Streamable HTTP, or SSE MCP servers. Enable/disable per server, test connections, and expose tools to the agent for tool-use.
- **Knowledge & RAG**: Upload TXT, MD, CSV, JSON, HTML, PDF, or DOCX. Local embeddings (`all-MiniLM-L6-v2`) via `@huggingface/transformers` + BM25 keyword search. Agent can retrieve relevant snippets before answering.
- **Admin dashboard** (React): manage settings, conversations, knowledge, MCP servers, view logs/agent runs, and a playground to test the agent directly.
- **SQLite** persistence for chats, messages, knowledge, MCP servers, agent runs, and encrypted secrets (AES-256-GCM).

### Multi-agent hub (official API + OpenCode)

- **Per-agent WhatsApp tokens** from the official WhatsApp Agent Platform. Inbound messages are polled per token; replies, read receipts, and optional typing indicators go back through the official API.
- **Per-agent OpenCode runtime** (`opencode serve`): each agent gets a generated `opencode.json` entry, its own model and system prompt, and one isolated OpenCode session per WhatsApp conversation.
- **Per-agent MCP access**: bind only the MCP servers an agent should use. Unbound servers are explicitly denied with normalized `<server>_*` rules.
- **Knowledge, skills, and schedules per agent**: attach RAG documents, add Markdown skills, and run cron prompts that send the result to the agent's creator.
- **Conversation isolation**: each sender gets a separate OpenCode session and dashboard conversation. Test prompts and scheduled jobs use their own contexts, so customer chats do not share memory with them.
- **Media handling**: inbound images, audio, video, and documents are downloaded to `data/uploads` and passed to OpenCode as file attachments.
- **Terminal UI**: `npm run tui` for a live status list with start/stop/restart controls.

## Prerequisites

- Node.js >= 22 (tested with v24.18)
- An [OpenRouter](https://openrouter.ai) API key
- For the classic bot: a phone with WhatsApp (to link as a device)
- For the hub: [OpenCode](https://opencode.ai) installed and available as `opencode` on `PATH`, plus a token from the official WhatsApp Agent Platform

## Quick start

```powershell
# 1. Go to the project folder
cd "$env:USERPROFILE\Documents\Projects\WhatsApp-Agent"

# 2. Install dependencies (already done if you received this repo)
npm install --no-audit --no-fund

# 3. Copy and edit the environment file
Copy-Item .env.example .env
# Edit .env and set ADMIN_PASSWORD and your OpenRouter key:
#   ADMIN_PASSWORD=your-long-random-password
#   OPENROUTER_API_KEY=sk-or-v1-...
#   OPENROUTER_MODEL=openai/gpt-4.1-mini

# 4. Build everything
npm run build

# 5. Start the server
npm start
# Server: http://127.0.0.1:8787
```

Then open `http://127.0.0.1:8787` in your browser and sign in with `ADMIN_PASSWORD`.

- For the classic bot, connect WhatsApp by scanning the QR code.
- For the hub, open **Agents** and create your first agent (see below).

## Multi-agent hub setup

### 1. Install OpenCode

Install OpenCode and check that it works from a terminal:

```powershell
opencode --version
```

The app spawns `opencode serve` on `127.0.0.1` with a random Basic-auth password and manages the process for you. If `opencode` is not on `PATH`, point `OPENCODE_BIN` at the executable.

### 2. Create an agent

1. Open **Agents → New agent**.
2. Give it a name, an OpenCode model (for example `openrouter/openai/gpt-4.1-mini`), and a system prompt.
3. Paste the **WhatsApp Agent Platform token** for that agent. Tokens are encrypted with `APP_SECRET` and are never shown again after saving.
4. Save, then press **Start**. One poller runs per token; starting the same token twice returns HTTP 409.

New agents default to the classic bot's current OpenRouter model, prefixed with `openrouter/`, so both modes use the same provider.

### 3. Configure the agent

- **MCP tools** — enable servers on the **MCP Tools** page, then bind them per agent. The hub writes local/remote server definitions into `opencode.json` and adds deny rules for every unbound server.
- **Knowledge** — upload documents on the **Knowledge** page, then attach them to the agent. Relevant snippets are injected into the prompt before it reaches OpenCode.
- **Skills** — add reusable Markdown instructions. They are written to `.opencode/skills/` and included in the agent's prompt.
- **Schedules** — use a cron expression (validated when saved) and a prompt. The reply is sent to the agent's creator (the first person who messaged it).
- **Test** — use the test prompt and test-send controls before connecting real traffic.

OpenCode settings are generated in `opencode.json` at the project root. Existing unmanaged configs are backed up once as `opencode.json.bak-<timestamp>`; `data/opencode-managed.json` tracks the generated file so it is not backed up repeatedly.

### 4. Start and monitor

Start the agent from the dashboard, or run the terminal UI:

```powershell
npm run tui
```

The TUI signs in with `ADMIN_PASSWORD` from `.env` (or prompts for it), refreshes every 5 seconds, and supports:

| Key | Action |
|-----|--------|
| `↑` / `k`, `↓` / `j` | Select agent |
| `s` | Start or stop the selected agent |
| `r` | Restart the selected agent |
| `R` | Refresh now |
| `q` / `Ctrl+C` | Quit |

### Official API limits

The hub rate-limits calls to the official API per agent:

- 12 message sends per minute
- 12 status updates per minute
- 15 polls per minute
- 12 media operations per minute

Polling offsets are stored as 64-bit values. If the API reports that another poller owns the token, only one app instance should poll that token at a time.

## Development

Run the API and the Vite dev server together with one command:

```powershell
npm run dev
# same full stack, kept as a convenience alias:
npm run dev:web
```

- Dashboard with hot reload: `http://127.0.0.1:5173`
- API (also serves the compiled dashboard): `http://127.0.0.1:8787`
- Vite proxies `/api` to the backend, so cookies and SSE work in dev.

The backend watches `src/` and restarts when server files change. To test the production bundle locally, run `npm run build` and then `npm start`, and open `http://127.0.0.1:8787`.

If you only want the Vite process (for example while the API is running in another terminal), use `npm run dev:client`. Starting that alone will fail with `ECONNREFUSED 127.0.0.1:8787` until the API is up.

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run dev` | Start the API and Vite dev server together |
| `npm run dev:web` | Alias for `npm run dev` (full stack) |
| `npm run dev:server` | Start only the API with TypeScript + watch mode |
| `npm run dev:client` | Start only Vite (requires the API on port 8787) |
| `npm run build` | Build server + web dashboard |
| `npm run build:server` | Compile server to `dist/` |
| `npm run build:web` | Build React dashboard to `public/admin/` |
| `npm start` | Run compiled server (`dist/index.js`) |
| `npm run tui` | Open the terminal hub monitor |
| `npm run typecheck` | Type-check server and web |

## Environment variables (`.env`)

```env
PORT=8787
HOST=127.0.0.1
DATA_DIR=./data
ADMIN_PASSWORD=change-me   # required to protect the dashboard
APP_SECRET=change-me-to-a-long-random-secret   # encrypts stored OpenRouter key and WhatsApp tokens
OPENROUTER_API_KEY=sk-or-v1-...   # optional; can also be set in the dashboard
OPENROUTER_MODEL=openai/gpt-4.1-mini
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
LOG_LEVEL=info

# Multi-agent hub (optional)
# APP_URL=http://127.0.0.1:8787     # used by the TUI
# OPENCODE_BIN=opencode            # full path if opencode is not on PATH
# OPENCODE_PORT=4096               # base port for the managed OpenCode server
# WHATSAPP_AGENT_API_BASE=https://api.whatsapp.com/agent/v1
```

- `APP_SECRET` must be at least ~24 random chars to enable encrypted secret storage.
- The dashboard is only reachable from the bound `HOST` (default `127.0.0.1`). Put it behind a reverse proxy if you need remote access.
- The managed OpenCode server binds to `127.0.0.1` and uses a random password. Do not expose its port.

## Architecture

```
src/
  index.ts             Express server + admin static SPA + graceful shutdown
  config.ts            env config + directory setup
  db.ts                SQLite schema (WAL mode), including hub tables
  settings.ts          agent settings (Zod-validated)
  secrets.ts           AES-256-GCM encrypted secret store
  logger.ts            in-memory structured logger (SSE streamed to dashboard)
  events.ts            app event bus
  util.ts              helpers (jid normalization, text splitting, etc.)
  store.ts             chats/messages/agent-runs persistence
  rag.ts               knowledge documents, chunking, embeddings, hybrid search
  extract.ts           file text extraction (PDF/DOCX/TXT/MD/HTML/CSV/JSON)
  mcp.ts               MCP client manager (stdio/SSE/Streamable HTTP) + tool mapping
  openrouter.ts        OpenRouter client, key test, model list
  agent.ts             classic reasoning loop: RAG → OpenRouter → MCP tools → reply
  whatsapp.ts          Baileys socket, QR, connect/reconnect/logout, message handling
  hub-store.ts         hub agents, tokens, MCP bindings, knowledge, skills, schedules
  wa-platform.ts       official WhatsApp Agent Platform client + rate limits
  opencode-runtime.ts  spawns opencode serve, generates config/skills, runs prompts
  hub.ts               hub pollers, dedupe, media, RAG injection, schedules
  tui.ts               terminal monitor/control client
  routes.ts            REST API + SSE events
  status.ts            aggregated status for dashboard
```

## Security notes

- This is a self-hosted tool running on your machine. WhatsApp automation via unofficial libraries carries a risk of account restrictions; use a secondary number and don't spam. Hub agents use the official API instead.
- The admin dashboard is cookie-session protected with `ADMIN_PASSWORD`. Bind to `127.0.0.1` unless you add a reverse proxy with TLS.
- OpenRouter keys and official WhatsApp tokens are stored encrypted with `APP_SECRET` (AES-256-GCM).
- The generated `opencode.json` contains agent prompts and MCP server settings, but not WhatsApp tokens. Treat it as sensitive if prompts contain private data.
- Hub conversations are isolated per sender in separate OpenCode sessions and dashboard chats. Use **Reset session** to clear an agent's stored model context; deleting a chat removes its stored messages, but downloaded media remains in `data/uploads` until removed manually.
- Inbound media is written to `data/uploads`; clean that directory periodically if you handle sensitive attachments.
- File uploads are capped at 25 MB and restricted to text/document types.

## Data directory

`./data` (or `DATA_DIR`) contains:

- `agent.sqlite` — SQLite database
- `wa-auth/` — classic WhatsApp session credentials
- `models/` — Hugging Face embedding model cache
- `uploads/` — inbound hub media attachments
- `opencode-managed.json` — hash of the generated OpenCode config

## Troubleshooting

- **"ADMIN_PASSWORD is not configured"**: set `ADMIN_PASSWORD` in `.env`.
- **QR not appearing**: click **Connect WhatsApp** in the dashboard; scan with WhatsApp → Linked devices → Link a device.
- **Embeddings unavailable**: first run downloads ~25 MB; check `LOG_LEVEL=debug` and network access to Hugging Face.
- **MCP server won't connect**: verify the command/URL and that `npx`/`node` is on the PATH; use the **Test** button to see the error.
- **Hub agent won't start**: confirm the token is saved, `opencode --version` works, and `OPENCODE_PORT` is free. Check the runtime log tail on the Agents page.
- **OpenCode replies with a quota error**: the selected OpenRouter model needs more credits. Pick a cheaper or `:free` model, or top up the account.
- **HTTP 409 while starting an agent**: another process is polling the same WhatsApp token. Stop the other app or use a different token.
- **MCP tools missing in the hub**: enable the server, bind it to the agent, and save. Tool names are normalized as `<server>_<tool>`; unbound servers are denied.
- **Stale generated config**: saving or deleting an agent, or changing MCP servers, regenerates `opencode.json`; restarting the app also rebuilds it on the next agent start.

## License

MIT — for personal/self-hosted use. WhatsApp is a trademark of WhatsApp LLC; this project is not affiliated with WhatsApp or Meta.
