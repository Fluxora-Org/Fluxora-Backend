import { DEFAULT_MAX_WEBHOOK_BODY_BYTES } from './signature.js';

export const MAX_JSON_DEPTH = 32;

export type WebhookPreflightResult =
  | { ok: true; parsed: unknown }
  | { ok: false; status: 200 | 400 | 401 | 409 | 413 | 415; code: string; message: string };

export function checkWebhookPreflight(
  rawBody: Buffer | string,
  contentType?: string,
  maxBodyBytes: number = DEFAULT_MAX_WEBHOOK_BODY_BYTES
): WebhookPreflightResult {
  const bodyBuf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');

  // 1. Content-type check
  if (contentType && !contentType.toLowerCase().includes('application/json')) {
    return {
      ok: false,
      status: 415,
      code: 'unsupported_media_type',
      message: 'Only application/json is supported',
    };
  }

  // 2. Size check
  if (bodyBuf.length > maxBodyBytes) {
    return {
      ok: false,
      status: 413,
      code: 'payload_too_large',
      message: `Payload exceeds ${maxBodyBytes} bytes`,
    };
  }

  // 3. Encoding check (detect replacement character from invalid UTF-8)
  const str = bodyBuf.toString('utf8');
  if (str.includes('\uFFFD')) {
    // If the original buffer didn't actually contain the replacement char, it's an encoding error
    const originalHasReplacement = bodyBuf.includes(Buffer.from('\uFFFD', 'utf8'));
    if (!originalHasReplacement) {
      return {
        ok: false,
        status: 400,
        code: 'invalid_encoding',
        message: 'Payload contains invalid UTF-8 characters',
      };
    }
  }

  // 4. Depth check
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (char === '\\') {
        escape = true;
      } else if (char === '"') {
        inString = false;
      }
    } else {
      if (char === '"') {
        inString = true;
      } else if (char === '{' || char === '[') {
        depth++;
        if (depth > MAX_JSON_DEPTH) {
          return {
            ok: false,
            status: 400,
            code: 'payload_too_deep',
            message: `JSON nesting exceeds maximum depth of ${MAX_JSON_DEPTH}`,
          };
        }
      } else if (char === '}' || char === ']') {
        depth--;
      }
    }
  }

  // 5. Parse JSON
  let parsed: unknown = null;
  if (str.trim().length > 0) {
    try {
      parsed = JSON.parse(str);
    } catch {
      return {
        ok: false,
        status: 400,
        code: 'invalid_json',
        message: 'Payload is not valid JSON',
      };
    }
  }

  return { ok: true, parsed };
}
