---
title: Storage Providers
description: "Compare the 9 storage providers of Cloud Cache Action, from AWS S3 and Cloudflare R2 to self-hosted MinIO: credentials, endpoint, conditional writes, tags."
---

# Storage Providers

Cloud Cache Action stores caches in any S3-compatible bucket. These pages give the set-up for nine
providers: five cloud services and four self-hosted servers. The table compares them. Each row
links to the full set-up page.

The action finds the provider, the region and the addressing style from the `endpoint` URL. To
override the result, set the `provider` input.

| Provider | Credentials | Endpoint form | Conditional writes | Object tags | Notes |
| --- | --- | --- | --- | --- | --- |
| [AWS S3](./aws-s3.md) | GitHub OIDC with an IAM role, or static IAM user keys | No `endpoint`. Set `region`. | Enforced (verified) | Not stated | A bucket with Object Lock default retention needs `CLOUD_CACHE_SDK_CHECKSUMS: 'true'`. |
| [Cloudflare R2](./cloudflare-r2.md) | R2 API token, scoped to the bucket | `https://<account-id>.r2.cloudflarestorage.com` | Not stated | Not stated | The action sets `region: auto` from the endpoint. Zero egress fees. |
| [Google Cloud Storage (GCS)](./google-cloud-storage.md) | HMAC key of a dedicated service account | `https://storage.googleapis.com` | Reportedly ignored: last-writer-wins | No tagging API | The action sets path-style addressing. A streamed save attaches its checksum with a copy. |
| [Backblaze B2](./backblaze-b2.md) | Application key, restricted to the bucket | `https://s3.<region>.backblazeb2.com` | Not stated | Not stated | The action reads the region from the endpoint. |
| [Fastly Object Storage](./fastly-storage.md) | Access key pair, scoped to the bucket | `https://object.<region>.fastlystorage.com` | Not stated | Not stated | |
| [Garage](./garage.md) (self-hosted) | Garage key with `--read --write` on the bucket | `http://<host>:3900`, with `provider: garage` | Not supported: last-writer-wins (verified) | Accepted on upload, cannot be read back | Metadata and the sha256 check work. |
| [SeaweedFS](./seaweedfs.md) (self-hosted) | Identity in `s3.json` | `http://<host>:8333`, with `provider: seaweedfs` | Enforced (verified) | Verified | `prune` cannot abort incomplete uploads on SeaweedFS 4.46. |
| [MinIO](./minio.md) (self-hosted) | Service account with a bucket policy | `https://<host>:9000`, with `force-path-style: true` | Enforced (verified) | Verified | `prune` finds no incomplete uploads. Use an ILM rule. |
| [RustFS](./rustfs.md) (self-hosted) | Dedicated user with a bucket policy | `https://<host>:9000`, with `provider: rustfs` | Enforced (verified) | Verified | Without `provider`, the log shows an endpoint on port 9000 as `minio`. |

"Verified" means that the integration suite or a provider page measured the behavior. "Not
stated" means that these docs do not give the behavior for that provider. The sources are
[Safe Concurrent Saves](../guide/storage.md#safe-concurrent-saves),
[Object Metadata and Tags](../guide/storage.md#object-metadata-and-tags) and the provider pages.

## What every provider needs

- A private bucket. The action never creates a bucket.
- Credentials that can read, write and list objects in the bucket. The
  [Security guide](../guide/security.md) gives least-privilege policies for AWS S3, Cloudflare R2,
  Google Cloud Storage, MinIO and RustFS.
- A lifecycle rule or the [`prune` sub-action](../guide/pruning.md). The action never deletes
  caches.

## Conditional writes

A save uses a conditional create (`If-None-Match: *`). On a provider that enforces it, the first
of two concurrent saves of one key wins, and the second save keeps that cache. On a provider that
ignores it, the last save wins.

## Object tags

A streamed save attaches its sha256 checksum as an object tag. On a provider without a tagging
API, the save attaches the checksum with a copy of the object onto itself. See
[How Caches Are Stored](../guide/storage.md).
