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

<div class="reference-table">

| Input | Description | Required | Default |
| --- | --- | --- | --- |
| `bucket` | Name of the S3 bucket | **Yes** | — |
| `key` | Explicit key for restoring and saving cache | **Yes**, unless `preset` is set | — |
| `path` | Multiline list of paths, globs and `!` exclusions to cache (see [Paths and exclusions](./getting-started.md#paths-and-exclusions)) | **Yes**, unless `preset` is set | — |
| `preset` | Package manager preset that gives the default `path`, `key` and `restore-keys`: `npm`, `yarn`, `pnpm`, `bun`, `pip`, `poetry`, `uv`, `gradle`, `maven`, `cargo`, `go` (see [Cache presets](./presets.md)) | No | — |
| `restore-keys` | Multiline string of prefix keys for fallback matching | No | — |
| `endpoint` | Custom S3 endpoint URL | No | Auto/AWS |
| `region` | AWS or S3 provider region | No | Auto/`us-east-1` |
| `provider` | Preset: `aws`, `r2`, `gcs`, `b2`, `fastly`, `garage`, `seaweedfs`, `minio`, `rustfs` | No | Auto |
| `access-key` / `accessKey` | S3 Access Key ID | No | `AWS_ACCESS_KEY_ID` |
| `secret-key` / `secretKey` | S3 Secret Access Key | No | `AWS_SECRET_ACCESS_KEY` |
| `session-token` / `sessionToken` | S3 Session Token | No | `AWS_SESSION_TOKEN` |
| `force-path-style` | Force path-style S3 URLs | No | Auto |
| `prefix` | Subfolder prefix path inside bucket | No | `""` |
| `s3-key-pattern` | Custom S3 key template pattern (supports `${ENV_VARS}`) | No | See below the table |
| `scoped-to-repository` | Prefix bucket cache paths with repository name | No | `true` |
| `scoped-to-ref` | Restore from the current ref, then the PR base, then the default branch; `false` shares caches across refs | No | `true` |
| `lookup-only` | Check existence without downloading | No | `false` |
| `fail-on-cache-miss` | Fail workflow if cache is not found | No | `false` |
| `enableCrossOsArchive` | Allow Windows runners to save/restore cross-OS caches | No | `false` |
| `read-only` | Restore cache but never save in post step | No | `false` |
| `retry` | Enable exponential backoff retries on S3 operations | No | `true` |
| `retry-count` | Maximum number of S3 retries | No | `3` |
| `use-fallback` | Fallback to GitHub Actions cache service if S3 fails | No | `false` |
| `dual-cache` | Cache to both S3 and GitHub Actions Cache simultaneously | No | `false` |
| `restore-priority` | Cache source to query first: `s3-first` or `github-first` | No | `s3-first` |
| `dual-cache-strategy` | `backfill` (upload to a tier only if it lacks the key) or `skip-on-hit` | No | `backfill` |
| `dual-cache-strict` | Fail the step when either tier errors during restore or save | No | `false` |
| `streaming` | Stream archives directly between `tar` and S3 without a temporary file (experimental; see [Streaming Archives](./storage.md#streaming-archives-experimental)) | No | `false` |
| `download-concurrency` | Ranged GET requests a restore runs at once for archives larger than `download-chunk-size` (1–32); `1` downloads in one request (see [Parallel Transfers](./performance.md#parallel-transfers)) | No | `8` |
| `download-chunk-size` | Bytes per ranged GET request (1 MiB–128 MiB); archives no larger than this use one request | No | `8388608` |
| `upload-concurrency` | Multipart upload parts sent at once (1–32) | No | `8` |
| `upload-chunk-size` | Bytes per multipart upload part (5 MiB–128 MiB); the same input `actions/cache` takes | No | `67108864` |
| `transfer-tuning` | `auto` selects the part size and the concurrency per archive from its size (and, for a save, the provider); a transfer input you set still wins (see [Parallel Transfers](./performance.md#parallel-transfers)) | No | `fixed` |
| `compression-level` | zstd 1–19 or gzip 1–9 for saving; lower is faster and larger (see [Performance](./performance.md)) | No | Tool default |
| `job-summary` | Write a job summary table with the cache keys, hit, source, size and duration | No | `true` |
| `metadata` | User metadata (`x-amz-meta-*`) for every saved object, one `key=value` per line, with surrounding whitespace trimmed (see [Object Metadata and Tags](./storage.md#object-metadata-and-tags)) | No | — |
| `tags` | Object tags for every saved object, one `key=value` per line (up to 10; up to 9 with `streaming: true`, which reserves one slot for the checksum tag) | No | — |
| `explain` | Log why the lookup hits or misses before restoring (see [Inspecting a cache lookup](./inspecting.md)) | No | `false` |
| `metrics-file` | Append one JSON line of timings and sizes for this step to this file, relative to the workspace | No | `""` |

</div>

The default of `s3-key-pattern` is:

```text
${GITHUB_REPOSITORY}/${prefix}${ref}/${key}/${version}/${archive_filename}
```


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
