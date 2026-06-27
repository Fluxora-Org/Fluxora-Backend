import request from 'supertest';
import jwt from 'jsonwebtoken';
import { vi } from 'vitest';

import { app } from '../../src/app.js';
import { generateToken } from '../../src/lib/auth.js';
import { getConfig } from '../../src/config/env.js';

describe('RBAC Permission Middleware', () => {
  const address = 'GCSXAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUV';

  beforeAll(() => {
    vi.mock('../../src/db/repositories/streamRepository.js', () => ({ streamRepository: {} }));
  });

  it('allows operator (has DLQ_LIST) to access DLQ list', async () => {
    const token = generateToken({ address, role: 'operator' });
    const res = await request(app)
      .get('/admin/dlq')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
  });

  it('denies viewer (no DLQ_LIST) from accessing DLQ list', async () => {
    const token = generateToken({ address, role: 'viewer' });
    const res = await request(app)
      .get('/admin/dlq')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  it('rejects token missing permissions claim during authentication', async () => {
    const { jwtSecret } = getConfig();
    // Sign a token without permissions to simulate a malformed token
    const raw = jwt.sign({ address, role: 'viewer' } as any, jwtSecret);
    const res = await request(app)
      .get('/api/audit')
      .set('Authorization', `Bearer ${raw}`);

    expect(res.status).toBe(401);
  });
});

describe('Scope Permission Middleware (requireScope)', () => {
  it('returns 401 if authentication is missing entirely', async () => {
    const res = await request(app)
      .get('/api/streams') // Assuming this route uses requireScope
      .query({ limit: 10 });
    
    // An endpoint with requireScope but no auth should fail with 401
    // (If the route uses authenticateApiKey, it might pass as anonymous if it doesn't fail closed,
    // but requireScope should catch it now.)
    expect(res.status).toBe(401);
  });
});
