---
description: "Use self-hosted Garage as an S3-compatible GitHub Actions cache with Cloud Cache Action. Bucket quotas, garage key commands, the workflow step and local tests."
---

# Garage

To use self-hosted Garage as a GitHub Actions cache, create a bucket and an access key with
`garage bucket allow --read --write`. Then set `endpoint`, `provider: garage`, `bucket`,
`access-key` and `secret-key` on `xSAVIKx/cloud-cache-action@v1`.

[Garage](https://garagehq.deuxfleurs.fr/) is an open-source, distributed S3-compatible storage
system. You host it yourself on commodity hardware, bare-metal servers or home labs.

## Requirements

- A Garage node or cluster that the runners can reach on the S3 API port (`3900`).
- A bucket for the cache and a Garage key with read and write access to it.

## Bucket setup

### 1. Cluster layout and replication

- **Single-Node CI Runner Cache**: Set `replication_factor = 1` in `garage.toml` if you run Garage on one build server or runner node. This gives the most storage capacity.
- **Multi-Node Cluster**: Use `replication_factor = 3` across multiple physical nodes or availability zones for high availability.

### 2. Disk space protection and bucket quotas

CI workloads can use hundreds of gigabytes of storage if nothing limits them. Garage has built-in quota controls:

```bash
# Set a hard storage quota on the CI cache bucket (e.g. 50 GB)
garage bucket set --max-size 50G ci-cache

# Set a limit on the total number of cache objects (e.g. 10,000 objects)
garage bucket set --max-objects 10000 ci-cache
```

### 3. Periodic garbage collection

Run garbage collection on your Garage cluster at regular intervals to remove stale blocks and recover disk space:

```bash
# Check block storage status and run GC
garage gc
```

### 4. Network security

- Keep the Garage S3 API port (`3900`) and Admin port (`3902`) on internal networks, private VPCs or encrypted VPN overlays (for example, Tailscale / WireGuard).
- If you expose Garage across networks, put it behind an SSL/TLS reverse proxy (for example, Traefik, Caddy, Nginx).

## Credentials

Use the Garage CLI to manage credentials and to grant least-privilege bucket access.

### 1. Create a dedicated API key

```bash
# Create an access key named 'ci-runner-key'
garage key create ci-runner-key
```

Garage shows the **Key ID** (`GK...`) and the **Secret Key**.

### 2. Create the cache bucket and authorize the key

```bash
# Create the bucket
garage bucket create ci-cache

# Grant read and write permissions to the key
garage bucket allow ci-cache --read --write --key ci-runner-key
```

### 3. Verify key permissions

```bash
# Inspect key details and bound buckets at any time
garage key info ci-runner-key
```

### 4. Configure GitHub secrets

Save the credentials in your repository or organization secrets:

| Secret Name | Source |
| :--- | :--- |
| `GARAGE_ACCESS_KEY` | Output of `garage key info ci-runner-key` (Key ID) |
| `GARAGE_SECRET_KEY` | Output of `garage key info ci-runner-key` (Secret Key) |

## Workflow example

```yaml
- name: Cache dependencies using self-hosted Garage
  uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: ci-cache
    endpoint: http://garage.internal:3900 # Your Garage S3 endpoint
    provider: garage
    access-key: ${{ secrets.GARAGE_ACCESS_KEY }}
    secret-key: ${{ secrets.GARAGE_SECRET_KEY }}
    key: ${{ runner.os }}-build-${{ hashFiles('**/lock') }}
    path: build/
```

## Local testing

You can start Garage locally with the [`docker-compose.test.yml`](https://github.com/xSAVIKx/cloud-cache-action/blob/main/docker-compose.test.yml) file of the repository:

```bash
docker compose -f docker-compose.test.yml up -d garage
```

::: details `docker-compose.test.yml` (Click to view Compose definition)
<<< ../../docker-compose.test.yml{yaml}
:::

The Garage service needs a configuration file mounted at `/etc/garage.toml`. You can use [`tests/fixtures/garage.toml`](https://github.com/xSAVIKx/cloud-cache-action/blob/main/tests/fixtures/garage.toml) from the repository:

::: details `tests/fixtures/garage.toml` (Click to view Garage configuration)
<<< ../../tests/fixtures/garage.toml{toml}
:::

### Initialize Garage locally

After the container starts, initialize the layout and the credentials:

```bash
# 1. Assign layout to the local node
NODE_ID=$(docker exec cloud-cache-garage /garage status | awk '/Node/ {print $2}')
docker exec -ti cloud-cache-garage /garage layout assign -z dc1 -c 10G $NODE_ID
docker exec -ti cloud-cache-garage /garage layout apply --version 1

# 2. Create access key and bucket
docker exec -ti cloud-cache-garage /garage key create ci-cache-key
docker exec -ti cloud-cache-garage /garage bucket create ci-cache
docker exec -ti cloud-cache-garage /garage bucket allow ci-cache --read --write --key ci-cache-key
```

## Notes

- **Checksums**: for this provider, the action sends request checksums only when S3 requires them, because many S3-compatible services reject the CRC checksums recent AWS SDKs send by default. Nothing to configure.
- **Concurrent saves**: Garage does not support conditional writes, so two saves of one key are last-writer-wins. See [Safe Concurrent Saves](../guide/storage.md#safe-concurrent-saves).
- **Object tags**: Garage implements no tagging API. It accepts tags on upload, but you cannot read them back. See [Object Metadata and Tags](../guide/storage.md#object-metadata-and-tags).
- **Expiry**: the action never deletes caches. Add a lifecycle rule that expires objects after 30–60 days so old caches do not accumulate.
