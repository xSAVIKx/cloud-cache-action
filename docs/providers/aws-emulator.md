---
description: "Test Cloud Cache Action workflows against the AWS Emulator, a local emulator of the AWS APIs. No AWS account, no bucket to pay for, provider aws-emulator."
---

# AWS Emulator

To test the cache steps of a workflow with no AWS account, start the
[AWS Emulator](https://docs.aws.amazon.com/emulator/latest/userguide/) in the job, create a bucket
in it, and set `provider: aws-emulator` on `xSAVIKx/cloud-cache-action@v1`.

The AWS Emulator is a local program from AWS that serves the AWS APIs, Amazon S3 included. It keeps
all data in memory. When the emulator stops, it deletes all buckets and objects. Thus it is a test
target, not a cache store: a cache that one job saves is not there for the next job.

Use it for these tasks:

- Test the cache steps of a workflow before you connect a real bucket.
- Test a fork or a pull request that cannot get the secrets of the real bucket.

## Requirements

- Docker on the runner. GitHub-hosted Ubuntu runners have it.
- A container image of the emulator. AWS publishes only Linux packages, not an image. The
  [`xSAVIKx/aws-emulator`](https://github.com/xSAVIKx/aws-emulator-docker) image packages it for
  `linux/amd64` and `linux/arm64`.
- 2 GiB of memory for the container.

## Workflow example

The [`xSAVIKx/run-aws-emulator`](https://github.com/xSAVIKx/run-aws-emulator) action starts the
emulator and sets the environment for the next steps. It sets `AWS_ENDPOINT_URL`, the credentials
file, the region, and `NODE_EXTRA_CA_CERTS`, so the cache action needs no keys.

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5

      - name: Start the AWS Emulator
        id: emulator
        uses: xSAVIKx/run-aws-emulator@v1

      - name: Create the cache bucket
        run: aws s3 mb s3://ci-cache

      - name: Cache dependencies
        uses: xSAVIKx/cloud-cache-action@v1
        with:
          bucket: ci-cache
          endpoint: ${{ steps.emulator.outputs.endpoint-url }}
          provider: aws-emulator
          key: ${{ runner.os }}-node-${{ hashFiles('**/package-lock.json') }}
          path: ~/.npm
```

Do not set `access-key`, `secret-key`, `AWS_ACCESS_KEY_ID` or `AWS_PROFILE` in this job. The
emulator writes new keys to `AWS_SHARED_CREDENTIALS_FILE` at each start. The action reads them from
that file only when no other credentials are set.

For reproducible runs, pin the action to a commit SHA and the image to a digest. The
[image releases](https://github.com/xSAVIKx/aws-emulator-docker/releases) list the digest of each
build:

```yaml
      - uses: xSAVIKx/run-aws-emulator@<commit-sha> # v1.0.1
        with:
          image: ghcr.io/xsavikx/aws-emulator@sha256:<digest>
```

## Settings

`provider: aws-emulator` selects these settings:

| Setting | Value | Why |
| :--- | :--- | :--- |
| Addressing | Path-style | The endpoint is an IP address. The emulator rejects a bucket name in the host name. |
| Region | `us-east-1` | The emulator accepts any region, but it keeps one set of resources for all regions. |
| Upload part size | At most 16 MiB | The emulator answers `413` to a request body above 16 MiB. A larger `upload-chunk-size` gets a warning, and the action uses 16 MiB. |

The action also selects this preset with no `provider` input when the endpoint port is `9297`, the
default port of the emulator.

## Limits

These limits were measured with AWS Emulator 1.0.322 on 2026-11-12:

- **16 MiB in one request.** The emulator answers HTTP 413 to a `PutObject` or `UploadPart` body
  above 16777216 bytes. The preset keeps each upload part at 16 MiB or less, so larger caches go up
  as multipart uploads.
- **64 MiB in one bucket.** The emulator keeps at most 67108864 bytes of objects in one bucket. The
  parts of an incomplete multipart upload count too. A save that goes past this limit fails with a
  warning, and the job continues. To store more, use a
  bucket for each cache, or delete old caches with the [`prune` sub-action](../guide/pruning.md).
- **HTTPS only.** The emulator makes a new self-signed certificate at each start. Node.js trusts it
  only through `NODE_EXTRA_CA_CERTS`, which `run-aws-emulator` sets. If you start the emulator in a
  different way, set `NODE_EXTRA_CA_CERTS` to its `ca.pem` file before the cache step.
- **Use `127.0.0.1`, not `localhost`.** The certificate names both, but with a host name the AWS SDK
  for JavaScript can put the bucket name in the host name.
- **Memory.** If the container goes over its memory limit, Docker stops it and all objects are lost.

## Feature support

The whole integration suite of this action passes against AWS Emulator 1.0.322, and CI runs it on
each change, next to Garage, SeaweedFS, MinIO and RustFS. Nothing is disabled for this provider:

| Feature | AWS Emulator 1.0.322 |
| :--- | :--- |
| Multipart upload, with `upload-concurrency` and `upload-chunk-size` | Works |
| Ranged `GET` (parallel downloads) | Works |
| User metadata (`x-amz-meta-*`), so the sha256 integrity check runs | Stored and returned |
| Object tags (`tags` input) | Stored and returned |
| Conditional create (`If-None-Match`), for [Safe Concurrent Saves](../guide/storage.md#safe-concurrent-saves) | Enforced |
| `CopyObject` with `REPLACE`, for metadata on `streaming: true` saves | Works |
| `ListObjectsV2`, `DeleteObjects` and `ListMultipartUploads`, used by the `prune` sub-action | Work. `prune` aborts stale incomplete uploads. |

AWS releases a new emulator version many times a day. A new version can change this behavior.

## Local testing

Start the emulator with the image, then run the integration suite against it. The suite reads the
keys from the credentials file of the emulator:

```bash
mkdir -p ~/.aws/emulator
docker run -d --name aws-emulator --memory=2g -p 127.0.0.1:9297:9297 \
  --user "$(id -u):$(id -g)" -e HOME="$HOME" -e EMULATOR_TELEMETRY=off \
  -v "$HOME/.aws/emulator:$HOME/.aws/emulator" \
  ghcr.io/xsavikx/aws-emulator:latest -p 9297

export NODE_EXTRA_CA_CERTS=~/.aws/emulator/9297/ca.pem
export AWS_SHARED_CREDENTIALS_FILE=~/.aws/emulator/9297/emulator_credentials
TEST_S3_ENDPOINT=https://127.0.0.1:9297 TEST_S3_PROVIDER=aws-emulator REQUIRE_S3=1 \
  npm run test:integration
```

With rootless Docker, use `--user 0:0`. With your own user ID, the emulator stops with
`Permission denied (os error 13)`.
