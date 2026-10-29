---
description: "The prune sub-action of Cloud Cache Action deletes old CI caches from an S3 bucket by age, by count per ref or to fit a size budget. Inputs, dry runs and scope."
---

# Pruning Caches

Object storage has no built-in cache eviction like the size limit of the GitHub Actions cache (10 GB
per repository by default): whatever you save to S3 stays there until something deletes it.
`xSAVIKx/cloud-cache-action/prune@v1` is a standalone
sub-action that deletes cache archives from any S3-compatible bucket by age, by count per ref, or
to fit a total size budget. You can run it on a schedule instead of relying only on a bucket
lifecycle rule.

## Usage

Run it in its own scheduled workflow. **Start with `dry-run: true`** so you can read the logged
output before anything is actually deleted, then flip it to `false` once it looks right:

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
          endpoint: https://<account_id>.r2.cloudflarestorage.com # Or AWS, GCS, B2, MinIO, etc.
          access-key: ${{ secrets.S3_ACCESS_KEY }}
          secret-key: ${{ secrets.S3_SECRET_KEY }}
          older-than-days: 30
          dry-run: true # Flip to false once the logged output looks right.
```

Each candidate is logged at info level with its size and age (capped at 200 lines, followed by a
totals line), so a dry run tells you exactly what a real run would delete.

## Inputs

The prune action shares its storage inputs with the main action, plus the inputs of its own below.
Set at least one of `older-than-days`, `keep-latest`, `max-total-size` and `abort-uploads-older-than-hours`.

| Input                             | Required |          Default          | Description                                                                 |
| ---------------------------------- | :------: | :------------------------: | ---------------------------------------------------------------------------- |
| `bucket`                           | **Yes**  |             —              | Name of the S3 bucket                                                        |
| `older-than-days`                  |    No    |             —              | Delete cache archives whose last-modified time is older than this many days |
| `keep-latest`                      |    No    |             —              | Positive integer. In each ref, never delete the N most recently modified archives. Alone, it deletes every other archive of the ref |
| `max-total-size`                   |    No    |             —              | Total size budget in bytes (a plain integer). Delete the oldest archives until the total fits |
| `abort-uploads-older-than-hours`   |    No    |             —              | Positive integer. Abort incomplete multipart uploads in the prune scope that started more than this many hours ago. Deletes no archive. Set it above the duration of your longest save. Has no effect on SeaweedFS and MinIO (see below) |
| `ref`                               |    No    |     _(every ref)_          | Prune only caches under this full Git ref (`refs/heads/main`); empty means every ref |
| `dry-run`                           |    No    |          `false`           | List cache archives that would be pruned without deleting anything          |
| `endpoint`                         |    No    |          Auto/AWS          | Custom S3-compatible endpoint URL                                           |
| `region`                           |    No    |      Auto/`us-east-1`      | AWS or S3 provider region                                                    |
| `provider`                         |    No    |            Auto            | Preset: `aws`, `r2`, `gcs`, `b2`, `fastly`, `garage`, `seaweedfs`, `minio`  |
| `access-key` / `accessKey`         |    No    |    `AWS_ACCESS_KEY_ID`     | S3 Access Key ID                                                             |
| `secret-key` / `secretKey`         |    No    |  `AWS_SECRET_ACCESS_KEY`   | S3 Secret Access Key                                                         |
| `session-token` / `sessionToken`   |    No    |    `AWS_SESSION_TOKEN`     | S3 Session Token                                                             |
| `force-path-style`                 |    No    |            Auto            | Force path-style S3 URLs                                                    |
| `prefix`                           |    No    |            `""`            | Subfolder prefix path inside the bucket                                     |
| `s3-key-pattern`                   |    No    | same default as the main action | Template for the S3 object key (see [S3 Key Templating](./s3-key-patterns.md)) |
| `scoped-to-repository`             |    No    |           `true`           | Whether to prefix bucket cache paths with `GITHUB_REPOSITORY`               |
| `scoped-to-ref`                    |    No    |           `true`           | Whether cache keys include the Git ref; set `false` to prune caches saved with `scoped-to-ref: false` |
| `retry`                            |    No    |           `true`           | Enable exponential backoff retries on S3 operations                        |
| `retry-count`                      |    No    |            `3`              | Maximum number of S3 retries                                                |
| `metrics-file`                     |    No    |            `""`             | Append one JSON line of timings and sizes for this step to this file, relative to the workspace |

An invalid `older-than-days`, `keep-latest`, `max-total-size` or `abort-uploads-older-than-hours` (not a positive integer; `max-total-size` also accepts `0`), a step
with none of the four set, or an unrecognized `dry-run` value (anything
other than `true`, `True`, `TRUE`, `false`, `False` or `FALSE`) fails the step immediately, rather
than silently falling back to a default — a typo like `dry-run: Flase` must never turn into a real
deletion.

## Outputs

| Output          | Description                                                                    |
| ---------------- | ------------------------------------------------------------------------------- |
| `pruned-count`   | The number of cache archives pruned (or that would be pruned in a dry run)      |
| `pruned-bytes`   | The total size in bytes of the pruned cache archives                           |
| `kept-count`     | The number of cache archives that matched the scope but no rule selected       |
| `aborted-uploads` | The number of incomplete multipart uploads aborted (or that would be aborted in a dry run) |

The outputs are set once the prune finishes. A step that fails earlier — an invalid input, an
unsafe scope, an S3 error — sets none of them, so guard on `steps.<id>.outcome` before reading
them in a later step.

## Metrics

Set `metrics-file` to append one JSON line describing this prune to a file, in addition to the
`cloud-cache-metrics <json>` debug line every step writes. The line carries `"step":"prune"`, an
outcome of `pruned`, the pruned byte total, the step's `durationMs`, and the tallies in `extra`:

```json
{"step":"prune","timestamp":"2026-09-17T03:00:11.204Z","provider":"r2","bytes":4194304000,"durationMs":9412,"outcome":"pruned","extra":{"prunedCount":37,"prunedBytes":4194304000,"keptCount":12,"abortedUploads":0,"dryRun":false}}
```

The line is written once the prune has finished, so a step that fails earlier writes none. Writing
the file is best-effort: a write error only logs `Could not write metrics to <path>: <reason>` and
never fails the step. See [Metrics and Timings](./getting-started.md#metrics-and-timings) for the
fields the other steps emit.

## What gets pruned

Prune lists objects under the fixed start of your `s3-key-pattern` and only treats an object as a
candidate when its **whole key** matches the pattern: this repository, the configured prefix, the
given ref (or any full ref such as `refs%2Fheads%2Fmain` when `ref` is empty), any cache key, any
version, and either archive filename the action produces (`cache.tar.zst` or `cache.tar.gz`).
Objects that are not cache archives, and objects that belong to another repository or another ref
but happen to share the listing prefix, are never touched.

Caches saved with `scoped-to-ref: false` have no ref in their key. Prune them with a separate step
that also sets `scoped-to-ref: false` and leaves `ref` empty: the pattern is then resolved without
`${ref}`, exactly as the main action resolves it, and keys that carry a ref segment where the ref
would be are left for a ref-scoped prune. One exception: an unscoped prune with an empty `prefix`
also matches ref-scoped caches of the same repository that were saved with a non-empty `prefix`
(their prefix segment reads as part of the key), subject to the prune rules. If you mix prefixes,
give every prune step the `prefix` its caches were saved with.

Among candidates, the first three rules below choose what to delete. The fourth rule aborts
incomplete uploads and deletes no archive. Each rule is optional, and at least one must be set.

- **`older-than-days`**: an archive whose `LastModified` is older than this many days is deleted.
- **`keep-latest`**: in each ref, the N most recently modified archives are never deleted. With
  `older-than-days` also set, an archive is deleted only when it is older than the age limit **and**
  not among the newest N of its ref. With `keep-latest` alone, every other archive of the ref is
  deleted. With `max-total-size` and no `older-than-days`, `keep-latest` only protects the newest N,
  and the budget decides what else is deleted. Groups are per ref, not per cache key: with two cache
  keys under one ref, `keep-latest: 1` keeps one archive for that ref, and the newest archive of the
  other key can be deleted.
- **`max-total-size`**: after the other rules, the total size of the remaining archives in the
  whole prune scope (every ref, not each ref) must be at or below this many bytes. Prune deletes
  the oldest remaining archives until it is. The `keep-latest` archives are never deleted for the
  budget. If they alone are over the budget, the step logs a warning and deletes nothing more.
  The value is a plain integer in bytes: `10GB` or `5G` is not accepted. `0` is accepted and
  deletes every archive that `keep-latest` does not protect.
- **`abort-uploads-older-than-hours`**: a save that stops in the middle of a multipart upload
  leaves an incomplete upload, which uses storage until someone aborts it. On a provider with no
  lifecycle rule for incomplete uploads, nothing else removes it. Prune lists the incomplete
  uploads under the same scope as the archives, with the same key match. It aborts each upload
  that started more than this many hours ago. `dry-run` lists the uploads and aborts none. This
  rule alone is a valid prune: it aborts uploads and deletes no archive. If the provider cannot
  list uploads (for example, it answers `NotImplemented`), prune logs a warning and goes on. An
  upload that finished before prune aborted it is ignored. Any other abort error gives a warning
  for that upload and does not fail the step. Set the limit above the duration of your longest
  save: prune aborts an upload that is still in progress when it is older than the limit, and that
  save then fails. The minimum is 1 hour.

  This rule works only when the provider lists the uploads under a prefix, with their start time.
  The behaviour below was measured on 2026-10-21 with the servers of the CI suite:

  | Server              | What `ListMultipartUploads` returns                         | Result                                     |
  | ------------------- | ----------------------------------------------------------- | ------------------------------------------ |
  | RustFS 1.0.0        | The uploads under the prefix, with the `Initiated` time     | Prune aborts the stale uploads             |
  | Garage 2.4.1        | The uploads under the prefix, with the `Initiated` time     | Prune aborts the stale uploads             |
  | SeaweedFS 4.46      | The uploads under the prefix, with no `Initiated` time      | Prune aborts none and warns with the count |
  | MinIO (2026-03-30)  | No upload, unless the prefix is a full object key           | Prune finds no upload and aborts none      |

  On SeaweedFS and MinIO, use a lifecycle rule of the server if it has one (for MinIO,
  `mc ilm rule add --abort-incomplete-multipart-upload-days`). Other providers were not measured.

"Each ref" is the ref segment of your `s3-key-pattern`. When the pattern has no `${ref}` (or
`scoped-to-ref` is `false`), prune treats the whole scope as one group, so `keep-latest: 5` keeps the
5 newest archives of the scope. Two archives with the same modification time are ranked by key, so
the result is the same on every run. An archive with no modification time is never deleted.

Each log line names the rule that selected the archive (`age`, `count` for `keep-latest` alone, or
`size budget`), and the totals line counts them by rule. The outputs and the metrics line count
every archive deleted by any rule; `kept-count` is every archive in scope that no rule selected.

Deletion happens one `DeleteObject` call per key (up to 8 in flight at a time), rather than a
single batch delete: Google Cloud Storage's S3 interoperability layer does not support
multi-object delete, and this keeps behavior identical across providers.

## Scope: repository, prefix and ref

By default (`scoped-to-repository: true`), pruning is scoped to the current repository, matching
how caches are saved. Set `prefix` to further narrow it, exactly as with the main action.

Leaving `ref` empty prunes caches under **every** ref in scope, not just the current branch — this
is usually what you want for a scheduled cleanup job. Set `ref` to prune a single ref instead. It
must be the full ref, such as `refs/heads/main` or `refs/pull/12/merge`: caches are saved under
the full ref, so `main` matches nothing. The step warns when `ref` does not start with `refs/`.

The action refuses to run when the result would be unsafe:

- **No fixed listing prefix.** If the `s3-key-pattern` leaves nothing fixed before the first part
  that varies (for example `scoped-to-repository: false` with no `prefix`, or a pattern that starts
  with `${ref}` while `ref` is empty), prune would have to scan the whole bucket. The step fails
  and asks you to set `prefix`, keep `scoped-to-repository` enabled, or set `ref`.
- **A repository that cannot be told apart.** If every `${GITHUB_REPOSITORY}` in the pattern shares
  a path segment with `${key}`, `${version}` or a `${ref}` before it (for example
  `${key}-${GITHUB_REPOSITORY}/`), another repository's object keys could match yours, so the step
  fails. Separate `${GITHUB_REPOSITORY}` from them with `/`. `${GITHUB_REPOSITORY}-${ref}` is
  fine: an encoded ref always starts with `refs%2F`, which no repository name contains.
- **No `${archive_filename}`.** Without it in the pattern, prune cannot tell cache archives from
  other objects, so the step fails.
- **A ref without a ref scope.** Setting `ref` while `scoped-to-ref` is `false` fails the step,
  because those cache keys contain no ref.
- **A ref that cannot be told apart.** With `ref` set, the step fails when the pattern has no
  `${ref}`, or when every `${ref}` shares a path segment with `${key}`, `${version}` or another
  `${ref}`. Leave `ref` empty to prune every ref instead.
