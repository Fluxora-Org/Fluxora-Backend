import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../../src/app.js';
import { _resetForTest } from '../../src/state/adminState.js';
import { generateAdminToken } from '../../tests/lib/authHelpers.js';

describe('indexer control operations concurrency', () => {
  beforeEach(() => {
    _resetForTest();
  });

  it('rejects concurrent reindex requests and states why', async () => {
    const token = generateAdminToken();

    // Fire two requests concurrently
    const req1 = request(app)
      .post('/internal/indexer/events/replay')
      .set('Authorization', `Bearer ${token}`)
      .send({ contract_id: 'C123', ledger: 1000 });

    const req2 = request(app)
      .post('/internal/indexer/events/replay')
      .set('Authorization', `Bearer ${token}`)
      .send({ contract_id: 'C123', ledger: 1000 });

    const responses = await Promise.all([req1, req2]);

    const accepted = responses.filter(r => r.status === 202);
    const rejected = responses.filter(r => r.status === 409);

    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    expect(rejected[0].body).toMatchObject({
      error: 'CONFLICT',
      message: 'A reindex operation is already in progress.'
    });
  });
});
