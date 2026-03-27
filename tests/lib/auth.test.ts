import { generateToken, verifyToken, UserPayload } from '../../src/lib/auth.js';

describe('Auth Module', () => {
  const payload: UserPayload = {
    address: 'GCSX2...',
    role: 'operator',
  };

  it('should generate a valid token', () => {
    const token = generateToken(payload);
    expect(token).toBeDefined();
    expect(typeof token).toBe('string');
  });

  it('should verify a valid token', () => {
    const token = generateToken(payload);
    const decoded = verifyToken(token);
    expect(decoded.address).toBe(payload.address);
    expect(decoded.role).toBe(payload.role);
  });

  it('should throw for an invalid token', () => {
    expect(() => verifyToken('invalid-token')).toThrow();
  });

  it('should throw for an expired token or tampered token', () => {
    const token = generateToken(payload);
    const tamperedToken = token + 'a';
    expect(() => verifyToken(tamperedToken)).toThrow();
  });
});
