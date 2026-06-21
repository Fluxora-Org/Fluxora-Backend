import { Router, Request, Response } from 'express';
import { indexerService } from '../indexer/service';
import { ReplayRequest } from '../types';

export const indexerRouter = Router();

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * POST /internal/indexer/events/replay
 * 
 * Replay historical contract events into contract_events table
 * 
 * Security:
 * - This is an internal endpoint and should be protected by authentication/authorization
 * - Consider adding IP whitelisting or API key validation
 * - Rate limiting recommended to prevent abuse
 * 
 * Request body:
 * {
 *   "contract_id": "string",
 *   "ledger": number,
 *   "from_block": number (optional),
 *   "to_block": number (optional)
 * }
 */
indexerRouter.post('/internal/indexer/events/replay', async (req: Request, res: Response) => {
  try {
    const request: ReplayRequest = {
      contract_id: req.body.contract_id,
      ledger: req.body.ledger,
      from_block: req.body.from_block,
      to_block: req.body.to_block,
    };

    // Start replay asynchronously
    indexerService.replayEvents(request).catch((error) => {
      console.error('Replay failed:', error);
    });

    res.status(202).json({
      message: 'Replay started',
      status: indexerService.getReplayProgress(),
    });
  } catch (error: unknown) {
    console.error('Failed to start replay:', error);
    res.status(400).json({
      error: errorMessage(error, 'Failed to start replay'),
    });
  }
});

/**
 * GET /internal/indexer/status
 * 
 * Get current replay progress and indexer status
 * 
 * Response:
 * {
 *   "isReplaying": boolean,
 *   "rowsReplayed": number,
 *   "rowsRemaining": number,
 *   "totalRows": number,
 *   "estimatedCompletion": ISO date string | null,
 *   "startedAt": ISO date string | null,
 *   "contractId": string (optional),
 *   "ledger": number (optional)
 * }
 */
indexerRouter.get('/internal/indexer/status', async (req: Request, res: Response) => {
  try {
    const progress = await indexerService.getReplayProgressSnapshot();
    res.status(200).json(progress);
  } catch (error: unknown) {
    console.error('Failed to get status:', error);
    res.status(500).json({
      error: 'Failed to get indexer status',
    });
  }
});
