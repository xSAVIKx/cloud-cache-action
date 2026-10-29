---
description: "Use AWS S3 as a GitHub Actions cache with Cloud Cache Action. Bucket setup, an OIDC IAM role or static keys, lifecycle rules and a workflow step."
---

# AWS S3

To use AWS S3 as a GitHub Actions cache, create a private bucket and give the job AWS credentials.
Then set `bucket` on `xSAVIKx/cloud-cache-action@v1`. AWS S3 needs no `endpoint` input.

Cloud Cache Action supports two types of credentials for AWS S3: GitHub Actions OIDC (OpenID
Connect) with an IAM role, and static IAM credentials.

## Requirements

- An AWS account and an S3 bucket for the cache.
- An IAM role that GitHub Actions can assume through OIDC, or an IAM user with an access key.
- A least-privilege policy from the [Security guide](../guide/security.md#aws-s3).

## Bucket setup

Follow these recommendations when you create and configure the cache bucket.

### 1. Bucket region and colocation

- **GitHub-hosted runners**: GitHub hosts these runners in Microsoft Azure. Jobs that use multi-cloud compute can run in AWS or in Azure. GitHub does not state the region ([GitHub docs](https://docs.github.com/en/actions/concepts/runners/github-hosted-runners)). Select a bucket region, then measure the restore time in your own jobs.
- **Self-hosted EC2 runners**: Create the bucket in the same AWS region and VPC as your runners. This prevents cross-region latency and cross-region data transfer costs.

### 2. Security and access control

- **Block All Public Access**: Enable all 4 settings under **Block Public Access**. Cache bundles contain compiled binaries, source artifacts and dependency manifests. They must never be publicly readable.
- **Object Ownership**: Enable **Bucket owner enforced** (disable ACLs). Then the bucket owner owns all uploaded archives.
- **Default Encryption**: Use server-side encryption with Amazon S3 managed keys (**SSE-S3** / `AES256`) or AWS KMS (**SSE-KMS**). SSE-S3 has no additional cost.

### 3. Lifecycle rules and cost

Without lifecycle management, older cache revisions accumulate and increase storage costs. Configure two lifecycle rules under **Bucket Management** > **Lifecycle Rules**:

1. **Expire Current Objects**:
   - **Filter**: Apply to all objects in bucket (or prefix `${GITHUB_REPOSITORY}/`).
   - **Action**: Expire current versions of objects after **30** or **60 days**.
2. **Abort Incomplete Multipart Uploads**:
   - **Action**: Delete expired object delete markers and incomplete multipart uploads after **7 days**. This prevents chunks from failed or interrupted uploads from using storage.

### 4. Object Lock

Do not use a bucket with an Object Lock default retention for caches. Prune cannot delete locked objects. Also, Object Lock requires a checksum on each upload. From v1.9, the action does not send the AWS SDK CRC32 checksums, because its own sha256 check covers the archive. A save to such a bucket then fails with `400 InvalidRequest`. If you must use such a bucket, set this environment variable on the job:

```yaml
env:
  CLOUD_CACHE_SDK_CHECKSUMS: 'true'
```

## Credentials

### Option A: GitHub Actions OIDC (recommended)

With GitHub Actions OpenID Connect (OIDC), you do not store long-lived AWS access keys in repository secrets.

#### 1. Configure the IAM role trust policy

Create an IAM role with a trust policy that lets GitHub Actions assume it:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:<OWNER>/<REPO>:*"
        }
      }
    }
  ]
}
```

#### 2. Attach a least-privilege S3 permissions policy

Attach a policy that grants only the actions the action sends, scoped to the bucket and the
repository prefix. The [Security guide](../guide/security.md#aws-s3) holds the full read-write,
read-only and prune policies, and the list of S3 calls that each feature sends.

### Option B: Static IAM credentials

Create a dedicated IAM user. Never use your root AWS account. Attach a least-privilege policy from the [Security guide](../guide/security.md#aws-s3). Generate an access key ID and a secret access key, and save them in the GitHub secrets of your repository.

## Workflow example

### With OIDC

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      id-token: write # Required for requesting the OIDC JWT
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1

      - name: Configure AWS Credentials via OIDC
        uses: aws-actions/configure-aws-credentials@cbe3b392738ccf3f987d68400dafcf4b0624a56c # v6.2.4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/GitHubActionsCacheRole
          aws-region: us-east-1

      - name: Cache dependencies
        uses: xSAVIKx/cloud-cache-action@v1
        with:
          bucket: my-actions-cache-bucket
          key: ${{ runner.os }}-build-${{ hashFiles('**/lock') }}
          path: node_modules
```

### With static credentials

```yaml
- name: Cache dependencies
  uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: my-actions-cache-bucket
    region: us-east-1
    access-key: ${{ secrets.AWS_ACCESS_KEY_ID }}
    secret-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
    key: ${{ runner.os }}-build-${{ hashFiles('**/lock') }}
    path: node_modules
```

## Notes

- **Concurrent saves**: AWS S3 enforces the conditional create (`If-None-Match`). See [Safe Concurrent Saves](../guide/storage.md#safe-concurrent-saves).
- **Expiry**: the action never deletes caches. Use the lifecycle rules above, or the [`prune` sub-action](../guide/pruning.md).

### Live CI workflow

The repository tests the action continuously against a real Amazon S3 bucket. The workflow file is [`.github/workflows/provider-aws-s3.yml`](https://github.com/xSAVIKx/cloud-cache-action/blob/main/.github/workflows/provider-aws-s3.yml).

::: details `.github/workflows/provider-aws-s3.yml` (Click to view full workflow)
<<< ../../.github/workflows/provider-aws-s3.yml{yaml}
:::
