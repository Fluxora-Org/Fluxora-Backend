/**
 * __mocks__/@aws-sdk/client-s3.ts
 *
 * Test-time stub for the AWS S3 SDK.
 *
 * The @aws-sdk/client-s3 package is not installed as a project dependency
 * (backup-retention.ts is a devops script, not a runtime dependency). This
 * stub satisfies Vitest's module resolver so any test file that transitively
 * imports backup-retention.ts can load without making real AWS calls.
 *
 * S3Client.send is deliberately a prototype method: aws-sdk-client-mock
 * patches the SDK client's prototype when mockClient(S3Client) is created.
 */

import { vi } from 'vitest';

/** Generic no-op S3 command stub. */
export class S3Client {
  send(_command: unknown): Promise<Record<string, never>> {
    return Promise.resolve({});
  }

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
