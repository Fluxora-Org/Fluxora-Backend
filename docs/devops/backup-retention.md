# S3 Backup Retention Policy

## Overview

This document describes the S3 backup retention lifecycle policy for the Fluxora backend. A three-tier retention strategy is enforced to manage backup storage costs while maintaining sufficient recovery points:

- **Daily**: 7 days (all daily backups)
- **Weekly**: 28 days (one backup per week)
- **Monthly**: 365 days (one backup per month)
- **Expired**: Objects older than 365 days are deleted

This policy ensures compliance with audit requirements, reduces unbounded storage growth, and provides flexible recovery windows without excessive costs.

## Retention Policy Details

| Tier | Age Range | Retention | Strategy |
|------|-----------|-----------|----------|
| Daily | 0-7 days | Keep all | Frequent recovery points for incident response |
| Weekly | 8-28 days | Keep one per week | Balanced retention as incidents age |
| Monthly | 29-365 days | Keep one per month | Long-term recovery capability |
| Expired | 365+ days | Delete all | Automatic cleanup of old backups |

## Implementation

### Script-Based Enforcement

The backup retention policy is enforced via `src/scripts/backup-retention.ts`, a Node.js/TypeScript utility that:

1. **Lists** all objects in the S3 backup bucket with the configured prefix
2. **Classifies** each object by age (daily/weekly/monthly/expired)
3. **Filters** to keep only required backups (one per week/month in respective tiers)
4. **Deletes** expired and redundant objects
5. **Reports** on classification, retention, and storage recovery

#### Usage

```bash
# Standard run (deletes expired backups)
npx ts-node src/scripts/backup-retention.ts

# Dry-run mode (no deletions, shows what would be deleted)
npx ts-node src/scripts/backup-retention.ts --dry-run

# Custom prefix (non-default backup location)
npx ts-node src/scripts/backup-retention.ts --prefix custom/backups/

# Combine options
npx ts-node src/scripts/backup-retention.ts --dry-run --prefix archive/
```

#### Environment Variables

```bash
# Required
S3_BACKUP_BUCKET=my-database-backups

# Optional (defaults shown)
S3_BACKUP_PREFIX=backups/
AWS_REGION=us-east-1
```

#### Example Output

```
[INFO] Starting S3 backup retention policy enforcement...
[INFO] Validating S3 bucket access: my-database-backups
[INFO] Fetching backup objects from s3://my-database-backups/backups/
[INFO] Found 95 backup objects
[INFO] Backup classification:
  Daily (0-7 days):      7 objects
  Weekly (8-28 days):    12 objects
  Monthly (29-365 days): 52 objects
  Expired (>365 days):   24 objects
[INFO] Retention result:
  Retaining:  32 objects
  Deleting:   63 objects
  Storage recovery: ~450.25 GiB
[INFO] Objects to be deleted:
  - backups/db-2025-05-20.sql.gz (2500.00 MiB, 406 days old)
  - backups/db-2025-05-19.sql.gz (2500.00 MiB, 407 days old)
  - backups/db-2025-05-15.sql.gz (2500.00 MiB, 411 days old)
  - backups/db-2025-05-14.sql.gz (2500.00 MiB, 412 days old)
  - backups/db-2025-05-13.sql.gz (2500.00 MiB, 413 days old)
  ... and 58 more
[SUCCESS] Deleted 63 objects
```

#### Error Handling

The script gracefully handles:

- **Missing environment variables**: Fails with clear error message
- **S3 bucket not found**: Validates bucket access before processing
- **Permission errors**: Reports specific AWS SDK errors
- **Deletion failures**: Continues with other batches, reports errors at end
- **Empty bucket**: Completes successfully with no action

### AWS CLI Alternative

For environments without Node.js/TypeScript, use the AWS CLI directly:

```bash
# List all backups older than 365 days
aws s3api list-objects-v2 \
  --bucket my-database-backups \
  --prefix backups/ \
  --query 'Contents[?LastModified<`2025-05-31`].[Key, LastModified]' \
  --output table

# Delete a specific old backup
aws s3 rm s3://my-database-backups/backups/db-2025-01-01.sql.gz

# Delete all backups older than 365 days (CAUTION: irreversible)
aws s3api list-objects-v2 \
  --bucket my-database-backups \
  --prefix backups/ \
  --query 'Contents[?LastModified<`2025-05-31`].Key' \
  --output text | \
  xargs -I {} aws s3 rm s3://my-database-backups/{}
```

## Lifecycle Policy Configuration

### Option 1: AWS CLI

Configure S3 lifecycle rules using the AWS CLI:

```bash
# Create lifecycle policy file
cat > lifecycle-policy.json <<'EOF'
{
  "Rules": [
    {
      "Id": "backup-retention-daily",
      "Status": "Enabled",
      "Filter": {
        "Prefix": "backups/",
        "Tags": [
          {
            "Key": "backup-tier",
            "Value": "daily"
          }
        ]
      },
      "Expiration": {
        "Days": 7
      }
    },
    {
      "Id": "backup-retention-weekly",
      "Status": "Enabled",
      "Filter": {
        "Prefix": "backups/",
        "Tags": [
          {
            "Key": "backup-tier",
            "Value": "weekly"
          }
        ]
      },
      "Expiration": {
        "Days": 28
      }
    },
    {
      "Id": "backup-retention-monthly",
      "Status": "Enabled",
      "Filter": {
        "Prefix": "backups/",
        "Tags": [
          {
            "Key": "backup-tier",
            "Value": "monthly"
          }
        ]
      },
      "Expiration": {
        "Days": 365
      }
    }
  ]
}
EOF

# Apply lifecycle policy
aws s3api put-bucket-lifecycle-configuration \
  --bucket my-database-backups \
  --lifecycle-configuration file://lifecycle-policy.json
```

### Option 2: Terraform

Define S3 lifecycle rules in Terraform (recommended for IaC):

```hcl
# main.tf or s3.tf

resource "aws_s3_bucket" "backup_bucket" {
  bucket = var.backup_bucket_name

  tags = {
    Name        = "Database Backups"
    Environment = var.environment
    Component   = "backup-retention"
  }
}

resource "aws_s3_bucket_versioning" "backup_bucket_versioning" {
  bucket = aws_s3_bucket.backup_bucket.id

  versioning_configuration {
    status = "Enabled"
  }
}

# Lifecycle policy: Delete old backups to manage costs
resource "aws_s3_bucket_lifecycle_configuration" "backup_bucket_lifecycle" {
  bucket = aws_s3_bucket.backup_bucket.id

  depends_on = [aws_s3_bucket_versioning.backup_bucket_versioning]

  rule {
    id     = "backup-retention-policy"
    status = "Enabled"

    filter {
      prefix = "backups/"
    }

    # Delete all backups older than 365 days
    expiration {
      days = 365
    }

    # Optional: Transition to Glacier for cost optimization (keep in S3 Standard for fast recovery)
    # transition {
    #   days          = 90
    #   storage_class = "GLACIER"
    # }

    # Optional: Delete old versions of versioned objects
    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }

  # Optional: Separate rule for incomplete multipart uploads (clean up failed backups)
  rule {
    id     = "cleanup-incomplete-uploads"
    status = "Enabled"

    filter {
      prefix = "backups/"
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# Optional: S3 bucket versioning for additional safety
# (enables point-in-time recovery for accidentally deleted backups)
resource "aws_s3_bucket_public_access_block" "backup_bucket_pab" {
  bucket = aws_s3_bucket.backup_bucket.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Optional: Encryption for backups
resource "aws_s3_bucket_server_side_encryption_configuration" "backup_bucket_sse" {
  bucket = aws_s3_bucket.backup_bucket.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Optional: Logging for audit/compliance
resource "aws_s3_bucket_logging" "backup_bucket_logging" {
  bucket = aws_s3_bucket.backup_bucket.id

  target_bucket = aws_s3_bucket.log_bucket.id
  target_prefix = "backups/"
}

# Variables
variable "backup_bucket_name" {
  type        = string
  description = "Name of the S3 bucket for database backups"
  default     = "fluxora-db-backups"
}

variable "environment" {
  type        = string
  description = "Environment name (dev, staging, prod)"
}

# Output
output "backup_bucket_name" {
  value       = aws_s3_bucket.backup_bucket.id
  description = "S3 bucket name for backups"
}
```

Apply with Terraform:

```bash
# Initialize Terraform
terraform init

# Review changes
terraform plan

# Apply configuration
terraform apply

# Verify lifecycle policy
aws s3api get-bucket-lifecycle-configuration --bucket my-database-backups
```

## CI/CD Integration

### GitHub Actions

Integrate backup retention into your GitHub Actions CI/CD pipeline:

```yaml
# .github/workflows/backup-retention.yml

name: S3 Backup Retention Policy

on:
  schedule:
    # Run daily at 2 AM UTC
    - cron: '0 2 * * *'
  workflow_dispatch:

jobs:
  enforce-retention:
    runs-on: ubuntu-latest
    
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'

      - name: Install dependencies
        run: pnpm install

      - name: Enforce S3 backup retention policy (dry-run)
        env:
          S3_BACKUP_BUCKET: ${{ secrets.S3_BACKUP_BUCKET }}
          S3_BACKUP_PREFIX: backups/
          AWS_REGION: ${{ secrets.AWS_REGION }}
          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
        run: npx ts-node src/scripts/backup-retention.ts --dry-run

      - name: Enforce S3 backup retention policy (production)
        if: github.ref == 'refs/heads/main'
        env:
          S3_BACKUP_BUCKET: ${{ secrets.S3_BACKUP_BUCKET }}
          S3_BACKUP_PREFIX: backups/
          AWS_REGION: ${{ secrets.AWS_REGION }}
          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
        run: npx ts-node src/scripts/backup-retention.ts

      - name: Report status
        if: always()
        uses: slack-notify-action@v1
        with:
          webhook-url: ${{ secrets.SLACK_WEBHOOK_URL }}
          text: "Backup retention enforcement completed"
```

### AWS Lambda / Scheduled Tasks

For serverless execution, package the script as an AWS Lambda function:

```bash
# Create Lambda package
zip -r backup-retention.zip src/scripts/backup-retention.ts node_modules/

# Deploy with AWS CLI
aws lambda create-function \
  --function-name backup-retention-policy \
  --runtime nodejs20.x \
  --role arn:aws:iam::ACCOUNT_ID:role/lambda-backup-role \
  --handler src/scripts/backup-retention.ts \
  --zip-file fileb://backup-retention.zip \
  --environment Variables="{S3_BACKUP_BUCKET=my-backups,AWS_REGION=us-east-1}" \
  --timeout 600 \
  --memory-size 512

# Schedule with EventBridge
aws events put-rule \
  --name backup-retention-daily \
  --schedule-expression "cron(0 2 * * ? *)"

aws events put-targets \
  --rule backup-retention-daily \
  --targets "Id"="1","Arn"="arn:aws:lambda:REGION:ACCOUNT_ID:function:backup-retention-policy"
```

## Monitoring & Alerting

### CloudWatch Metrics

Monitor backup retention with CloudWatch:

```bash
# Create custom metric for deleted objects
aws cloudwatch put-metric-data \
  --namespace "Fluxora/Backups" \
  --metric-name DeletedObjects \
  --value 63 \
  --unit Count

# Create custom metric for storage freed
aws cloudwatch put-metric-data \
  --namespace "Fluxora/Backups" \
  --metric-name StorageFreedGiB \
  --value 450.25 \
  --unit Count
```

### CloudWatch Alarms

Set up alarms for failure scenarios:

```bash
# Alert if backup bucket becomes inaccessible
aws cloudwatch put-metric-alarm \
  --alarm-name backup-bucket-access-failed \
  --alarm-description "Alert when backup bucket is not accessible" \
  --metric-name BackupBucketAccessErrors \
  --namespace Fluxora/Backups \
  --statistic Sum \
  --period 300 \
  --threshold 1 \
  --comparison-operator GreaterThanOrEqualToThreshold \
  --alarm-actions arn:aws:sns:REGION:ACCOUNT_ID:AlertTopic
```

## Compliance & Security

### Security Considerations

1. **Access Control**: Restrict S3 bucket access to authorized roles
   ```hcl
   # Terraform IAM policy for lambda/script execution
   resource "aws_iam_role_policy" "backup_retention_policy" {
     role = aws_iam_role.backup_retention_role.id

     policy = jsonencode({
       Version = "2012-10-17"
       Statement = [
         {
           Effect = "Allow"
           Action = [
             "s3:ListBucket",
             "s3:GetObjectVersion"
           ]
           Resource = "arn:aws:s3:::${var.backup_bucket_name}"
         },
         {
           Effect = "Allow"
           Action = [
             "s3:DeleteObject",
             "s3:DeleteObjectVersion"
           ]
           Resource = "arn:aws:s3:::${var.backup_bucket_name}/*"
         }
       ]
     })
   }
   ```

2. **Encryption**: Enable S3 encryption at rest
   ```bash
   aws s3api put-bucket-encryption \
     --bucket my-database-backups \
     --server-side-encryption-configuration '{
       "Rules": [{
         "ApplyServerSideEncryptionByDefault": {
           "SSEAlgorithm": "AES256"
         }
       }]
     }'
   ```

3. **Audit Logging**: Enable S3 access logging
   ```bash
   aws s3api put-bucket-logging \
     --bucket my-database-backups \
     --bucket-logging-status '{
       "LoggingEnabled": {
         "TargetBucket": "my-audit-logs",
         "TargetPrefix": "backups/"
       }
     }'
   ```

4. **Versioning**: Enable object versioning for recovery from accidental deletion
   ```bash
   aws s3api put-bucket-versioning \
     --bucket my-database-backups \
     --versioning-configuration Status=Enabled
   ```

### Compliance Checkpoints

- [ ] Backup retention policy is enforced (script or lifecycle rule)
- [ ] Backups are encrypted at rest
- [ ] Access is restricted via IAM policies
- [ ] Audit logging is enabled
- [ ] Retention policy is tested with dry-run
- [ ] Alerts are configured for failures
- [ ] Schedule is documented and visible to operations team
- [ ] RTO/RPO requirements are met by retention windows

## Testing

### Manual Dry-Run

Always test retention policy before production enforcement:

```bash
# Dry-run to see what would be deleted
S3_BACKUP_BUCKET=my-backups npx ts-node src/scripts/backup-retention.ts --dry-run
```

### Unit Tests

Run test suite with coverage:

```bash
# Run tests
pnpm test tests/unit/scripts/backup-retention.test.ts

# Run with coverage
pnpm test:coverage tests/unit/scripts/backup-retention.test.ts

# Watch mode for development
pnpm test:watch tests/unit/scripts/backup-retention.test.ts
```

Test coverage includes:
- Age calculation logic
- Backup classification (daily/weekly/monthly/expired)
- Retention filtering
- S3 API integration
- Error handling
- Edge cases (boundary dates, empty bucket, large batches)
- Dry-run mode

## Troubleshooting

### Issue: "S3_BACKUP_BUCKET environment variable is required"

**Solution**: Set the environment variable before running the script:
```bash
export S3_BACKUP_BUCKET=my-backups
npx ts-node src/scripts/backup-retention.ts
```

### Issue: "Cannot access S3 bucket: AccessDenied"

**Solution**: Check IAM permissions. The role must have:
```json
{
  "Effect": "Allow",
  "Action": [
    "s3:ListBucket",
    "s3:GetObjectVersion",
    "s3:DeleteObject",
    "s3:DeleteObjectVersion",
    "s3:HeadBucket"
  ],
  "Resource": ["arn:aws:s3:::my-backups", "arn:aws:s3:::my-backups/*"]
}
```

### Issue: "No backup objects found"

**Solution**: Verify the prefix matches your backup location:
```bash
# List all objects with current prefix
aws s3 ls s3://my-backups/backups/

# If objects are elsewhere, use custom prefix
npx ts-node src/scripts/backup-retention.ts --prefix custom/path/
```

### Issue: "Deletion completed with errors"

**Solution**: Check error details in output. Common causes:
- Objects were already deleted (continue with next batch)
- Insufficient permissions
- Bucket versioning conflicts

Retry with clean credentials:
```bash
export AWS_PROFILE=production
npx ts-node src/scripts/backup-retention.ts
```

## References

- [AWS S3 Lifecycle Configuration](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lifecycle-mgmt.html)
- [Terraform aws_s3_bucket_lifecycle_configuration](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/s3_bucket_lifecycle_configuration)
- [AWS SDK for JavaScript (v3) S3 Client](https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/)
- [AWS IAM Best Practices](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html)
