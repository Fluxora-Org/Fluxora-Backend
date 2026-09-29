/**
 * WebSocket upgrade acceptance.
 *
 * Everything that runs before a socket becomes a hub connection lives here:
 * the path allowlist, the browser-origin allowlist, optional JWT auth, and the
 * atomic per-IP connection reservation. Keeping it apart from the hub's
 * lifecycle code means the security-critical counter protocol can be read (and
 * reviewed) on its own.
 *
 * @module ws/upgradeHandler
 */

import type { Server } from 'http';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import type { WebSocket, WebSocketServer } from 'ws';
import { verifyWsToken } from '../middleware/tokenAuth.js';
import { checkAndReserve, getClientIp, untrackConnection } from './connectionLimiter.js';

/** Settings the upgrade path needs from the hub. */
export interface UpgradeHandlerDeps {
  wss: WebSocketServer;
  /** Exact origins allowed to perform browser upgrades; undefined allows all. */
  allowedOrigins: ReadonlySet<string> | undefined;
  /** Reject upgrades without a valid token. */
  wsAuthRequired: boolean;
  /** Secret used to verify HS256 tokens. */
  jwtSecret: string | undefined;
}

function refuse(socket: Duplex, status: string, message: string): void {
  socket.write(
    `HTTP/1.1 ${status}\r\n` +
      'Content-Type: text/plain\r\n' +
      'Connection: close\r\n\r\n' +
      `${message}\r\n`
  );
  socket.destroy();
}

/**
 * HTTP upgrade handler for WebSocket connections with TOCTOU-safe per-IP limiting.
 *
 * SECURITY CRITICAL: Per-IP connection limiting using atomic check-and-reserve.
 * This handler prevents attackers from bypassing the per-IP connection cap via
 * concurrent upgrade race conditions.
 *
 * ALGORITHM:
 * 1. ATOMIC CHECK-AND-RESERVE:
 *    - Call checkAndReserve(ip) which synchronously checks the limit before incrementing.
 *    - This prevents multiple concurrent requests from both passing the check.
 *    - Reservation MUST be released exactly once on any failure path.
 *
 * 2. PRE-UPGRADE CLEANUP HANDLER:
 *    - Install a socket 'close' listener that releases the reservation if the upgrade fails.
 *    - This covers:
 *      * Network errors (socket closes before upgrade completes)
 *      * Timeouts (socket closes due to handshake timeout)
 *      * Auth failures (if WS_AUTH_REQUIRED is set)
 *    - The 'cleaned' flag ensures untrackConnection is called exactly once.
 *
 * 3. UPGRADE SUCCESS PATH:
 *    - Upgrade is accepted via wss.handleUpgrade(...)
 *    - Set 'cleaned = true' to prevent socket close listener from firing
 *    - Remove the close listener (no longer needed)
 *    - The hub's 'connection' listener registers the established WebSocket
 *      (the reservation stays active)
 *
 * 4. COUNTER RELEASE ON DISCONNECT:
 *    - When the WebSocket closes (normal or abnormal), the hub calls
 *      onDisconnect, which calls untrackConnection(ip) to decrement the counter
 *
 * COUNTER LIFECYCLE:
 *   checkAndReserve(ip) ──┬─→ allowed=false  →  close socket (no release)
 *                         │
 *                         └─→ allowed=true   →  reserve slot (must release once)
 *                                                ├─→ upgrade failure  →  socket close handler  →  untrackConnection
 *                                                └─→ upgrade success  →  onConnect (owns slot)  →  onDisconnect  →  untrackConnection
 *
 * INVARIANTS:
 *   - Each successful checkAndReserve increments the counter (atomic)
 *   - The counter is decremented exactly once per successful reservation
 *   - Counter never goes negative (clamped to 0)
 *   - No leaks under concurrent close events
 *
 * @security Prevents attackers from opening more than the allowed connections via burst requests.
 * @security Counter is atomic and cannot be bypassed via race conditions.
 * @security No counter underflow or leaks on failed upgrades.
 */
export function attachUpgradeHandler(server: Server, deps: UpgradeHandlerDeps): void {
  const { wss, allowedOrigins, wsAuthRequired, jwtSecret } = deps;

  server.on('upgrade', async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = new URL(req.url ?? '/', 'ws://localhost').pathname;
    if (pathname !== '/ws/streams') return;

    const origin = req.headers.origin;
    if (allowedOrigins && (typeof origin !== 'string' || !allowedOrigins.has(origin))) {
      refuse(socket, '403 Forbidden', 'Forbidden origin');
      return;
    }

    // 1. Auth + connection limiter check — reserve by authenticated identity when available,
    // otherwise fall back to the client IP.
    const ip = getClientIp(req);
    const authResult = verifyWsToken(req, jwtSecret);
    const clientIdentity = authResult.ok ? authResult.payload.sub?.trim() || undefined : undefined;

    if (wsAuthRequired && !authResult.ok) {
      refuse(socket, '401 Unauthorized', `Unauthorized: ${authResult.code}`);
      return;
    }

    const limitResult = await checkAndReserve(ip, clientIdentity);
    if (!limitResult.allowed) {
      // SECURITY: Reject BEFORE upgrade. Send HTTP error instead of upgrading.
      // This ensures the client never enters the OPEN state and the connection
      // is rejected cleanly at the HTTP level.
      refuse(socket, '429 Too Many Requests', limitResult.reason || 'Too many connections');
      return;
    }

    let cleaned = false;
    // Release the reserved slot if upgrade fails (before the connection is registered)
    const handleCleanup = () => {
      if (!cleaned) {
        cleaned = true;
        untrackConnection(ip, clientIdentity);
        socket.removeListener('close', handleCleanup);
      }
    };
    socket.on('close', handleCleanup);

    // 3. Accept Upgrade — mark cleaned to prevent double-cleanup on close
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      cleaned = true; // prevent the socket close handler from firing
      socket.removeListener('close', handleCleanup);
      wss.emit('connection', ws, req);
    });
  });
}
