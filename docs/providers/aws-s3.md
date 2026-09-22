# AWS S3 Setup

Cloud Cache Action supports AWS S3 out of the box using both GitHub Actions OIDC (OpenID Connect) with IAM Roles and static IAM credentials.

---

## Best Practices: Bucket Setup & Configuration

Follow these recommendations when creating and configuring your AWS S3 cache bucket:

### 1. Bucket Region & Colocation
- **GitHub-hosted runners**: Default `ubuntu-latest` and `windows-latest` runners typically execute in AWS US regions (`us-east-1` or `us-east-2`). Creating your bucket in `us-east-1` minimizes cross-region latency and lowers data transfer fees.
- **Self-hosted EC2 runners**: Always create the bucket in the same AWS region and VPC as your runners to achieve maximum throughput (line-rate VPC speeds) with zero data transfer costs.

### 2. Security & Access Control
- **Block All Public Access**: Ensure all 4 settings under **Block Public Access** are enabled. Cache bundles contain compiled binaries, source artifacts, and dependency manifests that must never be publicly readable.
- **Object Ownership**: Enable **Bucket owner enforced** (disable ACLs) to guarantee consistent ownership of all uploaded archives.
- **Default Encryption**: Use server-side encryption with Amazon S3 managed keys (**SSE-S3** / `AES256`) or AWS KMS (**SSE-KMS**). SSE-S3 is included at no additional cost.

### 3. Lifecycle Rules & Cost Optimization
Without lifecycle management, older cache revisions accumulate and increase storage costs. Configure two lifecycle rules under **Bucket Management** > **Lifecycle Rules**:

1. **Expire Current Objects**:
   - **Filter**: Apply to all objects in bucket (or prefix `${GITHUB_REPOSITORY}/`).
   - **Action**: Expire current versions of objects after **30** or **60 days**.
2. **Abort Incomplete Multipart Uploads**:
   - **Action**: Delete expired object delete markers and incomplete multipart uploads after **7 days**. This prevents lingering chunks from failed or interrupted uploads from consuming storage.

---

## Credentials & Least-Privilege IAM Policies

### Option A: GitHub Actions OIDC (Recommended)

Using GitHub Actions OpenID Connect (OIDC) eliminates the need to store long-lived AWS Access Keys in repository secrets.

#### 1. Configure the IAM Role Trust Policy
Create an IAM Role with a trust policy allowing GitHub Actions to assume it:

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

#### 2. Attach Least-Privilege S3 Permissions Policy
Attach an IAM policy granting only the minimal actions required by `cloud-cache-action`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowBucketListing",
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket"
      ],
      "Resource": "arn:aws:s3:::my-actions-cache-bucket"
    },
    {
      "Sid": "AllowObjectOperations",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:GetObjectTagging",
        "s3:PutObjectTagging",
        "s3:AbortMultipartUpload"
      ],
      "Resource": "arn:aws:s3:::my-actions-cache-bucket/*"
    }
  ]
}
```

> [!NOTE]
> `cloud-cache-action` does not require `s3:DeleteObject`. Lifecycle cleanup is handled by bucket lifecycle rules.

> [!NOTE]
> `s3:GetObjectTagging` and `s3:PutObjectTagging` carry the archive checksum for a streamed save.
> Without them the save falls back to a copy and the restore skips the integrity check, with a
> warning in the log. Grant both actions to the save role and at least `s3:GetObjectTagging` to
> the restore role.

#### 3. Workflow Example (OIDC)

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

---

### Option B: Static IAM Credentials

If you prefer static credentials, create a dedicated IAM user (never use your root AWS account) with the least-privilege policy shown above, generate an Access Key ID and Secret Access Key, and save them in your repository's GitHub Secrets.

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

---

## Live CI Verification Workflow

This action is tested continuously against a real Amazon S3 bucket. You can inspect the live GitHub Actions workflow file in the repository: [`.github/workflows/provider-aws-s3.yml`](https://github.com/xSAVIKx/cloud-cache-action/blob/main/.github/workflows/provider-aws-s3.yml).

::: details `.github/workflows/provider-aws-s3.yml` (Click to view full workflow)
<<< ../../.github/workflows/provider-aws-s3.yml{yaml}
:::
