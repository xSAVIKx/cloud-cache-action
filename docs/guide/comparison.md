---
title: Comparison
description: "Cloud Cache Action compared with runs-on/cache, tespkg/actions-cache, whywaita/actions-cache-s3 and everpcpc/actions-cache: storage, parity, prune, checks."
---

# Comparison with Other S3 Cache Actions

Cloud Cache Action, runs-on/cache, tespkg/actions-cache, whywaita/actions-cache-s3 and
everpcpc/actions-cache store GitHub Actions caches in an S3 or S3-compatible bucket. Of the five
READMEs, only the Cloud Cache Action README states a prune sub-action, a checksum check on restore
and a CLI for other CI systems.

Information from each project's README, read on 2026-10-29. The runtime comes from the
`action.yml` file of each project, the license from its GitHub repository, and the last release
from its GitHub Releases page, read on the same day. "Not stated" means that these sources do not
give the feature. It does not mean that the project does not have it.

| | Cloud Cache Action | [runs-on/cache](https://github.com/runs-on/cache) | [tespkg/actions-cache](https://github.com/tespkg/actions-cache) | [whywaita/actions-cache-s3](https://github.com/whywaita/actions-cache-s3) | [everpcpc/actions-cache](https://github.com/everpcpc/actions-cache) |
| --- | --- | --- | --- | --- | --- |
| Storage backends | Any S3-compatible bucket. Set-up pages for 9 providers. | An S3 bucket. A custom endpoint for S3-compatible services. The GitHub cache when no bucket is set. | S3-compatible storage, for example MinIO and AWS S3. | AWS S3 and compatible software. | Storage that OpenDAL supports, for example MinIO, AWS S3 and GCS. |
| `actions/cache` inputs | The inputs of v4 to v6, except `save-always` | "All the official options" of v5 | `key`, `path`, `restore-keys` and `lookup-only` | `key`, `path`, `restore-keys`, `upload-chunk-size`, `enableCrossOsArchive`, `fail-on-cache-miss` and `lookup-only` | `key`, `path` and `restore-keys` |
| Restore and save sub-actions | Yes | Yes | Yes | Yes | Not stated |
| Prune old caches | Yes, `prune` sub-action | Not stated. The RunsOn bucket has a 10-day lifecycle rule. | Not stated | Not stated | Not stated |
| Lookup inspection | `lookup-only`, `explain` and the `inspect` sub-action | `lookup-only` | `lookup-only` and a `check` sub-action | `lookup-only` | Not stated |
| Checksum check on restore | Yes, sha256 | Not stated | Not stated | Not stated | Not stated |
| Conditional writes | Yes, `If-None-Match` where the provider enforces it | Not stated | Not stated | Not stated | Not stated |
| Fallback to the GitHub cache | Yes, `use-fallback` and `dual-cache` | Yes, when no bucket is set | Yes, `use-fallback` | Not stated | Yes, `use-fallback` |
| CLI outside GitHub Actions | Yes, the `cloud-cache` CLI | Not stated | Not stated | Not stated | Not stated |
| Runtime | `node24` | `node24` | `node24` | `node16` | `node24` |
| License | MIT | MIT | MIT | MIT | MIT |
| Last release | v1.10.1, 2026-10-29 | v5.0.7, 2026-05-13 | v1.10.2, 2026-06-16 | v3-s3, 2023-10-10 | v3, 2026-04-22 |

## Sources

- Cloud Cache Action: [Migrate from actions/cache](./migration.md#parity-with-actions-cache),
  [Storage Providers](../providers/index.md), [Pruning Caches](./pruning.md),
  [Inspecting Lookups](./inspecting.md), [How Caches Are Stored](./storage.md),
  [Dual Caching](./dual-caching.md), [The cloud-cache CLI](./cli.md) and the
  [Changelog](../changelog.md).
- runs-on/cache: the README, `action.yml` and the GitHub Releases page.
- tespkg/actions-cache: the README, `action.yml` and the GitHub Releases page.
- whywaita/actions-cache-s3: the README, `action.yml` and the GitHub Releases page.
- everpcpc/actions-cache: the README, `action.yml` and the GitHub Releases page.

To move from `tespkg/actions-cache`, see
[Manual Migration from tespkg/actions-cache](./migration.md#manual-migration-from-tespkg-actions-cache).
