<p align="center">
  <a href="https://xsavikx.github.io/cloud-cache-action/">
    <img src="https://raw.githubusercontent.com/xSAVIKx/cloud-cache-action/main/docs/public/logo.svg" width="128" height="128" alt="Cloud Cache Action Logo">
  </a>
</p>

<h1 align="center">Cloud Cache Action</h1>

<p align="center">
  <strong>High-performance GitHub Action for saving and restoring CI cache bundles directly to any S3-compatible cloud or self-hosted object storage with 1:1 actions/cache parity and native Node 24 runtime.</strong>
</p>

<p align="center">
  <a href="https://github.com/xSAVIKx/cloud-cache-action/actions/workflows/test.yml"><img src="https://github.com/xSAVIKx/cloud-cache-action/actions/workflows/test.yml/badge.svg" alt="CI Tests"></a>
  <a href="https://xsavikx.github.io/cloud-cache-action/"><img src="https://img.shields.io/badge/docs-GitHub%20Pages-blue.svg" alt="Documentation"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-24-green.svg" alt="Node Runtime"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <a href="https://serhiichuk.dev"><img src="https://img.shields.io/badge/Author-serhiichuk.dev-black" alt="Author"></a>
</p>

<p align="center">
  <a href="#quick-usage">Quick Usage</a> •
  <a href="https://xsavikx.github.io/cloud-cache-action/">Documentation</a> •
  <a href="#supported-providers--examples">Supported Providers</a> •
  <a href="#dual-caching-lightweight-github-runner--heavy-remote-cloud-build">Dual Caching</a> •
  <a href="#cache-pruning">Cache Pruning</a> •
  <a href="#inputs">Inputs & Outputs</a>
</p>

---

Created and maintained by [Yurii Serhiichuk](https://serhiichuk.dev).

---

## Features

- **actions/cache (v4–v6) compatible**: the same inputs (`key`, `path` with globs, `~` and `!` exclusions, `restore-keys`, `lookup-only`, `fail-on-cache-miss`, `enableCrossOsArchive`, `upload-chunk-size`) and outputs (`cache-hit`, `cache-primary-key`, `cache-matched-key`); the same key matching (exact key, then key prefix, then restore keys); and the same branch isolation (current ref, then pull request base, then default branch). `save-always` is not supported; see [Saving after failed steps](#saving-after-failed-steps).
- **No Deprecation Warnings**: Built natively for modern GitHub Actions runners (`runs: using: 'node24'`).
- **Universal S3 Compatibility**: First-class support for:
  - **AWS S3** (IAM static credentials or OIDC `aws-actions/configure-aws-credentials`)
  - **Cloudflare R2** (Zero egress caching)
  - **Google Cloud Storage (GCS)** (HMAC interoperability)
  - **Backblaze B2**
  - **Fastly Object Storage**
  - **Garage S3** (Lightweight self-hosted S3)
  - **SeaweedFS S3**
  - **RustFS** (Rust, Apache-2.0, S3-compatible)
  - **MinIO / LocalStack / Ceph**
- **Smart Provider Auto-Detection**: Automatically determines optimal regions and path-style addressing from your endpoint URL.
- **Custom S3 Key & Environment Templating**: Default pattern `${GITHUB_REPOSITORY}/${prefix}${ref}/${key}/${version}/${archive_filename}` with full override capability and support for dynamic environment variables (`${RUNNER_OS}`, `${GITHUB_JOB}`, `${WORKLOAD_TYPE}`).
- **Safe Cross-Platform Keys**: Guarantees standard POSIX forward slashes (`/`) in object storage across Linux, macOS, and Windows runners (fixing legacy backslash bugs).
- **Multi-Threaded `zstd` Compression**: Lightning-fast archiving with fallback to `gzip`.
- **Dual Caching (Multi-Tier)**: Optionally cache across both remote S3 and GitHub Actions Cache simultaneously with configurable priority (`s3-first` or `github-first`) and automatic backfill synchronization.
- **Standalone Sub-Actions**: Includes `cloud-cache-action/restore`, `cloud-cache-action/save`, `cloud-cache-action/prune` and `cloud-cache-action/inspect` for decoupled cache stages, scheduled cleanup and lookup debugging.
- **Archive Integrity**: Every save writes a sha256 checksum as object metadata; restore verifies it and treats a mismatch as a cache miss with a warning, so a corrupted or truncated object is never reported as a hit. See [Archive Integrity](#archive-integrity).
- **Safe Concurrent Saves**: Uploads use a conditional create (`If-None-Match`), so on providers that enforce it, two jobs racing to save the same key never overwrite each other. See [Safe Concurrent Saves](#safe-concurrent-saves).
- **Cache Pruning**: A dedicated `prune` sub-action deletes cache archives from any S3-compatible bucket on a schedule, by age, by count per ref (`keep-latest`) or to fit a total size budget (`max-total-size`). See [Cache Pruning](#cache-pruning).
- **Job Summary**: Writes a step summary table after restore and save with the key, hit/source, size and duration (on by default; `job-summary: false` turns it off).
- **Object Metadata and Tags**: Store custom `x-amz-meta-*` metadata and object tags on every saved cache object with `metadata` and `tags`; the metadata comes back on restore as the `cache-metadata` output. See [Object Metadata and Tags](#object-metadata-and-tags).
- **Explain a Lookup**: `explain: true` logs why a lookup hits or misses — the resolved pattern, the `${version}` hash, every ref searched and every candidate object — and the `inspect` sub-action reports the same thing as step outputs, without restoring anything. See [Inspecting a cache lookup](#inspecting-a-cache-lookup).
- **Metrics**: Every step exposes its timings and byte count as outputs and can append one JSON line per step to a `metrics-file`. See [Metrics and Timings](#metrics-and-timings).
- **Opt-in Streaming (Experimental)**: Stream archives directly between `tar` and S3 without a temporary file, with `streaming: true`. See [Streaming Archives](#streaming-archives-experimental).
- **Parallel Transfers**: Restores fetch archives larger than 8 MiB as concurrent `Range` requests, and saves send multipart parts concurrently, 8 at a time each by default, the same fan-out as `actions/cache`. See [Parallel Transfers](#parallel-transfers).
- **Least-Privilege Policies**: The [Security guide](https://xsavikx.github.io/cloud-cache-action/guide/security.html) explains the trust boundary, fork pull requests, the read-only pattern, and gives IAM policies for AWS, R2, GCS, MinIO and RustFS.
- **Resilient**: Automatic exponential backoff retries on transient network errors.

---

## Quick Usage

```yaml
- name: Cache dependencies to S3
  uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: my-ci-cache-bucket
    endpoint: https://<account_id>.r2.cloudflarestorage.com # Or AWS, GCS, B2, MinIO
    access-key: ${{ secrets.S3_ACCESS_KEY }}
    secret-key: ${{ secrets.S3_SECRET_KEY }}
    path: |
      ~/.npm
      node_modules
    key: ${{ runner.os }}-node-${{ hashFiles('**/package-lock.json') }}
    restore-keys: |
      ${{ runner.os }}-node-
```

### Cache presets

Set `preset` instead of `path`, `key` and `restore-keys`. The preset gives the download cache of the package manager for the runner OS, the key `<runner.os>-<preset>-<hash of the lockfiles>` and the restore key `<runner.os>-<preset>-`:

```yaml
- name: Cache npm downloads to S3
  uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: my-ci-cache-bucket
    access-key: ${{ secrets.S3_ACCESS_KEY }}
    secret-key: ${{ secrets.S3_SECRET_KEY }}
    preset: npm # npm, yarn, pnpm, bun, pip, poetry, uv, gradle, maven, cargo or go
```

- An explicit `path`, `key` or `restore-keys` input replaces the preset value for that one input. With an explicit `key`, the action adds no preset restore keys.
- The paths are the static defaults that each tool documents. The action does not run the package manager to find them. If you move the cache directory, set `path`.
- With no lockfile that matches the preset globs, the step fails and names the globs.
- The post step saves with the key and the paths that the restore step resolved. It does not hash the lockfiles again.
- The `restore` and `save` sub-actions take `preset` too. `prune` and `inspect` do not.

The [Cache Presets](https://xsavikx.github.io/cloud-cache-action/guide/presets) guide lists the paths and the lockfile globs of each preset, and the source of each value.

### 🤖 Migrate in Seconds with AI Coding Agents

If you use an AI coding assistant (such as Claude Code, Cursor, Copilot, Antigravity, or Devin), paste this prompt to migrate your repository automatically:

```text
Migrate all GitHub Actions cache steps in this repository to `xSAVIKx/cloud-cache-action@v1`. Discover all workflow files in `.github/workflows/`, replace `actions/cache@*` (and /restore or /save) preserving all keys, paths, and inputs, detect or ask which storage provider (Cloudflare R2, AWS S3, GCS, MinIO) to configure, and provide a checklist of required GitHub Secrets.
```

👉 See the full [Agent-Assisted Migration Guide](https://xsavikx.github.io/cloud-cache-action/guide/migration.html) for the comprehensive prompt and provider secrets cheat sheet.

---


## Documentation

Full documentation, provider guides, and advanced configurations are available at:

👉 **[https://xsavikx.github.io/cloud-cache-action/](https://xsavikx.github.io/cloud-cache-action/)**

---

## CLI

The `cloud-cache` command line tool runs the same cache engine outside GitHub Actions. It has the commands `restore`, `save`, `inspect` and `prune`. The flags have the names of the action inputs.

The first release that includes the CLI, and each later release, has `cloud-cache.mjs` and a `SHA256SUMS` file. Read the [CLI guide](https://xsavikx.github.io/cloud-cache-action/guide/cli.html).

---

## Supported Providers & Examples

### Cloudflare R2

Zero egress fees for CI caches:

```yaml
- uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: ci-cache
    endpoint: https://${{ secrets.R2_ACCOUNT_ID }}.r2.cloudflarestorage.com
    access-key: ${{ secrets.R2_ACCESS_KEY }}
    secret-key: ${{ secrets.R2_SECRET_KEY }}
    key: ${{ runner.os }}-build-${{ hashFiles('**/lock') }}
    path: ~/.cache
```

### AWS S3 (with OIDC)

```yaml
- name: Configure AWS Credentials via OIDC
  uses: aws-actions/configure-aws-credentials@cbe3b392738ccf3f987d68400dafcf4b0624a56c # v6.2.4
  with:
    role-to-assume: arn:aws:iam::123456789012:role/GitHubActionsCacheRole
    aws-region: us-east-1

- uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: my-aws-cache-bucket
    key: ${{ runner.os }}-build-${{ hashFiles('**/lock') }}
    path: target/
```

### Google Cloud Storage (GCS)

```yaml
- uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: my-gcs-cache-bucket
    endpoint: https://storage.googleapis.com
    access-key: ${{ secrets.GCS_HMAC_ACCESS_ID }}
    secret-key: ${{ secrets.GCS_HMAC_SECRET }}
    key: ${{ runner.os }}-gradle-${{ hashFiles('**/*.gradle*') }}
    path: ~/.gradle/caches
```

### Backblaze B2

```yaml
- uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: my-b2-cache-bucket
    endpoint: https://s3.us-west-004.backblazeb2.com
    access-key: ${{ secrets.B2_KEY_ID }}
    secret-key: ${{ secrets.B2_APPLICATION_KEY }}
    key: ${{ runner.os }}-maven-${{ hashFiles('**/pom.xml') }}
    path: ~/.m2/repository
```

### Fastly Object Storage

```yaml
- uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: my-fastly-cache
    endpoint: https://object.us-east-1.fastlystorage.com
    access-key: ${{ secrets.FASTLY_ACCESS_KEY }}
    secret-key: ${{ secrets.FASTLY_SECRET_KEY }}
    key: ${{ runner.os }}-cargo-${{ hashFiles('**/Cargo.lock') }}
    path: target/
```

### Self-Hosted: Garage & SeaweedFS

```yaml
- uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: ci-cache
    endpoint: http://garage.internal:3900 # or http://seaweedfs.internal:8333
    provider: garage # or seaweedfs
    access-key: ${{ secrets.GARAGE_ACCESS_KEY }}
    secret-key: ${{ secrets.GARAGE_SECRET_KEY }}
    key: ${{ runner.os }}-build-${{ hashFiles('**/lock') }}
    path: build/
```

### Self-Hosted: RustFS

[RustFS](https://rustfs.com/) is an Apache-2.0, Rust object store that reached 1.0 in September 2026. Its S3 API covers everything this action uses: ranged downloads, multipart uploads, object tagging, user metadata and conditional writes. The whole integration suite passes against RustFS 1.0.0.

```yaml
- name: Cache dependencies using RustFS
  uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: ci-cache
    endpoint: http://127.0.0.1:9000 # or https://rustfs.internal:9000
    provider: rustfs
    access-key: ${{ secrets.RUSTFS_ACCESS_KEY }}
    secret-key: ${{ secrets.RUSTFS_SECRET_KEY }}
    key: ${{ runner.os }}-build-${{ hashFiles('**/lock') }}
    path: build/
```

### Self-Hosted / Local CI: MinIO

Even though upstream open-source MinIO changed licensing and older standalone community releases are no longer actively maintained, `cloud-cache-action` provides complete drop-in interoperability for existing on-prem MinIO clusters and ephemeral CI containers:

```yaml
- name: Cache dependencies using MinIO
  uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: ci-cache
    endpoint: http://127.0.0.1:9000 # or https://minio.internal:9000
    access-key: ${{ secrets.MINIO_ACCESS_KEY }}
    secret-key: ${{ secrets.MINIO_SECRET_KEY }}
    force-path-style: true # Required for MinIO
    key: ${{ runner.os }}-build-${{ hashFiles('**/lock') }}
    path: build/
```

### Dual Caching (Lightweight GitHub Runner $\to$ Heavy Remote Cloud Build)


Cache across **both** S3 and GitHub Actions Cache simultaneously. In this pattern, lightweight GitHub-hosted runners assemble `node_modules`, and heavy remote AWS/GCP machines pull directly from S3 at line-rate VPC speeds:

```yaml
# Job 1: Lightweight GitHub-hosted runner installs & caches dependencies
- name: Prepare node_modules
  uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: my-ci-cache
    endpoint: https://${{ secrets.R2_ACCOUNT_ID }}.r2.cloudflarestorage.com
    access-key: ${{ secrets.R2_ACCESS_KEY }}
    secret-key: ${{ secrets.R2_SECRET_KEY }}
    dual-cache: true
    restore-priority: github-first # Fast local cache on GitHub-hosted runner
    dual-cache-strategy: backfill # Populates S3 bucket so remote runners can access it
    key: ${{ runner.os }}-node-modules-${{ hashFiles('**/package-lock.json') }}
    path: node_modules

# Job 2: Remote AWS/GCP self-hosted runner building Docker/native binaries
- name: Restore node_modules directly from S3
  uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: my-ci-cache
    endpoint: https://${{ secrets.R2_ACCOUNT_ID }}.r2.cloudflarestorage.com
    access-key: ${{ secrets.R2_ACCESS_KEY }}
    secret-key: ${{ secrets.R2_SECRET_KEY }}
    dual-cache: true
    restore-priority: s3-first # Direct VPC speed, bypasses GitHub cache latency
    read-only: true # Fast restore-only for build job
    key: ${{ runner.os }}-node-modules-${{ hashFiles('**/package-lock.json') }}
    path: node_modules
```

---

## Cache Pruning

Object storage does not evict old caches the way GitHub's cache service does. The standalone
`cloud-cache-action/prune` sub-action deletes cache archives from any S3-compatible bucket, so you
can run it on a schedule. Set at least one rule: `older-than-days` (age), `keep-latest` (the newest
N archives of each ref are never deleted; alone, it deletes every other archive of the ref), `max-total-size` (a budget in bytes; the oldest
archives go first until the total fits) or `abort-uploads-older-than-hours` (abort stale incomplete
multipart uploads; no archive is deleted). **Run it with `dry-run: true` first** to see
what it would delete before letting it delete anything:

```yaml
name: Prune old caches

on:
  schedule:
    - cron: '0 3 * * 0' # Every Sunday at 03:00 UTC

jobs:
  prune:
    runs-on: ubuntu-latest
    steps:
      - uses: xSAVIKx/cloud-cache-action/prune@v1
        with:
          bucket: my-ci-cache-bucket
          endpoint: https://<account_id>.r2.cloudflarestorage.com
          access-key: ${{ secrets.S3_ACCESS_KEY }}
          secret-key: ${{ secrets.S3_SECRET_KEY }}
          older-than-days: 30
          dry-run: true # Flip to false once the logged output looks right.
```

Only cache archives (`cache.tar.zst` / `cache.tar.gz`) are ever deleted, one `DeleteObject` call
per key (Google Cloud Storage's S3 interoperability has no multi-object delete). Leaving `ref`
empty prunes every ref in scope; the action refuses to run when `s3-key-pattern` places `${ref}`
before the repository or prefix, since an all-refs prune could then reach another repository's
caches — set `ref` explicitly in that case. See the full [Pruning Caches guide](https://xsavikx.github.io/cloud-cache-action/guide/pruning.html) for inputs, outputs and safety details.

---

## Archive Integrity

Every save computes the sha256 checksum of the archive. A file-mode save stores the checksum as
object metadata (`cloud-cache-sha256`), as before. A streamed save stores the checksum as an
object tag instead. Four cases still use the metadata copy: user `metadata` is set, the provider
has no tagging API (Garage), the conditional create was not honored, or the save could not confirm
that it still owns the object after the tag — see
[Object Metadata and Tags](#object-metadata-and-tags).

On restore, the S3 tier looks for the checksum in metadata first. When metadata carries none, it
reads the tag, unless the object reports a tag count of exactly zero. Some servers never report
a tag count, and an unknown count is not proof that the object has no tags. When neither metadata
nor a tag carries a checksum, verification is skipped. When a checksum is found, the downloaded archive is hashed again and
compared before extraction. A mismatch does not extract the archive: the S3 tier reports an
`Integrity check failed for s3://<bucket>/<key>: expected sha256 <expected>, got <actual>` error,
which the restore logs as a warning (`Restoring from s3 failed, so it counts as a cache miss: ...`)
and treats as a cache miss, like any other S3 tier failure. With dual-cache the GitHub tier is
tried next, `fail-on-cache-miss: true` fails the step as it would for any miss, and only
`dual-cache-strict: true` turns the mismatch itself into a step failure. With
[streaming](#streaming-archives-experimental), the archive is hashed while it is extracted, so a
mismatch is only detected at the end and files may already have been extracted.

Objects with no checksum at all skip verification: caches from v1.1, or objects whose tagging or
metadata write the provider rejected. This is not a breaking change. An action older than v1.6
that restores a cache saved as a tag finds no checksum metadata. It skips the integrity check the
same way, instead of failing.

**Garage** does preserve this metadata, so integrity checks apply there like everywhere else.

---

## Safe Concurrent Saves

Uploads use a conditional create (`If-None-Match: *`). On providers that enforce it (verified on
AWS S3, MinIO, SeaweedFS and RustFS), when two jobs race to save the same key, only the first upload
succeeds; the second detects the precondition failure, logs `Another job saved s3://<bucket>/<key>
first; keeping its cache.`, and finishes without overwriting it. A `409 ConditionalRequestConflict`
(a concurrent write or delete of the same key, such as a prune, landing mid-upload) is retried once
with the same condition. Storage servers that reject the `If-None-Match` header outright are
detected automatically and the upload is retried once without it, so this never breaks the action
on providers with partial S3 API support.

**Providers that ignore `If-None-Match` keep last-writer-wins.** Garage (verified) does not support
conditional writes, and Google Cloud Storage's S3 interoperability reportedly ignores the header
too, so a race between two saves for the same key is last-writer-wins there, the same as v1.1's
behavior. The existing HEAD check before archiving still avoids pointless work when the key already
exists.

---

## Job Summary

After both restore and save, a step summary table is written via `core.summary` — a "Cloud cache
restore" table with the primary/matched key, cache hit, source, size and duration, and a "Cloud cache
save" table with the key, tiers saved to, size and duration. This is on by default; set
`job-summary: false` to turn it off. No summary is written when the step fails with an error, or
when `GITHUB_STEP_SUMMARY` is not set.

---

## Inspecting a cache lookup

When a restore misses and you expected a hit, `explain: true` logs the whole lookup into a
`Cache lookup explained` group (and, unless `job-summary: false`, into a job summary section of the
same name) right before the restore runs: the raw and resolved `s3-key-pattern`, the `${version}`
hash with the paths, compression method and cross-OS flag it is computed from, the refs and tier
order a restore would use, every listing it would perform, every candidate object with the version
it carries, and a plain-language reason for the outcome. It never fails the step — a report that
throws only logs `Could not explain the cache lookup: <reason>`.

```yaml
- uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: my-ci-cache-bucket
    path: ~/.npm
    key: ${{ runner.os }}-node-${{ hashFiles('**/package-lock.json') }}
    explain: true
```

The `inspect` sub-action prints the same report as a step of its own. It only lists objects — it
downloads nothing and writes nothing — and turns the answer into outputs: `would-hit`,
`would-match-key`, `would-match-object`, `candidate-count`, `report` (the full report as JSON,
replaced by `{"truncated":true,...}` beyond 64 KB) and `cache-storage-provider`. Its
`max-candidates` input (default `20`) caps how many objects the report shows per search — every
object under the prefix is still listed, as a restore does — and `fail-on-cache-miss: true` fails
the step when nothing would be restored, which makes a warm cache
a job dependency for a matrix.

```yaml
- uses: xSAVIKx/cloud-cache-action/inspect@v1
  id: lookup
  with:
    bucket: my-ci-cache-bucket
    path: ~/.npm
    key: ${{ runner.os }}-node-${{ hashFiles('**/package-lock.json') }}
    fail-on-cache-miss: true
```

Two things to know when reading a report:

- **"N objects match key prefix … but none has version …"** means the key was right and the
  `${version}` hash was not. That hash covers the `path` list as written, the compression method
  (`zstd` or `gzip`) and, on Windows, `enableCrossOsArchive` — nothing else.
- **The report lists objects; it never `HEAD`s the exact key.** A restore does, so on a provider
  with eventually consistent listings a report taken right after a save can say "would miss" where
  a restore would hit.

The outputs are set once the lookup finishes; a step that fails earlier (a missing input, an S3
error) sets none of them, as with `prune`. See
[Inspecting Lookups](https://xsavikx.github.io/cloud-cache-action/guide/inspecting.html) for a full
sample report and the matrix guard pattern.

---

## Metrics and Timings

Restore and save set `cache-restore-duration-ms`, `cache-save-duration-ms`,
`cache-transfer-duration-ms` and `cache-bytes` on every path, so they are always defined (`0` when
the step did not complete or transferred nothing). On the unified action the save runs as a post
step and sets the save-side three for itself, zeroing them when there is nothing to save, so after
the post step they describe the save while `cache-size` and `cache-restore-duration-ms` still hold
the restore's values. Use the standalone `restore` and `save` actions when each step should own its
outputs.

Every step — restore, save, `prune` and `inspect` — also writes one `cloud-cache-metrics <json>`
debug line. Set `metrics-file` to append the same JSON as one line to a file, resolved relative to
`GITHUB_WORKSPACE`:

```yaml
    metrics-file: cache-metrics.jsonl
```

```json
{"step":"restore","timestamp":"2026-09-17T06:02:41.912Z","provider":"r2","key":"Linux-node-9f2c1a","matchedKey":"Linux-node-9f2c1a","objectKey":"octo/app/refs%2Fheads%2Fmain/Linux-node-9f2c1a/4d0f1b2c9a7e35f1/cache.tar.zst","source":"s3","bytes":199687424,"durationMs":8123,"transferDurationMs":5310,"lookupDurationMs":240,"extractDurationMs":2410,"streaming":false,"downloadParts":24,"outcome":"hit"}
```

`transferDurationMs` measures the S3 transfer alone in the default file mode; with
`streaming: true` the archive is extracted (or compressed) as it moves, so the same field covers
download-plus-extract — the line's `streaming` field tells the two apart. On a restore,
`downloadParts` is how many ranged requests fetched the archive (`1` for a single request, `0`
when nothing was downloaded; see [Parallel Transfers](#parallel-transfers)). `lookupDurationMs`
is the time to find the S3 object on a restore. When the step uses a temporary archive file (file mode, or a
streaming step that falls back to file mode), `archiveDurationMs` is the time to write and hash
the archive on a save, and `extractDurationMs` is the time to unpack it on a restore. After an S3 download or upload, the step also logs the phases in one line, for example
`Timings: lookup 0.24 s, download 5.31 s (35.9 MiB/s), extract 2.41 s, total 8.12 s`. `total` is the whole step, including the GitHub tier in dual-cache mode. The transfer time and the rate include retries. `prune` and `inspect`
write their line once the step has finished its work, so a step that fails earlier writes none.
Writing the file is best-effort: a failure only logs
`Could not write metrics to <path>: <reason>` and never fails the step.

---

## Object Metadata and Tags

`metadata` stores user metadata (`x-amz-meta-*`) on every cache object the step saves, and `tags`
sets object tags, one `key=value` per line; surrounding whitespace is trimmed from each key and
value. Metadata is returned on restore as the `cache-metadata` output (a JSON object), except with
`lookup-only: true`, which never downloads the object. Tags are what bucket lifecycle rules and
IAM policies can filter on. Both inputs live on the main action and on
`cloud-cache-action/save@v1`: the standalone `restore` sub-action never saves, so it does not take
them.

```yaml
    metadata: |
      team=platform
      build=${{ github.run_id }}
    tags: |
      cloud-cache=true
      repo=${{ github.repository }}
```

Keys starting with `cloud-cache-` are reserved. Metadata is limited to 2 KB in total and tags to
10. With `streaming: true`, the cap drops to 9: a streamed save reserves one tag slot for the
`cloud-cache-sha256` checksum (see below). The cap is set from the `streaming` input itself, so a
streamed save that falls back to file mode on Windows still uses the stricter cap of 9. On
providers without object tagging the save logs one warning
(`s3://<bucket> could not store object tags (<reason>); saved without them.`) and completes without
tags.
Both are best-effort extras: neither can fail the save.

| Provider | Metadata | Tags |
|---|---|---|
| MinIO | ✅ verified | ✅ verified |
| SeaweedFS | ✅ verified | ✅ verified |
| RustFS | ✅ verified | ✅ verified |
| Garage | ✅ verified | ⚠️ accepted on upload, but Garage implements no tagging API (`GetObjectTagging`/`PutObjectTagging` answer `501 NotImplemented`), so the tags cannot be read back and should be assumed dropped |
| AWS S3, Cloudflare R2, GCS, B2, Fastly | ✅ | see provider docs |

Verified rows were measured by `tests/integration/objectAttributes.test.ts` against local MinIO,
SeaweedFS, RustFS and Garage servers; the last row is not covered by the local integration suite.

With [streaming](#streaming-archives-experimental), the sha256 checksum is only known once the
stream has finished, so it is attached after the upload. Normally it is attached as an object tag
(`PutObjectTagging`), sent together with any user `tags`. Four cases attach it with a copy of the
object onto itself instead, the same mechanism v1.2 through v1.5 always used: user `metadata` is
set, the provider has no tagging API (Garage today), the conditional create was not honored, or
the ownership check after the tag could not confirm the object. A tag write that fails for any
other reason falls back to the copy as well. When the upload reported no ETag, these last two
cases keep no checksum instead (see below). A provider that cannot do the copy either — or an
archive over 5 GiB, since a copy cannot span more than 5 GiB — costs the checksum, not the cache:
the save logs
`Saved s3://<bucket>/<key> but could not attach metadata: <reason>` and succeeds. A tag has no
size limit, so a streamed archive over 5 GiB gets a checksum for the first time when the tag path
applies. The copy was verified to work on MinIO, SeaweedFS, RustFS and Garage. Google Cloud
Storage has no tagging API, so a streamed save to GCS always uses the copy. GCS cannot check
`CopySourceIfMatch` against the ETag of a multipart upload. On GCS the copy therefore names the
generation that the upload wrote as its source version (`?versionId=`). When another job replaced
the object in between, the copy finds no source and fails, and the save keeps no checksum. With
Object Versioning on the bucket, an old generation stays readable: the copy can then put an older
save back over a newer one, with a checksum that matches its bytes.

The ownership check is one `HeadObject` after the tag. It proves that no other job replaced the
object between the upload and the tag. When the upload and the HEAD both report an ETag, the save
compares the ETags. Otherwise it compares the `cloud-cache-writer` metadata. The upload writes a
random id for this save into that field when the tag path applies, so a streamed object that
carries the checksum tag also carries `cloud-cache-writer=<id>` as user metadata. Like all
`cloud-cache-` keys, it is not reported in `cache-metadata`. It does not count against the
metadata limit, because the upload sends it only when no user `metadata` is set. When the check
shows that another job wrote the object, the save removes its checksum tag, warns, and does not
copy. The tag set has no partial update, so this can also remove the checksum tag of the other
job: that cache then has no checksum, but never a false one. When the check cannot confirm the
object (no object, a failed HEAD, or neither value returned), the save removes its checksum tag.
It then uses the copy only when the upload reported an ETag, because only then can
`CopySourceIfMatch` guard the copy. With no upload ETag, the save keeps no checksum and logs
`Saved s3://<bucket>/<key> without a checksum: the upload reported no ETag, ...`. A failed tag
write with no upload ETag has the same result. A missing checksum only skips the integrity check,
but a false checksum would reject a good cache. MinIO, SeaweedFS, RustFS and
Garage return the `cloud-cache-writer` field on `HeadObject` for single-part and multipart
uploads.

---

## Streaming Archives (Experimental)

Set `streaming: true` to stream archives directly between `tar` and S3 instead of writing a
temporary archive file first. This applies to the S3 tier only (the GitHub Actions Cache tier is
unaffected), uses less disk, and can be faster for large caches — but with these trade-offs:

- **No whole-archive retry.** A streaming upload cannot be retried as a single unit if it fails
  partway; only the S3 SDK's own per-part retries apply. Non-streaming (file-mode) saves are
  unaffected and keep full retry support.
- **No whole-download retry, and possibly partial extraction, on restore.** A streamed restore
  extracts the archive as it downloads, so a network or `tar` failure mid-stream becomes a cache
  miss (with a warning) and can leave the workspace partly extracted. File-mode restores download
  to a temporary file first and retry the whole download before extracting anything.
- **The integrity checksum is attached after the upload.** The digest is only known once the
  stream has finished, so a streamed save attaches `cloud-cache-sha256` afterwards, normally as an
  object tag rather than metadata (a copy of the object onto itself in four narrower cases; see
  [Object Metadata and Tags](#object-metadata-and-tags)). This drops about 8 seconds from a
  512 MiB save on Amazon S3, where the copy used to dominate the step. Attaching it is
  best-effort: on a provider that rejects both attempts the save still succeeds, logs
  `Saved s3://<bucket>/<key> but could not attach metadata: <reason>`, and the object carries no
  checksum, so restoring it skips the integrity check. An action older than v1.6 restoring a
  streamed cache saved by v1.6 or later finds no checksum metadata and skips the integrity check
  the same way, instead of failing.
- **`tags` allows one fewer entry.** With `streaming: true` the cap drops from 10 to 9, because
  the checksum tag reserves one slot. The cap follows the `streaming` input itself, so a streamed
  save that falls back to file mode on Windows keeps the stricter cap of 9.

Streaming is opt-in and defaults to `false`; disabling it (or leaving it unset) is identical to
v1.1 behavior. It automatically falls back to file mode — logging
`Streaming is not supported with BSD tar and zstd on Windows; using a temporary archive file.` —
when the plan requires the two-step BSD-tar-plus-zstd path on Windows. It follows the same
conditional-create and Garage fallback rules as [Safe Concurrent Saves](#safe-concurrent-saves).

---

## Parallel Transfers

Both directions move a large archive over several connections at once, with the fan-out
`actions/cache` uses for the GitHub cache service: 8 concurrent 8 MiB blocks on download and
8 concurrent 64 MiB parts on upload. (`actions/cache` downloads 4 MiB blocks; 8 MiB measured
1.2× to 2.6× faster on every provider across two runs, see below.)

```yaml
    download-concurrency: 16   # 1–32; 1 turns the parallel download off
    download-chunk-size: 16777216   # bytes per request, 1 MiB–128 MiB
    upload-concurrency: 4   # 1–32
    upload-chunk-size: 33554432   # bytes per part, 5 MiB–128 MiB
```

**Downloads.** A restore fetches any archive larger than `download-chunk-size` (default 8 MiB) as
concurrent `Range` requests, `download-concurrency` (default `8`) at a time, so a large cache uses
the whole link a runner has instead of one connection. Archives no larger than one chunk are
downloaded in a single request, as before. On a hosted runner the default keeps at most 64 MiB of
parts in memory.

- **Per-part retries.** Each part is retried on its own (`retry-count` times) when its connection
  drops, so a failure late in a large download costs one part, not the whole archive. The
  single-request path keeps its whole-download retry.
- **Timeouts.** The S3 client stops a TCP connect after 10 s, and a connection with no data in
  either direction after 120 s. The SDK or the part retry then tries again. Each retry logs one
  line, for example
  `HeadObject s3://<bucket>/<key>: attempt 1 of 4 failed after 10.0 s: <reason>. Starting attempt 2 after a wait of 0.1 s.`
  The idle limit is not a limit on the total transfer time. To change a limit, set
  `CLOUD_CACHE_CONNECTION_TIMEOUT_MS` or `CLOUD_CACHE_SOCKET_TIMEOUT_MS` (milliseconds) in the job
  `env`. The value `0` turns that timeout off.
- **Both modes.** In the default file mode every part is written straight into the archive file at
  its offset, and the sha256 check runs on the assembled file. With `streaming: true` the parts are
  fetched ahead and handed to `tar` in order, so memory is bounded by
  `download-concurrency × download-chunk-size`.
- **Providers that ignore `Range`.** If the server answers the first ranged request with the whole
  object, the restore logs
  `s3://<bucket>/<key> does not support ranged GET requests; downloading it in one request.` and
  continues with a single request. AWS S3, Cloudflare R2, Google Cloud Storage, Backblaze B2,
  MinIO, SeaweedFS, RustFS and Garage all serve ranged requests.

**Uploads.** A save sends the multipart upload's parts `upload-concurrency` (default `8`) at a time,
each `upload-chunk-size` bytes (default 64 MiB). Every part is retried by the S3 SDK with the
client's `retry-count`. The upload buffers up to `upload-concurrency × upload-chunk-size` in memory
(512 MiB by default, as `actions/cache` does); lower either input on a small self-hosted runner.
A value of `upload-chunk-size` below 5 MiB or above 128 MiB warns and uses the default, since
every S3-compatible provider rejects smaller parts.

**Automatic tuning.** With `transfer-tuning: auto`, a restore and a file-mode save select the
part size and the concurrency from the archive size, for example 16 × 16 MiB for a restore. A
save also uses the provider. The bytes in flight stay within about a quarter of the usable memory
and 1 GiB, with at least one part in flight. A transfer
input that you set still wins for that field, and a streaming save keeps the fixed settings. The
default is `fixed`. The rules and the measurements are in the
[Performance](https://xsavikx.github.io/cloud-cache-action/guide/performance#automatic-tuning)
guide and on the [Benchmarks](https://xsavikx.github.io/cloud-cache-action/guide/benchmarks) page.

**Measured on a hosted runner** (512 MiB archive, `ubuntu-latest`, 2026-09-21; the full tables,
the run-to-run variance and the settings that measured best are in the
[Performance](https://xsavikx.github.io/cloud-cache-action/guide/performance) guide):

| | Cloudflare R2 | Amazon S3 | Google Cloud Storage |
| --- | ---: | ---: | ---: |
| Restore, single request | 13.6 s | 10.7 s | 4.1 s |
| Restore, `actions/cache` 8 × 4 MiB | 4.6 s | 2.5 s | 3.7 s |
| Restore, default 8 × 8 MiB | 3.7 s | 1.9 s | 2.4 s |
| Restore, 8 × 16 MiB | 3.2 s | 1.8 s | 1.9 s |
| Save, v1.3 default 4 × 10 MiB | 17.0 s | 4.0 s | 4.8 s |
| Save, default 8 × 64 MiB | 9.1 s | 2.3 s | 2.3 s |

Larger download parts pay off on every provider, most on Google Cloud Storage; more connections
pay off most on Cloudflare R2. The `Transfer benchmark` workflow (`gh workflow run benchmark.yml`)
reproduces these tables against your own buckets.

The restore's `cloud-cache-metrics` line reports the number of parts as `downloadParts`; see
[Metrics and Timings](#metrics-and-timings).

`compression-level` trades save time against archive size and does not affect transfer speed; see
the compression section of the [Performance](https://xsavikx.github.io/cloud-cache-action/guide/performance)
guide for measured levels on real dependency trees.

---

## Changelog

Every release is listed in [CHANGELOG.md](CHANGELOG.md), which is also published on the [documentation site](https://xsavikx.github.io/cloud-cache-action/changelog.html).

## Upgrading to v1.1

v1.1 changes how cache objects are named, so **caches saved by v1.0 are not found and are rebuilt once**.

- **Key layout:** object keys now include the Git ref and a cache version: `${GITHUB_REPOSITORY}/${prefix}${ref}/${key}/${version}/${archive_filename}`. The version hashes `path`, the compression method and, on Windows, `enableCrossOsArchive`, so a cache is never restored into a job that caches different paths.
- **Paths:** `path` supports globs, `~` and `!` exclusions like actions/cache, and archives store paths relative to `GITHUB_WORKSPACE`. See [Paths and exclusions](#paths-and-exclusions).
- **Branch isolation:** restores search the current ref, then the pull request base branch, then the default branch. Set `scoped-to-ref: false` to share caches across all refs.
- **`save-always`** was removed. **`dual-cache-strategy: independent`** now behaves as `backfill` and logs a warning.
- **`dual-cache-strict: true`** now fails the step on any tier error during restore or save.

The action never reads v1.0 objects again; let a bucket lifecycle rule expire them.

Ref scoping stores a separate cache for every branch and pull request merge ref (`refs/pull/<n>/merge`), so the bucket grows with the number of active refs. **A lifecycle rule that expires old cache objects is strongly recommended.** Add an `AbortIncompleteMultipartUpload` rule as well (for example, after 1 day): the action aborts the multipart uploads it sees fail, but a job that is cancelled or whose runner dies mid-upload leaves its uploaded parts behind, stored and billed until such a rule removes them.

## Upgrading to v1.2

**There are no breaking changes in v1.2.** Caches saved by v1.1 remain valid and continue to
restore normally; objects saved without a sha256 checksum (any v1.1 cache) simply skip the new
integrity check.

- **New, all opt-in or on-by-default without changing existing behavior:** [Cache Pruning](#cache-pruning) (a new `prune` sub-action, run separately — nothing changes for existing `restore`/`save` steps), [Archive Integrity](#archive-integrity) (automatic; only skips when a checksum is absent), [Safe Concurrent Saves](#safe-concurrent-saves) (automatic; falls back cleanly on servers that reject the condition), [Job Summary](#job-summary) (on by default — set `job-summary: false` to keep the old, summary-free behavior), and [Streaming Archives](#streaming-archives-experimental) (opt-in via `streaming: true`; default `false` keeps the v1.1 file-based path).
- **Windows symlinks** are now covered by the Windows CI round trip: they restore as native symlinks through Git's GNU `tar` with `MSYS=winsymlinks:nativestrict`, as in v1.1.
- **Tag-triggered runs:** if a run started by pushing a tag is the only place that saves a given cache, no pull request or branch build will ever restore it — restores never search `refs/tags/*`. Save on the default branch instead (a `push` there, or `workflow_dispatch`), or see [Tag-triggered runs and refs](https://xsavikx.github.io/cloud-cache-action/guide/migration.html#tag-triggered-runs-and-refs) for using `scoped-to-ref: false`.
- **Maintenance:** Dependabot now keeps npm and GitHub Actions dependencies up to date, and publishing a GitHub release runs `.github/workflows/release.yml` automatically — see [Releasing](#releasing).

## Upgrading to v1.7

**There are no breaking changes in the inputs of v1.7, but one default changes.** Caches saved by
v1.1 to v1.6 restore normally.

- **`ACTIONS_CACHE_MODE`:** the S3 tier now obeys this variable, as `actions/cache` does. When a
  workflow does not set the `cache-mode` key, GitHub sets `read` for `pull_request_target`,
  `issue_comment` and `workflow_run`. An S3-only job on one of these triggers then restores but
  does not save. To save again, set `cache-mode: write` on the job. Do this only when the job
  cannot run untrusted code. See [Parity with actions/cache](#parity-with-actionscache).
- **Prune:** `older-than-days` is now optional. The step fails only when none of the four rule
  inputs is set, so an existing prune step works as before.

## Upgrading to v1.5

**There are no breaking changes in v1.5, and no default changes.** It adds
[RustFS](#self-hosted-rustfs) as a provider preset. Every other workflow behaves exactly as it did
in v1.4.

## Upgrading to v1.4

**There are no breaking changes in v1.4.** Caches saved by earlier versions restore normally.
One default changes:

- **[Parallel transfers](#parallel-transfers)** follow the `actions/cache` defaults. Restores of
  archives larger than 8 MiB download in 8 concurrent ranged parts, controlled by the new
  `download-concurrency` (default `8`) and `download-chunk-size` (default `8388608`) inputs; set
  `download-concurrency: 1` to keep the single-request download of v1.3. Saves send 8 parts at
  once instead of 4, controlled by the new `upload-concurrency` input, and the default
  `upload-chunk-size` is now 64 MiB instead of 10 MiB, so a save may hold up to 512 MiB of parts in
  memory; set `upload-concurrency: 4` and `upload-chunk-size: 10485760` to keep the v1.3 footprint.

## Upgrading to v1.3

**There are no breaking changes in v1.3.** Caches saved by v1.1 and v1.2 restore normally, the key
layout, `${version}` hashing and archive format are unchanged, and a save that sets none of the new
inputs writes the same object as v1.2 did. Every addition is opt-in:

- **[Object metadata and tags](#object-metadata-and-tags)** via the new `metadata` and `tags`
  inputs, with the restored object's metadata exposed as the new `cache-metadata` output (`{}` when
  there is none, on a GitHub-tier hit, or with `lookup-only: true`). Both are best-effort extras
  that never fail a save.
- **[Inspecting a cache lookup](#inspecting-a-cache-lookup)**: the new `explain` input (default
  `false`) and the new `inspect` sub-action, neither of which changes what a restore does.
- **[Metrics and timings](#metrics-and-timings)**: the new `cache-restore-duration-ms`,
  `cache-save-duration-ms`, `cache-transfer-duration-ms` and `cache-bytes` outputs, set on every
  path, and the new `metrics-file` input (default `""`, which keeps the previous file-free
  behavior).
- **Streaming saves now carry a checksum.** A `streaming: true` save attaches
  `cloud-cache-sha256` after the upload, so streamed archives are integrity-checked on restore like
  file-mode ones. See [Streaming Archives](#streaming-archives-experimental).

## Parity with actions/cache

The action takes the inputs and gives the outputs of `actions/cache`. See [Features](#features) for the list. This section gives the behaviour that has no input.

**`ACTIONS_CACHE_MODE`.** GitHub sets this environment variable from the `cache-mode` workflow key (generally available since 2026-09-10). The value is `read`, `write`, `write-only` or `none`, at the workflow level or at `jobs.<job_id>.cache-mode`. When the workflow does not set the key, the [GitHub documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching) gives a default of `read` for low-trust triggers, such as `pull_request_target`, `issue_comment` and `workflow_run`, that resolve to the default-branch scope. The `pull_request` event is not affected. `@actions/cache` 6.2.0 (and the 5.2.0 backport) reads the variable, and this action applies the same rules to the S3 tier:

| `ACTIONS_CACHE_MODE`                      | Restore | Save    |
| ----------------------------------------- | ------- | ------- |
| `none`                                    | skipped | skipped |
| `read`                                    | runs    | skipped |
| `write-only`                              | skipped | runs    |
| `write`, not set, or any other value      | runs    | runs    |

The action trims the value and ignores its case. A skip logs one info line that names the variable, and the metrics line and the job summary show the step as `skipped` with the reason. A skip does not fail the step, also with `dual-cache-strict: true`. A skipped restore sets `cache-hit` to `false`. With `fail-on-cache-miss: true`, a skipped restore fails the step, as in `actions/cache`. `read-only: true` skips the save in every mode.

An S3-only job on one of those low-trust triggers can stop saving after you upgrade to this version. To save from such a job again, set `cache-mode: write` on the job. Only do this when the job cannot run untrusted code, because the read default is there to stop cache poisoning.

**Write denied.** When the storage refuses an S3 write call (`PutObject`, `CreateMultipartUpload`, `UploadPart`, `CompleteMultipartUpload` or `CopyObject`) with `AccessDenied` (or a `403` that is not a credential error), the step logs a warning that the credentials may not be allowed to write to the bucket, and that `read-only: true` skips the save. The job does not fail. With `dual-cache-strict: true`, the step fails, as for every other save error. A `403` for wrong credentials, such as `InvalidAccessKeyId`, `SignatureDoesNotMatch` or `ExpiredToken`, gives the usual warning without the hint. A `403` on a read call, such as the `HeadObject` existence check, also gives no hint: it means a wrong secret or a policy without `s3:ListBucket`, not a read-only key.

**Access errors.** For every S3 `403`, the warning names the S3 call, the object, the HTTP status and the policy action that the call needs. A wrong secret, or a policy without `s3:ListBucket`, makes the first `HeadObject` fail with no response body. The warning then reads, for example:

```text
Restoring from s3 failed, so it counts as a cache miss: HeadObject s3://<bucket>/<key> returned HTTP 403 Forbidden. Check access-key, secret-key and region, and check that the bucket policy allows s3:ListBucket on the bucket and s3:GetObject on the cache keys. The Security guide lists the permission for each S3 call.
```

After a tier error, the last restore line is `No cache restored: the s3 tier failed (see the warning above). Keys searched: ...`. The `actions/cache` line `Cache not found for input keys: ...` is only for a true miss. For jobs that must not write, such as pull requests, see the read-only pattern in the [Security guide](https://xsavikx.github.io/cloud-cache-action/guide/security.html).

**`save-always`.** The action does not support this deprecated input. See [Saving after failed steps](#saving-after-failed-steps).

## Saving after failed steps

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

## Inputs

| Input                            | Required |                          Default                           | Description                                                                 |
| -------------------------------- | :------: | :--------------------------------------------------------: | --------------------------------------------------------------------------- |
| `bucket`                         | **Yes**  |                             —                              | Name of the S3 bucket                                                       |
| `key`                            | **Yes**, unless `preset` is set |                             —                              | Explicit key for restoring and saving cache                                 |
| `path`                           | **Yes**, unless `preset` is set |                             —                              | Multiline list of paths, globs and `!` exclusions to cache (see [Paths and exclusions](#paths-and-exclusions)) |
| `preset`                         |    No    |                             —                              | Package manager preset that gives the default `path`, `key` and `restore-keys`: `npm`, `yarn`, `pnpm`, `bun`, `pip`, `poetry`, `uv`, `gradle`, `maven`, `cargo`, `go` (see [Cache presets](#cache-presets)) |
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
| `streaming`                      |    No    |                          `false`                           | Stream archives directly between `tar` and S3 without a temporary file (experimental; see [Streaming Archives](#streaming-archives-experimental)) |
| `download-concurrency`           |    No    |                            `8`                             | Ranged GET requests a restore runs at once for archives larger than `download-chunk-size` (1–32); `1` downloads in one request (see [Parallel Transfers](#parallel-transfers)) |
| `download-chunk-size`            |    No    |                         `8388608`                          | Bytes per ranged GET request (1 MiB–128 MiB); archives no larger than this use one request |
| `upload-concurrency`             |    No    |                            `8`                             | Multipart upload parts sent at once (1–32)                                  |
| `upload-chunk-size`              |    No    |                         `67108864`                         | Bytes per multipart upload part (5 MiB–128 MiB); the same input `actions/cache` takes |
| `transfer-tuning`                |    No    |                          `fixed`                           | `auto` selects the part size and the concurrency per archive from its size (and, for a save, the provider); a transfer input you set still wins (see [Parallel Transfers](#parallel-transfers)) |
| `compression-level`              |    No    |                            Tool default                            | zstd 1–19 or gzip 1–9 for saving; lower is faster and larger (see [Performance](https://xsavikx.github.io/cloud-cache-action/guide/performance)) |
| `job-summary`                    |    No    |                           `true`                           | Write a job summary table with the cache keys, hit, source, size and duration |
| `metadata`                       |    No    |                             —                              | User metadata (`x-amz-meta-*`) for every saved object, one `key=value` per line, with surrounding whitespace trimmed (see [Object Metadata and Tags](#object-metadata-and-tags)) |
| `tags`                           |    No    |                             —                              | Object tags for every saved object, one `key=value` per line (up to 10; up to 9 with `streaming: true`, which reserves one slot for the checksum tag) |
| `explain`                        |    No    |                          `false`                           | Log why the lookup hits or misses before restoring (see [Inspecting a cache lookup](#inspecting-a-cache-lookup)) |
| `metrics-file`                   |    No    |                            `""`                            | Append one JSON line of timings and sizes for this step to this file, relative to the workspace |

### Paths and exclusions

- **Exclusions only remove what the include patterns matched**, as in actions/cache. `path: logs` with `!logs/debug.txt` still caches the whole `logs` directory, because the directory is the match. To leave one file out, match the files instead: `logs/*` with `!logs/debug.txt`.
- **Symbolic links are not followed while matching.** A pattern that wildcards through a symlinked directory, such as `linked-dir/*` where `linked-dir` is a symlink, matches nothing. A symlink that a pattern matches is archived as a link, not as the files it points to.
- **Windows symlinks without the privilege.** On a self-hosted Windows runner, the account can lack the `SeCreateSymbolicLinkPrivilege` privilege, and Developer Mode can be off. Then Git's GNU `tar` cannot create native symlinks, and the extract fails with `Cannot create symlink to ...: Operation not permitted`. When symlinks are the only failure, the action logs a warning and extracts the archive one more time with `MSYS=winsymlinks:deepcopy`. Each symlink is then restored as a copy of its target, not as a link. A symlink whose target is not in the archive still fails the restore. BSD `tar` (`C:\Windows\System32\tar.exe`) does not read `MSYS`, so the action does not retry with it. This retry applies only to the S3 tier in file mode. With `streaming: true`, or for the GitHub tier with `dual-cache: true` (`@actions/cache` runs its own `tar`), the restore still fails. The retry also fails for a symlink whose target is another symlink later in the archive. A copied directory symlink can make the restored tree much larger than the archive.

---

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
- `cache-bytes`: Size in bytes of the archive restored or saved; `0` when none was. See [Metrics and Timings](#metrics-and-timings).

---

## Sub-Actions

- **Restore Only**: `uses: xSAVIKx/cloud-cache-action/restore@v1`
- **Save Only**: `uses: xSAVIKx/cloud-cache-action/save@v1`
- **Prune**: `uses: xSAVIKx/cloud-cache-action/prune@v1` — deletes old cache archives on a schedule; see [Cache Pruning](#cache-pruning).
- **Inspect**: `uses: xSAVIKx/cloud-cache-action/inspect@v1` — reports which object a restore would use, and why, without restoring; see [Inspecting a cache lookup](#inspecting-a-cache-lookup).

---

## Releasing

Releases are made by [release-please](https://github.com/googleapis/release-please), from [Conventional Commit](https://www.conventionalcommits.org/) messages on `main`. Do not edit [CHANGELOG.md](CHANGELOG.md) or the version in `package.json` by hand.

1. Write each commit message as a Conventional Commit. `feat:` makes a minor release, and `fix:`, `perf:` and `deps:` make a patch release. `feat!:` or a `BREAKING CHANGE:` footer makes a major release. `docs:`, `build:`, `ci:`, `test:`, `refactor:` and `chore:` do not appear in the changelog.
2. After CI passes on `main`, [`.github/workflows/release-please.yml`](.github/workflows/release-please.yml) opens or updates a release PR named `chore: release vX.Y.Z`. The PR sets the version and adds the CHANGELOG entry.
3. GitHub does not run CI on a PR that `GITHUB_TOKEN` opens. To run CI on the release PR, close it and open it again.
4. Merge the release PR. After CI passes on `main` again, release-please tags `vX.Y.Z`, creates the GitHub release, and calls [`.github/workflows/release.yml`](.github/workflows/release.yml).

The release workflow also runs when you publish a GitHub release by hand. It:

- Verifies that `package.json`'s `version` matches the tag (without its `v` prefix), failing the run otherwise.
- Verifies that `dist/` is up to date by rebuilding it and diffing the result, failing the run if it is stale.
- Moves the major version tag (e.g. `v1`) to point at the release, so `uses: xSAVIKx/cloud-cache-action@v1` picks up the new release automatically. It only does this when the release is the highest stable `vX.y.z` tag of its major, so publishing an older patch never moves the tag backwards.

Pre-releases skip moving the major tag, so marking a release as a pre-release lets you publish it without affecting existing `@v1` consumers.

Dependency updates (npm and GitHub Actions) are proposed automatically by [Dependabot](.github/dependabot.yml), grouped into a single minor/patch PR per ecosystem so routine bumps do not create review noise; major version bumps are still proposed individually.

---

## Development & Local Testing

```bash
# Install dependencies
npm install

# Run unit and contract test suites
npm test

# Spin up a local S3 server for integration tests (garage, seaweedfs, minio or rustfs)
docker compose -f docker-compose.test.yml up -d garage

# Build distribution bundles (dist/)
npm run build

# Build documentation site
npm run docs:build
```

Live provider suites (Amazon S3, Cloudflare R2, Google Cloud Storage) run on `main`, nightly and on manual dispatch. To run them on a pull request, add the `full-ci` label; every self-hosted-S3 job still runs on every PR.

---

## License & Attribution

Distributed under the [MIT License](LICENSE).

Authored by **[Yurii Serhiichuk](https://serhiichuk.dev)**.
