import dotenv from 'dotenv';

dotenv.config();

export const config = {
  database: {
    url: process.env.DATABASE_URL || 'postgresql://localhost:5432/indexer_db',
  },
  indexer: {
    replayBatchSize: parseInt(process.env.REPLAY_BATCH_SIZE || '1000', 10),
  },
  sse: {
    drainTimeoutMs: parseInt(process.env.SSE_DRAIN_TIMEOUT_MS || '5000', 10),
  },
  server: {
    port: parseInt(process.env.PORT || '3000', 10),
  },
};
