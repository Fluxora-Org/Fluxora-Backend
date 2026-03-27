/**
 * Fluxora Backend — server entry point.
 *
 * Responsibilities:
 *  - Bind the Express app to a TCP port.
 *  - Register OS signal handlers for graceful shutdown.
 *
 * Everything else (routes, middleware, app config) lives in app.ts.
 * Shutdown logic (drain + hooks) lives in shutdown.ts.
 */

import http from 'node:http';
import { app } from './app.js';
import { gracefulShutdown } from './shutdown.js';
import { logger } from './lib/logger.js';

const PORT = Number(process.env.PORT ?? 3000);
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 30_000);

const server = http.createServer(app);

server.listen(PORT, () => {
  logger.info('Fluxora API listening', undefined, { port: PORT });
});

async function shutdown(signal: string): Promise<void> {
  await gracefulShutdown(server, signal, SHUTDOWN_TIMEOUT_MS);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT',  () => void shutdown('SIGINT'));
