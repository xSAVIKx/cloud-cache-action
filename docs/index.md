---
layout: home

hero:
  name: 'Cloud Cache Action'
  text: 'A drop-in replacement for actions/cache'
  tagline: 'Store your CI caches in your own S3-compatible bucket: AWS S3, Cloudflare R2, GCS, Backblaze B2, Fastly, Garage, SeaweedFS, MinIO or RustFS.'
  image:
    src: /logo.svg
    alt: Cloud Cache Action
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: Storage Providers
      link: /providers/aws-s3

features:
  - title: Same inputs as actions/cache
    details: The inputs, outputs, key matching and branch isolation of actions/cache v4 to v6, on the Node 24 runtime. Change the uses line, add a bucket, and keep your keys.
  - title: Any S3-compatible storage
    details: AWS S3 with static keys or OIDC, Cloudflare R2, Google Cloud Storage, Backblaze B2, Fastly, Garage, SeaweedFS, MinIO and RustFS.
  - title: Fast transfers
    details: Multi-threaded zstd compression, parallel ranged downloads, parallel multipart uploads, and automatic tuning from the archive size.
  - title: Safe caches
    details: A sha256 checksum on every save, verified on restore. Conditional writes stop two concurrent saves of one key from overwriting each other.
  - title: Full cache lifecycle
    details: Package manager presets, separate restore and save actions, scheduled pruning, lookup inspection, metrics, and dual caching with the GitHub Actions cache.
  - title: CLI for other CI systems
    details: The cloud-cache command runs the same cache engine outside GitHub Actions, with the same flags as the action inputs.
---
