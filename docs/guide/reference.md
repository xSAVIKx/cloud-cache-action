---
title: Inputs and Outputs
---

# Inputs and Outputs

This page lists the inputs and the outputs of the main action, `xSAVIKx/cloud-cache-action@v1`.
The `restore` and `save` sub-actions take the same inputs, with these exceptions:

- `restore` does not take the save inputs: `read-only`, `compression-level`, `upload-chunk-size`,
  `upload-concurrency`, `metadata` and `tags`.
- `save` does not take the restore inputs: `restore-keys`, `lookup-only`, `fail-on-cache-miss`,
  `read-only`, `restore-priority`, `explain`, `download-concurrency` and `download-chunk-size`.

The [`prune`](./pruning.md#inputs) and [`inspect`](./inspecting.md#outputs) sub-actions
have their own inputs and outputs, on their own pages. The `action.yml` file of each action is
the full definition (see [Action Metadata Definitions](./getting-started.md#action-metadata-definitions)).

## Sub-actions

| Action | Use |
| --- | --- |
| `xSAVIKx/cloud-cache-action@v1` | Restores in the main step and saves in the post step, as `actions/cache` does. |
| `xSAVIKx/cloud-cache-action/restore@v1` | Restores only. |
| `xSAVIKx/cloud-cache-action/save@v1` | Saves only. Use it with `if: always()` to save after a failed step (see [Saving after failed steps](./getting-started.md#saving-after-failed-steps)). |
| `xSAVIKx/cloud-cache-action/prune@v1` | Deletes old cache archives, for example on a schedule. See [Pruning Caches](./pruning.md). |
| `xSAVIKx/cloud-cache-action/inspect@v1` | Reports which object a restore would use, and why, without a restore. See [Inspecting Lookups](./inspecting.md). |

## Inputs

| Input                            | Required |                          Default                           | Description                                                                 |
| -------------------------------- | :------: | :--------------------------------------------------------: | --------------------------------------------------------------------------- |
| `bucket`                         | **Yes**  |                             —                              | Name of the S3 bucket                                                       |
| `key`                            | **Yes**, unless `preset` is set |                             —                              | Explicit key for restoring and saving cache                                 |
| `path`                           | **Yes**, unless `preset` is set |                             —                              | Multiline list of paths, globs and `!` exclusions to cache (see [Paths and exclusions](./getting-started.md#paths-and-exclusions)) |
| `preset`                         |    No    |                             —                              | Package manager preset that gives the default `path`, `key` and `restore-keys`: `npm`, `yarn`, `pnpm`, `bun`, `pip`, `poetry`, `uv`, `gradle`, `maven`, `cargo`, `go` (see [Cache presets](./presets.md)) |
| `restore-keys`                   |    No    |                             —                              | Multiline string of prefix keys for fallback matching                       |
| `endpoint`                       |    No    |                          Auto/AWS                          | Custom S3 endpoint URL                                                      |
| `region`                         |    No    |                      Auto/`us-east-1`                      | AWS or S3 provider region                                                   |
| `provider`                       |    No    |                            Auto                            | Preset: `aws`, `r2`, `gcs`, `b2`, `fastly`, `garage`, `seaweedfs`, `minio`, `rustfs`  |
| `access-key` / `accessKey`       |    No    |                    `AWS_ACCESS_KEY_ID`                     | S3 Access Key ID                                                            |
| `secret-key` / `secretKey`       |    No    |                  `AWS_SECRET_ACCESS_KEY`                   | S3 Secret Access Key                                                        |
| `session-token` / `sessionToken` |    No    |                    `AWS_SESSION_TOKEN`                     | S3 Session Token                                                            |
| `force-path-style`               |    No    |                            Auto                            | Force path-style S3 URLs                                                    |
| `prefix`                         |    No    |                            `""`                            | Subfolder prefix path inside bucket                                         |
| `s3-key-pattern`                 |    No    | `${GITHUB_REPOSITORY}/${prefix}${ref}/${key}/${version}/${archive_filename}` | Custom S3 key template pattern (supports `${ENV_VARS}`)                     |
| `scoped-to-repository`           |    No    |                           `true`                           | Prefix bucket cache paths with repository name                              |
| `scoped-to-ref`                  |    No    |                           `true`                            | Restore from the current ref, then the PR base, then the default branch; `false` shares caches across refs |
| `lookup-only`                    |    No    |                          `false`                           | Check existence without downloading                                         |
| `fail-on-cache-miss`             |    No    |                          `false`                           | Fail workflow if cache is not found                                         |
| `enableCrossOsArchive`           |    No    |                          `false`                           | Allow Windows runners to save/restore cross-OS caches                       |
| `read-only`                      |    No    |                          `false`                           | Restore cache but never save in post step                                   |
| `retry`                          |    No    |                           `true`                           | Enable exponential backoff retries on S3 operations                         |
| `retry-count`                    |    No    |                            `3`                             | Maximum number of S3 retries                                                |
| `use-fallback`                   |    No    |                          `false`                           | Fallback to GitHub Actions cache service if S3 fails                        |
| `dual-cache`                     |    No    |                          `false`                           | Cache to both S3 and GitHub Actions Cache simultaneously                    |
| `restore-priority`               |    No    |                         `s3-first`                         | Cache source to query first: `s3-first` or `github-first`                   |
| `dual-cache-strategy`            |    No    |                         `backfill`                         | `backfill` (upload to a tier only if it lacks the key) or `skip-on-hit` |
| `dual-cache-strict`              |    No    |                          `false`                           | Fail the step when either tier errors during restore or save |
| `streaming`                      |    No    |                          `false`                           | Stream archives directly between `tar` and S3 without a temporary file (experimental; see [Streaming Archives](./storage.md#streaming-archives-experimental)) |
| `download-concurrency`           |    No    |                            `8`                             | Ranged GET requests a restore runs at once for archives larger than `download-chunk-size` (1–32); `1` downloads in one request (see [Parallel Transfers](./performance.md#parallel-transfers)) |
| `download-chunk-size`            |    No    |                         `8388608`                          | Bytes per ranged GET request (1 MiB–128 MiB); archives no larger than this use one request |
| `upload-concurrency`             |    No    |                            `8`                             | Multipart upload parts sent at once (1–32)                                  |
| `upload-chunk-size`              |    No    |                         `67108864`                         | Bytes per multipart upload part (5 MiB–128 MiB); the same input `actions/cache` takes |
| `transfer-tuning`                |    No    |                          `fixed`                           | `auto` selects the part size and the concurrency per archive from its size (and, for a save, the provider); a transfer input you set still wins (see [Parallel Transfers](./performance.md#parallel-transfers)) |
| `compression-level`              |    No    |                            Tool default                            | zstd 1–19 or gzip 1–9 for saving; lower is faster and larger (see [Performance](./performance.md)) |
| `job-summary`                    |    No    |                           `true`                           | Write a job summary table with the cache keys, hit, source, size and duration |
| `metadata`                       |    No    |                             —                              | User metadata (`x-amz-meta-*`) for every saved object, one `key=value` per line, with surrounding whitespace trimmed (see [Object Metadata and Tags](./storage.md#object-metadata-and-tags)) |
| `tags`                           |    No    |                             —                              | Object tags for every saved object, one `key=value` per line (up to 10; up to 9 with `streaming: true`, which reserves one slot for the checksum tag) |
| `explain`                        |    No    |                          `false`                           | Log why the lookup hits or misses before restoring (see [Inspecting a cache lookup](./inspecting.md)) |
| `metrics-file`                   |    No    |                            `""`                            | Append one JSON line of timings and sizes for this step to this file, relative to the workspace |


For the rules that `path` follows (globs, `~`, `!` exclusions and symbolic links), see [Paths and Exclusions](./getting-started.md#paths-and-exclusions).

## Outputs

- `cache-hit`: `'true'` if an exact match was found for the primary key; `'false'` otherwise.
- `cache-primary-key`: The evaluated primary cache key.
- `cache-matched-key`: Key that was matched and restored.
- `cache-size`: Archive size in bytes.
- `cache-storage-provider`: Resolved storage provider (e.g. `r2`, `gcs`, `aws`).
- `cache-s3-key`: Full S3 object key inside the bucket.
- `cache-etag`: ETag checksum of the archive in S3.
- `cache-metadata`: JSON object of the restored object's user metadata, excluding `cloud-cache-*` keys; `{}` when there is none, on a GitHub-tier hit, or with `lookup-only: true`, which never downloads the object.
- `cache-hit-source`: The tier that serviced the hit: `s3`, `github`, or `none`.
- `cache-saved-sources`: Tiers successfully saved to: `s3`, `github`, or `s3,github`.
- `cache-restore-duration-ms`: Wall-clock milliseconds the restore step took; `0` when it did not complete.
- `cache-save-duration-ms`: Wall-clock milliseconds the save step took; `0` when it did not complete.
- `cache-transfer-duration-ms`: Milliseconds spent on the S3 download or upload alone; `0` when nothing was transferred.
- `cache-bytes`: Size in bytes of the archive restored or saved; `0` when none was. See [Metrics and Timings](./getting-started.md#metrics-and-timings).
