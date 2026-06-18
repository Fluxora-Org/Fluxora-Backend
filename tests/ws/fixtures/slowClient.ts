import { WebSocket } from 'ws';
import type { StreamHub } from '../../../src/ws/hub.js';

type ServerWebSocket = WebSocket & {
  _socket?: {
    remotePort?: number;
    write?: (...args: unknown[]) => boolean;
    emit?: (event: string) => boolean;
  };
};

export interface SlowClient {
  client: WebSocket;
  serverSocket: WebSocket;
  messages: unknown[];
  subscribe(streamId: string): void;
  setBufferedAmount(bytes: number): void;
  releaseDrain(): void;
  restore(): void;
  close(): void;
}

export function connectClient(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/streams`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

export function sendJson(ws: WebSocket, message: unknown): void {
  ws.send(JSON.stringify(message));
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function createSlowClient(port: number, hub: StreamHub): Promise<SlowClient> {
  const client = await connectClient(port);
  const localPort = getClientLocalPort(client);
  const serverSocket = findServerSocket(hub, localPort);
  const messages: unknown[] = [];
  let bufferedAmount = 0;

  client.on('message', (data) => {
    messages.push(JSON.parse(data.toString()));
  });

  const bufferedDescriptor = Object.getOwnPropertyDescriptor(serverSocket, 'bufferedAmount');
  Object.defineProperty(serverSocket, 'bufferedAmount', {
    configurable: true,
    get: () => bufferedAmount,
  });

  const rawSocket = (serverSocket as ServerWebSocket)._socket;
  const originalWrite = rawSocket?.write?.bind(rawSocket);
  const queuedWriteCallbacks: Array<() => void> = [];
  const restore = (): void => {
    if (rawSocket && originalWrite) {
      rawSocket.write = originalWrite as typeof rawSocket.write;
    }
    if (bufferedDescriptor) {
      Object.defineProperty(serverSocket, 'bufferedAmount', bufferedDescriptor);
    } else {
      delete (serverSocket as { bufferedAmount?: number }).bufferedAmount;
    }
  };

  if (rawSocket?.write) {
    rawSocket.write = ((...args: unknown[]): boolean => {
      const callback = args.find((arg): arg is () => void => typeof arg === 'function');
      if (callback) queuedWriteCallbacks.push(callback);
      return false;
    }) as typeof rawSocket.write;
  }

  return {
    client,
    serverSocket,
    messages,
    subscribe(streamId: string): void {
      sendJson(client, { type: 'subscribe', streamId });
    },
    setBufferedAmount(bytes: number): void {
      bufferedAmount = bytes;
    },
    releaseDrain(): void {
      bufferedAmount = 0;
      if (rawSocket && originalWrite) {
        rawSocket.write = originalWrite as typeof rawSocket.write;
      }
      for (const callback of queuedWriteCallbacks.splice(0)) callback();
      rawSocket?.emit?.('drain');
    },
    restore,
    close(): void {
      restore();
      client.close();
    },
  };
}

function getClientLocalPort(client: WebSocket): number {
  const localPort = (client as unknown as { _socket?: { localPort?: number } })._socket?.localPort;
  if (typeof localPort !== 'number') {
    throw new Error('Unable to read client socket localPort');
  }
  return localPort;
}

function findServerSocket(hub: StreamHub, clientLocalPort: number): WebSocket {
  const clients = (hub as unknown as { clients: Map<WebSocket, unknown> }).clients;
  const serverSocket = Array.from(clients.keys()).find((socket) => {
    return (socket as ServerWebSocket)._socket?.remotePort === clientLocalPort;
  });

  if (!serverSocket) {
    throw new Error(`Unable to find server WebSocket for client port ${clientLocalPort}`);
  }

  return serverSocket;
}
