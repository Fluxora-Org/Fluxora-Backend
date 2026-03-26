/**
 * Validation module for Fluxora Backend
 * 
 * Provides validation for stream data and other inputs.
 * Ensures amounts and identities remain unambiguous for clients and auditors.
 * 
 * Failure modes:
 * - Invalid input (malformed addresses, negative amounts)
 * - Missing required fields
 * - Type mismatches
 */

export class ValidationError extends Error {
    constructor(
        message: string,
        public field?: string,
        public value?: unknown
    ) {
        super(message);
        this.name = 'ValidationError';
    }
}

/**
 * Validate Stellar account address format
 */
export function validateStellarAddress(address: string, fieldName: string = 'address'): string {
    if (!address || typeof address !== 'string') {
        throw new ValidationError(`${fieldName} must be a non-empty string`, fieldName, address);
    }

    // Stellar public keys start with 'G' and are 56 characters
    if (!/^G[A-Z2-7]{55}$/.test(address)) {
        throw new ValidationError(
            `${fieldName} must be a valid Stellar public key (starts with G, 56 chars)`,
            fieldName,
            address
        );
    }

    return address;
}

/**
 * Validate amount as a positive integer string (stroops)
 */
export function validateAmount(amount: string | number, fieldName: string = 'amount'): string {
    const amountStr = String(amount).trim();

    if (!amountStr) {
        throw new ValidationError(`${fieldName} is required`, fieldName, amount);
    }

    // Must be a valid integer
    if (!/^\d+$/.test(amountStr)) {
        throw new ValidationError(
            `${fieldName} must be a non-negative integer (stroops)`,
            fieldName,
            amount
        );
    }

    const parsed = BigInt(amountStr);

    // Must be positive
    if (parsed <= 0n) {
        throw new ValidationError(`${fieldName} must be greater than 0`, fieldName, amount);
    }

    // Stellar max amount: 922337203685.4775807 XLM = 9223372036854775807 stroops
    const maxAmount = BigInt('9223372036854775807');
    if (parsed > maxAmount) {
        throw new ValidationError(
            `${fieldName} exceeds maximum Stellar amount`,
            fieldName,
            amount
        );
    }

    return amountStr;
}

/**
 * Validate rate per second as a positive integer string (stroops/second)
 */
export function validateRatePerSecond(rate: string | number, fieldName: string = 'ratePerSecond'): string {
    const rateStr = String(rate).trim();

    if (!rateStr) {
        throw new ValidationError(`${fieldName} is required`, fieldName, rate);
    }

    if (!/^\d+$/.test(rateStr)) {
        throw new ValidationError(
            `${fieldName} must be a non-negative integer (stroops/second)`,
            fieldName,
            rate
        );
    }

    const parsed = BigInt(rateStr);

    if (parsed <= 0n) {
        throw new ValidationError(`${fieldName} must be greater than 0`, fieldName, rate);
    }

    return rateStr;
}

/**
 * Validate Unix timestamp (seconds)
 */
export function validateTimestamp(timestamp: number | string, fieldName: string = 'timestamp'): number {
    const ts = typeof timestamp === 'string' ? parseInt(timestamp, 10) : timestamp;

    if (isNaN(ts)) {
        throw new ValidationError(`${fieldName} must be a valid Unix timestamp`, fieldName, timestamp);
    }

    // Timestamp must be in the future or very recent (within 1 hour)
    const now = Math.floor(Date.now() / 1000);
    const oneHourAgo = now - 3600;

    if (ts < oneHourAgo) {
        throw new ValidationError(
            `${fieldName} must be in the future or within the last hour`,
            fieldName,
            timestamp
        );
    }

    return ts;
}

/**
 * Validate stream creation request
 */
export interface CreateStreamRequest {
    sender: string;
    recipient: string;
    depositAmount: string;
    ratePerSecond: string;
    startTime: number;
}

export function validateCreateStreamRequest(data: unknown): CreateStreamRequest {
    if (!data || typeof data !== 'object') {
        throw new ValidationError('Request body must be a JSON object');
    }

    const obj = data as Record<string, unknown>;

    const sender = validateStellarAddress(String(obj.sender ?? ''), 'sender');
    const recipient = validateStellarAddress(String(obj.recipient ?? ''), 'recipient');

    if (sender === recipient) {
        throw new ValidationError('sender and recipient must be different addresses');
    }

    const depositAmount = validateAmount(String(obj.depositAmount ?? ''), 'depositAmount');
    const ratePerSecond = validateRatePerSecond(String(obj.ratePerSecond ?? ''), 'ratePerSecond');
    const startTime = validateTimestamp(Number(obj.startTime ?? 0), 'startTime');

    // Validate that deposit amount is sufficient for at least 1 second of streaming
    const depositBig = BigInt(depositAmount);
    const rateBig = BigInt(ratePerSecond);

    if (depositBig < rateBig) {
        throw new ValidationError(
            'depositAmount must be at least equal to ratePerSecond (minimum 1 second of streaming)'
        );
    }

    return {
        sender,
        recipient,
        depositAmount,
        ratePerSecond,
        startTime,
    };
}

/**
 * Validate stream ID format
 */
export function validateStreamId(id: string, fieldName: string = 'id'): string {
    if (!id || typeof id !== 'string') {
        throw new ValidationError(`${fieldName} must be a non-empty string`, fieldName, id);
    }

    if (!/^stream-\d+$/.test(id)) {
        throw new ValidationError(
            `${fieldName} must match format "stream-{timestamp}"`,
            fieldName,
            id
        );
    }

    return id;
}
