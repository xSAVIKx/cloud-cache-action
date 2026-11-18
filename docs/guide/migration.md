---
description: "Migrate from actions/cache or tespkg/actions-cache to Cloud Cache Action: change the uses line, add a bucket and keys, and keep key, path and restore-keys."
---

# Migrate from actions/cache to an S3 Cache

To migrate from `actions/cache` or `tespkg/actions-cache` to Cloud Cache Action, change the `uses:` line and add a bucket and credentials. Keep your `key`, `path` and `restore-keys` inputs. The cache then goes to your S3-compatible bucket, not to the GitHub Actions cache.

## Migration checklist

1. Create a private bucket. The [Storage Providers](../providers/index.md) pages give the steps.
2. Add a rule that deletes old caches. The action never deletes a cache. See [Old caches stay in the bucket](#old-caches-stay-in-the-bucket).
3. Create a key that can read, write and list objects in the bucket. Add its two values as repository secrets. See [Required secrets by provider](#required-secrets-by-provider).
4. Change the `uses:` line. Add `bucket`, `endpoint` (or `region` for AWS S3) and the two secrets. See [the example](#manual-migration-from-actions-cache-v4-v5-v6).
5. Run the workflow two times on the default branch. The first run misses and saves. The second run shows a hit in the job summary. See [Check that it works](./getting-started.md#check-that-it-works). If a step logs a warning, see [Troubleshooting](./troubleshooting.md).

Before you merge the change, read [What changes after the move](#what-changes-after-the-move). It gives three differences from `actions/cache` that cost time or money if you do not plan for them.

To move the built-in cache of a `setup-*` action, see [Migrate from `setup-*` caching](#migrate-from-setup-caching).

The sections below give the details. A prompt for an AI coding agent is at [the end of the steps](#automated-migration-with-ai-coding-agents).

## Manual migration from `actions/cache` (v4, v5, v6)

Cloud Cache Action has the same inputs and outputs as `actions/cache`. Change the `uses:` line and add your bucket configuration:

### Before (`actions/cache`)

```yaml
- name: Cache dependencies
  uses: actions/cache@v4
  with:
    path: ~/.npm
    key: ${{ runner.os }}-node-${{ hashFiles('**/package-lock.json') }}
    restore-keys: |
      ${{ runner.os }}-node-
```

### After (Cloud Cache Action)

```yaml
- name: Cache dependencies
  uses: xSAVIKx/cloud-cache-action@v1
  with:
    # 1. Add your S3 bucket & credentials
    bucket: my-ci-cache-bucket
    endpoint: https://<account-id>.r2.cloudflarestorage.com
    access-key: ${{ secrets.S3_ACCESS_KEY }}
    secret-key: ${{ secrets.S3_SECRET_KEY }}

    # 2. Keep all your existing inputs exactly as they are
    path: ~/.npm
    key: ${{ runner.os }}-node-${{ hashFiles('**/package-lock.json') }}
    restore-keys: |
      ${{ runner.os }}-node-
```

All existing features (`lookup-only`, `fail-on-cache-miss`, `enableCrossOsArchive`, `read-only`) continue to work identically. `save-always` is not supported: use `xSAVIKx/cloud-cache-action/save@v1` with `if: always()` instead.

See [Parity with actions/cache](#parity-with-actions-cache) for the behaviour that has no input.

## What changes after the move

### Old caches stay in the bucket

`actions/cache` removes an entry that no job accessed for 7 days. This action never deletes a cache, so the bucket grows until something deletes the objects. Use one of these:

- **A lifecycle rule of the bucket**, for example an expiry after 30 days. Each provider page gives the steps.
- **The [`prune` sub-action](./pruning.md)** on a schedule, for example with `older-than-days: 30`.

Both use the time of the save, not the time of the last restore. A restore does not change the object. A 30-day rule thus also deletes a cache that jobs restore each day. The next run then misses and saves the cache again. To keep the caches that jobs use, set `keep-latest` together with `older-than-days` on `prune`. `keep-latest` keeps the newest archives of each ref.

### The first run of each key misses

The migration does not copy the entries of the GitHub Actions cache to the bucket. The first run of each key is a cache miss, and that run saves the cache to the bucket.

To keep the GitHub caches during the switch, set `dual-cache: true` and `restore-priority: github-first` for some days. The restore then asks the GitHub Actions cache first, with your `key`, `path` and `restore-keys`. The post step saves each cache to the bucket. In the job summary, the "Source" column shows `github` or `s3` for each hit. See [Dual Caching, use case 3](./dual-caching.md#use-case-3-zero-downtime-migration-from-the-github-cache-to-cloud-storage).

### Fork and Dependabot pull requests get no S3 cache

With `actions/cache`, a pull request from a fork restores the cache of the base branch. GitHub does not give repository secrets to a fork pull request or to a Dependabot pull request. The S3 restore then fails, and the step logs a warning that starts with `Restoring from s3 failed, so it counts as a cache miss`. The job does not fail.

If these pull requests need a cache, use the GitHub Actions cache for them:

- **`dual-cache: true`** saves each cache to the bucket and to the GitHub Actions cache. A run with no secrets gets the warning for the S3 tier, and then restores from the GitHub Actions cache. See [Dual Caching](./dual-caching.md).
- **`use-fallback: true`** makes a restore ask the GitHub Actions cache after an S3 error or an S3 miss, and makes a save go to the GitHub Actions cache when the S3 save fails. Runs that have the secrets save only to the bucket. A run with no secrets thus finds only the caches that other runs with no secrets saved to the GitHub Actions cache.

Do not put `bucket` in a secret for these runs. An empty `bucket` fails the step, unless one of the two inputs above is set. See [Pull requests from forks](./security.md#pull-requests-from-forks) for the security rules.

## Migrate from `setup-*` caching {#migrate-from-setup-caching}

Many workflows have no `actions/cache` step. They use the cache that is built into `actions/setup-node`, `actions/setup-python`, `actions/setup-java` or `actions/setup-go`. That cache is the GitHub Actions cache. To move it to your bucket, turn off the built-in cache and add a step with a [preset](./presets.md).

### Before (`actions/setup-node` with `cache: npm`)

```yaml
- uses: actions/setup-node@v6
  with:
    node-version: 24
    cache: npm
- run: npm ci
```

### After (Cloud Cache Action with `preset: npm`)

```yaml
- uses: actions/setup-node@v6
  with:
    node-version: 24
    package-manager-cache: false

- name: Cache npm downloads
  uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: my-ci-cache-bucket
    endpoint: https://<account-id>.r2.cloudflarestorage.com
    access-key: ${{ secrets.S3_ACCESS_KEY }}
    secret-key: ${{ secrets.S3_SECRET_KEY }}
    preset: npm

- run: npm ci
```

Remove the `cache` input and set `package-manager-cache: false`. `actions/setup-node` v5 and later can turn on the npm cache automatically from the `packageManager` field of `package.json` ([README of the action](https://github.com/actions/setup-node#readme)). Without `package-manager-cache: false`, the job can keep a second npm cache in the GitHub Actions cache.

### The other `setup-*` actions

| Action | Built-in cache | How to turn it off | Preset |
| --- | --- | --- | --- |
| `actions/setup-node` | `cache: npm`, `yarn` or `pnpm` | Remove `cache`. Set `package-manager-cache: false`. | `npm`, `yarn`, `pnpm` |
| `actions/setup-python` | `cache: pip`, `poetry` or `pipenv` | Remove `cache`. | `pip`, `poetry` |
| `actions/setup-java` | `cache: maven`, `gradle` or `sbt` | Remove `cache`. | `maven`, `gradle` |
| `actions/setup-go` | On by default | Set `cache: false`. | `go` |

There is no preset for `pipenv` or `sbt`. For these, set `path`, `key` and `restore-keys` on the cache step.

A preset does not use the key of the `setup-*` action, so the first run after the change is a cache miss. A preset also uses the default cache directory of the tool. If your job moves that directory, set `path` (see [A custom cache directory](./presets.md#a-custom-cache-directory)).

## Parity with actions/cache

The action takes the inputs of `actions/cache` v4 to v6: `key`, `path` (with globs, `~` and `!` exclusions), `restore-keys`, `lookup-only`, `fail-on-cache-miss`, `enableCrossOsArchive` and `upload-chunk-size`. It gives the same outputs: `cache-hit`, `cache-primary-key` and `cache-matched-key`. The key matching is the same: the exact key, then a key prefix, then the restore keys. The branch isolation is the same: the current ref, then the pull request base, then the default branch.

This section gives the behaviour that has no input.

**`ACTIONS_CACHE_MODE`.** GitHub sets this environment variable from the `cache-mode` workflow key (generally available since 2026-09-10). The value is `read`, `write`, `write-only` or `none`, at the workflow level or at `jobs.<job_id>.cache-mode`. When the workflow does not set the key, the [GitHub documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching) gives a default of `read` for low-trust triggers, such as `pull_request_target`, `issue_comment` and `workflow_run`, that resolve to the default-branch scope. The `pull_request` event is not affected. `@actions/cache` 6.2.0 (and the 5.2.0 backport) reads the variable, and this action applies the same rules to the S3 tier:

| `ACTIONS_CACHE_MODE`                      | Restore | Save    |
| ----------------------------------------- | ------- | ------- |
| `none`                                    | skipped | skipped |
| `read`                                    | runs    | skipped |
| `write-only`                              | skipped | runs    |
| `write`, not set, or any other value      | runs    | runs    |

The action trims the value and ignores its case. A skip logs one info line that names the variable, and the metrics line and the job summary show the step as `skipped` with the reason. A skip does not fail the step, also with `dual-cache-strict: true`. A skipped restore sets `cache-hit` to `false`. With `fail-on-cache-miss: true`, a skipped restore fails the step, as in `actions/cache`. `read-only: true` skips the save in every mode.

An S3-only job on one of those low-trust triggers can stop saving after you upgrade to this version. To save from such a job again, set `cache-mode: write` on the job. Only do this when the job cannot run untrusted code, because the read default is there to stop cache poisoning.

**Access errors.** For an S3 `403` on a restore or a save, see [Troubleshooting](./troubleshooting.md). That page gives the warning text, the cause and the fix. For jobs that must not write, such as pull requests, see the read-only pattern in the [Security guide](./security.md).

**`save-always`.** The action does not support this deprecated input. See [Saving after failed steps](./getting-started.md#saving-after-failed-steps).

## Manual migration from `tespkg/actions-cache`

If you use `tespkg/actions-cache`, Cloud Cache Action gives these differences:

1. **Active Runner Support**: Runs natively on Node 24 (`node24`) with zero runner deprecation warnings.
2. **Official AWS SDK v3**: Avoids `minio-js` URL signing and header quirks with Cloudflare R2 and Fastly.
3. **Cross-Platform Path Safety**: Normalizes Windows cache keys to POSIX forward slashes (`/`), avoiding broken backslash keys in object storage.
4. **Modern Parity**: Includes `actions/cache@v6` features such as `lookup-only`, `fail-on-cache-miss`, and `read-only`.

### Input differences

- All legacy inputs (`bucket`, `endpoint`, `region`, `insecure`, `accessKey`, `secretKey`, `sessionToken`) remain supported for backward compatibility.
- Kebab-case aliases are also supported (`access-key`, `secret-key`, `session-token`, `force-path-style`).
- **Fallback Behavior**: `use-fallback` is `false` by default in Cloud Cache Action, not `true`. If you want automatic GitHub Actions Cache fallback on S3 errors or cache miss, set `use-fallback: true`.

## Required secrets by provider

Use this table when you set up the repository secrets. The [Storage Providers](../providers/index.md) page compares the providers.

The general examples in these docs use two secret names for every provider: `S3_ACCESS_KEY` and `S3_SECRET_KEY`. Each provider page uses the names in this table for the same two values. Select one pair of names. Then use that pair in the repository secrets and in the workflow. If the two places have different names, the action gets an empty value for the key.

| Provider | Required GitHub Secrets | Endpoint Format / Note |
| :--- | :--- | :--- |
| **Cloudflare R2** | `R2_ACCOUNT_ID`<br>`R2_ACCESS_KEY_ID`<br>`R2_SECRET_ACCESS_KEY` | `https://<account-id>.r2.cloudflarestorage.com`<br>*(Zero egress fees)* |
| **AWS S3 (OIDC)** | *No static keys needed* | Configured via `aws-actions/configure-aws-credentials` and IAM Role |
| **AWS S3 (Static)** | `AWS_ACCESS_KEY_ID`<br>`AWS_SECRET_ACCESS_KEY` | Specify `region` (e.g. `us-east-1`) |
| **Google Cloud Storage** | `GCS_HMAC_ACCESS_ID`<br>`GCS_HMAC_SECRET` | `https://storage.googleapis.com`<br>*(Requires HMAC key for dedicated Service Account)* |
| **Backblaze B2** | `B2_KEY_ID`<br>`B2_APPLICATION_KEY` | `https://s3.<region>.backblazeb2.com` |
| **Fastly Object Storage** | `FASTLY_ACCESS_KEY`<br>`FASTLY_SECRET_KEY` | `https://object.<region>.fastlystorage.com` |
| **Garage** | `GARAGE_ACCESS_KEY`<br>`GARAGE_SECRET_KEY` | `http://garage.internal:3900` |
| **SeaweedFS** | `SEAWEED_ACCESS_KEY`<br>`SEAWEED_SECRET_KEY` | `http://seaweedfs.internal:8333` |
| **MinIO** | `MINIO_ACCESS_KEY`<br>`MINIO_SECRET_KEY` | `http://minio.internal:9000`<br>*(Requires `force-path-style: true`)* |
| **RustFS** | `RUSTFS_ACCESS_KEY`<br>`RUSTFS_SECRET_KEY` | `http://rustfs.internal:9000`<br>*(Set `provider: rustfs`)* |

## Automated migration with AI coding agents

If you use an AI coding assistant or agent (such as Claude Code, Cursor, Copilot, Antigravity, Devin, Codex, or Gemini), copy and paste the prompt below into your agent.

The prompt instructs the agent to discover all cache steps in your repository, recommend or detect your cloud storage provider, perform 1:1 input preservation, and output a concise checklist of required GitHub Secrets.

### Agent prompt to copy

```markdown
Please migrate all GitHub Actions caching steps in this repository to `xSAVIKx/cloud-cache-action@v1`.

### Task Instructions

1. **Scan & Discover Workflows**:
   - Inspect all workflow files in `.github/workflows/` (and any custom composite actions).
   - Find all steps using:
     - `actions/cache@*`
     - `actions/cache/restore@*`
     - `actions/cache/save@*`
     - `tespkg/actions-cache@*`
   - Find all steps that use a built-in cache of a setup action:
     - `actions/setup-node@*` with a `cache` input, or v5 and later with a `packageManager` field in `package.json`
     - `actions/setup-python@*` or `actions/setup-java@*` with a `cache` input
     - `actions/setup-go@*` without `cache: false`

2. **Select Storage Provider & Secrets**:
   - Check if this repository already uses cloud infrastructure secrets, or ask me which provider I prefer:
     - **Cloudflare R2** (Recommended for zero egress fees):
       - Inputs: `bucket`, `endpoint: https://${{ secrets.R2_ACCOUNT_ID }}.r2.cloudflarestorage.com`, `access-key: ${{ secrets.R2_ACCESS_KEY_ID }}`, `secret-key: ${{ secrets.R2_SECRET_ACCESS_KEY }}`
     - **AWS S3 with OIDC** (Recommended for AWS workloads, no static keys):
       - Uses `aws-actions/configure-aws-credentials` with IAM role assumption, then `xSAVIKx/cloud-cache-action@v1` with `bucket` and `key`.
     - **AWS S3 (Static IAM)**:
       - Inputs: `bucket`, `region`, `access-key: ${{ secrets.AWS_ACCESS_KEY_ID }}`, `secret-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}`
     - **Google Cloud Storage (GCS)**:
       - Inputs: `bucket`, `endpoint: https://storage.googleapis.com`, `access-key: ${{ secrets.GCS_HMAC_ACCESS_ID }}`, `secret-key: ${{ secrets.GCS_HMAC_SECRET }}`
     - **Backblaze B2**:
       - Inputs: `bucket`, `endpoint: https://s3.<region>.backblazeb2.com`, `access-key: ${{ secrets.B2_KEY_ID }}`, `secret-key: ${{ secrets.B2_APPLICATION_KEY }}`
     - **Fastly Object Storage**:
       - Inputs: `bucket`, `endpoint: https://object.<region>.fastlystorage.com`, `access-key: ${{ secrets.FASTLY_ACCESS_KEY }}`, `secret-key: ${{ secrets.FASTLY_SECRET_KEY }}`
     - **Self-Hosted (MinIO / Garage / SeaweedFS / RustFS)**:
       - Inputs: `bucket`, `endpoint`, `access-key`, `secret-key` (and `force-path-style: true` for MinIO).
   - If I have not specified a provider yet, prompt me or default to **Cloudflare R2** or **AWS S3**.

3. **Perform 1:1 Step Replacement**:
   - Replace `actions/cache@v...` with `xSAVIKx/cloud-cache-action@v1`.
   - Replace `actions/cache/restore@v...` with `xSAVIKx/cloud-cache-action/restore@v1`.
   - Replace `actions/cache/save@v...` with `xSAVIKx/cloud-cache-action/save@v1`.
   - Preserve all existing cache keys and options: `path`, `key`, `restore-keys`, `lookup-only`, `fail-on-cache-miss`, `enableCrossOsArchive`, `read-only`.
   - Add the required provider inputs (`bucket`, `endpoint`, `access-key`, `secret-key`) referencing GitHub Secrets (`${{ secrets.<SECRET_NAME> }}`).
   - For each built-in cache of a setup action, turn it off (remove `cache`; set `package-manager-cache: false` on `actions/setup-node`; set `cache: false` on `actions/setup-go`). Then add a `xSAVIKx/cloud-cache-action@v1` step with `preset: <tool>` after the setup step and before the install step. The presets are `npm`, `yarn`, `pnpm`, `bun`, `pip`, `poetry`, `uv`, `gradle`, `maven`, `cargo` and `go`. For `pipenv` and `sbt`, set `path`, `key` and `restore-keys`.

4. **Verify & Summarize**:
   - Check that all modified YAML files have valid syntax and proper indentation.
   - List the modified workflow files with a summary of changes.
   - Provide a clear checklist of the exact secret names I need to configure in GitHub Repository Settings (`Settings > Secrets and variables > Actions`).
   - Remind me to add a lifecycle rule to the bucket or to schedule `xSAVIKx/cloud-cache-action/prune@v1`, because the action never deletes a cache.
```

## Branch isolation and trust model

Like actions/cache, restores only use caches from the current ref, the pull request's base branch and the default branch. A feature branch can reuse `main`'s cache, but `main` never restores a cache that a feature branch saved. Set `scoped-to-ref: false` to share caches across every ref.

Unlike GitHub's cache service, the bucket itself does not enforce this: **anyone who holds the bucket's write credentials can write any cache object**, including ones `main` will restore. Archives are extracted with absolute paths allowed, as actions/cache does. So:

- Do not expose cache credentials to workflows that run untrusted code, such as `pull_request_target` jobs that check out fork code.
- Prefer short-lived credentials (OIDC) scoped to the cache bucket or prefix.
- Use a separate bucket or `prefix` for caches that must not be shared between repositories or trust levels.

### Tag-triggered runs and refs

The Git ref segment in the object key comes from whatever triggered the run. A run started by
pushing a tag saves its cache under `refs/tags/<tag>`, which is a ref no pull request or branch
build will ever restore from, since restores only search the current ref, the pull request base
branch and the default branch — never arbitrary tags. If a release workflow triggered by a tag push
is your only place that populates a cache other jobs expect to reuse, that cache will never be
found.

Prefer saving on the default branch instead — a `push` to `main` or a manual `workflow_dispatch`
run there — so the cache is saved under a ref other jobs actually search. If you do need caches
shared across tags, branches and pull requests, set `scoped-to-ref: false` together with the trust
model warning above: every ref then reads and writes the same object, so anyone who can push a
branch or tag can also overwrite what `main` restores.
