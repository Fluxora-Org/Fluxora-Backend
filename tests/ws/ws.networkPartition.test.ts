import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'http';
import { StreamHub } from '../../src/ws/hub.js';
import { _resetLimiter } from '../../src/ws/connectionLimiter.js';
import { createSlowClient, wait, type SlowClient } from './fixtures/slowClient.js';

function setup(): Promise<{ server: http.Server; hub: StreamHub; port: number }> {
  const server = http.createServer();
  const hub = new StreamHub(server, {
    dropBytes: 1024,
    terminateBytes: 2048,
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      resolve({ server, hub, port: address.port });
    });
  });
}

function teardown(server: http.Server, hub: StreamHub): Promise<void> {
  return new Promise((resolve) => {
    hub.close(() => server.close(() => resolve()));
  });
}

describe('StreamHub Network Partition', () => {
  let server: http.Server;
  let hub: StreamHub;
  let port: number;

  beforeEach(async () => {
    ({ server, hub, port } = await setup());
    _resetLimiter();
  });

  afterEach(async () => {
    _resetLimiter();
    await teardown(server, hub);
  });

  it('correctly classifies backpressured connections and terminates them on network partition', async () => {
    const slowClient = await createSlowClient(port, hub);
    const streamId = 'partition-stream';
    
    slowClient.subscribe(streamId);
    await wait(50);

    // Simulate partition
    slowClient.simulatePartition();
    
    // Send a message large enough to cross the terminate threshold
    const largeMessage = 'A'.repeat(3000);
    slowClient.setBufferedAmount(3000);
    
    // We can listen for the backpressure event
    let backpressureEventTriggered = false;
    hub.on('backpressure', (event) => {
      if (event.action === 'terminate') {
        backpressureEventTriggered = true;
      }
    });

    // Send broadcast
    await hub.broadcast({
      streamId,
      eventId: 'evt-large-1',
      payload: { data: largeMessage }
    });

    // It should have terminated the client
    await wait(50);
    
    expect(backpressureEventTriggered).toBe(true);
    
    // Subscription should be cleared
    expect(hub.getStreamSubscriptionCount(streamId)).toBe(0);
    
    slowClient.close();
  });
});
