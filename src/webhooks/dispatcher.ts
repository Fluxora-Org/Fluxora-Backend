import crypto from 'crypto';
import { info, error } from '../utils/logger.js';

export interface WebhookOptions {
  url: string;
  secret: string;
  event: string;
  payload: any;
  retryCount?: number;
}

/**
 * Dispatches a webhook notification with HMAC-SHA256 signature.
 * Implements exponential backoff for 5xx errors.
 */
export async function dispatchWebhook(options: WebhookOptions): Promise<void> {
  const { url, secret, event, payload, retryCount = 0 } = options;
  const timestamp = Math.floor(Date.now() / 1000);
  const signaturePayload = `${timestamp}.${event}.${JSON.stringify(payload)}`;
  const signature = crypto.createHmac('sha256', secret).update(signaturePayload).digest('hex');

  const headers = {
    'Content-Type': 'application/json',
    'X-Fluxora-Event': event,
    'X-Fluxora-Timestamp': timestamp.toString(),
    'X-Fluxora-Signature': signature,
    'User-Agent': 'Fluxora-Webhook-Dispatcher/1.0',
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ event, timestamp, payload }),
      signal: AbortSignal.timeout(10000), // 10s timeout
    });

    if (!response.ok) {
      if (response.status >= 500 && retryCount < 3) {
        const delay = Math.pow(2, retryCount) * 1000;
        info('Retrying webhook dispatch due to server error', { url, event, status: response.status, retryCount: retryCount + 1 });
        await new Promise(resolve => setTimeout(resolve, delay));
        return dispatchWebhook({ ...options, retryCount: retryCount + 1 });
      }
      error('Webhook dispatch failed', { url, event, status: response.status });
      return;
    }

    info('Webhook dispatched successfully', { url, event });
  } catch (err) {
    if (retryCount < 3) {
      const delay = Math.pow(2, retryCount) * 1000;
      info('Retrying webhook dispatch due to network error', { url, event, retryCount: retryCount + 1 });
      await new Promise(resolve => setTimeout(resolve, delay));
      return dispatchWebhook({ ...options, retryCount: retryCount + 1 });
    }
    error('Webhook dispatch failed with error', { url, event }, err as Error);
  }
}
