# S3 Key Templating & Overrides

Cloud Cache Action gives you complete control over where cache archives are stored in your bucket.

## Default Key Pattern

```text
${GITHUB_REPOSITORY}/${prefix}${ref}/${key}/${version}/${archive_filename}
```

For repository `my-org/my-project`, branch `main` and key `linux-node-18-a1b2c3`, the object is:

```text
my-org/my-project/refs%2Fheads%2Fmain/linux-node-18-a1b2c3/27747e0d22df7792/cache.tar.zst
```

## Available Template Placeholders

### Special Placeholders

| Variable               | Description                                                                                 | Example                           |
| ---------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------- |
| `${GITHUB_REPOSITORY}` | Repository in `owner/repo` format; removed when `scoped-to-repository: false`               | `xSAVIKx/cloud-cache-action`      |
| `${repository}`        | An alias of `${GITHUB_REPOSITORY}`. Use it on CI systems other than GitHub                  | `my-workspace/my-repo`            |
| `${prefix}`            | The `prefix` input with a trailing slash, or empty                                          | `frontend/`                       |
| `${ref}`               | The Git ref, encoded as one path segment; removed when `scoped-to-ref: false`               | `refs%2Fheads%2Fmain`             |
| `${key}`               | The cache key. Must appear exactly once. Inserted as written, so keys may contain `/`       | `linux-node-a1b2c3`               |
| `${version}`           | 16-character hash of `path`, the compression method and (on Windows) `enableCrossOsArchive` | `27747e0d22df7792`                |
| `${archive_filename}`  | Archive name                                                                                 | `cache.tar.zst` or `cache.tar.gz` |

Write special placeholders in braces. A pattern without `${ref}` or `${version}` works, but the action warns:

- Without `${ref}`, every branch shares caches.
- Without `${version}`, a cache saved with different paths or compression can be restored as a hit.
- A bare form of a special placeholder, such as `$ref` instead of `${ref}`, is never expanded — it
  is left in the object key literally, and the action warns `s3-key-pattern uses $ref; write
  ${ref} to use the ref placeholder.` (one warning per placeholder used this way).

### Environment Variables

Reference any environment variable with `${VAR_NAME}`, `$VAR_NAME` or `${env.VAR_NAME}`:

- An unset `${VAR_NAME}` becomes empty.
- An unset `$VAR_NAME` stays as written.
- Values are inserted once and never expanded again.
- The post step of the main action expands the pattern again when it saves. If a step changes a variable the pattern uses through `GITHUB_ENV`, the save writes to a different object than the restore looked up. Keep such variables fixed for the whole job. The compression method does not have this problem: the post step reuses the one the restore step used, even if `zstd` was installed in between.

| Variable             | Description                           | Example Value               |
| --------------------- | -------------------------------------- | ----------------------------- |
| `${RUNNER_OS}`       | Runner operating system               | `Linux`, `Windows`, `macOS` |
| `${GITHUB_JOB}`      | Current job ID in the workflow        | `build-frontend`            |
| `${GITHUB_RUN_ID}`   | Unique ID of the workflow run         | `1234567890`                |
| `${CUSTOM_WORKLOAD}` | Any user-defined environment variable | `api-service`               |

## How Restore Finds a Cache

For each ref in order (the current ref, the pull request base branch, then the default branch), restore tries:

1. The exact `key`.
2. The newest object whose key starts with `key`.
3. For each `restore-keys` entry in order, the newest object whose key starts with it.

Only objects with the same `${version}` and archive format count, and the first match wins.

## Common Configuration Patterns

### 1. Custom Prefix Within Repository

```yaml
- uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: ci-caches
    prefix: web-app
    key: ${{ runner.os }}-node-${{ hashFiles('yarn.lock') }}
    path: node_modules
```

Object key: `my-org/my-repo/web-app/refs%2Fheads%2Fmain/Linux-node-12345/<version>/cache.tar.zst`

### 2. Global Shared Cache (No Repository or Ref Scoping)

```yaml
- uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: shared-org-cache
    scoped-to-repository: false
    scoped-to-ref: false
    key: global-rust-toolchain-v1
    path: ~/.cargo
```

Object key: `global-rust-toolchain-v1/<version>/cache.tar.zst`

### 3. Fully Custom S3 Key Pattern

```yaml
- uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: my-bucket
    s3-key-pattern: 'builds/${GITHUB_REPOSITORY}/${ref}/${prefix}${key}/${version}.tar.zst'
    prefix: release-v1/
    key: app-bundle
    path: dist/
```

Object key: `builds/my-org/my-repo/refs%2Fheads%2Fmain/release-v1/app-bundle/<version>.tar.zst`

### 4. Per-Workload Isolated Cache

```yaml
- uses: xSAVIKx/cloud-cache-action@v1
  env:
    WORKLOAD_TYPE: backend-api
  with:
    bucket: my-bucket
    s3-key-pattern: '${GITHUB_REPOSITORY}/${RUNNER_OS}/${WORKLOAD_TYPE}/${ref}/${key}/${version}/${archive_filename}'
    key: ${{ runner.os }}-deps-${{ hashFiles('go.sum') }}
    path: ~/go/pkg/mod
```

Object key: `my-org/my-repo/Linux/backend-api/refs%2Fheads%2Fmain/Linux-deps-abc123/<version>/cache.tar.zst`

> [!NOTE]
> Object keys always use forward slashes (`/`), whether the runner is Linux, macOS or Windows.

## Custom Patterns and Pruning

If you use [`cloud-cache-action/prune`](./pruning.md) with a custom `s3-key-pattern`, prune only
deletes objects whose whole key matches the pattern. Keep `${GITHUB_REPOSITORY}` and `${ref}` in
path segments of their own, separated from `${key}` and `${version}` by `/`: when they share a
segment, keys from other repositories or refs could match, and the prune action refuses to run
whenever it cannot tell them apart.
Starting the pattern with `${ref}` also leaves no fixed listing prefix for pruning every ref, so
set its `ref` input in that case.
