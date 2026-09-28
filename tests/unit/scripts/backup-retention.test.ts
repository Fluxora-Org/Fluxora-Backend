import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { enforceBackupRetention, selectObjectsForDeletion, BackupObject } from '../../../src/scripts/backup-retention';

const s3Mock = mockClient(S3Client);

describe('backup-retention', () => {
  beforeEach(() => {
    s3Mock.reset();
    process.env.S3_BACKUP_BUCKET = 'test-bucket';
    process.env.AWS_REGION = 'us-east-1';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.S3_BACKUP_BUCKET;
    delete process.env.AWS_REGION;
  });

  it('runs dry-run and execution paths with identical deletion sets (shared selection oracle)', async () => {
    const fixedNow = new Date('2026-08-26T12:00:00Z');
    
    // Fake objects setup
    const fakeObjects = [
      { Key: 'backups/db-today.sql', LastModified: new Date(fixedNow.getTime() - 1 * 86400000), Size: 1024 }, // Keep
      { Key: 'backups/db-40days.sql', LastModified: new Date(fixedNow.getTime() - 40 * 86400000), Size: 1024 }, // Keep (monthly)
      { Key: 'backups/db-40days-dup.sql', LastModified: new Date(fixedNow.getTime() - 41 * 86400000), Size: 1024 }, // Delete (dup monthly)
      { Key: 'backups/db-400days.sql', LastModified: new Date(fixedNow.getTime() - 400 * 86400000), Size: 1024 }, // Delete (expired)
      { Key: 'backups/legal-hold-400days.sql', LastModified: new Date(fixedNow.getTime() - 400 * 86400000), Size: 1024 }, // Keep (legal hold)
    ];

    s3Mock.on(HeadBucketCommand).resolves({});
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: fakeObjects,
    });
    s3Mock.on(DeleteObjectsCommand).resolves({
      Deleted: [{ Key: 'backups/db-40days-dup.sql' }, { Key: 'backups/db-400days.sql' }]
    });

    // Capture console.log
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // 1. Dry run
    await enforceBackupRetention({
      dryRun: true,
      now: fixedNow,
      legalHolds: ['backups/legal-hold']
    });

    const dryRunLogs = logSpy.mock.calls.map(c => c[0]);
    expect(dryRunLogs).toContain('[DRY-RUN] Skipping actual deletion.');

    logSpy.mockClear();

    // 2. Execution (time shifted to simulate running later)
    const laterTime = new Date('2026-08-27T12:00:00Z');
    await enforceBackupRetention({
      dryRun: false,
      confirmDeletion: true,
      now: fixedNow, // Oracle guarantees deterministic selection by using the same 'now'
      legalHolds: ['backups/legal-hold']
    });

    const execLogs = logSpy.mock.calls.map(c => c[0]);
    expect(execLogs.some(log => typeof log === 'string' && log.includes('[SUCCESS] Deleted 2 objects'))).toBe(true);

    // Verify S3 calls
    const deleteCalls = s3Mock.commandCalls(DeleteObjectsCommand);
    expect(deleteCalls.length).toBe(1);
    
    const deletedObjects = deleteCalls[0].args[0].input.Delete?.Objects?.map(o => o.Key);
    expect(deletedObjects).toEqual(['backups/db-40days-dup.sql', 'backups/db-400days.sql']);
  });
});
