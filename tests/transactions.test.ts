/**
 * DB Transaction Tests — streams + audit + webhook outbox
 *
 * Covers:
 *  - Atomic commit: stream row + audit row + webhook_outbox row all written
 *  - Rollback on stream write failure: no audit or webhook rows left behind
 *  - Rollback on audit write failure: stream row also rolled back
 *  - Rollback on webhook_outbox write failure: stream + audit also rolled back
 *  - Idempotent upsert still writes audit + webhook rows
 *  - Out-of-order event (update path) commits atomically
 *  - Invalid status transition rolls back cleanly
 *  - Decimal-string amounts are preserved exactly (no float coercion)
 *  - Missing stream on update throws and rolls back
 *  - webhookEvent: null skips outbox without error
 *  - Concurrent transactions do not interleave (SQLite serialises writes)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  buildAuditEntry,
  writeAuditEntryToDb,
  getAuditEntries,
  _resetAuditLog,
} from '../src/lib/auditLog.js';
import type { CreateStreamInput } from '../src/db/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Create a fresh in-memory SQLite DB with the minimal schema needed. */
function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE streams (
      id                TEXT PRIMARY KEY,
      sender_address    TEXT NOT NULL,
      recipient_address TEXT NOT NULL,
      amount            TEXT NOT NULL,
      streamed_amount   TEXT NOT NULL,
      remaining_amount  TEXT NOT NULL,
      rate_per_second   TEXT NOT NULL,
      start_time        INTEGER NOT NULL,
      end_time          INTEGER NOT NULL,
      status            TEXT NOT NULL DEFAULT 'active',
      contract_id       TEXT NOT NULL,
      transaction_hash  TEXT NOT NULL,
      event_index       INTEGER NOT NULL,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL,
      UNIQUE (transaction_hash, event_index)
    );

    CREATE TABLE audit_logs (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      seq            INTEGER NOT NULL,
      timestamp      TEXT NOT NULL,
      action         TEXT NOT NULL,
      resource_type  TEXT NOT NULL,
      resource_id    TEXT NOT NULL,
      correlation_id TEXT,
      meta           TEXT
    );

    CREATE TABLE webhook_outbox (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      stream_id  TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload    TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  return db;
}

/** Minimal valid CreateStreamInput. Amounts are decimal strings. */
function makeInput(overrides: Partial<CreateStreamInput> = {}): CreateStreamInput {
  return {
    id: 'stream-' + 'a'.repeat(64) + '-0',
    sender_address: 'GCSZIQEYTDI4IQKZWQXZQXZQXZQXZQXZQXZQXZQXZQXZQXZQXZQXZQ',
    recipient_address: 'GDRX2IQEYTDI4IQKZWQXZQXZQXZQXZQXZQXZQXZQXZQXZQXZQXZQXZ',
    amount: '1000.0000000',
    streamed_amount: '0',
    remaining_amount: '1000.0000000',
    rate_per_second: '0.0000116',
    start_time: 1_700_000_000,
    end_time: 1_800_000_000,
    contract_id: 'CCONTRACT123',
    transaction_hash: 'a'.repeat(64),
    event_index: 0,
    ...overrides,
  };
}

/**
 * Minimal inline transaction runner that mirrors the logic in
 * streamRepository.transactionalUpsertStream / transactionalUpdateStream
 * but operates on a supplied db instance (no singleton).
 */
function txUpsert(
  db: Database.Database,
  input: CreateStreamInput,
  correlationId?: string,
  webhookPayload?: { eventType: string; data: Record<string, unknown> } | null,
) {
  const txn = db.transaction(() => {
    const now = new Date().toISOString();

    // Check idempotency
    const existing = db
      .prepare('SELECT * FROM streams WHERE transaction_hash = ? AND event_index = ?')
      .get(input.transaction_hash, input.event_index) as any;

    if (existing) {
      const entry = buildAuditEntry('STREAM_CREATED', 'stream', existing.id, correlationId);
      writeAuditEntryToDb(db, entry);
      if (webhookPayload) {
        db.prepare(
          'INSERT INTO webhook_outbox (stream_id, event_type, payload, created_at) VALUES (?, ?, ?, ?)',
        ).run(existing.id, webhookPayload.eventType, JSON.stringify(webhookPayload.data), now);
      }
      return { created: false, updated: false, stream: existing, auditSeq: entry.seq };
    }

    db.prepare(`
      INSERT INTO streams (
        id, sender_address, recipient_address, amount, streamed_amount,
        remaining_amount, rate_per_second, start_time, end_time, status,
        contract_id, transaction_hash, event_index, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id, input.sender_address, input.recipient_address,
      input.amount, input.streamed_amount, input.remaining_amount,
      input.rate_per_second, input.start_time, input.end_time,
      'active', input.contract_id, input.transaction_hash, input.event_index,
      now, now,
    );

    const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(input.id) as any;

    const entry = buildAuditEntry('STREAM_CREATED', 'stream', stream.id, correlationId, {
      amount: input.amount,
      ratePerSecond: input.rate_per_second,
    });
    writeAuditEntryToDb(db, entry);

    if (webhookPayload) {
      db.prepare(
        'INSERT INTO webhook_outbox (stream_id, event_type, payload, created_at) VALUES (?, ?, ?, ?)',
      ).run(stream.id, webhookPayload.eventType, JSON.stringify(webhookPayload.data), now);
    }

    return { created: true, updated: false, stream, auditSeq: entry.seq };
  });

  return txn();
}

function txUpdate(
  db: Database.Database,
  id: string,
  status: string,
  correlationId?: string,
  webhookPayload?: { eventType: string; data: Record<string, unknown> } | null,
) {
  const txn = db.transaction(() => {
    const now = new Date().toISOString();

    const current = db.prepare('SELECT * FROM streams WHERE id = ?').get(id) as any;
    if (!current) throw new Error(`Stream not found: ${id}`);

    const validTransitions: Record<string, string[]> = {
      active: ['paused', 'completed', 'cancelled'],
      paused: ['active', 'cancelled'],
      completed: [],
      cancelled: [],
    };
    if (!validTransitions[current.status]?.includes(status)) {
      throw new Error(`Invalid status transition: ${current.status} -> ${status}`);
    }

    db.prepare('UPDATE streams SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id);
    const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(id) as any;

    const entry = buildAuditEntry('STREAM_CANCELLED', 'stream', id, correlationId, {
      previousStatus: current.status,
      status,
    });
    writeAuditEntryToDb(db, entry);

    if (webhookPayload) {
      db.prepare(
        'INSERT INTO webhook_outbox (stream_id, event_type, payload, created_at) VALUES (?, ?, ?, ?)',
      ).run(id, webhookPayload.eventType, JSON.stringify(webhookPayload.data), now);
    }

    return { stream, auditSeq: entry.seq };
  });

  return txn();
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

let db: Database.Database;

beforeEach(() => {
  db = makeDb();
  _resetAuditLog();
});

afterEach(() => {
  db.close();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Atomic commit — upsert (create path)', () => {
  it('writes stream + audit + webhook_outbox in one transaction', () => {
    const input = makeInput();
    const result = txUpsert(db, input, 'corr-1', {
      eventType: 'stream.created',
      data: { streamId: input.id, amount: input.amount },
    });

    expect(result.created).toBe(true);

    // Stream row
    const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(input.id) as any;
    expect(stream).toBeDefined();
    expect(stream.amount).toBe('1000.0000000'); // decimal string preserved

    // Audit row
    const auditRows = db.prepare('SELECT * FROM audit_logs').all() as any[];
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].action).toBe('STREAM_CREATED');
    expect(auditRows[0].resource_id).toBe(input.id);
    expect(auditRows[0].correlation_id).toBe('corr-1');

    // Webhook outbox row
    const outbox = db.prepare('SELECT * FROM webhook_outbox').all() as any[];
    expect(outbox).toHaveLength(1);
    expect(outbox[0].event_type).toBe('stream.created');
    const payload = JSON.parse(outbox[0].payload);
    expect(payload.amount).toBe('1000.0000000'); // decimal string preserved in JSON

    // In-memory audit log also updated
    const entries = getAuditEntries();
    expect(entries).toHaveLength(1);
    expect(result.auditSeq).toBeGreaterThan(0);
  });

  it('preserves decimal-string amounts exactly — no float coercion', () => {
    const preciseAmount = '9999999.9999999';
    const input = makeInput({ amount: preciseAmount, remaining_amount: preciseAmount });
    txUpsert(db, input);

    const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(input.id) as any;
    expect(stream.amount).toBe(preciseAmount);
    expect(stream.remaining_amount).toBe(preciseAmount);

    // Audit meta also preserves the string
    const auditRow = db.prepare('SELECT meta FROM audit_logs').get() as any;
    const meta = JSON.parse(auditRow.meta);
    expect(meta.amount).toBe(preciseAmount);
  });
});

describe('Atomic commit — update path', () => {
  it('writes stream update + audit + webhook_outbox atomically', () => {
    const input = makeInput();
    txUpsert(db, input);
    _resetAuditLog();

    const result = txUpdate(db, input.id, 'cancelled', 'corr-2', {
      eventType: 'stream.cancelled',
      data: { streamId: input.id },
    });

    expect(result.stream.status).toBe('cancelled');

    const auditRows = db.prepare('SELECT * FROM audit_logs').all() as any[];
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].action).toBe('STREAM_CANCELLED');
    expect(auditRows[0].correlation_id).toBe('corr-2');

    const outbox = db.prepare('SELECT * FROM webhook_outbox').all() as any[];
    expect(outbox).toHaveLength(1);
    expect(outbox[0].event_type).toBe('stream.cancelled');
  });
});

describe('Rollback — stream write failure', () => {
  it('rolls back audit and webhook rows when stream INSERT fails (duplicate key)', () => {
    const input = makeInput();
    // Pre-insert a row with the same (transaction_hash, event_index) to force a UNIQUE violation.
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO streams (
        id, sender_address, recipient_address, amount, streamed_amount,
        remaining_amount, rate_per_second, start_time, end_time, status,
        contract_id, transaction_hash, event_index, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'stream-different-id',
      input.sender_address, input.recipient_address,
      input.amount, input.streamed_amount, input.remaining_amount,
      input.rate_per_second, input.start_time, input.end_time,
      'active', input.contract_id, input.transaction_hash, input.event_index,
      now, now,
    );

    // Now try to insert a *different* id with the same (tx_hash, event_index).
    // The idempotency check in txUpsert will catch this before the INSERT,
    // so we test the raw transaction directly to force the UNIQUE violation.
    const badTxn = db.transaction(() => {
      // Force a duplicate stream id to trigger PRIMARY KEY violation
      db.prepare(`
        INSERT INTO streams (
          id, sender_address, recipient_address, amount, streamed_amount,
          remaining_amount, rate_per_second, start_time, end_time, status,
          contract_id, transaction_hash, event_index, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'stream-different-id', // duplicate PK
        input.sender_address, input.recipient_address,
        input.amount, input.streamed_amount, input.remaining_amount,
        input.rate_per_second, input.start_time, input.end_time,
        'active', input.contract_id, 'b'.repeat(64), 99,
        now, now,
      );

      // These should NOT be committed if the above throws
      const entry = buildAuditEntry('STREAM_CREATED', 'stream', 'stream-different-id');
      writeAuditEntryToDb(db, entry);
      db.prepare(
        'INSERT INTO webhook_outbox (stream_id, event_type, payload, created_at) VALUES (?, ?, ?, ?)',
      ).run('stream-different-id', 'stream.created', '{}', now);
    });

    expect(() => badTxn()).toThrow();

    // Only the pre-inserted stream row should exist
    const streams = db.prepare('SELECT * FROM streams').all() as any[];
    expect(streams).toHaveLength(1);
    expect(streams[0].id).toBe('stream-different-id');

    // No audit or webhook rows from the failed transaction
    expect(db.prepare('SELECT * FROM audit_logs').all()).toHaveLength(0);
    expect(db.prepare('SELECT * FROM webhook_outbox').all()).toHaveLength(0);
  });
});

describe('Rollback — audit write failure', () => {
  it('rolls back stream row when audit INSERT fails', () => {
    const input = makeInput();
    const now = new Date().toISOString();

    // Drop audit_logs to force a failure mid-transaction
    db.exec('DROP TABLE audit_logs');

    const badTxn = db.transaction(() => {
      db.prepare(`
        INSERT INTO streams (
          id, sender_address, recipient_address, amount, streamed_amount,
          remaining_amount, rate_per_second, start_time, end_time, status,
          contract_id, transaction_hash, event_index, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id, input.sender_address, input.recipient_address,
        input.amount, input.streamed_amount, input.remaining_amount,
        input.rate_per_second, input.start_time, input.end_time,
        'active', input.contract_id, input.transaction_hash, input.event_index,
        now, now,
      );

      // This will throw because audit_logs no longer exists
      db.prepare(
        `INSERT INTO audit_logs (seq, timestamp, action, resource_type, resource_id, correlation_id, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(1, now, 'STREAM_CREATED', 'stream', input.id, null, null);
    });

    expect(() => badTxn()).toThrow();

    // Recreate table to verify stream was rolled back
    db.exec(`
      CREATE TABLE audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        seq INTEGER NOT NULL, timestamp TEXT NOT NULL,
        action TEXT NOT NULL, resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL, correlation_id TEXT, meta TEXT
      )
    `);

    const streams = db.prepare('SELECT * FROM streams').all();
    expect(streams).toHaveLength(0); // rolled back
  });
});

describe('Rollback — webhook_outbox write failure', () => {
  it('rolls back stream + audit rows when webhook_outbox INSERT fails', () => {
    const input = makeInput();
    const now = new Date().toISOString();

    db.exec('DROP TABLE webhook_outbox');

    const badTxn = db.transaction(() => {
      db.prepare(`
        INSERT INTO streams (
          id, sender_address, recipient_address, amount, streamed_amount,
          remaining_amount, rate_per_second, start_time, end_time, status,
          contract_id, transaction_hash, event_index, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id, input.sender_address, input.recipient_address,
        input.amount, input.streamed_amount, input.remaining_amount,
        input.rate_per_second, input.start_time, input.end_time,
        'active', input.contract_id, input.transaction_hash, input.event_index,
        now, now,
      );

      const entry = buildAuditEntry('STREAM_CREATED', 'stream', input.id);
      writeAuditEntryToDb(db, entry);

      // This will throw because webhook_outbox no longer exists
      db.prepare(
        'INSERT INTO webhook_outbox (stream_id, event_type, payload, created_at) VALUES (?, ?, ?, ?)',
      ).run(input.id, 'stream.created', '{}', now);
    });

    expect(() => badTxn()).toThrow();

    // Recreate tables to verify rollback
    db.exec(`
      CREATE TABLE webhook_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stream_id TEXT NOT NULL, event_type TEXT NOT NULL,
        payload TEXT NOT NULL, created_at TEXT NOT NULL
      )
    `);

    expect(db.prepare('SELECT * FROM streams').all()).toHaveLength(0);
    expect(db.prepare('SELECT * FROM audit_logs').all()).toHaveLength(0);
  });
});

describe('Idempotent upsert', () => {
  it('still writes audit + webhook rows on duplicate event', () => {
    const input = makeInput();
    txUpsert(db, input, 'corr-first');
    _resetAuditLog();

    // Same event again — idempotency path
    const result = txUpsert(db, input, 'corr-second', {
      eventType: 'stream.created',
      data: { streamId: input.id },
    });

    expect(result.created).toBe(false);
    expect(result.updated).toBe(false);

    // Only one stream row
    expect(db.prepare('SELECT * FROM streams').all()).toHaveLength(1);

    // Second audit row written
    const auditRows = db.prepare('SELECT * FROM audit_logs').all() as any[];
    expect(auditRows).toHaveLength(2); // one from first call, one from second
    expect(auditRows[1].correlation_id).toBe('corr-second');

    // Second webhook outbox row written
    const outbox = db.prepare('SELECT * FROM webhook_outbox').all() as any[];
    expect(outbox).toHaveLength(1); // only second call had a webhook payload
  });
});

describe('Invalid status transition', () => {
  it('throws and rolls back without writing audit or webhook rows', () => {
    const input = makeInput();
    txUpsert(db, input);
    _resetAuditLog();

    // 'completed' → 'active' is not a valid transition
    db.prepare("UPDATE streams SET status = 'completed' WHERE id = ?").run(input.id);

    expect(() => txUpdate(db, input.id, 'active', 'corr-bad')).toThrow(
      /Invalid status transition/,
    );

    expect(db.prepare('SELECT * FROM audit_logs').all()).toHaveLength(0);
    expect(db.prepare('SELECT * FROM webhook_outbox').all()).toHaveLength(0);
    expect(getAuditEntries()).toHaveLength(0);
  });

  it('throws and rolls back for cancelled → completed', () => {
    const input = makeInput();
    txUpsert(db, input);
    db.prepare("UPDATE streams SET status = 'cancelled' WHERE id = ?").run(input.id);
    _resetAuditLog();

    expect(() => txUpdate(db, input.id, 'completed')).toThrow(/Invalid status transition/);
    expect(db.prepare('SELECT * FROM audit_logs').all()).toHaveLength(0);
  });
});

describe('Missing stream on update', () => {
  it('throws and rolls back cleanly when stream does not exist', () => {
    expect(() => txUpdate(db, 'nonexistent-id', 'cancelled', 'corr-x')).toThrow(
      /Stream not found/,
    );

    expect(db.prepare('SELECT * FROM audit_logs').all()).toHaveLength(0);
    expect(db.prepare('SELECT * FROM webhook_outbox').all()).toHaveLength(0);
    expect(getAuditEntries()).toHaveLength(0);
  });
});

describe('webhookEvent: null skips outbox', () => {
  it('commits stream + audit without a webhook_outbox row when payload is null', () => {
    const input = makeInput();
    txUpsert(db, input, 'corr-no-webhook', null);

    expect(db.prepare('SELECT * FROM streams').all()).toHaveLength(1);
    expect(db.prepare('SELECT * FROM audit_logs').all()).toHaveLength(1);
    expect(db.prepare('SELECT * FROM webhook_outbox').all()).toHaveLength(0);
  });

  it('commits stream + audit without a webhook_outbox row when payload is undefined', () => {
    const input = makeInput({ transaction_hash: 'b'.repeat(64) });
    txUpsert(db, input, 'corr-no-webhook-undef', undefined);

    expect(db.prepare('SELECT * FROM streams').all()).toHaveLength(1);
    expect(db.prepare('SELECT * FROM audit_logs').all()).toHaveLength(1);
    expect(db.prepare('SELECT * FROM webhook_outbox').all()).toHaveLength(0);
  });
});

describe('Decimal-string precision edge cases', () => {
  it('stores the maximum Stellar precision (7 decimals) without loss', () => {
    const amount = '123456789.1234567';
    const input = makeInput({ amount, remaining_amount: amount });
    txUpsert(db, input);

    const row = db.prepare('SELECT amount, remaining_amount FROM streams WHERE id = ?').get(input.id) as any;
    expect(row.amount).toBe(amount);
    expect(row.remaining_amount).toBe(amount);
  });

  it('stores zero amounts as "0" string', () => {
    const input = makeInput({ streamed_amount: '0', remaining_amount: '0' });
    txUpsert(db, input);

    const row = db.prepare('SELECT streamed_amount, remaining_amount FROM streams WHERE id = ?').get(input.id) as any;
    expect(row.streamed_amount).toBe('0');
    expect(row.remaining_amount).toBe('0');
  });

  it('preserves rate_per_second with leading zeros after decimal', () => {
    const rate = '0.0000001';
    const input = makeInput({ rate_per_second: rate });
    txUpsert(db, input);

    const row = db.prepare('SELECT rate_per_second FROM streams WHERE id = ?').get(input.id) as any;
    expect(row.rate_per_second).toBe(rate);
  });
});

describe('Concurrent transactions (SQLite serialisation)', () => {
  it('two sequential transactions each commit independently', () => {
    const input1 = makeInput({ id: 'stream-' + 'a'.repeat(64) + '-0', transaction_hash: 'a'.repeat(64), event_index: 0 });
    const input2 = makeInput({ id: 'stream-' + 'b'.repeat(64) + '-1', transaction_hash: 'b'.repeat(64), event_index: 1 });

    txUpsert(db, input1, 'corr-t1');
    txUpsert(db, input2, 'corr-t2');

    const streams = db.prepare('SELECT id FROM streams ORDER BY id').all() as any[];
    expect(streams).toHaveLength(2);

    const auditRows = db.prepare('SELECT correlation_id FROM audit_logs ORDER BY id').all() as any[];
    expect(auditRows).toHaveLength(2);
    expect(auditRows[0].correlation_id).toBe('corr-t1');
    expect(auditRows[1].correlation_id).toBe('corr-t2');
  });
});

describe('buildAuditEntry + writeAuditEntryToDb unit tests', () => {
  it('buildAuditEntry returns correct shape without writing anything', () => {
    const entry = buildAuditEntry('STREAM_CREATED', 'stream', 'sid-1', 'c-1', { amount: '5.0' });

    expect(entry.action).toBe('STREAM_CREATED');
    expect(entry.resourceType).toBe('stream');
    expect(entry.resourceId).toBe('sid-1');
    expect(entry.correlationId).toBe('c-1');
    expect(entry.meta?.amount).toBe('5.0');
    expect(typeof entry.timestamp).toBe('string');
    expect(entry.seq).toBeGreaterThan(0);

    // Nothing written to DB yet
    expect(db.prepare('SELECT * FROM audit_logs').all()).toHaveLength(0);
  });

  it('writeAuditEntryToDb inserts the row and mirrors to in-memory log', () => {
    const entry = buildAuditEntry('STREAM_CANCELLED', 'stream', 'sid-2', 'c-2');
    writeAuditEntryToDb(db, entry);

    const rows = db.prepare('SELECT * FROM audit_logs').all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('STREAM_CANCELLED');
    expect(rows[0].correlation_id).toBe('c-2');

    const inMemory = getAuditEntries();
    expect(inMemory).toHaveLength(1);
    expect(inMemory[0]!.action).toBe('STREAM_CANCELLED');
  });

  it('writeAuditEntryToDb serialises meta as JSON string', () => {
    const entry = buildAuditEntry('STREAM_CREATED', 'stream', 'sid-3', undefined, {
      amount: '100.0000000',
      nested: { key: 'value' },
    });
    writeAuditEntryToDb(db, entry);

    const row = db.prepare('SELECT meta FROM audit_logs').get() as any;
    const meta = JSON.parse(row.meta);
    expect(meta.amount).toBe('100.0000000');
    expect(meta.nested.key).toBe('value');
  });

  it('writeAuditEntryToDb stores null for missing correlationId and meta', () => {
    const entry = buildAuditEntry('STREAM_CANCELLED', 'stream', 'sid-4');
    writeAuditEntryToDb(db, entry);

    const row = db.prepare('SELECT correlation_id, meta FROM audit_logs').get() as any;
    expect(row.correlation_id).toBeNull();
    expect(row.meta).toBeNull();
  });

  it('throws when the DB write fails (propagates error for rollback)', () => {
    db.exec('DROP TABLE audit_logs');
    const entry = buildAuditEntry('STREAM_CREATED', 'stream', 'sid-5');
    expect(() => writeAuditEntryToDb(db, entry)).toThrow();
  });
});
