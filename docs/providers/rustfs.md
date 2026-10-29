# RustFS Setup

[RustFS](https://rustfs.com/) is an open-source, S3-compatible distributed object store written in
Rust and licensed under Apache-2.0. It reached 1.0 in September 2026 and targets the same
self-hosted and on-premise uses as MinIO, with erasure coding, lifecycle policies, IAM and
server-side encryption.

Use `provider: rustfs` to select path-style addressing and the `us-east-1` default region.

```yaml
- name: Cache dependencies using RustFS
  uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: ci-cache
    endpoint: https://rustfs.internal:9000
    provider: rustfs
    access-key: ${{ secrets.RUSTFS_ACCESS_KEY }}
    secret-key: ${{ secrets.RUSTFS_SECRET_KEY }}
    key: ${{ runner.os }}-node-${{ hashFiles('**/package-lock.json') }}
    restore-keys: |
      ${{ runner.os }}-node-
    path: ~/.npm
```

---

## Feature support

Every feature of this action was verified against RustFS 1.0.0, and the whole integration suite
passes against it in CI next to Garage, SeaweedFS and MinIO. Nothing is disabled for this
provider:

| Feature | RustFS 1.0.0 |
| :--- | :--- |
| Multipart upload, with `upload-concurrency` and `upload-chunk-size` | Works |
| Ranged `GET` (parallel downloads) | Works, answers `206 Partial Content` |
| User metadata (`x-amz-meta-*`), so the sha256 integrity check runs | Stored and returned |
| Object tags (`tags` input) | Stored, and readable with `GetObjectTagging` |
| Conditional create (`If-None-Match`), for [Safe Concurrent Saves](../guide/storage.md#safe-concurrent-saves) | Enforced, rejects a second write with `412` |
| `CopyObject` with `REPLACE`, for metadata on `streaming: true` saves | Works |
| `ListObjectsV2` and `DeleteObjects`, used by the `prune` sub-action | Work |

---

## Port 9000 and provider detection

RustFS serves the S3 API on port 9000 by default, the same port MinIO uses, so the endpoint alone
cannot tell the two apart. An endpoint ending in `:9000` with no `provider` input is reported as
`minio` in the log. Both presets resolve to the same settings (path-style addressing, `us-east-1`),
so a cache works either way. Set `provider: rustfs` when you want the log and the
`cache-storage-provider` output to name RustFS.

---

## Credentials

The server's initial credentials come from `RUSTFS_ACCESS_KEY` and `RUSTFS_SECRET_KEY`, which
default to `rustfsadmin` / `rustfsadmin`.

> [!WARNING]
> Do not put the server's root credentials in a workflow. Create a dedicated user restricted to the
> cache bucket in the RustFS console or through its IAM API, and store that user's keys as GitHub
> secrets.

The [Security guide](../guide/security.md#minio-and-rustfs) shows a policy that limits the user to the bucket and the repository prefix.

| Secret Name | Description |
| :--- | :--- |
| `RUSTFS_ACCESS_KEY` | Access key of the CI user |
| `RUSTFS_SECRET_KEY` | Secret key of the CI user |

---

## Example: ephemeral RustFS inside a CI job

RustFS starts fast enough to run as a throwaway container in the same job as the build, which
gives an isolated cache with no external service:

```yaml
name: Build with an ephemeral RustFS cache

on: [push, pull_request]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5

      - name: Start RustFS
        run: |
          docker run -d --name ci-rustfs -p 9000:9000 \
            -e RUSTFS_ACCESS_KEY=cloudcacheci \
            -e RUSTFS_SECRET_KEY=cloudcachecisecret \
            --tmpfs /data:uid=10001,gid=10001 \
            --tmpfs /logs:uid=10001,gid=10001 \
            rustfs/rustfs:1.0.0
          # The S3 endpoint answers 403 to an anonymous request once it is ready.
          for _ in $(seq 1 60); do
            code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9000/ || true)
            if [ "$code" = "403" ]; then echo "RustFS ready."; break; fi
            sleep 1
          done

      - name: Cache dependencies
        uses: xSAVIKx/cloud-cache-action@v1
        with:
          bucket: ci-cache
          endpoint: http://127.0.0.1:9000
          provider: rustfs
          access-key: cloudcacheci
          secret-key: cloudcachecisecret
          key: ${{ runner.os }}-node-${{ hashFiles('**/package-lock.json') }}
          path: ~/.npm
```

The action creates nothing but objects: create the bucket first, either in the console or with any
S3 client, because the action never creates a bucket.

> [!NOTE]
> The container runs as uid/gid `10001`. Give it writable `/data` and `/logs`, either as `tmpfs`
> mounts as above, as Docker named volumes, or as host directories you `chown -R 10001:10001`
> first. A bind mount the user cannot write makes the server exit at startup with
> `Local disk initialization failed`.

---

## Running RustFS locally for integration testing

The repository's
[`docker-compose.test.yml`](https://github.com/xSAVIKx/cloud-cache-action/blob/main/docker-compose.test.yml)
includes a RustFS service, published on port 9010 so it can run next to MinIO:

```bash
docker compose -f docker-compose.test.yml up -d rustfs
TEST_S3_ENDPOINT=http://127.0.0.1:9010 TEST_S3_PROVIDER=rustfs REQUIRE_S3=1 npm run test:integration
```

::: details `docker-compose.test.yml` (Click to view Compose definition)
<<< ../../docker-compose.test.yml{yaml}
:::

---

## Live CI

The repository runs its integration suite and a full save-and-restore round trip against RustFS on
every pull request, in the `S3 compatibility (rustfs)` job of
[`.github/workflows/test.yml`](https://github.com/xSAVIKx/cloud-cache-action/blob/main/.github/workflows/test.yml).

## Notes

- **Checksums**: for this provider, the action sends request checksums only when S3 requires them,
  because many S3-compatible services reject the CRC checksums recent AWS SDKs send by default.
  Nothing to configure.
- **Expiry**: the action never deletes caches. Use a RustFS lifecycle policy, or the
  [`prune` sub-action](../guide/pruning.md), so old caches
  do not accumulate.
