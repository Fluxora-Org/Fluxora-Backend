import express from 'express';
import { config } from './config/index.js';
import { indexerRouter } from './routes/indexer';
import { gracefulShutdown } from './shutdown.js';
import { indexerService } from './indexer/service.js';

const app = express();

// Middleware
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

// Indexer routes
app.use(indexerRouter);

// Error handling middleware
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message,
  });
});

let server: any;

if (process.env.NODE_ENV !== 'test') {
  // Start server
  server = app.listen(config.server.port, () => {
    console.log(`Indexer service listening on port ${config.server.port}`);
    console.log(`Replay batch size: ${config.indexer.replayBatchSize}`);

    // Auto-resume any incomplete replays from the database checkpoint
    indexerService.resumeIncompleteReplay().catch((err) => {
      console.error('Failed to resume incomplete replays on startup:', err);
    });
  });

  // Delegate to the single graceful-shutdown path so all registered hooks
  // (SSE drain, indexer stop, Redis quit, DB pool close) run on SIGTERM.
  process.on('SIGTERM', () => void gracefulShutdown(server, 'SIGTERM'));
  process.on('SIGINT', () => void gracefulShutdown(server, 'SIGINT'));
}

export { app };
