---
description: "Use Backblaze B2 as a GitHub Actions cache with Cloud Cache Action. A private bucket, a bucket-restricted application key, lifecycle rules and the S3 endpoint."
---

# Backblaze B2

To use Backblaze B2 as a GitHub Actions cache, create a private bucket and an application key that
can access only that bucket. Then set the S3 `endpoint` of the bucket, `bucket`, `access-key` and
`secret-key` on `xSAVIKx/cloud-cache-action@v1`.

[Backblaze B2](https://www.backblaze.com/cloud-storage) is S3-compatible cloud object storage.

## Requirements

- A Backblaze B2 account.
- A private bucket for the cache, with Object Lock disabled.
- An application key with **Read and Write** access to that bucket only.

## Bucket setup

### 1. Bucket creation and access

1. In the Backblaze B2 console, go to **Buckets** > **Create a Bucket**.
2. **Bucket Unique Name**: Enter a globally unique name (for example, `my-org-ci-cache`).
3. **Files in Bucket are**: Select **Private**. Do not choose Public.
4. **Default Encryption**: Select **Enabled** (Server-Side Encryption / SSE-B2) to encrypt all cache bundles at rest.
5. **Object Lock**: Select **Disabled**. Object Lock prevents deletion during retention windows, and then cache lifecycle expiration fails.

### 2. Lifecycle rules and automatic deletion

By default, Backblaze B2 keeps all uploaded versions of files forever. To prevent storage costs that increase without a limit:

1. In your bucket list, click **Lifecycle Settings**.
2. Choose **Custom Lifecycle Settings**.
3. Add a rule:
   - **File Name Prefix**: Leave blank (applies to all archives in the bucket).
   - **Days until hiding**: `30` days (hides older cache files).
   - **Days until deleting**: `1` day (permanently deletes hidden files).

## Credentials

Do not use your master Backblaze application key for CI workflows. Generate a bucket-restricted application key.

### 1. Create a restricted application key

1. In the Backblaze B2 console, go to **Account** > **Application Keys**.
2. Click **Add a New Application Key**.
3. **Name of Key**: `github-actions-cache`.
4. **Allow access to Bucket(s)**: Select your dedicated CI cache bucket. Do **not** select "All".
5. **Type of Access**: Select **Read and Write**.
6. Click **Create New Key**.

### 2. Configure GitHub secrets

Backblaze shows your `applicationKey` **one time only**:

| Secret Name | Value in Backblaze |
| :--- | :--- |
| `B2_KEY_ID` | The `keyID` string (25-character alphanumeric ID) |
| `B2_APPLICATION_KEY` | The `applicationKey` secret string (31-character token) |

## Workflow example

```yaml
- name: Cache dependencies using Backblaze B2
  uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: my-b2-cache-bucket
    endpoint: https://s3.us-west-004.backblazeb2.com # Your bucket endpoint
    access-key: ${{ secrets.B2_KEY_ID }}
    secret-key: ${{ secrets.B2_APPLICATION_KEY }}
    key: ${{ runner.os }}-maven-${{ hashFiles('**/pom.xml') }}
    restore-keys: |
      ${{ runner.os }}-maven-
    path: ~/.m2/repository
```

> [!TIP]
> **Automatic Region Detection**: Cloud Cache Action reads the AWS-compatible region (for example, `us-west-004` or `eu-central-003`) from your Backblaze endpoint URL. You do not have to set `region`.

## Notes

- **Checksums**: for this provider, the action sends request checksums only when S3 requires them, because many S3-compatible services reject the CRC checksums recent AWS SDKs send by default. Nothing to configure.
- **Expiry**: the action never deletes caches. Add a lifecycle rule that expires objects after 30–60 days so old caches do not accumulate.
