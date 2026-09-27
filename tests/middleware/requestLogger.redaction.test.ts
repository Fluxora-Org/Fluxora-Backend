/**
 * Dedicated request-logger credential-redaction contract (issue #1472).
 *
 * A request carrying every credential form the PII policy names - the
 * Authorization header, cookies, and token/password-bearing body fields - must
 * be logged without any of those values reaching the output. These tests pin
 * that guarantee so a future change that starts logging headers or bodies
 * cannot silently leak credentials.
 */

import { EventEmitter } from 'node:events';
import type { NextFunction, Request, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestLoggerMiddleware } from '../../src/middleware/requestLogger';
import { logger } from '../../src/lib/logger.js';
import { redactableFields } from '../../src/pii/policy.js';

const AUTH_HEADER = 'Bearer super-secret-bearer-1472';
const AUTH_TOKEN = 'super-secret-bearer-1472';
const COOKIE = 'session=super-secret-cookie-1472';
const COOKIE_VALUE = 'super-secret-cookie-1472';
const BODY_TOKEN = 'super-secret-body-token-1472';
const BODY_PASSWORD = 'super-secret-password-1472';

const FORBIDDEN_VALUES = [
  AUTH_HEADER,
  AUTH_TOKEN,
  COOKIE,
  COOKIE_VALUE,
  BODY_TOKEN,
  BODY_PASSWORD,
];

function captureWrites(): { output: () => string; restore: () => void } {
  const chunks: string[] = [];
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = ((chunk: string) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return {
    output: () => chunks.join(''),
    restore: () => {
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
    },
  };
}

function fakeRequest(): Request {
  return {
    correlationId: 'corr-1472',
    method: 'POST',
    path: '/api/secret',
    headers: {
      authorization: AUTH_HEADER,
      cookie: COOKIE,
    },
    body: {
      token: BODY_TOKEN,
      password: BODY_PASSWORD,
    },
    query: {},
  } as unknown as Request;
}

function fakeResponse(statusCode = 200): Response & EventEmitter {
  const res = new EventEmitter() as Response & EventEmitter;
  (res as unknown as { statusCode: number }).statusCode = statusCode;
  return res;
}

function expectNoCredentials(output: string): void {
  for (const secret of FORBIDDEN_VALUES) {
    expect(output).not.toContain(secret);
  }
}

describe('request logger credential redaction (#1472)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('never writes the authorization header, cookies, or token-bearing body fields', () => {
    const capture = captureWrites();
    try {
      const res = fakeResponse(200);
      requestLoggerMiddleware(fakeRequest(), res, (() => undefined) as NextFunction);
      res.emit('finish');
    } finally {
      capture.restore();
    }

    expectNoCredentials(capture.output());
  });

  it('never writes credentials for a 5xx response either', () => {
    const capture = captureWrites();
    try {
      const res = fakeResponse(503);
      requestLoggerMiddleware(fakeRequest(), res, (() => undefined) as NextFunction);
      res.emit('finish');
    } finally {
      capture.restore();
    }

    expectNoCredentials(capture.output());
  });

  it('does not hand credentials to the logger as metadata', () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const res = fakeResponse(200);

    requestLoggerMiddleware(fakeRequest(), res, (() => undefined) as NextFunction);
    res.emit('finish');

    for (const call of [...info.mock.calls, ...error.mock.calls]) {
      expectNoCredentials(JSON.stringify(call));
    }
  });

  it('redacts credentials even if they are handed to the logger directly', () => {
    // Belt-and-suspenders: if the middleware is later extended to log headers or
    // bodies, the sanitizer must still strip every policy-named field.
    const capture = captureWrites();
    try {
      const meta: Record<string, unknown> = {};
      for (const field of redactableFields()) {
        meta[field] = BODY_TOKEN;
      }
      logger.info(`authorization=${AUTH_HEADER}; cookie=${COOKIE}`, 'corr-1472', meta);
    } finally {
      capture.restore();
    }

    expectNoCredentials(capture.output());
  });
});
