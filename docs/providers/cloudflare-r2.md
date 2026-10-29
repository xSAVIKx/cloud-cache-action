---
description: "Use Cloudflare R2 as a GitHub Actions cache with Cloud Cache Action. Create a bucket and a scoped R2 API token, then set the endpoint and keys in the step."
---

# Cloudflare R2

To use Cloudflare R2 as a GitHub Actions cache, create an R2 bucket and an R2 API token with
**Object Read & Write** access to that bucket. Then set `endpoint`, `bucket`, `access-key` and
`secret-key` on `xSAVIKx/cloud-cache-action@v1`.

[Cloudflare R2](https://www.cloudflare.com/developer-platform/r2/) is S3-compatible object storage
with **zero egress fees**.

## Requirements

- A Cloudflare account with R2 Object Storage.
- An R2 bucket for the cache.
- An R2 API token that is scoped to that bucket.

## Bucket setup

### 1. Bucket creation and location hint

1. In the Cloudflare dashboard, go to **R2 Object Storage** > **Create bucket**.
2. **Bucket Name**: Use a descriptive name, for example `my-org-ci-cache`.
3. **Location Hint**: Choose a region hint near your GitHub Actions runners:
   - `wnam` (Western North America) or `enam` (Eastern North America) for default GitHub-hosted runners.
   - `weur` or `eeur` for European runners.
   - `apac` for Asia-Pacific runners.
   - Or keep **Automatic**, and Cloudflare selects the location.

### 2. Security and public access

- **Keep Public Access Disabled**: Do not enable the public R2 `r2.dev` test domain or attach a custom domain. Cache archives contain build artifacts and private dependencies. They must stay private.
- **Data Encryption**: Cloudflare R2 encrypts all stored data at rest with AES-256. You do not have to configure it.

### 3. Lifecycle expiration rules

To prevent old cache archives from accumulating:

1. On your bucket page, click **Settings** > **Lifecycle Rules** > **Add rule**.
2. Set a rule name (for example, `expire-old-caches`).
3. Set **Action** to **Delete objects**.
4. Set **Age** to **30 days** (or 60 days for low-frequency branches).
5. Add an **Abort incomplete multipart uploads** rule after **7 days**.

## Credentials

Do not use account-wide administrative tokens for CI workflows. Create a scoped, bucket-specific API token.

### 1. Create a scoped R2 API token

1. In the Cloudflare dashboard, go to **R2** > **Manage R2 API Tokens** > **Create API token**.
2. **Token Name**: `github-actions-cache`.
3. **Permissions**: Select **Object Read & Write**.
4. **Bucket Scope**: Select **Apply to specific buckets only**, and choose your cache bucket.
5. (Optional) Set a **TTL / Expiration date** for your security rotation policy.
6. Click **Create API Token**.

Use **Object Read only** for jobs that never save. See the [Security guide](../guide/security.md#cloudflare-r2) for the token types and the S3 calls the action sends.

### 2. Configure GitHub secrets

Cloudflare shows the credentials **one time**. Copy them into **Settings** > **Secrets and variables** > **Actions** of your repository:

| Secret Name | Source in Cloudflare |
| :--- | :--- |
| `R2_ACCOUNT_ID` | Found on the R2 overview page in the right sidebar |
| `R2_ACCESS_KEY_ID` | Displayed on the token creation screen |
| `R2_SECRET_ACCESS_KEY` | Displayed on the token creation screen |

## Workflow example

```yaml
- name: Cache dependencies using Cloudflare R2
  uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: my-org-ci-cache
    endpoint: https://${{ secrets.R2_ACCOUNT_ID }}.r2.cloudflarestorage.com
    access-key: ${{ secrets.R2_ACCESS_KEY_ID }}
    secret-key: ${{ secrets.R2_SECRET_ACCESS_KEY }}
    key: ${{ runner.os }}-node-${{ hashFiles('**/package-lock.json') }}
    restore-keys: |
      ${{ runner.os }}-node-
    path: ~/.npm
```

> [!TIP]
> **Automatic Provider Detection**: Cloud Cache Action recognizes `*.r2.cloudflarestorage.com` endpoints and sets `region: auto` and `force-path-style: false`.

## Notes

- **Checksums**: for this provider, the action sends request checksums only when S3 requires them, because many S3-compatible services reject the CRC checksums recent AWS SDKs send by default. Nothing to configure.
- **Expiry**: the action never deletes caches. Add a lifecycle rule that expires objects after 30–60 days so old caches do not accumulate.
- **Transfer settings**: the [Performance](../guide/performance.md) and [Benchmarks](../guide/benchmarks.md) pages give the measured restore and save times on R2.

### Live CI workflow

The repository tests the action continuously against Cloudflare R2. The workflow file is [`.github/workflows/provider-r2.yml`](https://github.com/xSAVIKx/cloud-cache-action/blob/main/.github/workflows/provider-r2.yml).

::: details `.github/workflows/provider-r2.yml` (Click to view full workflow)
<<< ../../.github/workflows/provider-r2.yml{yaml}
:::
