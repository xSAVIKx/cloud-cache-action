---
description: "Set up Cloud Cache Action in 10 minutes: create a bucket and two secrets, add one step with a preset, and check the cache hit in the job summary."
---

# Getting Started

**Cloud Cache Action** stores and restores GitHub Actions caches in any S3-compatible cloud or self-hosted object storage service. It is a drop-in replacement for `actions/cache` v4 to v6. Change the `uses:` line, and add a bucket and credentials.

The GitHub Actions cache gives each repository 10 GB at no cost, and it removes entries that no job accessed for more than 7 days. Above the limit, GitHub evicts the least recently used entries. Pro, Team and Enterprise accounts can raise the limit, and GitHub bills the storage above 10 GB ([GitHub docs](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#usage-limits-and-eviction-policy), [changelog of 2025-11-20](https://github.blog/changelog/2025-11-20-github-actions-cache-size-can-now-exceed-10-gb-per-repository/)). A bucket has the limits and the prices of your storage provider. With Cloudflare R2, there are no egress fees.

## Before you start

You need these four items. The [Storage Providers](../providers/index.md) pages give the steps for each provider.

1. **A private bucket.** The action does not create the bucket.
2. **A key that can read, write and list objects in the bucket.** The [Security guide](./security.md) gives least-privilege policies.
3. **Two repository secrets**, `S3_ACCESS_KEY` and `S3_SECRET_KEY`, in **Settings** > **Secrets and variables** > **Actions**. AWS S3 with OIDC needs no secrets (see [AWS S3](../providers/aws-s3.md#option-a-github-actions-oidc-recommended)).
4. **A rule that deletes old caches.** The action never deletes a cache. Add a lifecycle rule to the bucket, or schedule the [`prune` sub-action](./pruning.md).

## Quickstart

Add the cache step after the checkout step and before the install step:

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1

      - name: Cache npm downloads
        uses: xSAVIKx/cloud-cache-action@v1
        with:
          bucket: my-ci-cache-bucket
          # Cloudflare R2 and the other providers: set the endpoint.
          endpoint: https://<account-id>.r2.cloudflarestorage.com
          # AWS S3: remove the endpoint line and set the region of the bucket.
          # region: eu-west-1
          access-key: ${{ secrets.S3_ACCESS_KEY }}
          secret-key: ${{ secrets.S3_SECRET_KEY }}
          preset: npm

      - run: npm ci
```

The step restores the cache. A post step saves the cache when the job succeeds, as `actions/cache` does. When the restore finds the exact key, the post step does not save.

`preset: npm` gives the `path`, the `key` and the `restore-keys`. The key contains a hash of the lockfile, so the checkout step must run first. The other presets are `yarn`, `pnpm`, `bun`, `pip`, `poetry`, `uv`, `gradle`, `maven`, `cargo` and `go`. See [Cache Presets](./presets.md).

### Endpoint and region

- **AWS S3:** do not set `endpoint`. Set `region` to the region of the bucket. See [AWS S3](../providers/aws-s3.md#region).
- **All other providers:** set `endpoint`. The action finds the provider from the endpoint URL and sets a default region. You do not need `region`, except for B2 with an unusual endpoint, or when the provider requires a given region. The [Storage Providers](../providers/index.md) table gives the endpoint form of each provider.

### Explicit path and key

To cache other files, set `path`, `key` and `restore-keys`, as with `actions/cache`. This step caches the same directory as `preset: npm` on a Linux runner:

```yaml
- name: Cache npm downloads
  uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: my-ci-cache-bucket
    endpoint: https://<account-id>.r2.cloudflarestorage.com
    access-key: ${{ secrets.S3_ACCESS_KEY }}
    secret-key: ${{ secrets.S3_SECRET_KEY }}
    path: ~/.npm
    key: ${{ runner.os }}-node-${{ hashFiles('**/package-lock.json') }}
    restore-keys: |
      ${{ runner.os }}-node-
```

The examples cache `~/.npm`, not `node_modules`. The command `npm ci` deletes `node_modules` before it installs ([npm docs](https://docs.npmjs.com/cli/commands/npm-ci)). A restored `node_modules` then gives no benefit.

## Check that it works

1. Run the workflow on the default branch. The first run has no cache. The restore step logs `Cache not found for input keys: <keys>`. The post step logs `Cache saved to S3 with key: <key>`.
2. Run the workflow again. The restore step logs `Cache restored from s3 with key: <key>` and one `Timings:` line, for example:

   ```text
   Timings: lookup 0.24 s, download 5.31 s (35.9 MiB/s), extract 2.41 s, total 8.12 s
   ```

3. Open the summary page of the second run. The "Cloud cache restore" table shows `true` in the "Cache hit" column and `s3` in the "Source" column.

Do the first run on the default branch. A restore searches the current ref, the pull request base branch and the default branch. A cache that a feature branch saved is not visible to other branches.

If the restore logs a warning that starts with `Restoring from s3 failed`, the storage refused the request or the action could not connect. The warning gives the reason. See [Troubleshooting](./troubleshooting.md) for each warning text, its cause and its fix.

### Metrics and timings

The restore and the save set the outputs `cache-restore-duration-ms`, `cache-save-duration-ms`, `cache-transfer-duration-ms` and `cache-bytes`. Set `metrics-file` to append one JSON line for each step to a file. [How It Works](./how-it-works.md#metrics-and-timings) gives the fields. To turn off the summary table, set `job-summary: false`.

## Paths and exclusions

`path` accepts files, directories, globs, `~` and `!` exclusions, one per line.

- **Exclusions only remove what the include patterns matched**, as in `actions/cache`. `path: logs` with `!logs/debug.txt` still caches the whole `logs` directory, because the directory itself is the match. To leave one file out, match the files instead:

  ```yaml
  path: |
    logs/*
    !logs/debug.txt
  ```

- **Symbolic links are not followed while matching.** A pattern that wildcards through a symlinked directory, such as `linked-dir/*` where `linked-dir` is a symlink, matches nothing. A symlink that a pattern matches is archived as a link, not as the files it points to. See [Symlinks](./how-it-works.md#symlinks) for Windows runners.

## Restore and save actions

As with `actions/cache/restore` and `actions/cache/save`, you can run the restore and the save as separate steps. The examples below show only the cache inputs. When `access-key` and `secret-key` are empty, the action reads `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` from the environment of the job.

### Restore only

```yaml
- name: Restore cache
  id: restore-step
  uses: xSAVIKx/cloud-cache-action/restore@v1
  with:
    bucket: my-ci-cache-bucket
    # Add endpoint or region, access-key and secret-key, as in the Quickstart.
    key: ${{ runner.os }}-build-${{ hashFiles('**/package-lock.json') }}
    path: build/
```

### Save only

```yaml
- name: Save cache
  uses: xSAVIKx/cloud-cache-action/save@v1
  with:
    bucket: my-ci-cache-bucket
    # Add endpoint or region, access-key and secret-key, as in the Quickstart.
    key: ${{ runner.os }}-build-${{ hashFiles('**/package-lock.json') }}
    path: build/
```

### Saving after failed steps

The post step only runs when the job succeeds. To save a cache even when a later step fails, use the separate actions with `if: always()`:

```yaml
- uses: xSAVIKx/cloud-cache-action/restore@v1
  id: cache
  with:
    bucket: my-ci-cache-bucket
    # Add endpoint or region, access-key and secret-key, as in the Quickstart.
    key: ${{ runner.os }}-build-${{ hashFiles('**/package-lock.json') }}
    path: ~/.cache

- run: make build

- uses: xSAVIKx/cloud-cache-action/save@v1
  if: always() && steps.cache.outputs.cache-hit != 'true'
  with:
    bucket: my-ci-cache-bucket
    # Add endpoint or region, access-key and secret-key, as in the Quickstart.
    key: ${{ runner.os }}-build-${{ hashFiles('**/package-lock.json') }}
    path: ~/.cache
```

## Next steps

- [Migrate from actions/cache](./migration.md): the changes for an existing workflow, and the differences that you must know.
- [Storage Providers](../providers/index.md): the bucket and the key for each provider.
- [Troubleshooting](./troubleshooting.md): the log text of each common error, with the cause and the fix.
- [Inspecting Lookups](./inspecting.md): set `explain: true` when a restore misses and you expected a hit.
- [Performance](./performance.md): the transfer inputs, `transfer-tuning: auto` and the measured times.
- [How It Works](./how-it-works.md): the phases of a restore and a save, symlinks, metrics and the `action.yml` files.
- [Inputs and Outputs](./reference.md): the full list.
