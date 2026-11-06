# Hosting TAARS 24/7 on this PC

Goal: agents answer WhatsApp around the clock; the dashboard is reachable from
anywhere over HTTPS; nothing is paid. Everything runs on this PC through a free
Cloudflare tunnel. The server only listens on `127.0.0.1`, so the tunnel is the
only public door.

This uses a **fresh hosted instance** — its own empty database at
`data-hosted/`, its own port (8788), its own OpenCode runtime (4297). The old
development instance (8787) keeps running independently until you retire it.

## Secrets without files

Nothing sensitive is typed into `.env` anymore:

| Secret | How it is set | Stored as |
| --- | --- | --- |
| Instance encryption key | auto-generated on first boot | `data-hosted/secret.key` (file) |
| Admin password | **created in the browser on first visit** | scrypt hash, encrypted in the DB |
| OpenRouter key | **pasted once in the dashboard** (Settings → OpenRouter key) | encrypted in the DB |
| WhatsApp agent token | pasted in the agent editor | encrypted in the DB |

Changing the password later: Settings → Security → Update password (this also
signs out every other device). The legacy `ADMIN_PASSWORD` value is accepted
once, then automatically sealed into the hash — afterwards it can be deleted
from `.env`.

## Quick path (10 minutes, URL changes on reboot)

```powershell
winget install --id Cloudflare.cloudflared -e     # once
cd C:\Users\Irtiza\Documents\Projects\WhatsApp-Agent
.\deploy\start-host.ps1                          # boots fresh instance + tunnel
```

It prints a `https://…trycloudflare.com` URL → open it → first-run screen asks
for the new admin password → Settings → paste the OpenRouter key → create your
agent (with a WhatsApp token from the platform). The URL is also saved to
`%USERPROFILE%\taars-tunnel-url.txt`.

Survive reboots (once, elevated PowerShell):

```powershell
.\deploy\install-autostart.ps1
```

## Session lifecycle rules

- The hosted instance must be running for agents to reply (the scheduled task
  handles this after reboots).
- One poller per WhatsApp token — create the hosted agents with **fresh
  tokens**, and retire the development instance (port 8787) once you have:
  two OpenCode runtimes on one PC also doubles memory usage.
- Keep the PC plugged in; sleep/hibernate are disabled by the installer.

## Stable domain path (recommended once you have router access)

Keeps `taaars.duckdns.org` with a real Let's Encrypt certificate and no URL
changes:

1. **Reachability test first** (some ISPs block inbound — CGNAT): forward port
   443 on the router to this PC, then from another network test
   `Test-NetConnection taaars.duckdns.org -Port 443`.
2. Caddy with the `caddy-dns/duckdns` module (caddyserver.com/download) and:

   ```
   taaars.duckdns.org {
       tls { dns duckdns {DUCKDNS_TOKEN} }
       reverse_proxy 127.0.0.1:8788
   }
   ```

3. Run it as a service — certificates renew via DNS-01 automatically.

## Zero-PC option (later, as planned)

A PC cannot beat an always-on server for reliability. Next step when wanted:
Oracle Cloud **Always Free ARM** (4 cores/24 GB, free forever) or a cheap VPS:
repo is already on GitHub → `git clone` → `npm ci` → systemd unit → same
Caddyfile. Budget half a day; the deploy assets here assume local Windows
paths and would be adapted to a Linux service.

## Multi-user note

One shared admin password (no per-user accounts yet) — fine for a few trusted
people. Per-user logins with isolated agent ownership are a planned addition.
