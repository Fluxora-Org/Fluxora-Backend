/**
 * Fluxora Backend - server entry point.
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
import { gracefulShutdown, addShutdownHook } from './shutdown.js';
import { logger } from './lib/logger.js';
import { initializeMigrations } from './db/migrate.js';
import { getPool } from './db/pool.js';
import { createStreamHub, getStreamHub } from './ws/hub.js';

// Configuration
const PORT = parseInt(process.env.PORT || '3000', 10);
const NODE_ENV = process.env.NODE_ENV || 'development';

async function startServer() {
  try {
    // Run migrations before starting the server
    await initializeMigrations();

    const app = createApp();
    const server = http.createServer(app);

    // Initialize WebSocket hub
    const hub = createStreamHub(server);
    logger.info('WebSocket hub initialized', undefined, { path: '/ws/streams' });

    // Register shutdown hooks
    addShutdownHook(async () => {
      logger.info('Closing database connections...');
      const pool = getPool();
      await pool.end();
      logger.info('Database connections closed');
    });

    addShutdownHook(async () => {
      logger.info('Closing WebSocket hub...');
      const currentHub = getStreamHub();
      if (currentHub) {
        await new Promise<void>((resolve) => {
          currentHub.close(() => {
            logger.info('WebSocket hub closed');
            resolve();
          });
        });
      }
    });

    // Register signal handlers for graceful shutdown
    process.on('SIGTERM', () => {
      logger.warn('SIGTERM received, initiating graceful shutdown');
      void gracefulShutdown(server, 'SIGTERM').then(() => {
        process.exit(0);
      });
    });

    process.on('SIGINT', () => {
      logger.warn('SIGINT received, initiating graceful shutdown');
      void gracefulShutdown(server, 'SIGINT').then(() => {
        process.exit(0);
      });
    });

    // Start listening
    server.listen(PORT, () => {
      logger.info('Fluxora API listening', undefined, { 
        port: PORT, 
        nodeEnv: NODE_ENV,
        pid: process.pid 
      });
    });

  } catch (err) {
    logger.error('Failed to start Fluxora API', undefined, {
      error: err instanceof Error ? err.message : 'Unknown error',
    });
    process.exit(1);
  }
}

// Global unhandled rejection handler
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Promise Rejection', undefined, { 
    reason: String(reason) 
  });
  // In production, we might want to exit here to allow a clean restart
  if (NODE_ENV === 'production') {
    process.exit(1);
  }
});

// Global uncaught exception handler
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception', undefined, { 
    error: err.message,
    stack: err.stack 
  });
  process.exit(1);
});

void startServer();
