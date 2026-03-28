import { app } from './app.js';
import { initializeConfig, getConfig, resetConfig } from './config/env.js';
import { info, error } from './utils/logger.js';
import { gracefulShutdown } from './shutdown.js';

async function start() {
    try {
        // Load and validate environment configuration
        const config = initializeConfig();
        const { port, nodeEnv, apiVersion } = config;

        const server = app.listen(port, () => {
            info(`Fluxora API v${apiVersion} started`, {
                port,
                env: nodeEnv,
                pid: process.pid,
            });
        });

        // Initialize graceful shutdown handler
        gracefulShutdown(server);

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
