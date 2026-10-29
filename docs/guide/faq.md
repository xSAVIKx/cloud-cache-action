---
title: FAQ
description: "Answers to common questions about Cloud Cache Action: actions/cache parity, storage providers, self-hosted runners, other CI systems, pruning and permissions."
---

# FAQ

Each answer is short and links to the page that has the full details.

## Is Cloud Cache Action a drop-in replacement for actions/cache?

Yes, for `actions/cache` v4 to v6. The action takes the same inputs (`key`, `path`,
`restore-keys`, `lookup-only`, `fail-on-cache-miss`, `enableCrossOsArchive` and
`upload-chunk-size`) and gives the same outputs. Change the `uses:` line and add a bucket and
credentials. The input `save-always` is not supported. See
[Migrate from actions/cache](./migration.md#parity-with-actions-cache).

## Which storage providers does it support?

It supports any S3-compatible bucket. The docs give set-up pages for AWS S3, Cloudflare R2, Google
Cloud Storage, Backblaze B2 and Fastly Object Storage, and for self-hosted Garage, SeaweedFS, MinIO
and RustFS. See [Storage Providers](../providers/index.md).

## How large can the cache be?

The bucket sets the limit, not the action. The GitHub Actions cache gives each repository 10 GB at
no cost. Pro, Team and Enterprise accounts can raise that limit
([GitHub docs](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#usage-limits-and-eviction-policy)).
A bucket has the limits and the prices of your storage provider. See
[Dual Caching](./dual-caching.md) to use both.

## Does it work on self-hosted runners?

Yes. The runner must be able to reach the bucket endpoint. You can also start an ephemeral MinIO or
RustFS container in the job. See [MinIO](../providers/minio.md) and
[RustFS](../providers/rustfs.md).

## Does it work outside GitHub Actions?

Yes. The `cloud-cache` CLI runs the same cache engine in other CI systems and on a local machine.
It uses the same cache keys and S3 object keys as the action. See
[The cloud-cache CLI](./cli.md) and [Bitbucket Pipelines](./bitbucket.md).

## How do I delete old caches?

The action never deletes caches. Add a lifecycle rule to the bucket, or run the
`xSAVIKx/cloud-cache-action/prune@v1` sub-action on a schedule. Start the prune with
`dry-run: true`. See [Pruning Caches](./pruning.md).

## What happens when two jobs save the same key?

A save uses a conditional create (`If-None-Match: *`). On a provider that enforces it, the first
save wins, and the second save keeps that cache. On a provider that ignores it, such as Garage, the
last save wins. See [Safe Concurrent Saves](./storage.md#safe-concurrent-saves).

## Does the restore check the archive?

Yes. Every save records the sha256 checksum of the archive. A restore hashes the download and
compares it before it extracts the archive. A mismatch counts as a cache miss. See
[Archive Integrity](./storage.md#archive-integrity).

## Which permissions does the bucket key need?

A job that restores and saves needs read, write and list access to the cache prefix. A job that
only restores needs a read-only key. The [Security guide](./security.md) gives least-privilege
policies for AWS S3, Cloudflare R2, Google Cloud Storage, MinIO and RustFS.

## Is it safe for pull requests from forks?

GitHub does not give repository secrets to a workflow that a fork pull request starts. The S3 tier
then has no credentials and cannot connect. Do not restore a cache with a write credential in a
`pull_request_target` job that runs pull request code. See
[Pull requests from forks](./security.md#pull-requests-from-forks).

## Why did my restore miss?

Set `explain: true` on the restore, or run the `xSAVIKx/cloud-cache-action/inspect@v1`
sub-action. Both list each object that the lookup checked, and why the restore did not use it.
See [Inspecting Lookups](./inspecting.md).

## How do I make transfers faster?

Set `transfer-tuning: auto`. The action then selects the part size and the concurrency from the
archive size. In the benchmark run that the docs give, `auto` was faster than the defaults for
every provider and size measured. See [Performance](./performance.md#automatic-tuning).
