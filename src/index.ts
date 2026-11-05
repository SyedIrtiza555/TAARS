import express, { Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import fs from 'node:fs';
import { createRouter } from './routes.js';
import { config, validateConfig } from './config.js';
import { hub } from './hub.js';
import { logger } from './logger.js';
import { mcp } from './mcp.js';
import { rag } from './rag.js';

/**
 * The manager is a control plane only: it never links a personal WhatsApp account and never
 * replies to anyone itself. Each agent talks on WhatsApp through its own official token.
 */
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
  if (!fsExists(indexHtml)) {
    res.status(404).type('application/json').send(JSON.stringify({ error: 'Admin UI not built. Run npm run build:web.' }));
    return;
  }
  res.sendFile(indexHtml);
});

const server = app.listen(config.port, config.host, () => {
  logger.info({ host: config.host, port: config.port }, 'Agent manager API server started');
  logger.info(`Open the admin dashboard at ${config.appUrl}`);
  for (const warning of validateConfig()) logger.warn(warning);

  // Warm local embeddings in the background so knowledge and memory search are faster.
  void rag.warmEmbeddings?.();

  // Start the agent hub: each agent with auto-start and its own token begins polling here.
  void hub.start().catch((error) =>
    logger.error({ error: error instanceof Error ? error.message : String(error) }, 'Agent hub failed to start'),
  );

  void mcp.getAllTools().catch((error) =>
    logger.debug({ error: error instanceof Error ? error.message : String(error) }, 'MCP tool preload skipped'),
  );
});

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    logger.error(`Port ${config.port} is already in use. Stop the other process (or change PORT in .env) and try again.`);
    process.exit(1);
  }
  logger.error({ error: error.message }, 'HTTP server failed');
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    logger.info({ signal }, 'Shutting down');
    try {
      await hub.stop();
      await mcp.closeAll();
    } catch {
      // ignore
    } finally {
      server.close(() => process.exit(0));
    }
  });
}
