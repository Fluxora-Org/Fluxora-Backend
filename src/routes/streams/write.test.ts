import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiErrorCode, errorHandler } from '../../middleware/errorHandler.js';
import { getIdempotencyStore, resetStreamIdempotencyStore } from './state.js';
import { registerWriteRoutes } from './write.js';

const SENDER = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
const RECIPIENT = 'GBDEVU63Y6NTHJQQZIKVTC23NWLQVP3WJ2RI2OTSJTNYOIGICST6DUXR';

vi.mock('../../services/stellar-rpc.js', () => ({
  RpcFallbackExhaustedError: class extends Error {},
}));

vi.mock('./guards.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./guards.js')>()),
  parseCreateStreamBody: (body: unknown) => body,
}));

vi.mock('../../middleware/auth.js', () => {
  const pass = (_req: Request, _res: Response, next: NextFunction) => next();
  return {
    authenticate: (req: Request, _res: Response, next: NextFunction) => {
      req.callerAddress = SENDER;
      next();
    },
    requireAuth: pass,
    authenticateApiKey: pass,
    requireScope: () => pass,
  };
});

afterEach(resetStreamIdempotencyStore);

it('returns 409 CONFLICT and the retry hint for an in-flight stream request', async () => {
  const key = 'in-flight-stream';
  expect(await getIdempotencyStore().start(key, SENDER, 60)).toBe(true);

  const app = express();
  const router = express.Router();
  registerWriteRoutes(router);
  app.use(express.json(), router, errorHandler);

  const response = await request(app)
    .post('/')
    .set('Idempotency-Key', key)
    .send({ sender: SENDER, recipient: RECIPIENT, depositAmount: '1000', ratePerSecond: '10' })
    .expect(409);

  expect(response.body.error).toMatchObject({
    code: ApiErrorCode.CONFLICT,
    message: 'An identical request is already being processed',
    details: { hint: 'Retry after the in-flight request completes' },
  });
});
