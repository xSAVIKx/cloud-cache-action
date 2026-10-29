# Getting Started

**Cloud Cache Action** allows you to store and retrieve GitHub Actions cache bundles using any S3-compatible cloud or self-hosted object storage service.

It is designed as a drop-in replacement for `actions/cache@v4-v6`, keeping your CI/CD workflows lightning fast while bypassing GitHub's 10GB default cache quotas and egress fees.

## Quickstart

Add the following step to your GitHub Actions workflow:

```yaml
- name: Cache dependencies to S3
  uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: my-ci-cache-bucket
    endpoint: https://<account_id>.r2.cloudflarestorage.com # Or AWS, GCS, B2, MinIO, etc.
    access-key: ${{ secrets.S3_ACCESS_KEY }}
    secret-key: ${{ secrets.S3_SECRET_KEY }}
    path: |
      ~/.npm
      node_modules
    key: ${{ runner.os }}-node-${{ hashFiles('**/package-lock.json') }}
    restore-keys: |
      ${{ runner.os }}-node-
```

For a package manager cache, `preset: npm` (or `yarn`, `pnpm`, `bun`, `pip`, `poetry`, `uv`, `gradle`, `maven`, `cargo`, `go`) gives the `path`, `key` and `restore-keys` for you. See [Cache Presets](./presets.md).

## Paths and Exclusions

`path` accepts files, directories, globs, `~` and `!` exclusions, one per line.

- **Exclusions only remove what the include patterns matched**, as in `actions/cache`. `path: logs` with `!logs/debug.txt` still caches the whole `logs` directory, because the directory itself is the match. To leave one file out, match the files instead:

  ```yaml
  path: |
    logs/*
    !logs/debug.txt
  ```

- **Symbolic links are not followed while matching.** A pattern that wildcards through a symlinked directory, such as `linked-dir/*` where `linked-dir` is a symlink, matches nothing. A symlink that a pattern matches is archived as a link, not as the files it points to.

### Symlinks

Symlinks are archived as links, never followed and re-created as copies. On Windows, `windows-latest` runners use Git's bundled GNU `tar`, which this action runs with `MSYS=winsymlinks:nativestrict` (the same setting `actions/cache` uses) so that restored links come back as native NTFS symlinks rather than plain-text stand-ins. GitHub-hosted Windows runners allow creating these without extra privileges.

On a self-hosted Windows runner, the account can lack the `SeCreateSymbolicLinkPrivilege` privilege, and Developer Mode can be off. Then Git's GNU `tar` cannot create native symlinks, and the extract fails with `Cannot create symlink to ...: Operation not permitted`. When symlinks are the only failure, the action logs a warning and extracts the archive one more time with `MSYS=winsymlinks:deepcopy`. Each symlink is then restored as a copy of its target, not as a link. A symlink whose target is not in the archive still fails the restore. BSD `tar` (`C:\Windows\System32\tar.exe`) does not read `MSYS`, so the action does not retry with it. This retry applies only to the S3 tier in file mode. With `streaming: true`, or for the GitHub tier with `dual-cache: true` (`@actions/cache` runs its own `tar`), the restore still fails. The retry also fails for a symlink whose target is another symlink later in the archive. A copied directory symlink can make the restored tree much larger than the archive.

## How It Works

1. **Restore Phase (Pre/Main)**:
   - Connects to your S3 bucket using modern `@aws-sdk/client-s3`.
   - Checks if an exact match exists for the `key` parameter.
   - If not found, evaluates `restore-keys` in order and downloads the most recently updated matching archive.
   - Downloads an archive larger than `download-chunk-size` (default 8 MiB) as concurrent `Range` requests, `download-concurrency` (default `8`) at a time, each retried on its own; set `download-concurrency: 1` for a single request. A provider that ignores `Range` gets the single request automatically. With `transfer-tuning: auto`, the action selects these settings from the archive size (see [Automatic tuning](./performance.md#automatic-tuning)).
   - Verifies the archive's sha256 checksum, when the object carries one, before extracting it; a mismatch is logged as a warning and counts as a cache miss (with `dual-cache: true` and `dual-cache-strict: true`, it fails the step).
   - With `streaming: true`, extracts the archive as it downloads instead, verifying the checksum at the end: a network or `tar` failure mid-stream, or a checksum mismatch, becomes a cache miss with the workspace possibly partly extracted, and there is no whole-download retry as there is in the default file mode.
   - Decompresses the archive using `zstd` (or `gzip` fallback) directly into your workspace.
   - Sets outputs (`cache-hit`, `cache-primary-key`, `cache-matched-key`, `cache-size`, `cache-storage-provider`, `cache-s3-key`, `cache-etag`, `cache-metadata`, `cache-hit-source`) plus the timings described in [Metrics and Timings](#metrics-and-timings).
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

## Inspecting a Lookup

When a restore misses and you expected a hit, set `explain: true` to log the whole lookup — the resolved key pattern, the `${version}` hash and what it is computed from, every ref searched and every candidate object with the version it carries — right before the restore runs. The `inspect` sub-action prints the same report as a step of its own, restoring nothing and exposing the result as outputs (`would-hit`, `would-match-key`, `would-match-object`, `candidate-count`, `report`):

```yaml
- name: Inspect the cache lookup
  id: lookup
  uses: xSAVIKx/cloud-cache-action/inspect@v1
  with:
    bucket: my-ci-cache-bucket
    path: ~/.npm
    key: ${{ runner.os }}-node-${{ hashFiles('**/package-lock.json') }}
```

See [Inspecting Lookups](./inspecting.md) for the full report, how to read the "none has version" reason, and the `fail-on-cache-miss` guard pattern for matrix jobs.

## Metrics and Timings

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

## Job Summary

After both restore and save, a step summary table is written via `core.summary` — a "Cloud cache
restore" table with the primary/matched key, cache hit, source, size and duration, and a "Cloud cache
save" table with the key, tiers saved to, size and duration. This is on by default; set
`job-summary: false` to turn it off. No summary is written when the step fails with an error, or
when `GITHUB_STEP_SUMMARY` is not set.

## Standalone Restore and Save Actions

Just like `actions/cache/restore` and `actions/cache/save`, you can invoke restore and save as independent steps:

### Restore Only

```yaml
- name: Restore cache
  id: restore-step
  uses: xSAVIKx/cloud-cache-action/restore@v1
  with:
    bucket: my-ci-cache-bucket
    key: ${{ runner.os }}-build-${{ hashFiles('**/lock') }}
    path: build/
```

### Save Only

```yaml
- name: Save cache
  uses: xSAVIKx/cloud-cache-action/save@v1
  with:
    bucket: my-ci-cache-bucket
    key: ${{ runner.os }}-build-${{ hashFiles('**/lock') }}
    path: build/
```

### Saving after failed steps

The post step only runs when the job succeeds. To save a cache even when a later step fails, use the separate actions with `if: always()`:

```yaml
- uses: xSAVIKx/cloud-cache-action/restore@v1
  id: cache
  with:
    bucket: my-bucket
    key: ${{ runner.os }}-build-${{ hashFiles('**/lock') }}
    path: ~/.cache

- run: make build

- uses: xSAVIKx/cloud-cache-action/save@v1
  if: always() && steps.cache.outputs.cache-hit != 'true'
  with:
    bucket: my-bucket
    key: ${{ runner.os }}-build-${{ hashFiles('**/lock') }}
    path: ~/.cache
```

### Action Metadata Definitions

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

