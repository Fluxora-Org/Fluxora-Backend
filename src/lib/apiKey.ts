import { Request } from 'express';

/**
 * Extracts the API key from common request headers.
 */
export function getApiKeyFromRequest(headers: Record<string, string | string[] | undefined>): string | undefined {
  const key = headers['x-api-key'] || headers['X-API-Key'];
  if (Array.isArray(key)) return key[0];
  return key;
}

/**
 * Validates an API key against the configured authorized keys.
 */
export function isValidApiKey(key: string): boolean {
  // In a real app, this would check a DB or a cache of hashed keys.
  // For now, we use the environment-provided list.
  try {
    const { getConfig } = require('../config/env.js');
    const { apiKeys } = getConfig();
    return apiKeys.includes(key);
  } catch {
    // Falls back to a defensive default if config isn't ready
    return false;
  }
}
