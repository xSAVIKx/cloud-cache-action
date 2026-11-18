---
title: Troubleshooting
description: "Fix the common errors of Cloud Cache Action: HTTP 403 on restore, a refused save, no secrets in a fork pull request, a wrong AWS region, and a restore that misses."
---

# Troubleshooting

Each section starts with the text that the log shows. Then it gives the cause and the fix. Search
this page for the text of your log.

A failed S3 restore does not fail the job. The step logs a warning, and the restore counts as a
cache miss. With `dual-cache: true` and `dual-cache-strict: true`, the step fails.

## `HeadObject ... returned HTTP 403 Forbidden`

```text
Restoring from s3 failed, so it counts as a cache miss: HeadObject s3://<bucket>/<key> returned HTTP 403 Forbidden. Check access-key, secret-key and region, and check that the bucket policy allows s3:ListBucket on the bucket and s3:GetObject on the cache keys. The Security guide lists the permission for each S3 call.
```

**Cause.** The storage refused the first request of the restore. The usual causes are a wrong
secret value, or a policy without `s3:ListBucket` on the bucket.

**Fix.**

1. Make sure that the two secrets hold the values of a key for this bucket. If you are not sure,
   create the key again and update the two secrets.
2. For AWS S3, make sure that `region` is the region of the bucket.
3. Compare the policy of the key with the policies in the [Security guide](./security.md).

For every S3 `403`, the warning names the S3 call, the object, the HTTP status and the policy
action that the call needs. After a tier error, the last restore line is
`No cache restored: the s3 tier failed (see the warning above). Keys searched: ...`. The line
`Cache not found for input keys: ...` is only for a true miss.

## `The credentials may not be allowed to write to the bucket`

```text
Failed to save cache to S3: ... The credentials may not be allowed to write to the bucket. Set read-only: true to skip the save.
```

**Cause.** The storage refused an S3 write call (`PutObject`, `CreateMultipartUpload`,
`UploadPart`, `CompleteMultipartUpload` or `CopyObject`) with `AccessDenied`, or with a `403` that
is not a credential error. The key is read-only, or its policy does not allow the write.

**Fix.** If the job must save, give the key the read-write policy of the
[Security guide](./security.md). If the job must not save, for example a pull request job, set
`read-only: true`.

The job does not fail. With `dual-cache-strict: true`, the step fails, as for every other save
error. A `403` for wrong credentials, such as `InvalidAccessKeyId`, `SignatureDoesNotMatch` or
`ExpiredToken`, gives the warning without this hint. A `403` on a read call, such as the
`HeadObject` existence check, also gives no hint. It means a wrong secret or a policy without
`s3:ListBucket`, not a read-only key.

## A pull request from a fork or from Dependabot has no cache

```text
Restoring from s3 failed, so it counts as a cache miss: ...
```

**Cause.** GitHub does not give repository secrets to a fork pull request or to a Dependabot pull
request. The `access-key` and `secret-key` inputs are then empty. A secret name in the workflow
that is not the name of a repository secret gives the same result (see
[Required secrets by provider](./migration.md#required-secrets-by-provider)). The action then reads
`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` from the environment, and then uses the default
credential chain of the AWS SDK. On a GitHub-hosted runner, that chain finds no credentials. The
text after the colon is the error of the AWS SDK.

**Fix.** Use the GitHub Actions cache for these runs, with `dual-cache: true` or
`use-fallback: true`. See
[Fork and Dependabot pull requests get no S3 cache](./migration.md#fork-and-dependabot-pull-requests-get-no-s3-cache).

Two related messages:

- `Only one of access-key and secret-key is set; ignoring it and using the default AWS credential chain.`
  One of the two secrets is empty. Examine the secret names.
- `Bucket name is required. Please set "bucket" input or AWS_S3_BUCKET environment variable.`
  The `bucket` input is empty, for example because it comes from a secret. This error fails the
  step, unless `use-fallback: true` is set, or `dual-cache: true` without `dual-cache-strict`.

## Wrong AWS region

```text
Restoring from s3 failed, so it counts as a cache miss: ...
```

**Cause.** The bucket is in a different AWS region from the region that the action uses. Without
the `region` input and without `AWS_REGION` or `AWS_DEFAULT_REGION`, the action uses `us-east-1`.
The action does not follow the redirect that AWS gives for a different region. AWS documents the
error codes `PermanentRedirect` (HTTP 301) and `AuthorizationHeaderMalformed` (HTTP 400) for a
request to the wrong region. The project did not measure which text the log shows.

**Fix.** Set `region` to the region of the bucket. See [Region](../providers/aws-s3.md#region) on
the AWS S3 page.

## `Cache not found for input keys` and you expected a hit

```text
Cache not found for input keys: Linux-npm-9f2c1a..., Linux-npm-
```

**Cause.** The restore found no object for the key and the restore keys in the refs that it
searches. These are the usual causes:

- It is the first run after the migration. The action does not copy the GitHub caches to the
  bucket.
- A different branch saved the cache. A restore searches only the current ref, the pull request
  base branch and the default branch.
- A run that a tag started saved the cache. See
  [Tag-triggered runs and refs](./migration.md#tag-triggered-runs-and-refs).
- The `path` list changed. The `path` lines are part of the cache version, so a different list is
  a different cache.
- A lifecycle rule or `prune` deleted the object. Both use the time of the save.

**Fix.** Set `explain: true` on the step. The log then lists each ref and each object that the
lookup examined, and why the restore did not use it. See [Inspecting Lookups](./inspecting.md).

## The job failed, and the cache was not saved

**Cause.** The post step runs only when the job succeeds, as in `actions/cache`. The action does
not support the `save-always` input.

**Fix.** Use the separate `restore` and `save` actions, with `if: always()` on the save. See
[Saving after failed steps](./getting-started.md#saving-after-failed-steps).

## `Path Validation Error`

```text
Path Validation Error: Path(s) specified in the action for caching do(es) not exist, hence no cache is being saved.
```

**Cause.** At the time of the save, no file matched the `path` lines. With a preset, the tool can
use a cache directory that is not the default directory. The Presets page gives two reports for
GitHub-hosted Windows runners.

**Fix.** Print the cache directory in the job, for example with `npm config get cache` or
`pnpm store path`. Then set `path` to that directory. See
[A custom cache directory](./presets.md#a-custom-cache-directory).

## `Preset "..." found no lockfile to hash`

```text
Preset "go" found no lockfile to hash in /home/runner/work/app/app. It looked for: **/go.sum. Add a lockfile, or set the key input.
```

**Cause.** The preset makes the key from a hash of the lockfile, and no file in the workspace
matched. Either the cache step runs before the checkout step, or the repository has no lockfile.

**Fix.** Put the cache step after `actions/checkout`. If the repository has no lockfile, set
`key`. See [Errors](./presets.md#errors) on the Presets page.

## `Input required and not supplied: key`

```text
Input required and not supplied: key. Set key and path, or set preset.
```

**Cause.** The step has no `preset`, and `key` or `path` is empty.

**Fix.** Set `key` and `path`, or set `preset`.

## `Cannot create symlink to ...: Operation not permitted`

**Cause.** On a self-hosted Windows runner, the runner account cannot create native symlinks.

**Fix.** Give the account the `SeCreateSymbolicLinkPrivilege` privilege, or turn on Developer
Mode. In file mode, the action logs a warning and extracts the archive again with copies of the
symlink targets. See [Symlinks](./how-it-works.md#symlinks) for the limits of that retry.

## `400 InvalidRequest` on a save to AWS S3

**Cause.** The bucket has an Object Lock default retention. Object Lock requires a checksum on
each upload, and the action does not send the AWS SDK checksums.

**Fix.** Use a bucket without Object Lock for caches. If you must use such a bucket, set
`CLOUD_CACHE_SDK_CHECKSUMS: 'true'` in the job `env`. See
[Object Lock](../providers/aws-s3.md#_4-object-lock).

## `BusyBox tar is not supported`

```text
BusyBox tar is not supported. Install GNU tar and zstd, for example: apk add tar zstd
```

**Cause.** The `cloud-cache` CLI found BusyBox `tar`, for example on Alpine Linux.

**Fix.** Install GNU `tar` and `zstd`. On Alpine Linux, run `apk add tar zstd`. See
[Requirements](./cli.md#requirements) of the CLI.

## The bucket grows with no limit

**Cause.** The action never deletes a cache.

**Fix.** Add a lifecycle rule to the bucket, or schedule the `prune` sub-action. See
[Old caches stay in the bucket](./migration.md#old-caches-stay-in-the-bucket) and
[Pruning Caches](./pruning.md).

## A step is `skipped` and names `ACTIONS_CACHE_MODE`

**Cause.** GitHub sets `ACTIONS_CACHE_MODE` from the `cache-mode` workflow key. The value `read`
skips the save, `write-only` skips the restore, and `none` skips both.

**Fix.** See [Parity with actions/cache](./migration.md#parity-with-actions-cache) for the rules
and for when it is safe to set `cache-mode: write`.

## More help

If your log text is not on this page, set `explain: true` for a restore problem. Then open an
[issue](https://github.com/xSAVIKx/cloud-cache-action/issues) with the warning line of the step.
Remove secret values and private names from the text first.
