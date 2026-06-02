/**
 * src/scripts/backup-retention.ts
 *
 * S3 Backup Retention Policy Management
 *
 * Classifies S3 backup objects by age and enforces a three-tier retention policy:
 * - Daily:   Keep for 7 days
 * - Weekly:  Keep for 4 weeks (28 days total, starting at day 7)
 * - Monthly: Keep for 12 months (365 days)
 *
 * Usage:
 *   npx ts-node src/scripts/backup-retention.ts [--dry-run] [--prefix <prefix>]
 *
 * Environment variables:
 *   - S3_BACKUP_BUCKET: S3 bucket name for backups (required)
 *   - S3_BACKUP_PREFIX: Optional prefix to filter objects (default: 'backups/')
 *   - AWS_REGION: AWS region (default: 'us-east-1')
 */

import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';

/**
 * Represents a backed-up object with metadata.
 */
interface BackupObject {
  key: string;
  size: number;
  lastModified: Date;
  ageInDays: number;
  classification: 'daily' | 'weekly' | 'monthly' | 'expired';
}

/**
 * Retention policy tiers.
 */
interface RetentionPolicy {
  dailyDays: number;
  weeklyDays: number;
  monthlyDays: number;
}

/**
 * Default three-tier retention policy.
 */
const DEFAULT_POLICY: RetentionPolicy = {
  dailyDays: 7,
  weeklyDays: 28,
  monthlyDays: 365,
};

/**
 * Calculates the age of an object in days.
 */
function calculateAgeInDays(lastModified: Date): number {
  const now = new Date();
  const ageMs = now.getTime() - lastModified.getTime();
  return Math.floor(ageMs / (1000 * 60 * 60 * 24));
}

/**
 * Classifies a backup object based on age and retention policy.
 *
 * Classification logic:
 * - daily (0-7 days):        Keep all daily backups
 * - weekly (8-28 days):      Keep one backup per week (objects from Sundays/first-of-week)
 * - monthly (29-365 days):   Keep one backup per month (objects from 1st of month or close to it)
 * - expired (>365 days):     Mark for deletion
 *
 * For weekly/monthly classification in the age ranges, we identify candidate
 * objects by checking if they're approximately one week or one month apart.
 */
function classifyBackup(object: BackupObject, policy: RetentionPolicy): 'daily' | 'weekly' | 'monthly' | 'expired' {
  const { ageInDays } = object;

  if (ageInDays <= policy.dailyDays) {
    return 'daily';
  }

  if (ageInDays <= policy.weeklyDays) {
    return 'weekly';
  }

  if (ageInDays <= policy.monthlyDays) {
    return 'monthly';
  }

  return 'expired';
}

/**
 * Filters objects to keep only one representative from each tier period.
 * This ensures we don't delete all weekly/monthly backups just because they're
 * all in that age range; we keep one per week/month.
 *
 * For weekly (8-28 days): Groups by week, keeps the most recent of each week.
 * For monthly (29-365 days): Groups by month, keeps the most recent of each month.
 */
function filterRetainedObjects(
  objects: BackupObject[],
  policy: RetentionPolicy,
): BackupObject[] {
  const daily = objects.filter((o) => o.classification === 'daily');
  const weekly = objects.filter((o) => o.classification === 'weekly');
  const monthly = objects.filter((o) => o.classification === 'monthly');
  const expired = objects.filter((o) => o.classification === 'expired');

  // Sort each tier by last modified (newest first)
  weekly.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  monthly.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());

  // For weekly tier, keep one backup per week (7-day window)
  const retainedWeekly: BackupObject[] = [];
  const weekGroups = new Map<number, BackupObject[]>();

  for (const obj of weekly) {
    const weekNumber = Math.floor(obj.ageInDays / 7);
    if (!weekGroups.has(weekNumber)) {
      weekGroups.set(weekNumber, []);
    }
    weekGroups.get(weekNumber)!.push(obj);
  }

  // Keep most recent from each week
  for (const group of weekGroups.values()) {
    group.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
    retainedWeekly.push(group[0]!);
  }

  // For monthly tier, keep one backup per month (30-day window)
  const retainedMonthly: BackupObject[] = [];
  const monthGroups = new Map<number, BackupObject[]>();

  for (const obj of monthly) {
    const monthNumber = Math.floor(obj.ageInDays / 30);
    if (!monthGroups.has(monthNumber)) {
      monthGroups.set(monthNumber, []);
    }
    monthGroups.get(monthNumber)!.push(obj);
  }

  // Keep most recent from each month
  for (const group of monthGroups.values()) {
    group.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
    retainedMonthly.push(group[0]!);
  }

  return [...daily, ...retainedWeekly, ...retainedMonthly];
}

/**
 * Fetches all backup objects from S3.
 */
async function fetchBackupObjects(
  client: S3Client,
  bucket: string,
  prefix: string,
): Promise<BackupObject[]> {
  const objects: BackupObject[] = [];
  let continuationToken: string | undefined;

  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );

    if (response.Contents) {
      for (const item of response.Contents) {
        if (!item.Key || !item.LastModified || item.Size === undefined) continue;

        const ageInDays = calculateAgeInDays(item.LastModified);
        const obj: BackupObject = {
          key: item.Key,
          size: item.Size,
          lastModified: item.LastModified,
          ageInDays,
          classification: 'daily', // Placeholder, will be set after classification
        };

        obj.classification = classifyBackup(obj, DEFAULT_POLICY);
        objects.push(obj);
      }
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return objects;
}

/**
 * Deletes objects from S3.
 */
async function deleteObjects(
  client: S3Client,
  bucket: string,
  keys: string[],
): Promise<{ deleted: number; errors: string[] }> {
  if (keys.length === 0) {
    return { deleted: 0, errors: [] };
  }

  const errors: string[] = [];
  let deleted = 0;

  // S3 DeleteObjects accepts max 1000 objects per call
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);

    try {
      const response = await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: {
            Objects: batch.map((key) => ({ Key: key })),
          },
        }),
      );

      deleted += response.Deleted?.length ?? 0;

      if (response.Errors) {
        for (const error of response.Errors) {
          errors.push(`${error.Key}: ${error.Message}`);
        }
      }
    } catch (error) {
      errors.push(`Batch delete error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { deleted, errors };
}

/**
 * Validates that the S3 bucket exists and is accessible.
 */
async function validateBucket(client: S3Client, bucket: string): Promise<void> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (error) {
    throw new Error(
      `Cannot access S3 bucket "${bucket}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Main retention policy enforcement function.
 */
async function enforceBackupRetention(options: {
  dryRun?: boolean;
  prefix?: string;
}): Promise<void> {
  const bucket = process.env.S3_BACKUP_BUCKET;
  const defaultPrefix = process.env.S3_BACKUP_PREFIX ?? 'backups/';
  const prefix = options.prefix ?? defaultPrefix;
  const region = process.env.AWS_REGION ?? 'us-east-1';
  const dryRun = options.dryRun ?? false;

  // Validate required environment variables
  if (!bucket) {
    throw new Error('S3_BACKUP_BUCKET environment variable is required');
  }

  const client = new S3Client({ region });

  try {
    // Validate bucket access
    console.log(`[INFO] Validating S3 bucket access: ${bucket}`);
    await validateBucket(client, bucket);

    // Fetch all backup objects
    console.log(`[INFO] Fetching backup objects from s3://${bucket}/${prefix}`);
    const allObjects = await fetchBackupObjects(client, bucket, prefix);

    console.log(`[INFO] Found ${allObjects.length} backup objects`);

    if (allObjects.length === 0) {
      console.log('[INFO] No backup objects found. Retention policy enforcement completed.');
      return;
    }

    // Classify and filter objects
    const retained = filterRetainedObjects(allObjects, DEFAULT_POLICY);
    const toDelete = allObjects.filter((obj) => !retained.find((r) => r.key === obj.key));

    // Log classification summary
    const dailyCount = allObjects.filter((o) => o.classification === 'daily').length;
    const weeklyCount = allObjects.filter((o) => o.classification === 'weekly').length;
    const monthlyCount = allObjects.filter((o) => o.classification === 'monthly').length;
    const expiredCount = allObjects.filter((o) => o.classification === 'expired').length;

    console.log('[INFO] Backup classification:');
    console.log(`  Daily (0-${DEFAULT_POLICY.dailyDays} days):      ${dailyCount} objects`);
    console.log(`  Weekly (${DEFAULT_POLICY.dailyDays + 1}-${DEFAULT_POLICY.weeklyDays} days):    ${weeklyCount} objects`);
    console.log(
      `  Monthly (${DEFAULT_POLICY.weeklyDays + 1}-${DEFAULT_POLICY.monthlyDays} days):  ${monthlyCount} objects`,
    );
    console.log(`  Expired (>${DEFAULT_POLICY.monthlyDays} days):   ${expiredCount} objects`);

    console.log(`[INFO] Retention result:`);
    console.log(`  Retaining:  ${retained.length} objects`);
    console.log(`  Deleting:   ${toDelete.length} objects`);

    // Calculate storage savings
    const totalDeleteSize = toDelete.reduce((sum, obj) => sum + obj.size, 0);
    const deleteGiB = totalDeleteSize / (1024 * 1024 * 1024);
    console.log(`  Storage recovery: ~${deleteGiB.toFixed(2)} GiB`);

    if (toDelete.length === 0) {
      console.log('[INFO] No objects to delete. Retention policy is already compliant.');
      return;
    }

    // Log objects to be deleted
    console.log(`[INFO] Objects to be deleted:`);
    for (const obj of toDelete.slice(0, 10)) {
      console.log(`  - ${obj.key} (${(obj.size / 1024 / 1024).toFixed(2)} MiB, ${obj.ageInDays} days old)`);
    }
    if (toDelete.length > 10) {
      console.log(`  ... and ${toDelete.length - 10} more`);
    }

    // Perform deletion (unless dry-run)
    if (dryRun) {
      console.log('[DRY-RUN] Skipping actual deletion.');
      return;
    }

    console.log(`[INFO] Deleting ${toDelete.length} objects from S3...`);
    const deleteResult = await deleteObjects(
      client,
      bucket,
      toDelete.map((obj) => obj.key),
    );

    console.log(`[SUCCESS] Deleted ${deleteResult.deleted} objects`);

    if (deleteResult.errors.length > 0) {
      console.error(`[WARNING] ${deleteResult.errors.length} deletion errors:`);
      for (const error of deleteResult.errors.slice(0, 5)) {
        console.error(`  - ${error}`);
      }
      if (deleteResult.errors.length > 5) {
        console.error(`  ... and ${deleteResult.errors.length - 5} more`);
      }
    }
  } finally {
    client.destroy();
  }
}

/**
 * CLI entry point.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const options = {
    dryRun: args.includes('--dry-run'),
    prefix: undefined as string | undefined,
  };

  // Parse --prefix argument
  const prefixIndex = args.indexOf('--prefix');
  if (prefixIndex !== -1 && prefixIndex + 1 < args.length) {
    options.prefix = args[prefixIndex + 1];
  }

  try {
    console.log('[INFO] Starting S3 backup retention policy enforcement...');
    await enforceBackupRetention(options);
    console.log('[INFO] Retention policy enforcement completed successfully.');
    process.exit(0);
  } catch (error) {
    console.error('[ERROR]', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('[FATAL]', error);
  process.exit(1);
});
