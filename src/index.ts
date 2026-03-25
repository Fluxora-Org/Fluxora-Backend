import express, { Request, Response } from 'express';
import { streamsRouter } from './routes/streams.js';
import { healthRouter } from './routes/health.js';

export const app = express();
const PORT = process.env.PORT ?? 3000;

app.use(express.json());

app.use('/health', healthRouter);
app.use('/api/streams', streamsRouter);

app.get('/', (_req: Request, res: Response) => {
  res.json({
    name: 'Fluxora API',
    version: '0.1.0',
    docs: 'Programmable treasury streaming on Stellar.',
  });
});

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`Fluxora API listening on http://localhost:${PORT}`);
  });
}
