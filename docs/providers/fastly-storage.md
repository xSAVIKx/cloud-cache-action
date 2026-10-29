---
description: "Use Fastly Object Storage as an S3-compatible GitHub Actions cache with Cloud Cache Action. Bucket region, lifecycle rules, bucket-scoped keys and the step."
---

# Fastly Object Storage

To use Fastly Object Storage as a GitHub Actions cache, create a private bucket and an access key
pair with **Read/Write** access to that bucket. Then set the regional `endpoint`, `bucket`,
`access-key` and `secret-key` on `xSAVIKx/cloud-cache-action@v1`.

[Fastly Object Storage](https://www.fastly.com/products/object-storage) is S3-compatible cloud
storage from Fastly.

## Requirements

- A Fastly account with Object Storage.
- A private bucket in a region near your runners.
- An S3-compatible access key pair that is scoped to that bucket.

## Bucket setup

### 1. Bucket region and placement

- In the Fastly Control Panel, go to **Storage** > **Object Storage** > **Create bucket**.
- **Region Selection**: Select the region nearest to your GitHub Actions runners (for example, US-East or EU-Central). This decreases the network distance of each cache restore.
- **Access Level**: Make sure that the bucket is private. Keep public read permissions disabled.

### 2. Lifecycle rules and automatic eviction

Give CI cache bundles an expiration policy, so that old dependencies are removed:

- Set up a lifecycle rule in the bucket management console that expires and deletes objects older than **30** or **60 days**.
- Configure incomplete multipart uploads to abort after **7 days**.

## Credentials

### 1. Generate S3-compatible credentials

1. In Fastly Object Storage, go to **Access Keys** / **API Credentials**.
2. Create a new key pair that is scoped to your CI cache bucket, with **Read/Write** permissions.
3. Write down the generated **Access Key** and **Secret Key**.

### 2. Configure GitHub secrets

Store the credentials in **Settings** > **Secrets and variables** > **Actions** of your repository:

| Secret Name | Description |
| :--- | :--- |
| `FASTLY_ACCESS_KEY` | Fastly S3 Access Key ID |
| `FASTLY_SECRET_KEY` | Fastly S3 Secret Access Key |

## Workflow example

```yaml
- name: Cache dependencies using Fastly Object Storage
  uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: my-fastly-cache-bucket
    endpoint: https://object.us-east-1.fastlystorage.com # Your region
    access-key: ${{ secrets.FASTLY_ACCESS_KEY }}
    secret-key: ${{ secrets.FASTLY_SECRET_KEY }}
    key: ${{ runner.os }}-cargo-${{ hashFiles('**/Cargo.lock') }}
    restore-keys: |
      ${{ runner.os }}-cargo-
    path: |
      ~/.cargo/bin/
      ~/.cargo/registry/index/
      ~/.cargo/registry/cache/
      target/
```

## Notes

- **Checksums**: for this provider, the action sends request checksums only when S3 requires them, because many S3-compatible services reject the CRC checksums recent AWS SDKs send by default. Nothing to configure.
- **Expiry**: the action never deletes caches. Use the lifecycle rule above, or the [`prune` sub-action](../guide/pruning.md).
