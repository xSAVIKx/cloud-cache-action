---
title: How It Works
description: "What a restore and a save of Cloud Cache Action do, step by step: the phases, symlinks, the metrics outputs and file, the job summary and the action.yml files."
---

# How It Works

This page is the reference for what a restore and a save do. To set up the action, read
[Getting Started](./getting-started.md) first.

## Restore and save phases

1. **Restore Phase (Pre/Main)**:
   - Connects to your S3 bucket using modern `@aws-sdk/client-s3`.
   - Looks for the `key`, then for each `restore-keys` entry in order, in the current ref, the pull request base branch and the default branch. The first match wins. [How a restore finds a cache](./s3-key-patterns.md#how-a-restore-finds-a-cache) shows the order in a diagram.
   - Downloads an archive larger than `download-chunk-size` (default 8 MiB) as concurrent `Range` requests, `download-concurrency` (default `8`) at a time, each retried on its own; set `download-concurrency: 1` for a single request. A provider that ignores `Range` gets the single request automatically. With `transfer-tuning: auto`, the action selects these settings from the archive size (see [Automatic tuning](./performance.md#automatic-tuning)).
   - Verifies the archive's sha256 checksum, when the object carries one, before extracting it; a mismatch is logged as a warning and counts as a cache miss (with `dual-cache: true` and `dual-cache-strict: true`, it fails the step).
   - With `streaming: true`, extracts the archive as it downloads instead, verifying the checksum at the end: a network or `tar` failure mid-stream, or a checksum mismatch, becomes a cache miss with the workspace possibly partly extracted, and there is no whole-download retry as there is in the default file mode.
   - Decompresses the archive using `zstd` (or `gzip` fallback) directly into your workspace.
   - Sets outputs (`cache-hit`, `cache-primary-key`, `cache-matched-key`, `cache-size`, `cache-storage-provider`, `cache-s3-key`, `cache-etag`, `cache-metadata`, `cache-hit-source`) plus the timings described in [Metrics and timings](#metrics-and-timings).
   - Writes a job summary table with the key, hit status, source, size and duration, unless `job-summary: false`.

2. **Save Phase (Post)**:
   - If `read-only: true` or if an exact key match occurred during restore, saving is automatically skipped.
   - Checks whether another job already saved the same object first; if so, keeps that job's cache instead of overwriting it. The upload itself is a conditional create, so two saves racing for the same key cannot overwrite each other on providers that enforce `If-None-Match` (verified on AWS S3, MinIO, SeaweedFS and RustFS); providers that ignore it (verified: Garage; reportedly Google Cloud Storage's S3 interoperability) keep last-writer-wins.
   - Otherwise, archives the specified `path` directories using multi-threaded `zstd` compression.
   - Streams the compressed archive to your S3 bucket using multipart uploads via `@aws-sdk/lib-storage`, `upload-concurrency` (default `8`) parts of `upload-chunk-size` (default 64 MiB) at a time, tagged with a sha256 checksum for later integrity verification.
   - Stores any `metadata` as `x-amz-meta-*` user metadata on the saved object and any `tags` as object tags, and the metadata comes back on the next restore as the `cache-metadata` output. Providers without object tagging log one warning and save without tags (verified: SeaweedFS and MinIO store tags; Garage accepts the upload but implements no tagging API, so its tags cannot be read back).
   - Emits diagnostics and completes cleanly without breaking the build on non-fatal network interruptions.
   - Writes a job summary table with the key, saved-to tiers, size and duration, unless `job-summary: false`.

Cache archives are never deleted automatically; see [Pruning Caches](./pruning.md) for a
scheduled cleanup sub-action.

## Symlinks

Symlinks are archived as links, never followed and re-created as copies. On Windows, `windows-latest` runners use Git's bundled GNU `tar`, which this action runs with `MSYS=winsymlinks:nativestrict` (the same setting `actions/cache` uses) so that restored links come back as native NTFS symlinks rather than plain-text stand-ins. GitHub-hosted Windows runners allow creating these without extra privileges.

On a self-hosted Windows runner, the account can lack the `SeCreateSymbolicLinkPrivilege` privilege, and Developer Mode can be off. Then Git's GNU `tar` cannot create native symlinks, and the extract fails with `Cannot create symlink to ...: Operation not permitted`. When symlinks are the only failure, the action logs a warning and extracts the archive one more time with `MSYS=winsymlinks:deepcopy`. Each symlink is then restored as a copy of its target, not as a link. A symlink whose target is not in the archive still fails the restore. BSD `tar` (`C:\Windows\System32\tar.exe`) does not read `MSYS`, so the action does not retry with it. This retry applies only to the S3 tier in file mode. With `streaming: true`, or for the GitHub tier with `dual-cache: true` (`@actions/cache` runs its own `tar`), the restore still fails. The retry also fails for a symlink whose target is another symlink later in the archive. A copied directory symlink can make the restored tree much larger than the archive.

## Metrics and timings

Restore and save set four timing and size outputs on every path, so they are always defined: `cache-restore-duration-ms` and `cache-save-duration-ms` (wall-clock milliseconds of the step, `0` when it did not complete), `cache-transfer-duration-ms` (the S3 download or upload alone) and `cache-bytes` (the archive that was restored or saved, `0` when none was).

On the unified action the save runs as a post step, and it sets `cache-save-duration-ms`, `cache-transfer-duration-ms` and `cache-bytes` for itself — including zeroing them when there is nothing to save. After the post step those three therefore describe the save, while `cache-size` and `cache-restore-duration-ms` still hold the restore's values. Read a restore's byte count in a step that runs before the post step, or use the standalone `restore` and `save` actions, where each step owns its outputs.

Every step — restore, save, `prune` and `inspect` — also writes one `cloud-cache-metrics <json>` debug line. Set `metrics-file` to append that same JSON as one line to a file, resolved relative to `GITHUB_WORKSPACE`:

```yaml
- uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: my-ci-cache-bucket
    path: ~/.npm
    key: ${{ runner.os }}-node-${{ hashFiles('**/package-lock.json') }}
    metrics-file: cache-metrics.jsonl
```

```json
{"step":"restore","timestamp":"2026-09-17T06:02:41.912Z","provider":"r2","key":"Linux-node-9f2c1a","matchedKey":"Linux-node-9f2c1a","objectKey":"octo/app/refs%2Fheads%2Fmain/Linux-node-9f2c1a/4d0f1b2c9a7e35f1/cache.tar.zst","source":"s3","bytes":199687424,"durationMs":8123,"transferDurationMs":5310,"lookupDurationMs":240,"extractDurationMs":2410,"streaming":false,"downloadParts":24,"outcome":"hit"}
```

- `step` is `restore`, `save`, `prune` or `inspect`, and `outcome` is one of `hit`, `miss`, `saved`, `exists`, `skipped`, `error`, `pruned`, `would-hit` or `would-miss`.
- `transferDurationMs` measures the S3 transfer alone in the default file mode. With `streaming: true` the archive is extracted (or compressed) as it moves, so the same field covers download-plus-extract; the `streaming` field on the line tells the two apart.
- `downloadParts` on a restore is how many ranged requests fetched the archive: `1` for a single request and `0` when nothing was downloaded.
- `lookupDurationMs` on a restore is the time to find the S3 object. In file mode, `archiveDurationMs` on a save is the time to write and hash the archive, and `extractDurationMs` on a restore is the time to unpack it. Streaming mode does these phases during the transfer, so it does not report them. A streaming step that falls back to file mode reports them.
- After an S3 download or upload, the step also logs the phases in one line, for example `Timings: lookup 0.24 s, download 5.31 s (35.9 MiB/s), extract 2.41 s, total 8.12 s`. This line is not a debug line, so it shows in every log. `total` is the whole step, including the GitHub tier in dual-cache mode. The transfer time and the rate include retries.
- `prune` and `inspect` write their line once the step has finished its work, so a step that fails earlier writes none. `prune` reports its tallies in `extra` (`prunedCount`, `prunedBytes`, `keptCount`, `dryRun`) and `inspect` reports `candidateCount`.
- Writing the file is best-effort by design: a machine-readable timing record must never fail a cache step, so a write error only logs `Could not write metrics to <path>: <reason>`.

## Job summary

After both restore and save, a step summary table is written via `core.summary` — a "Cloud cache
restore" table with the primary/matched key, cache hit, source, size and duration, and a "Cloud cache
save" table with the key, tiers saved to, size and duration. This is on by default; set
`job-summary: false` to turn it off. No summary is written when the step fails with an error, or
when `GITHUB_STEP_SUMMARY` is not set.

## Action metadata definitions

You can inspect the full action specification files directly in the repository:

- **Unified Action**: [`action.yml`](https://github.com/xSAVIKx/cloud-cache-action/blob/main/action.yml)
- **Dedicated Restore Action**: [`restore/action.yml`](https://github.com/xSAVIKx/cloud-cache-action/blob/main/restore/action.yml)
- **Dedicated Save Action**: [`save/action.yml`](https://github.com/xSAVIKx/cloud-cache-action/blob/main/save/action.yml)
- **Inspect Action**: [`inspect/action.yml`](https://github.com/xSAVIKx/cloud-cache-action/blob/main/inspect/action.yml)

::: details `action.yml` (Click to view unified action definition)
<<< ../../action.yml{yaml}
:::

::: details `restore/action.yml` (Click to view restore action definition)
<<< ../../restore/action.yml{yaml}
:::

::: details `save/action.yml` (Click to view save action definition)
<<< ../../save/action.yml{yaml}
:::

::: details `inspect/action.yml` (Click to view inspect action definition)
<<< ../../inspect/action.yml{yaml}
:::
