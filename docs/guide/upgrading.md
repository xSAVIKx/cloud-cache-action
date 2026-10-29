---
title: Upgrading
---

# Upgrading

This page gives the notes that you must read before you upgrade from one `v1` release to a later
one. The newest release is first. The [Changelog](../changelog.md) lists every change in every
release.

`uses: xSAVIKx/cloud-cache-action@v1` always gets the newest `v1` release. To stay on one
release, pin the action to a full tag, such as `@v1.10.1`, or to a commit SHA.

## v1.8 and later

There are no breaking changes and no default changes in v1.8, v1.9 and v1.10.

- **v1.8, unsigned upload payloads.** Uploads over `https://` send
  `x-amz-content-sha256: UNSIGNED-PAYLOAD`. When a server refuses the header, the action sends
  the request again with a signed payload and logs one line. Set
  `CLOUD_CACHE_UNSIGNED_PAYLOAD=false` in the job environment to turn the change off.
- **v1.9, AWS buckets with Object Lock.** Uploads to AWS S3 no longer send an SDK checksum for
  each part. An AWS bucket with an Object Lock default retention requires a checksum on each
  upload, so a save to it fails with `400 InvalidRequest`. Set `CLOUD_CACHE_SDK_CHECKSUMS=true`
  in the job environment to send the SDK checksums again.
- **v1.9, `transfer-tuning`.** The new `transfer-tuning` input has the default `fixed`, so a
  workflow that does not set it behaves as before. See
  [Automatic tuning](./performance.md#automatic-tuning).

## v1.7

**There are no breaking changes in the inputs of v1.7, but one default changes.** Caches saved by
v1.1 to v1.6 restore normally.

- **`ACTIONS_CACHE_MODE`:** the S3 tier now obeys this variable, as `actions/cache` does. When a
  workflow does not set the `cache-mode` key, GitHub sets `read` for `pull_request_target`,
  `issue_comment` and `workflow_run`. An S3-only job on one of these triggers then restores but
  does not save. To save again, set `cache-mode: write` on the job. Do this only when the job
  cannot run untrusted code. See [Parity with actions/cache](./migration.md#parity-with-actions-cache).
- **Prune:** `older-than-days` is now optional. The step fails only when none of the four rule
  inputs is set, so an existing prune step works as before.

## v1.6

**There are no breaking changes in v1.6.** Caches saved by v1.1 to v1.5 stay valid. A streamed
save now stores its checksum as an object tag. Grant `s3:PutObjectTagging` and
`s3:GetObjectTagging` to the cache credentials. See
[How Caches Are Stored](./storage.md#archive-integrity) and the [Security](./security.md) guide.

## v1.5

**There are no breaking changes in v1.5, and no default changes.** It adds
[RustFS](../providers/rustfs.md) as a provider preset. Every other workflow behaves exactly as it did
in v1.4.

## v1.4

**There are no breaking changes in v1.4.** Caches saved by earlier versions restore normally.
One default changes:

- **[Parallel transfers](./performance.md#parallel-transfers)** follow the `actions/cache` defaults. Restores of
  archives larger than 8 MiB download in 8 concurrent ranged parts, controlled by the new
  `download-concurrency` (default `8`) and `download-chunk-size` (default `8388608`) inputs; set
  `download-concurrency: 1` to keep the single-request download of v1.3. Saves send 8 parts at
  once instead of 4, controlled by the new `upload-concurrency` input, and the default
  `upload-chunk-size` is now 64 MiB instead of 10 MiB, so a save may hold up to 512 MiB of parts in
  memory; set `upload-concurrency: 4` and `upload-chunk-size: 10485760` to keep the v1.3 footprint.

## v1.3

**There are no breaking changes in v1.3.** Caches saved by v1.1 and v1.2 restore normally, the key
layout, `${version}` hashing and archive format are unchanged, and a save that sets none of the new
inputs writes the same object as v1.2 did. Every addition is opt-in:

- **[Object metadata and tags](./storage.md#object-metadata-and-tags)** via the new `metadata` and `tags`
  inputs, with the restored object's metadata exposed as the new `cache-metadata` output (`{}` when
  there is none, on a GitHub-tier hit, or with `lookup-only: true`). Both are best-effort extras
  that never fail a save.
- **[Inspecting a cache lookup](./inspecting.md)**: the new `explain` input (default
  `false`) and the new `inspect` sub-action, neither of which changes what a restore does.
- **[Metrics and timings](./getting-started.md#metrics-and-timings)**: the new `cache-restore-duration-ms`,
  `cache-save-duration-ms`, `cache-transfer-duration-ms` and `cache-bytes` outputs, set on every
  path, and the new `metrics-file` input (default `""`, which keeps the previous file-free
  behavior).
- **Streaming saves now carry a checksum.** A `streaming: true` save attaches
  `cloud-cache-sha256` after the upload, so streamed archives are integrity-checked on restore like
  file-mode ones. See [Streaming Archives](./storage.md#streaming-archives-experimental).

## v1.2

**There are no breaking changes in v1.2.** Caches saved by v1.1 remain valid and continue to
restore normally; objects saved without a sha256 checksum (any v1.1 cache) simply skip the new
integrity check.

- **New, all opt-in or on-by-default without changing existing behavior:** [Cache Pruning](./pruning.md) (a new `prune` sub-action, run separately — nothing changes for existing `restore`/`save` steps), [Archive Integrity](./storage.md#archive-integrity) (automatic; only skips when a checksum is absent), [Safe Concurrent Saves](./storage.md#safe-concurrent-saves) (automatic; falls back cleanly on servers that reject the condition), [Job Summary](./getting-started.md#job-summary) (on by default — set `job-summary: false` to keep the old, summary-free behavior), and [Streaming Archives](./storage.md#streaming-archives-experimental) (opt-in via `streaming: true`; default `false` keeps the v1.1 file-based path).
- **Windows symlinks** are now covered by the Windows CI round trip: they restore as native symlinks through Git's GNU `tar` with `MSYS=winsymlinks:nativestrict`, as in v1.1.
- **Tag-triggered runs:** if a run started by pushing a tag is the only place that saves a given cache, no pull request or branch build will ever restore it — restores never search `refs/tags/*`. Save on the default branch instead (a `push` there, or `workflow_dispatch`), or see [Tag-triggered runs and refs](./migration.md#tag-triggered-runs-and-refs) for using `scoped-to-ref: false`.
- **Maintenance:** Dependabot now keeps npm and GitHub Actions dependencies up to date, and publishing a GitHub release runs `.github/workflows/release.yml` automatically — see [Releasing](https://github.com/xSAVIKx/cloud-cache-action/blob/main/CONTRIBUTING.md#releasing).

## v1.1

v1.1 changes how cache objects are named, so **caches saved by v1.0 are not found and are rebuilt once**.

- **Key layout:** object keys now include the Git ref and a cache version: `${GITHUB_REPOSITORY}/${prefix}${ref}/${key}/${version}/${archive_filename}`. The version hashes `path`, the compression method and, on Windows, `enableCrossOsArchive`, so a cache is never restored into a job that caches different paths.
- **Paths:** `path` supports globs, `~` and `!` exclusions like actions/cache, and archives store paths relative to `GITHUB_WORKSPACE`. See [Paths and exclusions](./getting-started.md#paths-and-exclusions).
- **Branch isolation:** restores search the current ref, then the pull request base branch, then the default branch. Set `scoped-to-ref: false` to share caches across all refs.
- **`save-always`** was removed. **`dual-cache-strategy: independent`** now behaves as `backfill` and logs a warning.
- **`dual-cache-strict: true`** now fails the step on any tier error during restore or save.

The action never reads v1.0 objects again; let a bucket lifecycle rule expire them.

Ref scoping stores a separate cache for every branch and pull request merge ref (`refs/pull/<n>/merge`), so the bucket grows with the number of active refs. **A lifecycle rule that expires old cache objects is strongly recommended.** Add an `AbortIncompleteMultipartUpload` rule as well (for example, after 1 day): the action aborts the multipart uploads it sees fail, but a job that is cancelled or whose runner dies mid-upload leaves its uploaded parts behind, stored and billed until such a rule removes them.

