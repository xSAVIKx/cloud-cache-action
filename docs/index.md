---
layout: home
title: 'Cloud Cache Action: actions/cache for S3, R2, GCS and MinIO'
titleTemplate: false
description: 'Cloud Cache Action is a drop-in replacement for actions/cache that stores GitHub Actions caches in your own S3-compatible bucket: AWS S3, Cloudflare R2, GCS, MinIO.'

hero:
  name: 'Cloud Cache Action'
  text: 'A drop-in replacement for actions/cache'
  tagline: 'Store your CI caches in your own S3-compatible bucket: AWS S3, Cloudflare R2, GCS, Backblaze B2, Fastly, Garage, SeaweedFS, MinIO or RustFS.'
  image:
    src: /logo.svg
    # The h1 next to the image has the name, so the image is decorative.
    alt: ''
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: Storage Providers
      link: /providers/

features:
  - title: Same inputs as actions/cache
    details: The inputs, outputs, key matching and branch isolation of actions/cache v4 to v6, on the Node 24 runtime. Change the uses line, add a bucket, and keep your keys.
    link: /guide/migration
    linkText: Migrate from actions/cache
  - title: Any S3-compatible storage
    details: AWS S3 with static keys or OIDC, Cloudflare R2, Google Cloud Storage, Backblaze B2, Fastly, Garage, SeaweedFS, MinIO and RustFS.
    link: /providers/
    linkText: Compare the providers
  - title: Fast transfers
    details: Multi-threaded zstd compression, parallel ranged downloads, parallel multipart uploads, and automatic tuning from the archive size.
    link: /guide/performance
    linkText: Performance guide
  - title: Safe caches
    details: A sha256 checksum on every save, verified on restore. Conditional writes stop two concurrent saves of one key from overwriting each other.
    link: /guide/storage
    linkText: How caches are stored
  - title: Full cache lifecycle
    details: Package manager presets, separate restore and save actions, scheduled pruning, lookup inspection, metrics, and dual caching with the GitHub Actions cache.
    link: /guide/presets
    linkText: Cache presets
  - title: CLI for other CI systems
    details: The cloud-cache command runs the same cache engine outside GitHub Actions, with the same flags as the action inputs.
    link: /guide/cli
    linkText: The cloud-cache CLI
---

## What is Cloud Cache Action?

Cloud Cache Action (`xSAVIKx/cloud-cache-action`) is a GitHub Action that restores and saves CI caches in your own S3-compatible bucket, with the same inputs and outputs as `actions/cache` v4 to v6. Its command line interface, `cloud-cache`, runs the same cache engine in Bitbucket Pipelines and other CI systems.

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

The step restores the cache. A post step saves it when the job succeeds, as `actions/cache` does. The [Getting Started](./guide/getting-started.md) guide tells how a restore and a save work.

**Works with:** [AWS S3](./providers/aws-s3.md), [Cloudflare R2](./providers/cloudflare-r2.md), [Google Cloud Storage](./providers/google-cloud-storage.md), [Backblaze B2](./providers/backblaze-b2.md), [Fastly Object Storage](./providers/fastly-storage.md), [Garage](./providers/garage.md), [SeaweedFS](./providers/seaweedfs.md), [MinIO](./providers/minio.md), [RustFS](./providers/rustfs.md), and [Bitbucket Pipelines](./guide/bitbucket.md) through the CLI.
