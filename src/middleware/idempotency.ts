import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { type IdempotencyStore } from '../redis/idempotencyStore.js';
import { logger } from '../lib/logger.js';
import { idempotentReplayResponse } from '../utils/response.js';

/**
 * Canonicalize the request body by sorting keys recursively and stripping whitespace.
 * This ensures that semantically identical JSON bodies produce the same hash
 * regardless of key order or indentation.
 */
export function canonicalizeBody(body: unknown): string {
  if (body === null || typeof body !== 'object') {
    // For non-objects, use standard JSON stringify and trim whitespace
    return JSON.stringify(body)?.trim() ?? '';
  }

  if (Array.isArray(body)) {
    return `[${body.map(canonicalizeBody).join(',')}]`;
  }

  const sortedKeys = Object.keys(body as Record<string, unknown>).sort();
  const parts = sortedKeys.map((key) => {
    const value = (body as Record<string, unknown>)[key];
    return `"${key}":${canonicalizeBody(value)}`;
  });

  return `{${parts.join(',')}}`;
}

/**
 * Compute SHA-256 fingerprint of the canonicalized request body.
 */
export function hashBody(body: unknown): string {
  const canonical = canonicalizeBody(body);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * Factory for the idempotency middleware.
 *
 * @param store The idempotency store (Redis or In-Memory)
 * @param ttlSeconds TTL for cached responses (default: 24 hours)
 */
export function createIdempotencyMiddleware(
  store: IdempotencyStore,
  ttlSeconds = 86400,
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Only apply to POST requests with an Idempotency-Key
    const idempotencyKey = req.headers['idempotency-key'];
    if (req.method !== 'POST' || !idempotencyKey || typeof idempotencyKey !== 'string') {
      return next();
    }

    const incomingHash = hashBody(req.body);

    try {
      const existing = await store.get(idempotencyKey);

      if (existing) {
        if (existing.requestFingerprint !== incomingHash) {
          logger.warn('Idempotency conflict detected', {
            idempotencyKeyLength: idempotencyKey.length,
            incomingHash,
            storedHash: existing.requestFingerprint,
          });

          return res.status(409).json({
            error: 'idempotency_conflict',
            stored_hash: existing.requestFingerprint,
            incoming_hash: incomingHash,
          });
        }

        logger.info('Replaying idempotent response', { 
            idempotencyKeyLength: idempotencyKey.length,
            requestId: req.id 
        });
        
        res.set('Idempotency-Key', idempotencyKey);
        res.set('Idempotency-Replayed', 'true');
        
        // Return the cached response using the standardized envelope
        // We wrap existing.body in idempotentReplayResponse to add the metadata
        // Note: existing.body already contains the 'data' part if it was stored via successResponse
        const responseData = (existing.body as any)?.data ?? existing.body;
        return res.status(existing.statusCode).json(
          idempotentReplayResponse(responseData, req.id as string)
        );
      }

      // Intercept res.json to cache the successful response
      const originalJson = res.json.bind(res);

      res.json = (body: any) => {
        // Only cache successful 2xx responses
        if (res.statusCode >= 200 && res.statusCode < 300) {
          store.set(
            idempotencyKey,
            { requestFingerprint: incomingHash, statusCode: res.statusCode, body },
            ttlSeconds,
          ).catch((err) => {
            logger.error('Failed to store idempotent response', { 
                error: err instanceof Error ? err.message : String(err) 
            });
          });
        }
        
        res.set('Idempotency-Key', idempotencyKey);
        res.set('Idempotency-Replayed', 'false');
        
        return originalJson(body);
      };

      next();
    } catch (err) {
      logger.error('Idempotency middleware error', { 
          error: err instanceof Error ? err.message : String(err) 
      });
      next();
    }
  };
}
