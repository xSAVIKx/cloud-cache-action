# Changelog

All notable changes to Cloud Cache Action are documented here.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The floating
`v1` tag always points at the latest `v1.x.y` release. From v1.9.0 on,
[release-please](https://github.com/googleapis/release-please) writes the new entries from the
Conventional Commit messages on `main`. Entries up to v1.9.0 follow
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.9.1](https://github.com/xSAVIKx/cloud-cache-action/compare/v1.9.0...v1.9.1) (2026-10-25)


### Fixed

* add connection and idle timeouts to the S3 client and log each retry ([01334bf](https://github.com/xSAVIKx/cloud-cache-action/commit/01334bf91b14362f5b5a3cee2d518ed36ef8bae0))
* name the S3 call, the status and a fix in S3 access errors ([305c14e](https://github.com/xSAVIKx/cloud-cache-action/commit/305c14e4f568ac46e85771575eee4900ab6efd58))
* S3 client timeouts and clear access error messages ([b4fb9bf](https://github.com/xSAVIKx/cloud-cache-action/commit/b4fb9bf27815e7acd5fb72230f5521c5723e3a82))
* say that no cache was restored when a tier failed ([da33171](https://github.com/xSAVIKx/cloud-cache-action/commit/da33171d4e8613950d212e228f4a6b173110018e))
* stop a stalled S3 response body after the socket timeout ([8bc67b2](https://github.com/xSAVIKx/cloud-cache-action/commit/8bc67b2fe50b2e9594e8b0a37199f291039a7845))

## [1.9.0] - 2026-10-24

Faster uploads to AWS S3, opt-in transfer tuning, and phase timings in the log. Object keys and
archive bytes do not change, so caches saved by v1.1 to v1.8 stay valid.

### Added

- **A timing line for each restore and save.** After an S3 download or upload, the step logs
  one line with the time of each phase and the transfer rate, for example
  `Timings: lookup 0.24 s, download 5.31 s (35.9 MiB/s), extract 2.41 s, total 8.12 s`. The
  metrics line and the `metrics-file` get the same phases as `lookupDurationMs`,
  `archiveDurationMs` and `extractDurationMs`. The archive and extract phases appear only when the
  step writes or reads a temporary archive file. A streaming step that falls back to file mode
  reports them too. `total` is the whole step, including the GitHub tier in dual-cache mode. The
  transfer time and the rate include retries. A save that uploads and then finds that another job
  saved first ends the line with `(another job saved first)`.
- **A log line when a streaming save may not tag its object.** A streaming save attaches its
  sha256 as a tag. When the credentials do not have `s3:PutObjectTagging`, the save copies the
  whole object instead, which took about 7.5 s for 512 MiB on AWS S3 in a test. The step now logs
  this and names the missing permission. Before, only a debug line showed it.
- **`transfer-tuning: auto`, an opt-in mode that selects the transfer settings.** A restore and a
  file-mode save select the part size and the concurrency from the archive size. A save also uses
  the provider. For example, a restore uses 16 × 16 MiB, and an upload of more than 256 MiB uses
  16 × 32 MiB. The bytes in flight stay within about a quarter of the usable memory, including a
  container limit, and within 1 GiB. A transfer input that
  the workflow sets still wins for that field. A streaming save keeps the fixed settings, because
  it does not know the archive size in advance. The default is `fixed`, so nothing changes
  without the input. The rule values come from a size sweep of 128 MiB, 512 MiB and 2 GiB on AWS
  S3, Cloudflare R2 and Google Cloud Storage.
- **A Benchmarks page on the website.** It compares the defaults, other fixed settings and
  `transfer-tuning: auto` per provider and per cache size. `tests/ci/benchmarkPage.ts` writes it
  from the artifacts of a benchmark run.
- **The benchmark measures several sizes in one run.** The workflow input `size-mb` takes a
  comma-separated list, and the new `matrix: sweep` input runs more part sizes and concurrencies.

### Changed

- **The transfer inputs have no default in `action.yml`.** `upload-concurrency`,
  `download-concurrency` and `download-chunk-size` now name their default in the description,
  and the code applies the same values as before. This lets `transfer-tuning: auto` tell a value
  that the workflow set from an unset one.
- **Uploads to AWS S3 no longer compute a CRC32 for each part.** The AWS SDK computed this
  checksum on the main thread, which took about 100 ms for each 64 MiB part on a test host. The
  action now sends a checksum only when an S3 operation requires one, as it already did for every
  other provider. The sha256 integrity check on restore stays, and TLS protects the bytes in
  transit. Downloads from AWS also no longer validate the CRC that the SDK can check on a whole
  object, because the sha256 check covers the same bytes. **Caution:** an AWS bucket with an
  Object Lock default retention requires a checksum on each upload, so saves to it now fail with
  `400 InvalidRequest`. The log can then also say that the server refused `UNSIGNED-PAYLOAD`. Set
  `CLOUD_CACHE_SDK_CHECKSUMS=true` in the job environment to send the SDK checksums again.

### Fixed

- **Streaming saves to Google Cloud Storage keep their checksum again.** GCS has no tagging API,
  so a streaming save attaches its sha256 with a copy of the object onto itself. The copy was
  guarded with `CopySourceIfMatch`, which GCS rejects with `400 InvalidArgument` for the ETag of
  a multipart upload. Every streaming save larger than one part therefore logged
  `could not attach metadata: Invalid argument.` and kept no checksum and no user `metadata`. On
  GCS the copy now names the generation that the upload wrote as its source version. A copy
  after another job replaced the object finds no source and fails, as before.

## [1.8.0] - 2026-10-22

Faster saves and restores. Object keys, metadata and archive bytes do not change, so caches saved
by v1.1 to v1.7 stay valid.

### Changed

- **Upload parts skip the second hash pass over HTTPS.** Uploads to AWS S3 and to any `https://`
  endpoint now send `x-amz-content-sha256: UNSIGNED-PAYLOAD` on `UploadPart` and `PutObject`
  requests. The AWS SDK no longer hashes each part again for the request signature. The sha256
  integrity check on restore stays, and TLS protects the bytes in transit. Plain `http://`
  endpoints keep the signed payload. Set `CLOUD_CACHE_UNSIGNED_PAYLOAD=false` to turn the change
  off, or `CLOUD_CACHE_UNSIGNED_PAYLOAD=true` to turn it on for an `http://` endpoint. If a server
  refuses the header, the action sends that request again with a signed payload and logs one line.
- **A file-mode save hashes the archive while tar writes it.** Tar now writes the archive to
  stdout, and the action computes the sha256 on the way to the temporary file. The save no longer
  reads the whole archive again before the upload. The archive bytes and the stored sha256 do not
  change. If tar fails, the action removes the partial file. This applies to GNU tar only. BSD
  tar (macOS without `gtar`, and `tar.exe` in System32 on Windows) writes the file as before, and
  the action hashes the file after tar.
- **A file-mode restore hashes the archive while it downloads.** For a download in ranged parts,
  a worker thread computes the sha256 each time the parts at the start of the file are complete.
  For a download in one request, the action computes the sha256 as the bytes arrive. The restore
  no longer reads the whole archive again before the integrity check. The check and its error
  text do not change. If the hash worker fails, the action hashes the file after the download, as
  before. A streaming restore does not change.
- **The second run of the action in a job starts faster.** For example, the post step starts
  faster. Each entry turns on the Node.js V8 compile cache. The cache directory is
  `cloud-cache-action-v8` under `RUNNER_TEMP`, or under the system temp directory when
  `RUNNER_TEMP` is not set. If the cache cannot start, the step runs without it. The first run in
  a job does not start faster. A job that uses S3 only no longer loads the GitHub Actions Cache
  code (`@azure/*` and `@protobuf-ts/*`). The action loads this code only when a run uses the
  GitHub tier. The bundle in `dist/lib` is now split into three files.

## [1.7.0] - 2026-10-22

One default changes: the S3 tier now obeys `ACTIONS_CACHE_MODE`, so S3-only jobs on
`pull_request_target`, `issue_comment` and `workflow_run` no longer save by default (see Changed).
Caches saved by v1.1 to v1.6 stay valid.

### Added

- **`preset` input.** Set `preset: npm` (or `yarn`, `pnpm`, `bun`, `pip`, `poetry`, `uv`,
  `gradle`, `maven`, `cargo`, `go`) instead of `path`, `key` and `restore-keys`, like the `cache:`
  input of `actions/setup-node`. The preset gives the download cache of the package manager for
  the runner OS, the key `<runner.os>-<preset>-<hash of the lockfiles>` and the restore key
  `<runner.os>-<preset>-`. The hash comes from `hashFiles` of `@actions/glob`, the function that
  `hashFiles()` in a workflow uses. An explicit `path`, `key` or `restore-keys` input replaces that
  one value. With no lockfile, the step fails and names the globs. The post step saves with the key
  and the paths that the restore step resolved. The main action and the `restore` and `save`
  sub-actions take the input. See the [Cache Presets](./guide/presets.md) guide.

- **`ACTIONS_CACHE_MODE` support.** The S3 tier now obeys the `ACTIONS_CACHE_MODE` environment
  variable in the same way as `@actions/cache` 6.2.0 (and the 5.2.0 backport) does for GitHub
  Actions Cache. GitHub sets the variable from the `cache-mode` workflow key. `none` skips
  the restore and the save. `read` skips the save. `write-only` skips the restore. `write`, an
  unset variable and an unknown value change nothing. The action trims the value and ignores its
  case, as the toolkit does. A skip logs one info line that names the variable. The metrics line
  and the job summary show the step as skipped, with the reason. A skip never fails the step, also
  in strict dual-cache mode. A skipped restore sets `cache-hit` to `false`, and
  `fail-on-cache-miss: true` then fails the step, as in `actions/cache`. `read-only: true` still
  skips the save in every mode. See
  [Parity with actions/cache](https://github.com/xSAVIKx/cloud-cache-action#parity-with-actionscache).

- **Security guide.** A new [Security](./guide/security.md) page explains the cache trust boundary
  and what the action does and does not protect. It covers fork pull requests, `pull_request_target`
  and the read-only credential pattern. It lists each S3 call and the feature that sends it, and it
  gives least-privilege policies for AWS S3 (read-write, read-only and prune), Cloudflare R2, Google
  Cloud Storage, MinIO and RustFS. The AWS and MinIO provider pages now link to it.

- **`keep-latest` and `max-total-size` prune inputs.** `keep-latest` keeps the N most recently
  modified archives of each ref, even when they are older than `older-than-days`. Alone, it
  deletes every other archive of the ref. `max-total-size` is a budget in bytes: after the other
  rules, prune deletes the oldest remaining archives in the scope until the total fits.
  `older-than-days` is now optional, but the step fails when none of the four rule inputs
  (`older-than-days`, `keep-latest`, `max-total-size` and `abort-uploads-older-than-hours`) is
  set. Each log line names the rule that selected the archive.
  `max-total-size: 0` is allowed. It deletes every archive that `keep-latest` does not protect.
  See the [Pruning](./guide/pruning.md) guide.

- **`abort-uploads-older-than-hours` prune input.** A save that stops in the middle of a multipart
  upload leaves an incomplete upload that uses storage on providers with no lifecycle rule. Prune
  now lists the incomplete uploads in its scope and aborts each one that started more than this
  many hours ago. Set the limit above the duration of your longest save, because prune aborts a
  save in progress that is older than the limit. `dry-run` lists them and aborts none. The input
  counts as a prune rule on its own: with only this input set, prune aborts uploads and deletes no
  archive. A provider that cannot list uploads gives a warning, not a failure. Measured on the CI
  servers: RustFS 1.0.0 and Garage 2.4.1 list the uploads with their start time, and prune aborts
  them. SeaweedFS 4.46 lists them without a start time, so prune aborts none and logs a warning
  with the count. MinIO lists no upload for a prefix that is not a full object key, so prune finds
  none. The new `aborted-uploads` output and the `abortedUploads` metrics field give the count.
  See the [Pruning](./guide/pruning.md) guide.

### Changed

- **Behaviour change: S3-only jobs on low-trust triggers no longer save by default.** The S3 tier now obeys
  `ACTIONS_CACHE_MODE`. GitHub sets it from the `cache-mode` workflow key, which is generally
  available since 2026-09-10. When the workflow does not set the key, the
  [GitHub documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching) gives a default of `read` for low-trust triggers, such as
  `pull_request_target`, `issue_comment` and `workflow_run`, that resolve to the default-branch
  scope. A job on such a trigger then restores but does not save, and logs one info line. The
  `pull_request` event is not affected. To save from such a job again, set `cache-mode: write` on
  the job. Only do this when the job cannot run untrusted code.

- **An S3 save that the storage refuses with `AccessDenied` now gives a hint.** The warning
  adds: "The credentials may not be allowed to write to the bucket. Set read-only: true to skip
  the save and silence this message." A `403` for wrong credentials (`InvalidAccessKeyId`,
  `SignatureDoesNotMatch`, `RequestTimeTooSkewed`, `ExpiredToken`, `InvalidToken`,
  `TokenRefreshRequired`) does not get the hint. The step still only warns. Strict dual-cache mode still fails the
  step, as for every other save error, and the failure message has the same hint.

- **`path` and `key` are optional in the manifests.** The main action and the `restore` and
  `save` manifests now declare `path` and `key` with `required: false`, because a `preset` can
  give them. With no `preset` and no `key` or `path`, the restore still fails, and the message
  now tells you to set `preset` or both inputs.

- **One shared bundle in `dist/`.** `dist/` held six ncc bundles that each contained the same
  SDK code. Now ncc builds one bundle, `dist/lib/index.js`, from `src/main.ts`. Each action entry
  (`dist/restore`, `dist/save`, `dist/restore-only`, `dist/save-only`, `dist/prune` and
  `dist/inspect`) is a small file that imports this bundle and calls the function of its action.
  The `action.yml` paths do not change. `dist/` is now 4.9 MB instead of 24 MB, and
  `npm run build` takes about 50 seconds instead of about 245 seconds.

### Fixed

- A dual-cache save where `path` matches nothing now skips both tiers with the reason
  "no paths matched". Before, the GitHub tier reported an error, because `@actions/cache` throws a
  plain `Error` for this case and the check expected a `ValidationError`. In strict mode, this
  failed the step. The S3 tier alone was not affected.

- On Windows, an S3 tier restore in file mode with Git's GNU `tar` no longer fails when the runner
  account cannot create native symlinks (no `SeCreateSymbolicLinkPrivilege` and no Developer Mode). When the only errors
  are `Cannot create symlink to ...: Operation not permitted`, the action logs a warning and
  extracts the archive one more time with `MSYS=winsymlinks:deepcopy`. Symlinks are then restored
  as copies of their targets. Any other extract error still fails the restore without a retry.
  The retry does not run with `streaming: true`, or for the GitHub tier with `dual-cache: true`,
  because `@actions/cache` runs its own `tar`. A symlink whose target is a later symlink in the
  archive still fails. A copied directory symlink can make the restored tree much larger than the
  archive.

## [1.6.0] - 2026-10-22

No breaking changes. Caches saved by v1.1 to v1.5 stay valid. A streamed save now uses object
tagging for its checksum, so grant `s3:PutObjectTagging` and `s3:GetObjectTagging` (see Changed).

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
  when user `metadata` is set, when the provider has no tagging API (Garage), when the upload
  could not use a conditional create, or when the save cannot confirm that it owns the object
  after the tag. A streamed archive over 5 GiB now gets a checksum for the
  first time, since a tag has no size limit while the copy was refused above 5 GiB. With
  `streaming: true`, the `tags` input is capped at 9 instead of 10, because the reserved checksum
  tag takes one slot.
  - The save sends one small `HeadObject` after the tag and compares its ETag with the upload's.
    A provider that accepts `If-None-Match` and silently ignores it (Google Cloud Storage) would
    otherwise let this job tag another job's bytes with this archive's checksum, which a later
    restore would reject. When the ETags differ, the save removes its checksum tag again, warns,
    and leaves the other job's cache alone.
  - When the upload or the `HeadObject` reports no ETag, the save compares a new
    `cloud-cache-writer` user metadata field instead. The upload writes a random id for this save
    into it, so an object that carries the checksum tag also carries this field. It is not
    reported in `cache-metadata`. When the save cannot confirm the object either way, it now
    removes its checksum tag. It then falls back to the copy only when the upload reported an
    ETag, because only then can `CopySourceIfMatch` guard the copy. With no upload ETag, the save
    keeps no checksum and warns, and a failed tag write is handled the same way. A missing
    checksum only skips the integrity check, but a false checksum would reject a good cache.
  - The documented IAM policies now grant `s3:GetObjectTagging` and `s3:PutObjectTagging`. A
    restore that cannot read the tags now warns instead of logging a debug line, because the only
    other symptom is an integrity check that silently stops running.

## [1.5.1] - 2026-10-21

No breaking changes. This release only updates dependencies.

### Changed

- **Dependency update to `@actions/cache` 6.3.0.** This version fixes a race on Windows runners.
  Concurrent restores no longer fight over the tar scratch file.

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

[1.9.0]: https://github.com/xSAVIKx/cloud-cache-action/compare/v1.8.0...v1.9.0
[1.8.0]: https://github.com/xSAVIKx/cloud-cache-action/compare/v1.7.0...v1.8.0
[1.7.0]: https://github.com/xSAVIKx/cloud-cache-action/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/xSAVIKx/cloud-cache-action/compare/v1.5.1...v1.6.0
[1.5.1]: https://github.com/xSAVIKx/cloud-cache-action/compare/v1.5.0...v1.5.1
[1.5.0]: https://github.com/xSAVIKx/cloud-cache-action/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/xSAVIKx/cloud-cache-action/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/xSAVIKx/cloud-cache-action/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/xSAVIKx/cloud-cache-action/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/xSAVIKx/cloud-cache-action/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/xSAVIKx/cloud-cache-action/compare/v0.1.0...v1.0.0
[0.1.0]: https://github.com/xSAVIKx/cloud-cache-action/releases/tag/v0.1.0
