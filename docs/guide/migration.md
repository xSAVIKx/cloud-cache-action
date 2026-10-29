# Migration Guide

Migrating from official `actions/cache` or legacy `tespkg/actions-cache` to `cloud-cache-action` takes less than 2 minutes.

---

## Automated Migration with AI Coding Agents

If you use an AI coding assistant or agent (such as Claude Code, Cursor, Copilot, Antigravity, Devin, Codex, or Gemini), copy and paste the prompt below into your agent.

The prompt instructs the agent to discover all cache steps in your repository, recommend or detect your cloud storage provider, perform 1:1 input preservation, and output a concise checklist of required GitHub Secrets.

### Copy-Pastable Agent Prompt

```markdown
Please migrate all GitHub Actions caching steps in this repository to `xSAVIKx/cloud-cache-action@v1`.

### Task Instructions:

1. **Scan & Discover Workflows**:
   - Inspect all workflow files in `.github/workflows/` (and any custom composite actions).
   - Find all steps using:
     - `actions/cache@*`
     - `actions/cache/restore@*`
     - `actions/cache/save@*`
     - `tespkg/actions-cache@*`

2. **Select Storage Provider & Secrets**:
   - Check if this repository already uses cloud infrastructure secrets, or ask me which provider I prefer:
     - **Cloudflare R2** (Recommended for zero egress fees):
       - Inputs: `bucket`, `endpoint: https://${{ secrets.R2_ACCOUNT_ID }}.r2.cloudflarestorage.com`, `access-key: ${{ secrets.R2_ACCESS_KEY_ID }}`, `secret-key: ${{ secrets.R2_SECRET_ACCESS_KEY }}`
     - **AWS S3 with OIDC** (Recommended for AWS workloads, no static keys):
       - Uses `aws-actions/configure-aws-credentials` with IAM role assumption, then `cloud-cache-action` with `bucket` and `key`.
     - **AWS S3 (Static IAM)**:
       - Inputs: `bucket`, `region`, `access-key: ${{ secrets.AWS_ACCESS_KEY_ID }}`, `secret-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}`
     - **Google Cloud Storage (GCS)**:
       - Inputs: `bucket`, `endpoint: https://storage.googleapis.com`, `access-key: ${{ secrets.GCS_HMAC_ACCESS_ID }}`, `secret-key: ${{ secrets.GCS_HMAC_SECRET }}`
     - **Backblaze B2**:
       - Inputs: `bucket`, `endpoint: https://s3.<region>.backblazeb2.com`, `access-key: ${{ secrets.B2_KEY_ID }}`, `secret-key: ${{ secrets.B2_APPLICATION_KEY }}`
     - **Self-Hosted (MinIO / Garage / SeaweedFS / RustFS)**:
       - Inputs: `bucket`, `endpoint`, `access-key`, `secret-key` (and `force-path-style: true` for MinIO).
   - If I have not specified a provider yet, prompt me or default to **Cloudflare R2** or **AWS S3**.

3. **Perform 1:1 Step Replacement**:
   - Replace `actions/cache@v...` with `xSAVIKx/cloud-cache-action@v1`.
   - Replace `actions/cache/restore@v...` with `xSAVIKx/cloud-cache-action/restore@v1`.
   - Replace `actions/cache/save@v...` with `xSAVIKx/cloud-cache-action/save@v1`.
   - Preserve all existing cache keys and options: `path`, `key`, `restore-keys`, `lookup-only`, `fail-on-cache-miss`, `enableCrossOsArchive`, `read-only`.
   - Add the required provider inputs (`bucket`, `endpoint`, `access-key`, `secret-key`) referencing GitHub Secrets (`${{ secrets.<SECRET_NAME> }}`).

4. **Verify & Summarize**:
   - Check that all modified YAML files have valid syntax and proper indentation.
   - List the modified workflow files with a summary of changes.
   - Provide a clear checklist of the exact secret names I need to configure in GitHub Repository Settings (`Settings > Secrets and variables > Actions`).
```

---

## Required Secrets Cheat Sheet by Provider

Share this quick reference with your team or agent when setting up repository secrets:

| Provider | Required GitHub Secrets | Endpoint Format / Note |
| :--- | :--- | :--- |
| **Cloudflare R2** | `R2_ACCOUNT_ID`<br>`R2_ACCESS_KEY_ID`<br>`R2_SECRET_ACCESS_KEY` | `https://<account-id>.r2.cloudflarestorage.com`<br>*(Zero egress fees)* |
| **AWS S3 (OIDC)** | *No static keys needed* | Configured via `aws-actions/configure-aws-credentials` and IAM Role |
| **AWS S3 (Static)** | `AWS_ACCESS_KEY_ID`<br>`AWS_SECRET_ACCESS_KEY` | Specify `region` (e.g. `us-east-1`) |
| **Google Cloud Storage** | `GCS_HMAC_ACCESS_ID`<br>`GCS_HMAC_SECRET` | `https://storage.googleapis.com`<br>*(Requires HMAC key for dedicated Service Account)* |
| **Backblaze B2** | `B2_KEY_ID`<br>`B2_APPLICATION_KEY` | `https://s3.<region>.backblazeb2.com` |
| **Fastly Storage** | `FASTLY_ACCESS_KEY`<br>`FASTLY_SECRET_KEY` | `https://object.<region>.fastlystorage.com` |
| **Garage S3** | `GARAGE_ACCESS_KEY`<br>`GARAGE_SECRET_KEY` | `http://garage.internal:3900` |
| **SeaweedFS S3** | `SEAWEED_ACCESS_KEY`<br>`SEAWEED_SECRET_KEY` | `http://seaweedfs.internal:8333` |
| **MinIO S3** | `MINIO_ACCESS_KEY`<br>`MINIO_SECRET_KEY` | `http://minio.internal:9000`<br>*(Requires `force-path-style: true`)* |
| **RustFS** | `RUSTFS_ACCESS_KEY`<br>`RUSTFS_SECRET_KEY` | `http://rustfs.internal:9000`<br>*(Set `provider: rustfs`)* |

---

## Manual Migration from `actions/cache` (v4, v5, v6)

Because `cloud-cache-action` maintains 1:1 input and output parity, you simply change the `uses:` line and add your bucket configuration:

### Before (`actions/cache`):

```yaml
- name: Cache dependencies
  uses: actions/cache@v4
  with:
    path: node_modules
    key: ${{ runner.os }}-node-${{ hashFiles('**/package-lock.json') }}
    restore-keys: |
      ${{ runner.os }}-node-
```

### After (`cloud-cache-action`):

```yaml
- name: Cache dependencies
  uses: xSAVIKx/cloud-cache-action@v1
  with:
    # 1. Add your S3 bucket & credentials
    bucket: my-ci-cache-bucket
    endpoint: https://${{ secrets.R2_ACCOUNT_ID }}.r2.cloudflarestorage.com # Optional for AWS S3
    access-key: ${{ secrets.S3_ACCESS_KEY }}
    secret-key: ${{ secrets.S3_SECRET_KEY }}

    # 2. Keep all your existing inputs exactly as they are
    path: node_modules
    key: ${{ runner.os }}-node-${{ hashFiles('**/package-lock.json') }}
    restore-keys: |
      ${{ runner.os }}-node-
```

All existing features (`lookup-only`, `fail-on-cache-miss`, `enableCrossOsArchive`, `read-only`) continue to work identically. `save-always` is not supported: use `cloud-cache-action/save` with `if: always()` instead.

See [Parity with actions/cache](#parity-with-actions-cache) for the behaviour that has no input.

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

**Write denied.** When the storage refuses an S3 write call (`PutObject`, `CreateMultipartUpload`, `UploadPart`, `CompleteMultipartUpload` or `CopyObject`) with `AccessDenied` (or a `403` that is not a credential error), the step logs a warning that the credentials may not be allowed to write to the bucket, and that `read-only: true` skips the save. The job does not fail. With `dual-cache-strict: true`, the step fails, as for every other save error. A `403` for wrong credentials, such as `InvalidAccessKeyId`, `SignatureDoesNotMatch` or `ExpiredToken`, gives the usual warning without the hint. A `403` on a read call, such as the `HeadObject` existence check, also gives no hint: it means a wrong secret or a policy without `s3:ListBucket`, not a read-only key.

**Access errors.** For every S3 `403`, the warning names the S3 call, the object, the HTTP status and the policy action that the call needs. A wrong secret, or a policy without `s3:ListBucket`, makes the first `HeadObject` fail with no response body. The warning then reads, for example:

```text
Restoring from s3 failed, so it counts as a cache miss: HeadObject s3://<bucket>/<key> returned HTTP 403 Forbidden. Check access-key, secret-key and region, and check that the bucket policy allows s3:ListBucket on the bucket and s3:GetObject on the cache keys. The Security guide lists the permission for each S3 call.
```

After a tier error, the last restore line is `No cache restored: the s3 tier failed (see the warning above). Keys searched: ...`. The `actions/cache` line `Cache not found for input keys: ...` is only for a true miss. For jobs that must not write, such as pull requests, see the read-only pattern in the [Security guide](./security.md).

**`save-always`.** The action does not support this deprecated input. See [Saving after failed steps](./getting-started.md#saving-after-failed-steps).

---

## Manual Migration from `tespkg/actions-cache`

If you are using legacy `tespkg/actions-cache`, migrating to `cloud-cache-action` solves multiple architectural issues:

1. **Active Runner Support**: Runs natively on Node 24 (`node24`) with zero runner deprecation warnings.
2. **Official AWS SDK v3**: Avoids `minio-js` URL signing and header quirks with Cloudflare R2 and Fastly.
3. **Cross-Platform Path Safety**: Normalizes Windows cache keys to POSIX forward slashes (`/`), avoiding broken backslash keys in object storage.
4. **Modern Parity**: Includes `actions/cache@v6` features such as `lookup-only`, `fail-on-cache-miss`, and `read-only`.

### Input Differences:

- All legacy inputs (`bucket`, `endpoint`, `region`, `insecure`, `accessKey`, `secretKey`, `sessionToken`) remain supported for backward compatibility.
- Kebab-case aliases are also supported (`access-key`, `secret-key`, `session-token`, `force-path-style`).
- **Fallback Behavior**: `use-fallback` is `false` by default in `cloud-cache-action` rather than `true`. If you want automatic GitHub Actions Cache fallback on S3 errors or cache miss, set `use-fallback: true`.

## Branch Isolation and Trust Model

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
