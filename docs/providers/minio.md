---
description: "Use self-hosted MinIO as a GitHub Actions cache with Cloud Cache Action. A private bucket, quotas, ILM expiry, a service account, path-style and the step."
---

# MinIO

To use self-hosted MinIO as a GitHub Actions cache, create a private bucket and a service account
that a bucket policy restricts. Then set `endpoint`, `force-path-style: true`, `bucket`,
`access-key` and `secret-key` on `xSAVIKx/cloud-cache-action@v1`.

[MinIO](https://min.io/) is a distributed object store with an S3 API. Teams use it for
on-premise infrastructure, private clouds and local CI tests.

> [!NOTE]
> **Maintenance and compatibility notice**:
> Upstream open-source MinIO changed its license (AGPLv3). Standalone community releases no longer get free public security patches. Many teams still use existing MinIO infrastructure, or use ephemeral MinIO containers in CI. The CI of Cloud Cache Action tests the action against a MinIO container. See [Live CI workflow](#live-ci-workflow).

## Requirements

- A MinIO server or cluster that the runners can reach, or Docker on the runner for an ephemeral container.
- The MinIO Client (`mc`) for the bucket and account setup.
- A bucket for the cache and a service account that a policy restricts to that bucket.

## Bucket setup

### 1. Bucket privacy and quotas

- **Bucket Access Policy**: Make sure that the bucket access policy is private (`none`). Never set download or public access policies on cache buckets.
- **Hard Storage Quotas**: CI builds can make hundreds of gigabytes of dependency archives. Use the MinIO Client (`mc`) to set a hard storage quota on your cache bucket:

  ```bash
  # Set a 100 GB hard limit on the cache bucket
  mc quota set --hard 100GB myminio/ci-cache
  ```

### 2. Information Lifecycle Management (ILM) expiration

MinIO has native ILM lifecycle management. Configure automatic expiration, so that MinIO removes old caches:

```bash
# Automatically expire and delete cache archives older than 30 days
mc ilm rule add --expire-days 30 myminio/ci-cache

# Automatically abort incomplete multipart uploads after 7 days
mc ilm rule add --expire-delete-marker --abort-incomplete-multipart-upload-days 7 myminio/ci-cache
```

### 3. Server-side encryption

Enable server-side encryption with MinIO-managed keys:

```bash
# Enable auto-encryption on the bucket
mc encrypt set sse-s3 myminio/ci-cache
```

## Credentials

> [!WARNING]
> Never use root credentials (`MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`) in your GitHub Actions workflows. Create a dedicated service account that is restricted to the CI cache bucket.

### 1. Create a restricted policy (`ci-cache-policy.json`)

Copy the MinIO policy from the [Security guide](../guide/security.md#minio-and-rustfs) into
`ci-cache-policy.json`. Change the bucket name and the prefix to match your set-up.

Add the policy to MinIO:

```bash
mc admin policy create myminio ci-cache-policy ci-cache-policy.json
```

### 2. Generate service account credentials

```bash
# Create a service account restricted by the policy
mc admin user svcacct add --policy ci-cache-policy myminio ci-runner
```

MinIO shows the **Access Key** and the **Secret Key**.

### 3. Configure GitHub secrets

Store the credentials in **Settings** > **Secrets and variables** > **Actions** of your repository:

| Secret Name | Description |
| :--- | :--- |
| `MINIO_ACCESS_KEY` | MinIO Service Account Access Key |
| `MINIO_SECRET_KEY` | MinIO Service Account Secret Key |

## Workflow example

> [!TIP]
> **Path-Style Addressing**: Set `force-path-style: true` for MinIO, unless you configured wildcard DNS subdomains (virtual-host style) for your buckets.

### Ephemeral MinIO container in a GitHub Actions job

You can start an ephemeral MinIO instance in your GitHub Actions job with Docker or Docker Compose. This gives an isolated cache with no external service:

```yaml
name: Build with Local MinIO Cache

on: [push, pull_request]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1

      # 1. Start ephemeral MinIO container
      - name: Start ephemeral MinIO
        run: |
          docker run -d --name ci-minio -p 9000:9000 \
            -e MINIO_ROOT_USER=minioadmin \
            -e MINIO_ROOT_PASSWORD=minioadmin \
            minio/minio:RELEASE.2025-09-07T16-13-09Z server /data
          
          # Wait for MinIO readiness
          for i in {1..30}; do
            if curl -s http://127.0.0.1:9000/minio/health/live > /dev/null 2>&1; then
              echo "MinIO ready."
              break
            fi
            sleep 1
          done
          
          # Create cache bucket
          docker exec ci-minio mkdir -p /data/ci-cache

      # 2. Cache dependencies with Cloud Cache Action
      - name: Cache dependencies using local MinIO
        uses: xSAVIKx/cloud-cache-action@v1
        with:
          bucket: ci-cache
          endpoint: http://127.0.0.1:9000
          access-key: minioadmin
          secret-key: minioadmin
          force-path-style: true
          key: ${{ runner.os }}-node-${{ hashFiles('**/package-lock.json') }}
          restore-keys: |
            ${{ runner.os }}-node-
          path: ~/.npm

      - name: Install dependencies
        run: npm ci
```

### Self-hosted or on-premise MinIO cluster

For a persistent MinIO server or cluster on private infrastructure (for example, bare-metal or Kubernetes):

```yaml
- name: Cache dependencies using self-hosted MinIO
  uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: ci-cache
    endpoint: https://minio.internal.mycompany.com:9000
    access-key: ${{ secrets.MINIO_ACCESS_KEY }}
    secret-key: ${{ secrets.MINIO_SECRET_KEY }}
    force-path-style: true
    key: ${{ runner.os }}-build-${{ hashFiles('**/lock') }}
    path: build/
```

## Local testing

You can start MinIO locally with the [`docker-compose.test.yml`](https://github.com/xSAVIKx/cloud-cache-action/blob/main/docker-compose.test.yml) file of the repository:

```bash
docker compose -f docker-compose.test.yml up -d minio
```

::: details `docker-compose.test.yml` (Click to view Compose definition)
<<< ../../docker-compose.test.yml{yaml}
:::

When the container runs:

- **S3 API**: `http://localhost:9000`
- **Web Console**: `http://localhost:9001` (Default credentials: `minioadmin` / `minioadmin`)

## Notes

- **Checksums**: for this provider, the action sends request checksums only when S3 requires them, because many S3-compatible services reject the CRC checksums recent AWS SDKs send by default. Nothing to configure.
- **Concurrent saves**: MinIO enforces the conditional create (`If-None-Match`). See [Safe Concurrent Saves](../guide/storage.md#safe-concurrent-saves).
- **Expiry**: the action never deletes caches. Add a lifecycle rule that expires objects after 30–60 days so old caches do not accumulate.
- **Incomplete uploads**: MinIO lists no incomplete multipart upload for a prefix that is not a full object key (measured on 2026-10-21 with the CI image). The `prune` input `abort-uploads-older-than-hours` therefore finds no upload and aborts none. Use the `--abort-incomplete-multipart-upload-days` lifecycle rule above instead.

### Live CI workflow

The repository uses MinIO in its continuous integration test suite: [`.github/workflows/test.yml`](https://github.com/xSAVIKx/cloud-cache-action/blob/main/.github/workflows/test.yml).

::: details `.github/workflows/test.yml` (Click to view test workflow)
<<< ../../.github/workflows/test.yml{yaml}
:::
