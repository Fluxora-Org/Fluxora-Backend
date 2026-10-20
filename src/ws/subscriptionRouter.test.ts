import { describe, it, expect, beforeEach } from 'vitest';
import { SubscriptionRouter, SubscriptionValidationError } from './subscriptionRouter';

describe('subscriptionRouter input validation', () => {
  let router: SubscriptionRouter;

  beforeEach(() => {
    router = new SubscriptionRouter();
  });

  it('rejects empty input with a typed error', () => {
    expect(() => router.handle('')).toThrow(SubscriptionValidationError);
  });

  it('rejects malformed JSON with a typed error', () => {
    expect(() => router.handle('{not json')).toThrow(SubscriptionValidationError);
  });

  it('rejects oversized input with a typed error', () => {
    const oversized = 'x'.repeat(1024 * 1024);
    expect(() => router.handle(oversized)).toThrow(SubscriptionValidationError);
  });

  it('rejection happens before state is written', () => {
    const before = router.getState();
    expect(() => router.handle('')).toThrow();
    expect(router.getState()).toEqual(before);
  });

  it('caller can tell why input was rejected', () => {
    try {
      router.handle('');
    } catch (e) {
      expect(e).toBeInstanceOf(SubscriptionValidationError);
      expect((e as SubscriptionValidationError).code).toBeDefined();
      expect((e as SubscriptionValidationError).message).toBeTruthy();
    }
  });

  it('valid input is unaffected', () => {
    const result = router.handle(JSON.stringify({ type: 'subscribe', channel: 'test' }));
    expect(result).toBeDefined();
  });
});
