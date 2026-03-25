import express from 'express';
import { streamsRouter } from './routes/streams.js';
import { healthRouter } from './routes/health.js';
import { registry } from './metrics.js';
import { httpMetrics } from './middleware/httpMetrics.js';

const app = express();
const PORT = process.env.PORT ?? 3000;

app.use(express.json());
app.use(httpMetrics);

app.get('/metrics', async (_req, res) => {
  try {
    const metrics = await registry.metrics();
    res.set('Content-Type', registry.contentType);
    res.end(metrics);
  } catch (err) {
    res.status(500).json({ error: 'Failed to collect metrics' });
  }
});

app.use('/health', healthRouter);
app.use('/api/streams', streamsRouter);

app.get('/', (_req, res) => {
  res.json({
    name: 'Fluxora API',
    version: '0.1.0',
    docs: 'Programmable treasury streaming on Stellar.',
  });
});

export { app };

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`Fluxora API listening on http://localhost:${PORT}`);
  });
}
