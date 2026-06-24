import express from 'express';
import { config } from './config/index.js';
import { indexerRouter } from './routes/indexer';

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
  });

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully...');
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  });
}

export { app };
