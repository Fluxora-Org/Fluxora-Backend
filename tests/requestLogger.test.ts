import request from 'supertest';
import { app } from '../src/app';
import { logger } from '../src/lib/logger';
import { CORRELATION_ID_HEADER } from '../src/middleware/correlationId';

describe('requestLogger middleware', () => {
  let infoSpy: jest.SpyInstance;

  beforeEach(() => {
    infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  });

  afterEach(() => {
    infoSpy.mockRestore();
  });

  it('logs "request received" on the way in', async () => {
    await request(app).get('/health');
    const calls = infoSpy.mock.calls;
    const messages = calls.map((c) => c[0] as string);
    expect(messages).toContain('request received');
  });

  it('logs "request completed" after the response is sent', async () => {
    await request(app).get('/health');
    const calls = infoSpy.mock.calls;
    const messages = calls.map((c) => c[0] as string);
    expect(messages).toContain('request completed');
  });

  it('passes the correlationId to both log calls', async () => {
    const clientId = 'log-test-id';
    await request(app).get('/health').set(CORRELATION_ID_HEADER, clientId);

    const calls = infoSpy.mock.calls;
    const correlationIds = calls.map((c) => c[1] as string);
    expect(correlationIds.every((id) => id === clientId)).toBe(true);
  });

  it('"request received" log includes method and path', async () => {
    await request(app).get('/health');
    const receivedCall = infoSpy.mock.calls.find((c) => c[0] === 'request received');
    expect(receivedCall).toBeDefined();
    const meta = receivedCall![2] as Record<string, unknown>;
    expect(meta.method).toBe('GET');
    expect(meta.path).toBe('/');
  });

  it('"request completed" log includes statusCode and durationMs', async () => {
    await request(app).get('/health');
    const completedCall = infoSpy.mock.calls.find((c) => c[0] === 'request completed');
    expect(completedCall).toBeDefined();
    const meta = completedCall![2] as Record<string, unknown>;
    expect(meta.statusCode).toBe(200);
    expect(typeof meta.durationMs).toBe('number');
  });
});
