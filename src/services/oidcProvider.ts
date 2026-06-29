import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { getConfig } from '../config/env.js';
import { createRedisClient, type RedisClient } from '../redis/client.js';
import { addShutdownHook } from '../shutdown.js';
import { info, warn, error } from '../utils/logger.js';

interface JwksKey {
  kty: string;
  kid: string;
  use?: string;
  alg?: string;
  n: string;
  e: string;
  [key: string]: unknown;
}

interface JwksResponse {
  keys: JwksKey[];
}

interface CachedJwks {
  jwks: JwksResponse;
  expiresAt: number;
}

// In-memory cache for JWKS
const jwksMemoryCache = new Map<string, CachedJwks>();

// In-memory cache for replay prevention
// Stores replayKey -> expiration timestamp (ms)
const memoryReplayCache = new Map<string, number>();

/** Hard cap for the in-memory replay cache to prevent unbounded memory growth. */
const REPLAY_CACHE_MAX_SIZE = 10_000;

/** Interval at which expired replay entries are swept from the in-memory cache. */
const REPLAY_CACHE_SWEEP_INTERVAL_MS = 60_000;

/** Periodic timer handle for replay cache eviction. */
let replayCacheSweepTimer: ReturnType<typeof setInterval> | null = null;

let redisClient: RedisClient | null = null;
let redisClientPromise: Promise<RedisClient | null> | null = null;

/**
 * Gets or initializes the Redis client for OIDC caching.
 */
export async function getOidcRedisClient(): Promise<RedisClient | null> {
  const config = getConfig();
  if (!config.redisEnabled) {
    return null;
  }
  if (redisClient) {
    return redisClient;
  }
  if (redisClientPromise) {
    return redisClientPromise;
  }

  redisClientPromise = (async () => {
    try {
      const client = await createRedisClient({
        url: config.redisUrl,
        enabled: config.redisEnabled,
      });
      redisClient = client;
      return client;
    } catch (err) {
      warn('Failed to initialize Redis client for OIDC provider service', {
        error: err instanceof Error ? err.message : String(err),
      });
      redisClientPromise = null;
      return null;
    }
  })();

  return redisClientPromise;
}

/**
 * Eviction policy for the in-memory OIDC ID-token replay cache:
 *
 * - Each entry maps a token hash to an `expiresAt` timestamp (epoch ms).
 * - Entries are never removed before `expiresAt`; doing so would weaken replay protection.
 * - Expired entries are pruned on every insert and on a periodic timer.
 * - When the cache is at {@link REPLAY_CACHE_MAX_SIZE} with only valid entries,
 *   new entries skip the in-memory store (Redis remains authoritative when enabled).
 * - The sweep timer is `unref()`'d so it does not keep the process alive, and is
 *   cleared during graceful shutdown.
 */
function pruneExpiredReplayEntries(nowMs = Date.now()): void {
  for (const [key, expiresAt] of memoryReplayCache) {
    if (expiresAt <= nowMs) {
      memoryReplayCache.delete(key);
    }
  }
}

function recordReplayEntry(replayKey: string, expiresAtMs: number): void {
  pruneExpiredReplayEntries();
  if (memoryReplayCache.size >= REPLAY_CACHE_MAX_SIZE) {
    warn('OIDC replay cache at capacity; skipping in-memory record', {
      size: memoryReplayCache.size,
      maxSize: REPLAY_CACHE_MAX_SIZE,
    });
    return;
  }
  memoryReplayCache.set(replayKey, expiresAtMs);
}

/**
 * Starts the periodic sweep timer for the in-memory replay cache.
 *
 * The timer is `.unref()`'d so it does not keep the Node.js process alive
 * when no other work is pending. It is safe to call multiple times.
 */
function startReplayCacheSweepTimer(): void {
  if (replayCacheSweepTimer || process.env.NODE_ENV === 'test') {
    return;
  }

  replayCacheSweepTimer = setInterval(() => {
    pruneExpiredReplayEntries();
  }, REPLAY_CACHE_SWEEP_INTERVAL_MS);

  if (typeof replayCacheSweepTimer.unref === 'function') {
    replayCacheSweepTimer.unref();
  }
}

/**
 * Stops the periodic replay-cache sweep timer and frees the handle.
 */
export function stopReplayCacheSweepTimer(): void {
  if (replayCacheSweepTimer) {
    clearInterval(replayCacheSweepTimer);
    replayCacheSweepTimer = null;
  }
}

if (process.env.NODE_ENV !== 'test') {
  startReplayCacheSweepTimer();
  addShutdownHook(() => stopReplayCacheSweepTimer());
}

/**
 * Fetches and caches the JWKS keys.
 */
export async function getJwks(
  issuerUrl: string,
  options: { forceRefresh?: boolean } = {}
): Promise<JwksResponse> {
  const normalizedIssuer = issuerUrl.replace(/\/$/, '');
  const jwksUrl = `${normalizedIssuer}/.well-known/jwks.json`;
  const redisKey = `fluxora:jwks:${normalizedIssuer}`;
  const now = Date.now();

  // 1. Check in-memory cache
  if (!options.forceRefresh) {
    const memCached = jwksMemoryCache.get(normalizedIssuer);
    if (memCached && memCached.expiresAt > now) {
      return memCached.jwks;
    }
  }

  // 2. Check Redis cache
  if (!options.forceRefresh) {
    try {
      const redis = await getOidcRedisClient();
      if (redis) {
        const cached = await redis.get(redisKey);
        if (cached) {
          const parsed = JSON.parse(cached) as JwksResponse;
          // Store in memory cache for faster subsequent lookups
          jwksMemoryCache.set(normalizedIssuer, {
            jwks: parsed,
            // Align memory TTL with a reasonable time (1 hour from now or default)
            expiresAt: now + 3600 * 1000,
          });
          return parsed;
        }
      }
    } catch (err) {
      warn('Redis JWKS read failure, falling back to HTTP fetch', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 3. Fetch from HTTP endpoint
  info(`Fetching JWKS from external provider: ${jwksUrl}`);
  let response: globalThis.Response;
  try {
    response = await fetch(jwksUrl);
  } catch (err) {
    const msg = `JWKS fetch request failed: ${err instanceof Error ? err.message : String(err)}`;
    error(msg);
    throw new Error(msg);
  }

  if (!response.ok) {
    const msg = `JWKS fetch failed with HTTP status ${response.status}`;
    error(msg);
    throw new Error(msg);
  }

  let jwks: JwksResponse;
  try {
    jwks = (await response.json()) as JwksResponse;
  } catch (err) {
    const msg = `JWKS response is not valid JSON: ${err instanceof Error ? err.message : String(err)}`;
    error(msg);
    throw new Error(msg);
  }

  if (!jwks || !Array.isArray(jwks.keys)) {
    const msg = 'Invalid JWKS format returned from identity provider';
    error(msg);
    throw new Error(msg);
  }

  // TTL is 24 hours (86400 seconds)
  const ttlSeconds = 86400;

  // 4. Cache in memory
  jwksMemoryCache.set(normalizedIssuer, {
    jwks,
    expiresAt: now + ttlSeconds * 1000,
  });

  // 5. Cache in Redis
  try {
    const redis = await getOidcRedisClient();
    if (redis) {
      await redis.set(redisKey, JSON.stringify(jwks), { ex: ttlSeconds });
    }
  } catch (err) {
    warn('Failed to cache JWKS in Redis', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return jwks;
}

/**
 * Validates the token to prevent replay attacks.
 */
async function preventReplay(idToken: string, exp: number): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const ttl = exp - now;

  if (ttl <= 0) {
    throw new Error('OIDC ID token is expired');
  }

  const tokenHash = crypto.createHash('sha256').update(idToken).digest('hex');
  const replayKey = `fluxora:oidc_replay:${tokenHash}`;
  const nowMs = Date.now();

  startReplayCacheSweepTimer();

  // 1. Check in-memory replay cache
  const inMemoryExpiry = memoryReplayCache.get(replayKey);
  if (inMemoryExpiry && inMemoryExpiry > nowMs) {
    throw new Error('Token replay detected: this token has already been exchanged');
  }

  // 2. Check Redis replay cache
  try {
    const redis = await getOidcRedisClient();
    if (redis) {
      const exists = await redis.exists(replayKey);
      if (exists) {
        throw new Error('Token replay detected: this token has already been exchanged');
      }
      await redis.set(replayKey, '1', { ex: ttl });
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('Token replay detected')) {
      throw err;
    }
    warn('Failed to check/set token replay key in Redis', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Store in memory replay cache as fallback / double check
  recordReplayEntry(replayKey, nowMs + ttl * 1000);
}

/**
 * Verifies the signature of a public key in JWK format and verifies claims.
 */
function verifyWithJwk(
  idToken: string,
  jwk: JwksKey,
  issuerUrl: string,
  audience?: string
): any {
  let pem: string;
  try {
    const publicKey = crypto.createPublicKey({
      key: jwk,
      format: 'jwk',
    });
    pem = publicKey.export({
      type: 'spki',
      format: 'pem',
    }) as string;
  } catch (err) {
    throw new Error(`Failed to import JWK to PEM public key: ${err instanceof Error ? err.message : String(err)}`);
  }

  const verifyOptions: jwt.VerifyOptions = {
    algorithms: ['RS256'],
    issuer: issuerUrl,
  };

  if (audience) {
    verifyOptions.audience = audience;
  }

  try {
    return jwt.verify(idToken, pem, verifyOptions);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Token verification failed: ${msg}`);
  }
}

/**
 * Verifies an OIDC ID Token signature, iss, aud, exp, and prevents replay attacks.
 */
export async function verifyIdToken(idToken: string): Promise<{
  address: string;
  role: 'operator' | 'viewer';
  sub: string;
  email?: string;
  claims: any;
}> {
  const config = getConfig();
  const issuerUrl = config.oidcIssuerUrl;
  const audience = config.oidcAudience;

  if (!issuerUrl) {
    throw new Error('OIDC issuer URL is not configured');
  }

  if (!audience) {
    throw new Error('OIDC audience (client_id) is not configured — aud validation cannot be skipped');
  }

  // 1. Decode token to extract kid
  const decoded = jwt.decode(idToken, { complete: true });
  if (!decoded || typeof decoded === 'string' || !decoded.header || !decoded.payload) {
    throw new Error('Invalid token structure');
  }

  const kid = decoded.header.kid;
  if (!kid) {
    throw new Error('Missing key ID (kid) in token header');
  }

  const payload = decoded.payload as any;
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid token payload');
  }

  const exp = payload.exp;
  if (typeof exp !== 'number') {
    throw new Error('Token does not contain an expiration claim (exp)');
  }

  // 2. Fetch JWKS and locate the key
  let jwks = await getJwks(issuerUrl);
  let jwk = jwks.keys.find((k) => k.kid === kid);

  // If signing key not found, force-refresh the JWKS once in case of recent key rotation
  if (!jwk) {
    info(`Signing key not found in cache for kid: ${kid}. Force-refreshing JWKS...`);
    jwks = await getJwks(issuerUrl, { forceRefresh: true });
    jwk = jwks.keys.find((k) => k.kid === kid);
    if (!jwk) {
      throw new Error(`Signing key not found for kid: ${kid}`);
    }
  }

  // 3a. Explicit aud claim pre-check before signature verification
  const rawAud = payload.aud;
  const audArray = Array.isArray(rawAud) ? rawAud : [rawAud];
  if (!audArray.includes(audience)) {
    throw new Error(`Token aud claim does not include configured client_id. Expected "${audience}", got ${JSON.stringify(rawAud)}`);
  }

  // 3b. Verify token signature and claims (also re-validates aud via jwt library)
  const verifiedPayload = verifyWithJwk(idToken, jwk, issuerUrl, audience);

  // 4. Token replay prevention
  await preventReplay(idToken, exp);

  // 5. Extract claims
  const sub = verifiedPayload.sub;
  const email = verifiedPayload.email;
  // Fall back chain for address: custom claim 'stellar_address', standard claim 'address', then 'sub'
  const address = verifiedPayload.stellar_address || verifiedPayload.address || sub;
  const role = verifiedPayload.role === 'operator' ? 'operator' : 'viewer';

  return {
    address,
    role,
    sub,
    email,
    claims: verifiedPayload,
  };
}

/**
 * Resets local in-memory caches and closes active Redis connections (for testing).
 */
export async function _resetOidcProviderForTest(): Promise<void> {
  stopReplayCacheSweepTimer();
  jwksMemoryCache.clear();
  memoryReplayCache.clear();
  if (redisClient) {
    try {
      await redisClient.close();
    } catch {
      // ignore
    }
    redisClient = null;
  }
  redisClientPromise = null;
}

/** @internal Test-only accessors for replay-cache eviction behavior. */
export const _replayCacheForTest = {
  size: (): number => memoryReplayCache.size,
  pruneExpired: pruneExpiredReplayEntries,
  maxSize: REPLAY_CACHE_MAX_SIZE,
  recordEntry: recordReplayEntry,
  startSweepTimer: startReplayCacheSweepTimer,
  stopSweepTimer: stopReplayCacheSweepTimer,
};
