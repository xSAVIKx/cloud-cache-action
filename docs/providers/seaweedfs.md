---
description: "Use self-hosted SeaweedFS as an S3-compatible GitHub Actions cache with Cloud Cache Action. The S3 gateway, s3.json identities, TTL, the step and local tests."
---

# SeaweedFS

To use self-hosted SeaweedFS as a GitHub Actions cache, run its S3 gateway and add an identity
with `Read`, `Write` and `List` actions to `s3.json`. Then set `endpoint`, `provider: seaweedfs`,
`bucket`, `access-key` and `secret-key` on `xSAVIKx/cloud-cache-action@v1`.

[SeaweedFS](https://github.com/seaweedfs/seaweedfs) is an open-source distributed file system with
an S3 API.

## Requirements

- A SeaweedFS server or cluster with the S3 gateway enabled (port `8333` in the examples).
- An identity in `s3.json` for the CI runners.

## Bucket setup

### 1. Architecture and S3 gateway

- **Single-Server / Dev Runner**: Run `weed server -s3 -s3.port=8333` for an all-in-one Master, Volume, Filer and S3 API server.
- **Production Cluster**: Separate the Master, Filer and Volume nodes. Run multiple stateless `weed s3` gateway instances behind a load balancer that points to the shared Filer cluster.

### 2. Native time-to-live (TTL) and automatic pruning

SeaweedFS can set a time-to-live (TTL) on new writes under a path prefix. In `weed shell`, the
`fs.configure` command has a `-ttl` option for this (see
[Path-Specific Configuration](https://github.com/seaweedfs/seaweedfs/wiki/Path-Specific-Configuration)).
The S3 gateway stores a bucket under `/buckets/<bucket>/`. For a 30-day TTL on the `ci-cache`
bucket:

```bash
# In weed shell
fs.configure -locationPrefix=/buckets/ci-cache/ -ttl=30d -apply
```

The TTL applies to files that are written after you set it. The Cloud Cache Action test suite
does not test this setting. To delete old caches on a schedule, you can also use the
[`prune` sub-action](../guide/pruning.md).

### 3. Volume compaction and vacuuming

When older caches expire and SeaweedFS deletes them, it marks their chunks as deleted. The master vacuums volume servers when the garbage is more than the threshold (default 30%):

```bash
# Force volume vacuuming via the master admin API
curl "http://localhost:9333/vol/vacuum?garbageThreshold=0.2"
```

## Credentials

In production, configure authentication in the SeaweedFS `s3.json` configuration file.

### 1. Configure identities in `s3.json`

Put an `s3.json` configuration file in your SeaweedFS configuration folder (for example, `/etc/seaweedfs/s3.json`):

```json
{
  "identities": [
    {
      "name": "ci-runner",
      "credentials": [
        {
          "accessKey": "seaweed-ci-access-key",
          "secretKey": "seaweed-ci-super-secret-key"
        }
      ],
      "actions": [
        "Read",
        "Write",
        "List"
      ]
    }
  ]
}
```

### 2. Configure GitHub secrets

Save your credentials in **Settings** > **Secrets and variables** > **Actions** of your repository:

| Secret Name | Description |
| :--- | :--- |
| `SEAWEED_ACCESS_KEY` | The `accessKey` configured in `s3.json` |
| `SEAWEED_SECRET_KEY` | The `secretKey` configured in `s3.json` |

## Workflow example

```yaml
- name: Cache dependencies using SeaweedFS
  uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: ci-cache
    endpoint: http://seaweedfs.internal:8333 # S3 API endpoint
    provider: seaweedfs
    access-key: ${{ secrets.SEAWEED_ACCESS_KEY }}
    secret-key: ${{ secrets.SEAWEED_SECRET_KEY }}
    key: ${{ runner.os }}-build-${{ hashFiles('**/lock') }}
    restore-keys: |
      ${{ runner.os }}-build-
    path: build/
```

## Local testing

You can start SeaweedFS locally, with S3 enabled, with the [`docker-compose.test.yml`](https://github.com/xSAVIKx/cloud-cache-action/blob/main/docker-compose.test.yml) file of the repository:

```bash
docker compose -f docker-compose.test.yml up -d seaweedfs
```

::: details `docker-compose.test.yml` (Click to view Compose definition)
<<< ../../docker-compose.test.yml{yaml}
:::

When the container runs:

- **S3 API**: `http://localhost:8333`
- **Master UI**: `http://localhost:9333`
- The server creates a bucket automatically on the first write.

## Notes

- **Checksums**: for this provider, the action sends request checksums only when S3 requires them, because many S3-compatible services reject the CRC checksums recent AWS SDKs send by default. Nothing to configure.
- **Concurrent saves**: SeaweedFS enforces the conditional create (`If-None-Match`). See [Safe Concurrent Saves](../guide/storage.md#safe-concurrent-saves).
- **Expiry**: the action never deletes caches. Add a lifecycle rule that expires objects after 30–60 days so old caches do not accumulate.
- **Incomplete uploads**: SeaweedFS 4.46 lists incomplete multipart uploads without an `Initiated` time (measured on 2026-10-21). The `prune` input `abort-uploads-older-than-hours` therefore cannot find their age, aborts none, and logs a warning with the count. See [Pruning](../guide/pruning.md).
