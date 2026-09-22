# MinIO S3 Setup

[MinIO](https://min.io/) is a high-performance distributed object store with native S3 API compatibility, widely used for on-premise infrastructure, private enterprise clouds, and local CI testing.

> [!NOTE]
> **Maintenance & Compatibility Notice**:
> While upstream open-source MinIO changed licensing (AGPLv3) and standalone community releases are no longer actively maintained with free public security patches, many development teams and enterprise clusters continue to rely on existing MinIO infrastructure or use ephemeral containers in CI. `cloud-cache-action` maintains 100% interoperability with all MinIO versions.

---

## Best Practices: Bucket & Cluster Setup

Follow these recommendations when setting up MinIO for CI/CD caching:

### 1. Bucket Privacy & Quotas
- **Bucket Access Policy**: Ensure the bucket access policy is strictly private (`none`). Never set download or public access policies on cache buckets.
- **Hard Storage Quotas**: CI builds can rapidly generate hundreds of gigabytes of dependency archives. Use the MinIO Client (`mc`) to set a hard storage quota on your cache bucket:
  ```bash
  # Set a 100 GB hard limit on the cache bucket
  mc quota set --hard 100GB myminio/ci-cache
  ```

### 2. Information Lifecycle Management (ILM) Auto-Expiration
MinIO includes native ILM lifecycle management. Configure automatic expiration so old caches are purged automatically:
```bash
# Automatically expire and delete cache archives older than 30 days
mc ilm rule add --expire-days 30 myminio/ci-cache

# Automatically abort incomplete multipart uploads after 7 days
mc ilm rule add --expire-delete-marker --abort-incomplete-multipart-upload-days 7 myminio/ci-cache
```

### 3. Server-Side Encryption
Enable transparent server-side encryption with MinIO-managed keys:
```bash
# Enable auto-encryption on the bucket
mc encrypt set sse-s3 myminio/ci-cache
```

---

## Credentials & Least-Privilege Service Accounts

> [!WARNING]
> Never use root credentials (`MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`) in your GitHub Actions workflows. Always create a dedicated Service Account restricted strictly to the CI cache bucket.

### 1. Create a Restricted Policy (`ci-cache-policy.json`)
Save the following minimal policy JSON:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket"
      ],
      "Resource": "arn:aws:s3:::ci-cache"
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:GetObjectTagging",
        "s3:PutObjectTagging",
        "s3:AbortMultipartUpload"
      ],
      "Resource": "arn:aws:s3:::ci-cache/*"
    }
  ]
}
```

`s3:GetObjectTagging` and `s3:PutObjectTagging` carry the archive checksum for a streamed save.
Without them the save falls back to a copy and the restore skips the integrity check, with a
warning in the log.

Add the policy to MinIO:
```bash
mc admin policy create myminio ci-cache-policy ci-cache-policy.json
```

### 2. Generate Service Account Credentials
```bash
# Create a service account restricted by the policy
mc admin user svcacct add --policy ci-cache-policy myminio ci-runner
```
MinIO will print the **Access Key** and **Secret Key**.

### 3. Configure GitHub Secrets
Store the credentials in your repository's **Settings** > **Secrets and variables** > **Actions**:

| Secret Name | Description |
| :--- | :--- |
| `MINIO_ACCESS_KEY` | MinIO Service Account Access Key |
| `MINIO_SECRET_KEY` | MinIO Service Account Secret Key |

---

## Example 1: GitHub Actions CI with Ephemeral MinIO Container

You can spin up an ephemeral MinIO instance directly inside your GitHub Actions runner job using Docker or Docker Compose for zero-cost, isolated CI caching:

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

---

## Example 2: Self-Hosted / On-Prem MinIO Cluster

For organizations hosting a persistent MinIO server or cluster on private infrastructure (e.g., bare-metal or Kubernetes):

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

> [!TIP]
> **Path-Style Addressing**: Always set `force-path-style: true` for MinIO unless you have configured wildcard DNS subdomains (virtual-host style) for your buckets.

---

## Running MinIO Locally for Integration Testing

You can spin up MinIO locally using the repository's [`docker-compose.test.yml`](https://github.com/xSAVIKx/cloud-cache-action/blob/main/docker-compose.test.yml):

```bash
docker compose -f docker-compose.test.yml up -d minio
```

::: details `docker-compose.test.yml` (Click to view Compose definition)
<<< ../../docker-compose.test.yml{yaml}
:::

Once running:
- **S3 API**: `http://localhost:9000`
- **Web Console**: `http://localhost:9001` (Default credentials: `minioadmin` / `minioadmin`)

---

## Live CI Dogfooding Workflow

The repository dogfoods MinIO directly inside the continuous integration test suite: [`.github/workflows/test.yml`](https://github.com/xSAVIKx/cloud-cache-action/blob/main/.github/workflows/test.yml).

::: details `.github/workflows/test.yml` (Click to view test workflow)
<<< ../../.github/workflows/test.yml{yaml}
:::

## Notes

- **Checksums**: for this provider, the action sends request checksums only when S3 requires them, because many S3-compatible services reject the CRC checksums recent AWS SDKs send by default. Nothing to configure.
- **Expiry**: the action never deletes caches. Add a lifecycle rule that expires objects after 30–60 days so old caches do not accumulate.
