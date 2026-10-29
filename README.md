<p align="center">
  <a href="https://xsavikx.github.io/cloud-cache-action/">
    <img src="https://raw.githubusercontent.com/xSAVIKx/cloud-cache-action/main/docs/public/logo.svg" width="128" height="128" alt="Cloud Cache Action Logo">
  </a>
</p>

<h1 align="center">Cloud Cache Action</h1>

<p align="center">
  <strong>A drop-in replacement for <code>actions/cache</code> that stores your CI caches in any S3-compatible bucket.</strong>
</p>

<p align="center">
  <a href="https://github.com/xSAVIKx/cloud-cache-action/actions/workflows/test.yml"><img src="https://github.com/xSAVIKx/cloud-cache-action/actions/workflows/test.yml/badge.svg" alt="CI Tests"></a>
  <a href="https://xsavikx.github.io/cloud-cache-action/"><img src="https://img.shields.io/badge/docs-GitHub%20Pages-blue.svg" alt="Documentation"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-24-green.svg" alt="Node Runtime"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <a href="https://serhiichuk.dev"><img src="https://img.shields.io/badge/Author-serhiichuk.dev-black" alt="Author"></a>
</p>

<p align="center">
  <a href="https://xsavikx.github.io/cloud-cache-action/guide/getting-started.html">Getting Started</a> •
  <a href="https://xsavikx.github.io/cloud-cache-action/guide/reference.html">Inputs and Outputs</a> •
  <a href="#storage-providers">Providers</a> •
  <a href="https://xsavikx.github.io/cloud-cache-action/guide/migration.html">Migration</a> •
  <a href="CHANGELOG.md">Changelog</a>
</p>

---

## Why use it

- **The same inputs and outputs as `actions/cache` v4 to v6.** Change the `uses:` line, add a bucket and credentials, and keep your `key`, `path` and `restore-keys`.
- **Your bucket, your limits.** There is no 10 GB repository quota, and no cache is removed unless you remove it. With Cloudflare R2, there are no egress fees.
- **Any S3-compatible storage.** AWS S3 (static keys or OIDC), Cloudflare R2, Google Cloud Storage, Backblaze B2, Fastly, and self-hosted Garage, SeaweedFS, MinIO and RustFS.
- **Fast transfers.** Multi-threaded `zstd` compression, parallel ranged downloads and parallel multipart uploads. See [Performance](https://xsavikx.github.io/cloud-cache-action/guide/performance.html).
- **Safe caches.** Each save stores a sha256 checksum, and the restore verifies it. Branch isolation is the same as in `actions/cache`. On providers that support conditional writes, two concurrent saves of one key do not overwrite each other.
- **Tools for the full cache lifecycle.** Package manager presets, scheduled pruning, lookup inspection, metrics, and an optional second tier in the GitHub Actions cache.
- **A CLI for other CI systems.** The `cloud-cache` command runs the same cache engine outside GitHub Actions.

## Quick start

```yaml
- uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: my-ci-cache-bucket
    endpoint: https://<account_id>.r2.cloudflarestorage.com # Omit for AWS S3
    access-key: ${{ secrets.S3_ACCESS_KEY }}
    secret-key: ${{ secrets.S3_SECRET_KEY }}
    path: |
      ~/.npm
      node_modules
    key: ${{ runner.os }}-node-${{ hashFiles('**/package-lock.json') }}
    restore-keys: |
      ${{ runner.os }}-node-
```

The step restores the cache. A post step saves it when the job succeeds, as `actions/cache` does.

To use a preset, set `preset` instead of `path`, `key` and `restore-keys`. The presets are `npm`, `yarn`, `pnpm`, `bun`, `pip`, `poetry`, `uv`, `gradle`, `maven`, `cargo` and `go`:

```yaml
- uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: my-ci-cache-bucket
    access-key: ${{ secrets.S3_ACCESS_KEY }}
    secret-key: ${{ secrets.S3_SECRET_KEY }}
    preset: npm
```

The [Getting Started](https://xsavikx.github.io/cloud-cache-action/guide/getting-started.html) guide tells how a restore and a save work. The [Cache Presets](https://xsavikx.github.io/cloud-cache-action/guide/presets.html) guide lists the paths and the lockfiles of each preset.

### Migrate with an AI coding agent

Paste this prompt into your coding agent, for example Claude Code, Cursor or Copilot:

```text
Migrate all GitHub Actions cache steps in this repository to `xSAVIKx/cloud-cache-action@v1`. Discover all workflow files in `.github/workflows/`, replace `actions/cache@*` (and /restore or /save) preserving all keys, paths, and inputs, detect or ask which storage provider (Cloudflare R2, AWS S3, GCS, MinIO) to configure, and provide a checklist of required GitHub Secrets.
```

The [Migration](https://xsavikx.github.io/cloud-cache-action/guide/migration.html) guide has the full prompt and the secrets that each provider needs.

## Storage providers

| Provider | Setup guide |
| --- | --- |
| AWS S3 | [Static keys or OIDC](https://xsavikx.github.io/cloud-cache-action/providers/aws-s3.html) |
| Cloudflare R2 | [Cloudflare R2](https://xsavikx.github.io/cloud-cache-action/providers/cloudflare-r2.html) |
| Google Cloud Storage | [HMAC keys](https://xsavikx.github.io/cloud-cache-action/providers/google-cloud-storage.html) |
| Backblaze B2 | [Backblaze B2](https://xsavikx.github.io/cloud-cache-action/providers/backblaze-b2.html) |
| Fastly Object Storage | [Fastly](https://xsavikx.github.io/cloud-cache-action/providers/fastly-storage.html) |
| Garage (self-hosted) | [Garage](https://xsavikx.github.io/cloud-cache-action/providers/garage.html) |
| SeaweedFS (self-hosted) | [SeaweedFS](https://xsavikx.github.io/cloud-cache-action/providers/seaweedfs.html) |
| MinIO (self-hosted) | [MinIO](https://xsavikx.github.io/cloud-cache-action/providers/minio.html) |
| RustFS (self-hosted) | [RustFS](https://xsavikx.github.io/cloud-cache-action/providers/rustfs.html) |

The action finds the provider, the region and the addressing style from the `endpoint` URL. To override the result, set `provider`. The [Security](https://xsavikx.github.io/cloud-cache-action/guide/security.html) guide gives a least-privilege policy for each provider.

## Actions

| Action | Use |
| --- | --- |
| `xSAVIKx/cloud-cache-action@v1` | Restores, then saves in the post step. |
| `xSAVIKx/cloud-cache-action/restore@v1` | Restores only. |
| `xSAVIKx/cloud-cache-action/save@v1` | Saves only, for example with `if: always()` after a failed step. |
| `xSAVIKx/cloud-cache-action/prune@v1` | Deletes old caches on a schedule. See [Pruning](https://xsavikx.github.io/cloud-cache-action/guide/pruning.html). |
| `xSAVIKx/cloud-cache-action/inspect@v1` | Tells which cache a restore would use, and why, without a restore. See [Inspecting](https://xsavikx.github.io/cloud-cache-action/guide/inspecting.html). |

[Inputs and Outputs](https://xsavikx.github.io/cloud-cache-action/guide/reference.html) lists every input and every output.

## Documentation

- [Getting Started](https://xsavikx.github.io/cloud-cache-action/guide/getting-started.html): paths, how a restore and a save work, metrics, and the job summary.
- [Dual Caching](https://xsavikx.github.io/cloud-cache-action/guide/dual-caching.html): use the S3 bucket and the GitHub Actions cache together.
- [S3 Key Templating](https://xsavikx.github.io/cloud-cache-action/guide/s3-key-patterns.html): change the object key layout.
- [How Caches Are Stored](https://xsavikx.github.io/cloud-cache-action/guide/storage.html): checksums, concurrent saves, metadata and tags, and streaming.
- [Performance](https://xsavikx.github.io/cloud-cache-action/guide/performance.html) and [Benchmarks](https://xsavikx.github.io/cloud-cache-action/guide/benchmarks.html): transfer settings and measured times.
- [Command Line (CLI)](https://xsavikx.github.io/cloud-cache-action/guide/cli.html): use the cache in other CI systems.
- [Upgrading](https://xsavikx.github.io/cloud-cache-action/guide/upgrading.html): notes for each `v1` release.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) tells how to build and test the action, and how a release is made.

## License

Distributed under the [MIT License](LICENSE). Created and maintained by [Yurii Serhiichuk](https://serhiichuk.dev).
