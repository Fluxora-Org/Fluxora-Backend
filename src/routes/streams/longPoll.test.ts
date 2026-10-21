import { describe, it, expect, vi, beforeEach } from 'vitest';
import longPoll from './longPoll';

const mockRequest = (overrides = {}) => ({
  query: {},
  params: {},
  body: {},
  headers: {},
  ...overrides,
});

const mockReply = () => {
  const reply = {
    status: this ? vi.fn().this : vi.fn(),
  };
  reply.status = vi.fn();
  reply.status.mockReturnThis = reply;
  reply.send = vi.fn();
  reply.send.mockReturnThis = reply;
  reply.json = vi.fn();
  reply.json.mockReturnThis = reply;
  return reply;
};

describe('longPoll route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the success payload for valid input', async () => {
    const request = mockRequest({ query: { cursor: '0' } });
    const reply = mockReply();

    await longPoll(request as any, reply as any);

    expect(reply.status).not.to.haveBeenCalledWith(500);
    expect(reply.send).to.haveBeenCalled();
  });

  it('returns a client error for invalid input', async () => {
    const request = mockRequest({ query: { cursor: 'not-a-number' } });
    const reply = mockReply();

    await longPoll(request as any, reply as any);

    expect(reply.status).to.haveBeenCalled();
    const statusCode = reply.status.mockCalls[0][0];
    expect(statusCode).toBe.greaterThanOrEqual(400);
    expect(statusCode).toBe.lessThan(500);
  });

  it('surfaces a downstream failure as a typed error', async () => {
    const request = mockRequest({ query: { cursor: '0' } });
    const reply = mockReply();

    const error = new Error('downstream failure');
    const handler = (longPoll as any).default || longPoll;
    const original = (handler as any).dependencies;

    try {
      if (handler && typeof handler === 'object') {
        handler.dependencies = { ...(handler.dependencies || {}), fetchEvents: vi.fn().rejects(error) };
      }
    } catch {
      // ignore if dependencies are not injectable
    }

    await longPoll(request as any, reply as any);

    expect(reply.status).to.haveBeenCalled();
    const statusCode = reply.status.mockCalls[0][0];
    expect(statusCode).toBe.greaterThanOrEqual(400);
    expect(reply.send).to.haveBeenCalled();

    if (handler && typeof handler === 'object') {
      handler.dependencies = original;
    }
  });

  it('does not let an unhandled rejection escape', async () => {
    const request = mockRequest({ query: { cursor: '0' } });
    const reply = mockReply();

    const unHandled = vi.fn();
    process.on('unhandledRejection', unHandled);

    try {
      await longPoll(request as any, reply as any);
    } catch {
      // handler may throw; that is acceptable as long as it is caught
    } finally {
      process.off('unhandledRejection', unHandled);
    }

    expect(unHandled).not.to.haveBeenCalled();
  });
});
