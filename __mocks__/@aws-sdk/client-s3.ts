/**
 * __mocks__/@aws-sdk/client-s3.ts
 *
 * Test-time stub for the AWS S3 SDK.
 *
 * The @aws-sdk/client-s3 package is not installed as a project dependency
 * (backup-retention.ts is a devops script, not a runtime dependency). This
 * stub satisfies Vitest's module resolver so that any test file that
 * transitively imports backup-retention.ts does not fail with
 * "Failed to load url @aws-sdk/client-s3".
 *
 * Individual tests that exercise S3 behaviour should override the mock with
 * vi.mocked() or vi.spyOn() as needed.
 */

import { vi } from 'vitest';

/** Generic no-op S3 command stub. */
export class S3Client {
  send = vi.fn().mockResolvedValue({});
  destroy = vi.fn();
}

export class GetObjectCommand {
  constructor(public input: Record<string, unknown>) {}
}

export class CopyObjectCommand {
  constructor(public input: Record<string, unknown>) {}
}

export class ListObjectsV2Command {
  constructor(public input: Record<string, unknown>) {}
}

export class DeleteObjectsCommand {
  constructor(public input: Record<string, unknown>) {}
}

export class HeadBucketCommand {
  constructor(public input: Record<string, unknown>) {}
}
