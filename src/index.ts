/**
 * Fluxora Backend Server entry point
 */

import { createApp } from './app.js';
import { info, warn } from './utils/logger.js';

const PORT = process.env.PORT ?? 3000;

// Create the application instance
const app = createApp();

// Start server
const server = app.listen(PORT, () => {
  info(`Fluxora API listening on http://localhost:${PORT}`);
  info(`V1 API available at http://localhost:${PORT}/v1`);
});

// Graceful shutdown handling
process.on('SIGTERM', () => {
  warn('SIGTERM received, shutting down gracefully');
  server.close(() => {
    info('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  warn('SIGINT received, shutting down gracefully');
  server.close(() => {
    info('Server closed');
    process.exit(0);
  });
});

export { app };
