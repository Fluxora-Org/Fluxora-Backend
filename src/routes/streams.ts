import { Router, Request, Response } from 'express';

export const streamsRouter = Router();

// Placeholder: replace with DB and contract sync later
const streams: Array<{
  id: string;
  sender: string;
  recipient: string;
  depositAmount: string;
  ratePerSecond: string;
  startTime: number;
  status: string;
}> = [];

streamsRouter.get('/', (_req: Request, res: Response) => {
  res.json({ streams });
});

streamsRouter.get('/:id', (req: Request, res: Response) => {
  const stream = streams.find((s) => s.id === req.params.id);
  if (!stream) return res.status(404).json({ error: 'Stream not found' });
  res.json(stream);
});

streamsRouter.post('/', (req: Request, res: Response) => {
  const { sender, recipient, depositAmount, ratePerSecond, startTime } = req.body ?? {};
  const id = `stream-${Date.now()}`;
  const stream = {
    id,
    sender: sender ?? '',
    recipient: recipient ?? '',
    depositAmount: depositAmount ?? '0',
    ratePerSecond: ratePerSecond ?? '0',
    startTime: startTime ?? Math.floor(Date.now() / 1000),
    status: 'active',
  };
  streams.push(stream);
  res.status(201).json(stream);
});

streamsRouter.post('/lookup', (req: Request, res: Response) => {

  const { ids } = req.body ?? {};

  if (!ids || !Array.isArray(ids)) {
    return res.status(400).json({ error: 'Invalid input: ids must be an array of strings' });
  }

  const foundStreams = streams.filter((s) => ids.includes(s.id));

  res.json({ streams: foundStreams });
});
