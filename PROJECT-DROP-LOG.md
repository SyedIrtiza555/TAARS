# PROJECT DROP LOG — TAARS / WhatsApp-Agent

_Dropped on: November 7, 2026. Final commit: `1ea0c1c` on branch `feature/multi-agent-manager`._
_GitHub: `SyedIrtiza555/TAARS` (private). Tag: `drop/2026-11-07` marks the exact landed state._
_Nothing was deleted. This file is the full record of what this session was about, what worked, why it was stopped, and how to bring it back._

---

## 1. What this was all about

TAARS started as a single-agent WhatsApp bot with a dashboard. The effort that ended here was a full rework:

1. **Multi-agent "AI workforce" platform** — backend rebuild (agents hub, per-agent isolated workspaces, memory, MCP tool servers, read-only chats view) plus a frontend rebuild (Team / Agents / Chats / Knowledge / MCP / Settings / Logs navigation; Playgrounds and unused pages removed).
2. **Memory recall fix** — manual memories with importance >= 4 are always injected into agent context.
3. **TAARS agent revival** — moved off a dead model id to a live OpenRouter model, verified answering 9/9 through a dashboard-only test chat (`hub-test:*`, which never touches WhatsApp).
4. **Secrets moved out of files into the UI** (user requirement: "Let the UI handle all of this"):
   - First-run admin password creation in the browser (scrypt hash, encrypted at rest; sessions version-bumped so password changes sign out all devices).
   - Change-password in Settings → Security.
   - `APP_SECRET` auto-generated per instance into `<dataDir>/secret.key`.
   - Legacy `ADMIN_PASSWORD` env value accepted once, then auto-sealed into the hash on first login (so the plaintext line can be removed from `.env`).
   - OpenRouter key was already UI-managed (encrypted in DB).
5. **Deploy for real use** — user decisions on record: PC hosting for now (Cloudflare quick tunnel), zero-PC option later (Oracle Free ARM section in the runbook); a **fresh hosted instance** (separate DB/ports/workspaces at `data-hosted/`, port 8788, OpenCode 4297) rather than reusing dev data; merge to `master` only after user approval (never given — session ended before).

## 2. Commit trail (what got built)

| Commit | What |
| --- | --- |
| `29d049c` (master) | Backend multi-agent rework |
| `88f14cd` | Frontend rebuild (new nav, Team page, rebuilt Dashboard/Settings/Agents, dead pages deleted) |
| `71dba09` | Memory recall fix + legacy root `opencode.json` cleanup |
| `6afea75` | Secrets-in-UI: first-run password setup, change-password, APP_SECRET auto-generation, ENV_FILE support |
| `fdaac4f` | Hosted-instance deploy assets: `deploy/start-host.ps1`, `install-autostart.ps1`, `tunnel-run.cmd`, `hosted.env.example`, `HOSTING.md` |
| `5ea6a6c` | Bugfix: scrypt hash was compared against wrong-encoded bytes (base64 vs utf8) |
| `1ea0c1c` | Deploy fixes: read cloudflared's stderr for the tunnel URL; all deploy scripts kept pure ASCII |

## 3. What verified clean (so nobody rebuilds what already worked)

- **Auth/setup suite 10/10** on a throwaway fresh instance (ports 8891/4298): `setupRequired` flag, short-password rejection, setup-creates-password+session, re-setup lockout, wrong-current rejection, change-password, old-session invalidation via version bump, re-login.
- **TAARS live verify 9/9**: status shape, agent on team with a valid model, starts, replies, dashboard-only chat id, memory endpoint, agent detail fields.
- **Tunnel smoke test passed**: public URL served `/api/auth/me` → `{"authenticated":false,"setupRequired":true}` exactly as the first-run screen expects.
- Engine-level state at drop: auth, secrets, agents, memory all verified working; the failure experienced in real use was **UI polish** and **tunnel reliability**, not the data/secrets layer.

## 4. Why it was dropped (user verdict, November 7, 2026)

Final human testing failed in two places:

- **Dashboard UI broken/ugly** in real use.
- **Public URL broke** during the session.

User decision: *"the app is cooked... lets just drop this project."*

Rollback preference given: forgo rollback options; **drop the project** rather than attempt fixes or history rewrites.

## 5. What the shutdown actually did

Stopped (all confirmed gone — no listeners on any project port afterwards):

- Hosted instance server (port 8788) and its node process
- `cloudflared` quick tunnel
- OpenCode runtime (port 4096) and any OpenCode child processes
- Dev instance processes if any were lingering
- Scheduled tasks: none were ever registered (`TAARS-*` checked — clean), so **nothing boots this app on reboot**
- Power settings were never changed (the autostart installer was never run)

Explicitly **not** deleted:

- Repository, all branches, commits, and the `drop/2026-11-07` tag
- Local data: `data/` (dev DB + encrypted secrets) and `data-hosted/` (fresh instance) left intact
- Build outputs (`dist/`, `web/dist/`) and `deploy/` assets — all inside the repo

## 6. If this project is ever resumed

```powershell
git clone https://github.com/SyedIrtiza555/TAARS
cd TAARS
git checkout feature/multi-agent-manager
npm ci && npm run build:web && npm run build:server
npm run dev           # dev instance on 8787
```

Honest order of work for a resume, based on exactly where it broke:

1. **Fix/polish the web UI first** (`web/src/` — the new Team/Agents pages need real usability work; that is what failed the test). Consider a UI review pass before any further backend work.
2. **Stable tunnel** — the free `trycloudflare.com` URL rotates and hiccuped (QUIC reconnects observed in logs). `deploy/HOSTING.md` documents the stable paths: DuckDNS + Caddy (DNS-01, needs router reachability test) or a ~$10/yr custom-domain named tunnel.
3. Only then: merge `feature/multi-agent-manager` → `master` (the pending approval gate from the plan).

Data note: `data-hosted/secret.key` (and dev `data/secret.key`) are the decryption roots for every stored secret — if resuming, keep them; if wiping, the encrypted secrets become permanently unreadable (fresh instance = fresh passwords anyway).

Verification scripts used by the sessions live in `%TEMP%\opencode\wa-scripts\` (`verify-live.mjs`, `verify-setup.mjs`, `inspect-*.mjs`) — regenerate if Windows temp cleanup erased them.

## 7. Machine-specific gotchas (learned the hard way — applies to any future session)

- **Windows PowerShell 5.1 parses UTF-8 (no-BOM) files as ANSI**: any non-ASCII character (em-dash etc.) in a `.ps1` string becomes garbage and breaks parsing. Keep `deploy/*.ps1` and `*.cmd` pure ASCII (enforced as of `1ea0c1c`).
- Inline `node -e "..."` with single quotes gets mangled by PowerShell quoting — write `.mjs` script files instead.
- `git push` writes progress to stderr, which sets `$LASTEXITCODE = 1` in PowerShell — not an error.
- `Get-NetTCPConnection` intermittently misses live listeners — cross-check with `netstat -ano | findstr :PORT`.
- OpenCode child processes orphan and hold ports (4096/4296/4297/4298) after parent terminations; the machine previously hit ~1 GB free RAM and `tsc` builds failed — free memory before heavy builds.
- Start-Process'd servers keeps running after a shell timeout kill was attempted; verify via netstat and kill by PID.

## 8. Paste-ready prompt (to resume or to brief someone new)

```text
You are working on TAARS (WhatsApp-Agent) at C:\Users\Irtiza\Documents\Projects\WhatsApp-Agent
(GitHub: SyedIrtiza555/TAARS, private). The project was DROPPED on 2026-11-07 — read
PROJECT-DROP-LOG.md first: it has the full session record, commit trail, and shutdown state.

Context: the engine (multi-agent backend, encrypted secrets managed from the UI with
first-run password setup, memory recall, WhatsApp polling, dashboard-only test chats) is
built and verified. It was dropped after final testing because the rebuilt dashboard UI
felt broken/ugly and the free Cloudflare quick-tunnel URL dropped.

If the user wants to resume: start on branch feature/multi-agent-manager, fix/polish the
web UI in web/src (that is the blocker), then set up a stable tunnel (deploy/HOSTING.md
has the DuckDNS+Caddy and named-tunnel paths), then merge to master. Do not re-build the
secrets system — it works and is verified. Keep deploy scripts pure ASCII (PS 5.1 bug),
and remember the machine gotchas in section 7.
```

---

*(File name intentionally `PROJECT-DROP-LOG.md`; if resuming, rename to `PROJECT-LOG.md` or delete it.)*
