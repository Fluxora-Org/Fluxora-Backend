import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/index.js';
import { registry, httpRequestsTotal, httpRequestDurationSeconds } from '../src/metrics.js';

describe('GET /metrics', () => {
  beforeEach(async () => {
    httpRequestsTotal.reset();
    httpRequestDurationSeconds.reset();
  });

  it('returns 200 with Prometheus content type', async () => {
    const res = await request(app).get('/metrics');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain|application\/openmetrics-text/);
  });

  it('includes default Node.js process metrics', async () => {
    const res = await request(app).get('/metrics');

    expect(res.text).toContain('process_cpu_');
    expect(res.text).toContain('nodejs_heap_size_total_bytes');
  });

  it('includes the service label', async () => {
    const res = await request(app).get('/metrics');

    expect(res.text).toContain('service="fluxora-backend"');
  });

  it('includes http_requests_total counter after a request', async () => {
    // Fire a request so the counter is incremented
    await request(app).get('/health');

    const res = await request(app).get('/metrics');

    expect(res.text).toContain('http_requests_total');
    expect(res.text).toMatch(/method="GET".*route="\/health"/);
  });

  it('includes http_request_duration_seconds histogram', async () => {
    await request(app).get('/health');

    const res = await request(app).get('/metrics');

    expect(res.text).toContain('http_request_duration_seconds_bucket');
    expect(res.text).toContain('http_request_duration_seconds_sum');
    expect(res.text).toContain('http_request_duration_seconds_count');
  });

  it('tracks different routes independently', async () => {
    await request(app).get('/health');
    await request(app).get('/');

    const res = await request(app).get('/metrics');

    expect(res.text).toMatch(/http_requests_total\{.*route="\/health".*\}/);
    expect(res.text).toMatch(/http_requests_total\{.*route="\/".*\}/);
  });

  it('records correct status codes for errors', async () => {
    // /health/ready returns 503 when there is no health manager — that gives
    // us a deterministic non-2xx status without depending on a live DB.
    await request(app).get('/health/ready');

    const res = await request(app).get('/metrics');

    expect(res.text).toMatch(/http_requests_total\{.*status_code="[45]\d\d".*\}/);
  });

  it('tracks POST requests', async () => {
    // POST to the auth/session endpoint — no DB required, validates a string
    // body so the request hits the metrics middleware.
    await request(app)
      .post('/api/auth/session')
      .send({
        address: 'GCSX22222222222222222222222222222222222222222222222222UV',
        role: 'operator',
      });

    const res = await request(app).get('/metrics');

    expect(res.text).toMatch(/http_requests_total\{.*method="POST".*\}/);
  });
});
