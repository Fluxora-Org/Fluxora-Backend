import {
  _resetAuditLog,
  buildAuditEntry,
  getAuditEntries,
  writeAuditEntryToDb,
  type AuditDbConnection,
} from '../src/lib/auditLog.js';

describe('audit write durability', () => {
  beforeEach(() => {
    _resetAuditLog();
  });

  it('fails the action and does not expose a record when the audit store is unavailable', () => {
    const entry = buildAuditEntry('STREAM_CREATED', 'stream', 'stream-1', 'corr-1');
    const unavailableStore: AuditDbConnection = {
      prepare: () => {
        throw new Error('audit store unavailable');
      },
    };

    expect(() => writeAuditEntryToDb(unavailableStore, entry)).toThrow('audit store unavailable');
    expect(getAuditEntries()).toEqual([]);
  });

  it('exposes a record only after the store accepts the write', () => {
    const rows: unknown[][] = [];
    const store: AuditDbConnection = {
      prepare: () => ({
        run: (...params: unknown[]) => {
          rows.push(params);
        },
      }),
    };
    const entry = buildAuditEntry('STREAM_CREATED', 'stream', 'stream-2', 'corr-2');

    writeAuditEntryToDb(store, entry);

    expect(rows).toHaveLength(1);
    expect(getAuditEntries()).toEqual([entry]);
  });
});
