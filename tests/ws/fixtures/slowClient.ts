import { WebSocket } from 'ws';
import type { StreamHub } from '../../../src/ws/hub.js';

type ServerWebSocket = WebSocket & {
  _socket?: {
    remotePort?: number;
    write?: (...args: unknown[]) => boolean;
    emit?: (event: string) => boolean;
    pause?: () => void;
  };
};

export interface SlowClient {
  client: WebSocket;
  serverSocket: WebSocket;
  messages: unknown[];
  subscribe(streamId: string): void;
  setBufferedAmount(bytes: number): void;
  getBufferedAmount(): number;
  releaseDrain(): void;
  simulatePartition(): void;
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

/**
 * Compute byte length of a value passed to `net.Socket.write()`.
 * Handles string and Buffer — the two types used by the `ws` library.
 */
function byteLengthOfWriteArg(arg: unknown): number {
  if (typeof arg === 'string') return Buffer.byteLength(arg, 'utf8');
  if (Buffer.isBuffer(arg)) return arg.length;
  if (arg instanceof ArrayBuffer) return arg.byteLength;
  if (ArrayBuffer.isView(arg)) return arg.byteLength;
  return 0;
}

export async function createSlowClient(port: number, hub: StreamHub): Promise<SlowClient> {
  const client = await connectClient(port);
  const localPort = getClientLocalPort(client);
  const serverSocket = findServerSocket(hub, localPort);
  const messages: unknown[] = [];
  let bufferedAmount = 0;
  let partitioned = false;

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
    partitioned = false;
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

      if (partitioned) {
        // Network partition mode: accept writes into the simulated OS buffer
        // (return true), accumulate bytes as bufferedAmount, but never fire
        // drain callbacks — the remote end never reads/acks.
        const data = args[0];
        if (data !== undefined) {
          bufferedAmount += byteLengthOfWriteArg(data);
        }
        return true;
      }

      // Normal slow-client mode (legacy): queue the callback and signal
      // backpressure by returning false.
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
    getBufferedAmount(): number {
      return bufferedAmount;
    },
    simulatePartition(): void {
      partitioned = true;
      bufferedAmount = 0;
    },
    releaseDrain(): void {
      partitioned = false;
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
