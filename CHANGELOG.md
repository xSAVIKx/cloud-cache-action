# Changelog

All notable changes to Cloud Cache Action are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The floating `v1` tag always
points at the latest `v1.x.y` release.

## [Unreleased]

### Added

- **`compression-level` input.** Set the zstd (1–19) or gzip (1–9) level a save uses. Unset keeps
  today's exact command (zstd level 3, or gzip via `tar -z`), so an existing workflow sees no
  change. Only saving is affected; restore decodes whichever level a cache was saved with.
  Measured levels for two real dependency trees, and the reasoning for leaving the default at 3,
  are in the [Performance](./guide/performance.md) guide.
  A new `compression` job in the `Transfer benchmark` workflow, and a `compressionBenchmark.ts`
  script, reproduce the sweep against your own cache paths.
- **Faster cache lookups.** Refs are still searched one at a time and in the same order as before,
  so a later branch is never probed before an earlier one is ruled out. Within one ref, the
  primary-key and restore-key listings now go out together instead of one after another: a total
  miss with three refs and two restore keys drops from twelve sequential round trips to six, while
  an exact hit still costs one request. The `explain` report and the `inspect` sub-action fan out
  the same way, one ref's listings at a time, and still stop at the first hit, so the rendered
  report is unchanged.

### Changed

- **A streamed save now stores its sha256 checksum as an object tag** instead of rewriting the
  whole object, which removes about 8 seconds from a 512 MiB save on Amazon S3. An action older
  than v1.6 restoring such a cache finds no checksum metadata and skips the integrity check
  instead of failing, the same way it already does for a v1.1 cache. The object copy is still used
  when user `metadata` is set, when the provider has no tagging API (Garage), or when the upload
  could not use a conditional create. A streamed archive over 5 GiB now gets a checksum for the
  first time, since a tag has no size limit while the copy was refused above 5 GiB. With
  `streaming: true`, the `tags` input is capped at 9 instead of 10, because the reserved checksum
  tag takes one slot.
  - The save sends one small `HeadObject` after the tag and compares its ETag with the upload's.
    A provider that accepts `If-None-Match` and silently ignores it (Google Cloud Storage) would
    otherwise let this job tag another job's bytes with this archive's checksum, which a later
    restore would reject. When the ETags differ, the save removes its checksum tag again, warns,
    and leaves the other job's cache alone.
  - The documented IAM policies now grant `s3:GetObjectTagging` and `s3:PutObjectTagging`. A
    restore that cannot read the tags now warns instead of logging a debug line, because the only
    other symptom is an integrity check that silently stops running.

## [1.5.0] - 2026-09-22

No breaking changes, and nothing changes for an existing workflow: this release only adds a
provider.

### Added

- **RustFS provider preset.** `provider: rustfs` selects path-style addressing and the `us-east-1`
  default region for [RustFS](https://rustfs.com/), the Apache-2.0 Rust object store that reached
  1.0 in September 2026. The full integration suite runs against RustFS 1.0.0 in CI, next to
  Garage, SeaweedFS and MinIO. Ranged downloads, multipart uploads, object tagging, user metadata
  and conditional writes all work, so no feature is disabled for it.
  - RustFS serves S3 on port 9000, the port MinIO uses, so endpoint sniffing cannot tell the two
    apart and reports `minio`. Both presets resolve to the same settings; set `provider: rustfs`
    to name it in the log.

## [1.4.0] - 2026-09-21

No breaking changes. Caches saved by v1.1, v1.2 and v1.3 stay valid.

### Added

- **Parallel downloads.** A restore now fetches any archive larger than `download-chunk-size`
  (default `8388608`, 8 MiB) as concurrent `Range` requests, `download-concurrency` (default `8`,
  1–32) at a time, in both file and streaming mode, the same fan-out `actions/cache` uses with a
  larger block (it uses 4 MiB; 8 MiB measured faster on every provider). Each part is retried on
  its own. Archives no larger than one chunk, and every restore with `download-concurrency: 1`,
  use a single request as before. A provider that answers a ranged
  request with the whole object logs
  `s3://<bucket>/<key> does not support ranged GET requests; downloading it in one request.` and
  gets the single request. The restore's metrics line reports the part count as `downloadParts`.
- **`upload-concurrency` input** (default `8`, 1–32) on the main and `save` actions: how many
  multipart parts a save sends at once, in both file and streaming mode. It was fixed at 4.
- **Transfer benchmark workflow** (`benchmark.yml`, manual) that measures save and restore speed
  for several transfer settings against the live providers, and a "Transfer Performance" guide
  with the measured tables and the settings that measured best.

### Changed

- **Upload defaults follow `actions/cache`.** The default `upload-chunk-size` is 64 MiB instead of
  10 MiB and a save sends 8 parts at once instead of 4, so a save may hold up to 512 MiB of parts
  in memory. Set `upload-concurrency: 4` and `upload-chunk-size: 10485760` to keep the v1.3
  footprint. An `upload-chunk-size` below 5 MiB or above 128 MiB now warns and uses the default;
  before, a small value was silently replaced by 10 MiB.

## [1.3.0] - 2026-09-21

No breaking changes. Caches saved by v1.1 and v1.2 stay valid: the key layout, `${version}`
hashing and archive format are unchanged, and a save that sets none of the new inputs writes the
same object as v1.2 did.

### Added

- **Object metadata and tags.** The new `metadata` input stores user metadata (`x-amz-meta-*`) on
  every saved cache object and the new `tags` input sets object tags, one `key=value` per line.
  - Keys starting with `cloud-cache-` are reserved, metadata is capped at 2048 bytes in total
    (including the `cloud-cache-sha256` entry the save adds) and tags at 10, with S3's tag
    character set enforced. An invalid value fails the step before any S3 call.
  - Providers without object tagging log one warning
    (`s3://<bucket> could not store object tags (<reason>); saved without them.`) and save without
    tags.
    Garage accepts the `Tagging` header but implements no tagging API, so its tags cannot be read
    back and should be assumed dropped.
  - With `streaming: true` the metadata is attached by a copy of the object onto itself after the
    upload; a provider that cannot do that copy costs the metadata, not the cache.
- **`cache-metadata` output.** The restored object's user metadata as a JSON object, excluding
  `cloud-cache-*` keys; `{}` when there is none, on a GitHub-tier hit, or with
  `lookup-only: true`, which never downloads the object.
- **A sha256 on streaming saves.** A `streaming: true` save now attaches `cloud-cache-sha256`
  once the stream has finished, so streamed archives get the same integrity check on restore as
  file-mode ones. The attach is best-effort: if it fails, the save still succeeds and the object
  simply carries no checksum.
- **`explain` input** (default `false`) on the main and `restore` actions. It logs the whole cache
  lookup into a `Cache lookup explained` group, and into a job summary section of the same name,
  before the restore runs: the raw and resolved `s3-key-pattern`, the `${version}` hash and the
  paths, compression method and cross-OS flag it is computed from, the refs and tier order, every
  listing performed, every candidate object with the version it carries, and a plain-language
  reason for the outcome. Building the report never fails the step.
- **`cloud-cache-action/inspect` sub-action** that reports which object a restore would use, and
  why, without restoring. It only lists objects — it downloads nothing and writes nothing.
  - Outputs: `would-hit`, `would-match-key`, `would-match-object`, `candidate-count`, `report`
    (the full report as JSON, replaced by a `{"truncated":true,…}` summary beyond 64 KB) and
    `cache-storage-provider`.
  - `max-candidates` (default `20`) caps how many objects the report shows per search; every
    object under the prefix is still listed, as a restore does, and the rest are counted as
    "… and N more not shown". `fail-on-cache-miss: true` fails the step when nothing would be
    restored.
  - The report lists objects and never `HEAD`s the exact key, so on a provider with eventually
    consistent listings a report taken right after a save can say "would miss" where a restore
    would hit.
- **Metrics outputs.** `cache-restore-duration-ms`, `cache-save-duration-ms`,
  `cache-transfer-duration-ms` and `cache-bytes` are set on every path, so they are always
  defined (`0` when the step did not complete or transferred nothing).
- **`metrics-file` input** on the main, `restore`, `save`, `prune` and `inspect` actions. Every
  step writes one `cloud-cache-metrics <json>` debug line, and appends the same JSON as one line to
  this file when it is set, resolved relative to `GITHUB_WORKSPACE`.
  - `transferDurationMs` measures the S3 transfer alone in file mode; with `streaming: true` it
    covers download-plus-extract, and the line's `streaming` field tells the two apart.
  - `prune` and `inspect` write their line once the step has finished its work, so a step that
    fails earlier writes none.
  - Writing the file is best-effort: a failure only warns and never fails the step.
- **Documentation:** a new "Inspecting Lookups" guide on the documentation site, plus metrics
  sections in the README and the Getting Started and Pruning guides.

### Changed

- **`cache-etag` on streaming saves.** With `streaming: true` the output now reports the ETag of
  the object after its metadata copy, rather than the multipart upload's ETag.
- **Live cloud CI gating.** The Amazon S3, Cloudflare R2 and Google Cloud Storage suites now run on
  `main`, nightly and on manual dispatch, and on a pull request only when it carries the `full-ci`
  label. Every self-hosted-S3 job (Garage, SeaweedFS, MinIO) still runs on every pull request.

## [1.2.0] - 2026-09-14

No breaking changes. Caches saved by v1.1 stay valid, and the default save and restore paths still
work the same way, apart from the additions below.

### Added

- **`cloud-cache-action/prune` sub-action** that deletes cache archives older than
  `older-than-days`. It supports `ref`, `scoped-to-ref`, `scoped-to-repository`, `prefix` and
  `dry-run`.
  - It only deletes objects whose whole key matches the resolved `s3-key-pattern`, so other
    repositories, other refs and non-archive objects under the same listing prefix are never
    touched.
  - It refuses to run when a pattern can't be scoped safely.
  - An invalid `dry-run` value fails the step before any S3 call.
- **Archive integrity.** File-mode saves store a sha256 of the archive in the
  `cloud-cache-sha256` object metadata, and restores verify it.
  - A mismatch counts as a cache miss with a warning.
  - It only fails the step when both `dual-cache` and `dual-cache-strict` are `true`.
  - Objects without the metadata (any v1.1 cache, or a streamed save) skip the check.
- **Safe concurrent saves.** Saves send `If-None-Match: *`, so when two jobs save the same key,
  the first one wins and the second keeps the existing cache.
  - If a provider rejects the condition, the save retries once without it and doesn't send it
    again for the rest of the run.
  - A `409 ConditionalRequestConflict` is retried once.
  - Providers that ignore the condition, such as Garage, keep last-writer-wins.
- **Job summary.** Restore and save each write a step summary table with the key, hit and
  source, size and duration. The new `job-summary` input defaults to `true`.
- **Opt-in streaming** (`streaming: true`, default `false`): pipes tar straight to a multipart
  upload and downloads straight into tar, with no temporary archive file.
  - The file-based path stays the default and is unchanged.
  - A streamed upload is only completed after tar exits successfully, so a failed tar never
    leaves a truncated cache.
  - It falls back to file mode for BSD tar with zstd on Windows and for rejected conditions.
- **Maintenance.** Dependabot for npm and GitHub Actions, with minor and patch updates grouped
  and major updates proposed separately.
- **Release workflow** (`.github/workflows/release.yml`), which runs when a GitHub release is
  published.
  - It verifies the tag against `package.json` and checks that `dist` is up to date.
  - It then moves the major tag, but only for the highest stable release of that major.

### Changed

- The main action, `restore` and `save` gain the `job-summary` and `streaming` inputs.
- A bare `$ref`, `$key`, `$prefix`, `$version`, `$archive_filename` or `$GITHUB_REPOSITORY` in
  `s3-key-pattern` is no longer expanded from the environment. It stays literal and logs one
  warning per name.

### Fixed

- A strict dual-cache save where `path` matches nothing no longer fails the step. The GitHub
  tier's "Path Validation Error" now counts as a skipped save, as it already did for the S3 tier.
- With `scoped-to-repository: false` or `scoped-to-ref: false`, removing the placeholder no longer
  leaves a leading, doubled or trailing `/`. A `/` is only removed when the placeholder fills a
  whole path segment, so custom patterns keep their v1.1 keys.
- When `CompleteMultipartUpload` fails (for example, a lost save race), the multipart upload is
  aborted instead of leaving billed parts behind.
- Errors rewrapped by the restore and save steps keep the original error as `cause`.

## [1.1.0] - 2026-09-13

v1.1 is a correctness release. `path` now behaves like actions/cache, S3 keys carry the Git ref
and a cache version, and dual-cache strict mode actually fails the step.

### Breaking changes

- **New S3 key layout:** `${GITHUB_REPOSITORY}/${prefix}${ref}/${key}/${version}/${archive_filename}`.
  - `${version}` hashes the `path` patterns, the compression method and, on Windows,
    `enableCrossOsArchive`.
  - Caches saved by v1.0 are not found, and are rebuilt once.
- **Ref-scoped restores, like actions/cache:** the current ref first, then the pull request base
  branch, then the default branch. The new `scoped-to-ref` input (default `true`) shares caches
  across all refs when set to `false`.
- **`save-always` removed:** it never worked, because `post-if` can't read inputs. Use the
  `restore` and `save` sub-actions with `if: always()` instead.
- **`dual-cache-strategy: independent` removed:** it now logs a warning and behaves as `backfill`.
- **`dual-cache-strict: true` fails the step** on tier errors during both restore and save.

### Fixed

- `path` patterns go through `@actions/glob`, so `~`, `**` and `!` exclusions work. Archives store
  paths relative to `GITHUB_WORKSPACE`.
- **tar selection matches actions/cache:**
  - GNU tar on Linux.
  - `gtar` or BSD tar on macOS.
  - Git's GNU tar or System32 tar on Windows, with two-step zstd for BSD tar and
    `MSYS=winsymlinks:nativestrict` for symlinks.
  - File names starting with `-` can no longer inject tar options.
- **Restore-key matching:**
  - Listing reads every page instead of stopping after 100 keys.
  - The primary key is tried as a prefix before `restore-keys`.
  - Keys containing `/` or `$` survive a round trip.
- Failed downloads or extractions count as a cache miss with a warning instead of failing the job.
- `backfill` checks the other tier first and only uploads to a tier that doesn't already have the
  key.
- **Retries:**
  - `retry-count` sets the SDK's standard retries.
  - Stream retries only cover network failures the SDK doesn't retry itself.
  - Permanent errors such as 403 are no longer retried.
  - `retry-count: 0` is honoured.
- S3-compatible providers only receive request checksums when S3 requires them.
- Unknown providers, invalid booleans and enum values, and a lone access or secret key now log a
  warning.
- The post step reuses the restore step's settings and compression method, so both compute the
  same object key.
- The `restore` and `save` sub-actions use valid Marketplace icons.

### Testing

- Unit tests on real temporary directories, real tar round trips, and a contract test that keeps
  all `action.yml` manifests in sync with the code.
- Integration tests against SeaweedFS, MinIO and Garage.
- **CI on Linux, macOS and Windows:**
  - per-OS round trips and post-step saves
  - cross-OS restores
  - dual-cache against the live GitHub Actions Cache
  - a strict-mode failure check
  - actionlint
- A nightly live cross-OS restore on Cloudflare R2.

## [1.0.0] - 2026-09-11

First stable release. Inputs and outputs are unchanged from 0.1.0.

### Added

- Dedicated live provider verification workflows for Amazon S3, Cloudflare R2 and Google Cloud
  Storage.
- The repository's own CI and documentation deployment use the action.

### Changed

- Documentation and examples reference `@v1`.
- The action description was shortened to fit the Marketplace's 125-character limit.

## [0.1.0] - 2026-09-11

Initial pre-release.

### Added

- **Drop-in replacement for `actions/cache`:**
  - Inputs `path`, `key`, `restore-keys`, `fail-on-cache-miss`, `lookup-only`,
    `enableCrossOsArchive`, `read-only` and `save-always`.
  - Outputs `cache-hit`, `cache-primary-key` and `cache-matched-key`.
  - Runs on Node 24.
- **Storage:** any S3-compatible storage (AWS S3, Cloudflare R2, Google Cloud Storage, Backblaze B2,
  Fastly Object Storage, Garage, SeaweedFS, MinIO), with custom endpoints, path-style addressing
  and session tokens.
- **Dual-caching** to S3 and the GitHub Actions Cache, with `restore-priority`,
  `dual-cache-strategy` and `dual-cache-strict`.
- **Custom S3 key templates** (`s3-key-pattern`) with `prefix` and `scoped-to-repository`.
- zstd compression with a gzip fallback, chunked multipart uploads and retries.
- `restore` and `save` sub-actions.

[Unreleased]: https://github.com/xSAVIKx/cloud-cache-action/compare/v1.5.0...HEAD
[1.5.0]: https://github.com/xSAVIKx/cloud-cache-action/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/xSAVIKx/cloud-cache-action/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/xSAVIKx/cloud-cache-action/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/xSAVIKx/cloud-cache-action/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/xSAVIKx/cloud-cache-action/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/xSAVIKx/cloud-cache-action/compare/v0.1.0...v1.0.0
[0.1.0]: https://github.com/xSAVIKx/cloud-cache-action/releases/tag/v0.1.0
