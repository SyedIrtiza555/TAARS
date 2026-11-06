# Hosting TAARS 24/7 on this PC

Goal: agents answer WhatsApp around the clock; the dashboard is reachable from
anywhere over HTTPS; nothing is paid. Everything runs on this PC, exposed
through a free Cloudflare tunnel. The server only listens on `127.0.0.1`, so it
is invisible on the LAN — the tunnel is the only door.

## Session lifecycle rules

- The manager server must be running whenever agents should reply.
- One poller per WhatsApp token — never run the same agent token here and
  somewhere else at the same time.
- The PC must not sleep. `deploy/install-autostart.ps1` disables sleep/hibernate
  on AC power; keep the laptop plugged in.

## Quick path (10 minutes, URL changes on reboot)

```powershell
winget install --id Cloudflare.cloudflared -e     # once
cd C:\Users\Irtiza\Documents\Projects\WhatsApp-Agent
.\deploy\start-host.ps1                          # server + tunnel, prints URL
```

It prints a `https://…trycloudflare.com` URL — open it and log in with
`ADMIN_PASSWORD` from `.env`. The URL is also saved to
`%USERPROFILE%\taars-tunnel-url.txt`. Share that URL with other people;
they log in with the same admin password (single-admin design for now).

Survive reboots (optional, once):

```powershell
.\deploy\install-autostart.ps1   # from an elevated PowerShell
```

## Stable domain path (recommended once you have router access)

Keeps the DuckDNS name you made (`taaars.duckdns.org`) with a real
Let's Encrypt certificate, no Cloudflare, no URL changes:

1. **Test reachability first** — some ISPs use CGNAT and inbound ports never
   work. On the router, forward port `443` (TCP) to this PC's LAN IP, then from
   another network (phone hotspot) test: `Test-NetConnection taaars.duckdns.org -Port 443`
   after starting a temporary listener on the PC. If it never connects → CGNAT →
   use quick tunnel above or the custom-domain tunnel below.
2. Download a Caddy build with the DuckDNS DNS plugin: caddyserver.com/download
   → add module `github.com/caddy-dns/duckdns`.
3. `Caddyfile`:

   ```
   taaars.duckdns.org {
       tls {
           dns duckdns {DUCKDNS_TOKEN}
       }
       reverse_proxy 127.0.0.1:8787
   }
   ```

4. Run `caddy run` as a Windows service (sc create / WinSW) — certificates renew
   automatically via DNS-01, so inbound on 443 is all that's needed.

## Custom-domain tunnel (~$10/yr, zero open ports, most robust)

Buy any cheap domain → move its DNS to Cloudflare (free plan) → then:

```powershell
cloudflared tunnel login
cloudflared tunnel create taars              # get <UUID>
cloudflared tunnel route dns taars agents.yourdomain.com
cloudflared tunnel run --url http://127.0.0.1:8787 taars
```

Stable HTTPS URL, works behind CGNAT, reboots don't change anything. Run
`cloudflared tunnel run` from a scheduled task to make it permanent.

## Security checklist (do once)

- [ ] Change `ADMIN_PASSWORD` in `.env` (the old `1424` leaked into a WhatsApp
      reply) → restart the server.
- [ ] Rotate the OpenRouter key at openrouter.ai/keys and save it in
      Dashboard → Settings → OpenRouter key (or `.env` → restart).
- [ ] `APP_SECRET` must stay unchanged — WhatsApp tokens are encrypted with it.
- [ ] Skip `ADMIN_PASSWORD` in any cloud-deploy step; keep it only in `.env`.

## Multi-user note

The dashboard has one shared admin password — fine for a small team you trust.
Per-user accounts (each with their own agents) is a planned future addition;
until then share the password or keep the dashboard to yourself and let others
talk to the agents on WhatsApp directly.
