---
description: "Use Google Cloud Storage as a GitHub Actions cache with Cloud Cache Action, through the S3-compatible XML API and the HMAC key of a service account."
---

# Google Cloud Storage (GCS)

To use Google Cloud Storage as a GitHub Actions cache, create a bucket, a dedicated service
account and an HMAC key for that account. Then set `endpoint: https://storage.googleapis.com`,
`bucket`, `access-key` and `secret-key` on `xSAVIKx/cloud-cache-action@v1`.

Google Cloud Storage (GCS) accepts S3 API requests through its XML API and HMAC service account
keys.

## Requirements

- A Google Cloud project with Cloud Storage.
- A regional bucket with the **Standard** storage class.
- A dedicated service account with the **Storage Object User** role on the bucket, and an HMAC key for it.

## Bucket setup

### 1. Bucket location and storage class

- **Location Type**: Choose a **Region** bucket (for example, `us-central1` or `europe-west1`) near your runners. Do not use multi-region or dual-region buckets unless your runners are on more than one continent. Regional buckets have lower latency and no inter-region network charges.
- **Storage Class**: Select **Standard**. Do not use *Nearline*, *Coldline* or *Archive* for CI caches. These classes charge data retrieval fees each time a cache is restored, and they have minimum storage periods (30 to 90 days). This makes frequently updated caches cost more.

### 2. Access control and security

- **Public Access Prevention**: Enable **Enforce public access prevention** on the bucket. Then archives are never public.
- **Access Control Model**: Select **Uniform** bucket-level access (the Google recommendation). It uses Cloud IAM policies only, not legacy object-level ACLs.
- **Data Protection**: Keep Soft Delete enabled, or configure a 7-day retention period, if you want protection against accidental deletion.

### 3. Object lifecycle management

Configure a lifecycle policy in the Google Cloud Console (**Bucket** > **Lifecycle** > **Add a rule**):

1. **Delete Expired Archives**:
   - **Action**: Delete object.
   - **Condition**: Age is **30 days** (or 60 days).
2. **Abort Incomplete Multipart Uploads**:
   - **Action**: Abort incomplete multipart uploads after **7 days**.

## Credentials

GCS accepts S3 API requests with HMAC (Hash-based Message Authentication Code) credentials.

> [!IMPORTANT]
> Create HMAC keys for a **dedicated Service Account**, never for personal Google user accounts. User HMAC keys belong to one person, and they stop working when that person changes roles or leaves the organization.

### 1. Create a dedicated service account

1. In the Google Cloud Console, go to **IAM & Admin** > **Service Accounts** > **Create Service Account**.
2. **Name**: `github-actions-ci-cache`.
3. Click **Create and Continue**.

### 2. Grant least-privilege bucket permissions

Do not grant project-wide Editor or Storage Admin roles. Grant access on your cache bucket only:

1. Go to **Cloud Storage** > **Buckets**, and click your cache bucket.
2. On the **Permissions** tab, click **Grant Access**.
3. **New principals**: Enter the email of your dedicated service account (`github-actions-ci-cache@<project-id>.iam.gserviceaccount.com`).
4. **Role**: Select **Storage Object User** (`roles/storage.objectUser`). This role can read, write and list objects, without bucket administrative privileges.

To limit the account to the repository prefix, add an IAM condition to the binding. See the [Security guide](../guide/security.md#google-cloud-storage) for the expression and for the points that are not verified.

### 3. Generate an HMAC key for the service account

1. In the Google Cloud Console, go to **Cloud Storage** > **Settings** > **Interoperability**.
2. Under **Interoperability keys for service accounts**, click **Create a key for a service account**.
3. Select your `github-actions-ci-cache` service account.
4. Copy the generated **Access ID** (the access key) and **Secret** (the secret key).

### 4. Configure GitHub secrets

Store the credentials in **Settings** > **Secrets and variables** > **Actions** of your repository:

| Secret Name | Description |
| :--- | :--- |
| `GCS_HMAC_ACCESS_ID` | The generated HMAC Access ID (starts with `GOOG...`) |
| `GCS_HMAC_SECRET` | The generated HMAC Secret key |

## Workflow example

```yaml
- name: Cache dependencies using Google Cloud Storage
  uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: my-gcs-cache-bucket
    endpoint: https://storage.googleapis.com
    access-key: ${{ secrets.GCS_HMAC_ACCESS_ID }}
    secret-key: ${{ secrets.GCS_HMAC_SECRET }}
    key: ${{ runner.os }}-gradle-${{ hashFiles('**/*.gradle*') }}
    restore-keys: |
      ${{ runner.os }}-gradle-
    path: ~/.gradle/caches
```

> [!NOTE]
> **Path-Style Addressing**: The Google Cloud Storage XML API requires path-style addressing (`force-path-style: true`). Cloud Cache Action detects `storage.googleapis.com` and sets path-style addressing and the region defaults. You do not have to configure them.

## Notes

- **Checksums**: for this provider, the action sends request checksums only when S3 requires them, because many S3-compatible services reject the CRC checksums recent AWS SDKs send by default. Nothing to configure.
- **Concurrent saves**: the S3 interoperability of GCS reportedly ignores `If-None-Match`, so two saves of one key are last-writer-wins. See [Safe Concurrent Saves](../guide/storage.md#safe-concurrent-saves).
- **Streaming saves**: GCS has no object tagging API, so a `streaming: true` save attaches its checksum with a copy of the object onto itself. The copy names the generation that the upload wrote, so it fails when another job replaced the object in between. With Object Versioning on the bucket, an old generation stays readable, and the copy can put an older save back over a newer one. Its checksum still matches its bytes.
- **Expiry**: the action never deletes caches. Add a lifecycle rule that expires objects after 30–60 days so old caches do not accumulate.

### Live CI workflow

The repository tests the action continuously against Google Cloud Storage with HMAC keys and the XML API. The workflow file is [`.github/workflows/provider-gcs.yml`](https://github.com/xSAVIKx/cloud-cache-action/blob/main/.github/workflows/provider-gcs.yml).

::: details `.github/workflows/provider-gcs.yml` (Click to view full workflow)
<<< ../../.github/workflows/provider-gcs.yml{yaml}
:::
