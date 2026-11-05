import express, { Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import fs from 'node:fs';
import { createRouter } from './routes.js';
import { config } from './config.js';
import { hub } from './hub.js';
import { logger } from './logger.js';
import { mcp } from './mcp.js';
import { rag } from './rag.js';
import { getSettings } from './settings.js';
import { whatsapp } from './whatsapp.js';

const app = express();

app.set('trust proxy', true);
app.use(cookieParser());
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.get('/api/_ping', (_req: Request, res: Response) => {
  res.type('application/json').send(JSON.stringify({ ok: true }));
});

app.use('/api', createRouter());

const adminDir = config.publicDir;
const indexHtml = `${adminDir}/index.html`;

function serveAdmin(req: Request, res: Response): void {
  if (!fsExists(indexHtml)) {
    res.status(404).type('application/json').send(JSON.stringify({ error: 'Admin UI not built. Run npm run build:web.' }));
    return;
  }
  res.sendFile(indexHtml);
}

function fsExists(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

app.use(express.static(adminDir));

// SPA fallback: serve index.html for any non-API route so client-side routing works.
app.use((req: Request, res: Response) => {
  if (req.url.startsWith('/api')) {
    res.status(404).type('application/json').send(JSON.stringify({ error: 'Unknown API endpoint' }));
    return;
  }
  serveAdmin(req, res);
});

const server = app.listen(config.port, config.host, async () => {
  logger.info({ host: config.host, port: config.port }, 'WhatsApp Agent API server started');
  logger.info(`Open the admin dashboard at ${config.appUrl}`);

  const warnings = validateConfig();
  for (const warning of warnings) logger.warn(warning);

  // Restore WhatsApp session automatically when enabled.
  if (getSettings().autoConnect) {
    void whatsapp.start().catch((error) =>
      logger.error({ error: error instanceof Error ? error.message : String(error) }, 'Auto-connect to WhatsApp failed'),
    );
  }

  // Warm local embeddings in the background so knowledge search is faster.
  void rag.warmEmbeddings?.();

  // Start the local hub (official WhatsApp Agent Platform + OpenCode).
  // Agents with auto-start enabled and a stored token begin polling here.
  void hub.start().catch((error) =>
    logger.error({ error: error instanceof Error ? error.message : String(error) }, 'Local hub failed to start'),
  );

  // Try reconnecting known MCP servers lazily; dashboard /mcp/test can be used explicitly.
  void mcp.getAllTools().catch((error) =>
    logger.debug({ error: error instanceof Error ? error.message : String(error) }, 'MCP tool preload skipped'),
  );
});

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    logger.error(
      `Port ${config.port} is already in use. Stop the other process (or change PORT in .env) and try again.`,
    );
    process.exit(1);
  }
  logger.error({ error: error.message }, 'HTTP server failed');
  process.exit(1);
});

function validateConfig(): string[] {
  const warnings: string[] = [];
  if (!config.adminPassword) warnings.push('ADMIN_PASSWORD is not set - the dashboard is not protected.');
  if (!config.appSecret || config.appSecret.length < 24) {
    warnings.push('APP_SECRET is missing or too short; encrypted secrets are disabled.');
  }
  return warnings;
}

const signals: Array<NodeJS.Signals | string> = ['SIGINT', 'SIGTERM'];
for (const signal of signals) {
  process.on(signal as any, async () => {
    logger.info({ signal }, 'Shutting down');
    try {
      await hub.stop();
      await whatsapp.stop();
      await mcp.closeAll();
    } catch {
      // ignore
    } finally {
      server.close(() => process.exit(0));
    }
  });
}
