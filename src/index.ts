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
import { createApp } from './app.js';
import { gracefulShutdown } from './shutdown.js';
import { logger } from './lib/logger.js';
import { initializeMigrations } from './db/migrate.js';

async function start() {
    try {
        // Load and validate environment configuration
        const config = initializeConfig();
        const { port, nodeEnv, apiVersion } = config;

const app = createApp();
const server = http.createServer(app);

async function startServer() {
  try {
    // Run migrations before starting the server
    await initializeMigrations();

    server.listen(PORT, () => {
      logger.info('Fluxora API listening', undefined, { port: PORT });
    });
  } catch (err) {
    logger.error('Failed to start Fluxora API', undefined, {
      error: err instanceof Error ? err.message : 'Unknown error',
    });
    process.exit(1);
  }
}

void startServer();

    } catch (err) {
        error('Failed to start application', {}, err as Error);
        process.exit(1);
    }
}

// Global unhandled rejection handler
process.on('unhandledRejection', (reason) => {
    error('Unhandled Promise Rejection', { reason: String(reason) });
    // In production, we might want to exit here to allow a clean restart
});

start();
