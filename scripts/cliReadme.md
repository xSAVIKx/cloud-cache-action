# cloud-cache

`cloud-cache` restores and saves caches in S3-compatible storage. It uses the same engine as the
cloud-cache-action GitHub Action. Use it in any CI system or on a local machine.

Node.js 24 or later is required. The commands `tar` and `zstd` must be in the PATH.

Commands:

- `cloud-cache restore` restores a cache.
- `cloud-cache save` saves a cache.
- `cloud-cache inspect` shows which cache a restore picks.
- `cloud-cache prune` deletes old caches.

Each flag has the name of an action input. Each flag also has an environment variable,
`CLOUD_CACHE_<INPUT>`. A flag wins over the environment variable.

Read the guide: {{SITE_URL}}guide/cli.html
