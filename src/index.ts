import express from 'express';
import { config } from './config';
import { indexerRouter } from './routes/indexer';
import { getPool } from './db/pool';
import { indexerService } from './indexer/service';
import { closeAllRedisClients } from './redis/client';
import {
  addShutdownDrainHook,
  addShutdownHook,
  gracefulShutdown,
} from './shutdown';
import { drainSseConnections } from './streams/sseEmitter';

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
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message,
  });
});

// Start server
const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const server = app.listen(port, () => {
  console.log(`Indexer service listening on port ${port}`);
  console.log(`Replay batch size: ${config.indexer.replayBatchSize}`);
});

addShutdownDrainHook(() => {
  drainSseConnections();
});
addShutdownDrainHook(() => indexerService.stop());
addShutdownHook(() => getPool().end());
addShutdownHook(() => closeAllRedisClients());

function handleShutdown(signal: NodeJS.Signals): void {
  void gracefulShutdown(server, signal)
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      console.error('Graceful shutdown failed:', err);
      process.exit(1);
    });
}

process.on('SIGTERM', handleShutdown);
process.on('SIGINT', handleShutdown);

export { app };
