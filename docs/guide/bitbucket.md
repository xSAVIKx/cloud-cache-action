# Bitbucket Pipelines

## What it is

The `cloud-cache` CLI runs in Bitbucket Pipelines. It uses the same cache engine as the GitHub Action. The cache keys and the S3 object keys have the same format.

The CLI finds Bitbucket by the variable `BITBUCKET_BUILD_NUMBER`. It then reads the repository and the refs from the `BITBUCKET_*` variables. For the general CLI rules, read [Command Line (CLI)](./cli.md).

## Requirements

- Node.js 24 or later in the build image.
- GNU `tar` in the `PATH`.
- `zstd` in the `PATH`. Without `zstd`, the engine uses `gzip`. With `--debug`, the log names the fallback. The metrics field `compression` shows the method.
- An S3 bucket. Use a separate bucket, or a separate key prefix, for each CI system.

## Usage pattern

Download the CLI from a GitHub release. Check the checksum. Run `restore` in `script`. Run `save` in `after-script`.

The release asset URL has this form:

```text
https://github.com/xSAVIKx/cloud-cache-action/releases/download/vX.Y.Z/cloud-cache.mjs
```

The file `SHA256SUMS` is in the same directory. Replace `X.Y.Z` with the version that you want.

1. Set the version and the start time.
2. Download `cloud-cache.mjs` and `SHA256SUMS`.
3. Check the checksum.
4. Compute the time of the download in milliseconds.
5. Run `restore` before the build. Pass `CLOUD_CACHE_SETUP_MS` to this command.
6. Run `save` in `after-script`.

```yaml
pipelines:
  default:
    - step:
        name: Build
        image: maven:3.9.16-amazoncorretto-21-al2023
        oidc: true
        script:
          - VERSION=X.Y.Z
          - BASE="https://github.com/xSAVIKx/cloud-cache-action/releases/download/v${VERSION}"
          - START=$(date +%s%3N)
          - curl -fsSLo /tmp/cloud-cache.mjs "${BASE}/cloud-cache.mjs"
          - curl -fsSLo /tmp/SHA256SUMS "${BASE}/SHA256SUMS"
          - (cd /tmp && sha256sum -c --ignore-missing SHA256SUMS)
          - SETUP_MS=$(( $(date +%s%3N) - START ))
          - CLOUD_CACHE_SETUP_MS=$SETUP_MS node /tmp/cloud-cache.mjs restore --key "maven-{hash:**/pom.xml}" --path ~/.m2/repository
          - mvn -B verify
        after-script:
          - node /tmp/cloud-cache.mjs save
```

The image in this example must have Node.js 24. The official `maven` images from Docker Hub do not have Node.js. Use your own image, or install Node.js 24 in the step.

Set `CLOUD_CACHE_BUCKET`, `CLOUD_CACHE_ROLE_ARN` and the other `CLOUD_CACHE_*` settings as repository or deployment variables. Do not use `export` in `script` for these settings, because `after-script` can run in a different shell. Or pass the same flags on the `save` line. See [Inputs](./cli.md#inputs-flags-and-environment-variables).

The CLI records `setupMs` on the `restore` record only. Pass `CLOUD_CACHE_SETUP_MS` to `restore` in `script`.

::: warning Not verified
We did not test three points. The first point is whether a variable that you export in `script` is visible in `after-script`. The second point is whether repository and deployment variables are visible in `after-script`. The third point is whether `BITBUCKET_STEP_OIDC_TOKEN` is available in `after-script`. One community report says that `after-script` starts a different shell. The official Atlassian documentation does not say this.
:::

`save` with no flags uses the key and the paths from the state file of the `restore`. See [The state file](./cli.md#the-state-file).

### Save after a failed step

A failed build must not overwrite a good cache. In `after-script`, Bitbucket sets `BITBUCKET_EXIT_CODE`. If this value is not `0`, `save` logs one line and exits with code 0. It makes no request.

To save after a failure, use `--save-on-failure` or set `CLOUD_CACHE_SAVE_ON_FAILURE=true`.

## Refs and cache scopes

The CLI builds the current ref from these variables. The first rule that matches wins.

| Build type   | Current ref                       | Base ref                                    |
| ------------ | --------------------------------- | ------------------------------------------- |
| Tag          | `refs/tags/<BITBUCKET_TAG>`       | None                                        |
| Pull request | `refs/pull/<BITBUCKET_PR_ID>/merge` | `<BITBUCKET_PR_DESTINATION_BRANCH>`       |
| Branch       | `refs/heads/<BITBUCKET_BRANCH>`   | None                                        |

A pull request build saves under its own ref. It never saves under the destination branch. This is the same rule as in the GitHub Action.

`restore` searches these refs in order: the current ref, the base ref, and the default branch.

Bitbucket has no variable for the default branch. The CLI uses `CLOUD_CACHE_DEFAULT_BRANCH`. If you do not set it, the default branch is `main`. The log names the value in use.

The repository name is `BITBUCKET_REPO_FULL_NAME`, in the form `workspace/repo-slug`. The event name is `pull_request` for a pull request build. Else it is `push`.

### Ref override

On Bitbucket, the CLI ignores `CLOUD_CACHE_REF`, `CLOUD_CACHE_BASE_REF` and `CLOUD_CACHE_REPOSITORY`. If one of them is set, the CLI prints one warning.

To use these variables, set `--allow-ref-override` or `CLOUD_CACHE_ALLOW_REF_OVERRIDE=true`. The CLI then logs each value that it takes from the environment.

`CLOUD_CACHE_DEFAULT_BRANCH` is always read. It changes only the restore search.

::: warning
The CLI cannot enforce who writes to which ref. Only the IAM policy of the role can do this. See [OIDC with AWS](#oidc-with-aws).
:::

You can use the placeholder `${repository}` in `s3-key-pattern`. It is an alias of `${GITHUB_REPOSITORY}`. See [S3 Key Templating](./s3-key-patterns.md).

## OIDC with AWS

With OIDC, no long-lived AWS key is stored in Bitbucket. Bitbucket gives each step a short-lived token. AWS exchanges the token for temporary credentials.

### Set up AWS

1. In IAM, create an OIDC identity provider for your Bitbucket workspace. Use the values that the OpenID Connect page of the repository settings shows. Enter the issuer URL in the field **Provider URL**.
2. Create an IAM role. Set the trusted entity type to **Web identity**. Select the identity provider.
3. Write a trust policy for the role. Limit it to your repository.
4. Give the role access to the bucket (`s3:GetObject`, `s3:PutObject`, `s3:ListBucket`, and `s3:DeleteObject` for `prune`).
5. Set `oidc: true` on the step.
6. Pass the role ARN with `--role-arn` or with the variable `CLOUD_CACHE_ROLE_ARN`. Set the variable as a repository or deployment variable.

When all these conditions are true, the CLI uses OIDC:

- The variable `BITBUCKET_STEP_OIDC_TOKEN` is set.
- A role ARN is set, with `--role-arn`, `CLOUD_CACHE_ROLE_ARN` or `AWS_ROLE_ARN`.
- You give no access key, and `AWS_ACCESS_KEY_ID` and `AWS_WEB_IDENTITY_TOKEN_FILE` are not set.

The CLI writes the token to a file with mode 0600 in a new temporary directory. It sets `AWS_WEB_IDENTITY_TOKEN_FILE`, `AWS_ROLE_ARN` and `AWS_ROLE_SESSION_NAME` (`cloud-cache-<BITBUCKET_BUILD_NUMBER>`). The AWS SDK then reads them. The CLI deletes the file at the end of the command.

The CLI never prints the token, at any log level. Bitbucket has no command to mask a value, so do not print the token in your own script.

If an `AWS_WEB_IDENTITY_TOKEN_FILE` exists, the CLI does not change it. It assumes that you set up OIDC yourself.

```yaml
- step:
    oidc: true
    script:
      - node /tmp/cloud-cache.mjs restore --role-arn arn:aws:iam::123456789012:role/bitbucket-cache --key "deps-{hash:package-lock.json}" --path node_modules
    after-script:
      - node /tmp/cloud-cache.mjs save --role-arn arn:aws:iam::123456789012:role/bitbucket-cache
```

### Claims of the token

The token has these claims: `branchName`, `repositoryUuid`, `workspaceUuid`, `pipelineUuid` and `stepUuid`. The `sub` claim has the form `{repositoryUuid}[:{environmentUuid}]:{stepUuid}`.

::: warning Not verified
An IAM trust policy tests a fixed set of claims. We did not verify that it can test `branchName`. Do not rely on `branchName` in a trust policy until you test it. A trust policy on `sub` and `repositoryUuid` is the safe base.
:::

### Two setups

Setup (a): one role for all steps. It is simple. Use it for a test bucket. Every pull request build can then write to the cache.

Setup (b): one read-only role for all steps, and one write role for the default branch. Bind the write role to a Bitbucket deployment environment. The `sub` claim then holds the environment UUID. The trust policy of the write role tests this `sub`.

::: warning Not verified
Setup (b) is not verified yet. We did not test it in a real Bitbucket workspace. Test it before you use it to protect a cache.
:::

In setup (b), run `restore` with the read-only role in every step. Run `save` only in a step with a `deployment:` value. That step uses the write role.

## Key hashing with `{hash:}`

The action uses `hashFiles()` in the workflow. The CLI has its own form: `{hash:<glob>[,<glob>...]}`. Use it in `--key` and `--restore-keys`.

- The hash is the same as the result of `hashFiles` in GitHub Actions.
- Globs are relative to the clone directory (`BITBUCKET_CLONE_DIR`).
- A glob that starts with `!` excludes files.
- A glob that matches no file gives an empty string. The CLI prints a warning.
- The text `${hash:` is not a template. It stays as it is.

```sh
node /tmp/cloud-cache.mjs restore \
  --key "maven-{hash:**/pom.xml}" \
  --restore-keys maven- \
  --path ~/.m2/repository
```

::: warning
The template ends at the first `}`. A glob that has braces, such as `**/*.{lock,json}`, does not work.
:::

To match two kinds of file, use two globs. Separate them with a comma. For example, use `{hash:**/*.lock,**/*.json}`.

## Output variables

The CLI prints each output as `name=value`. On Bitbucket, it also appends each output to the file `$BITBUCKET_PIPELINES_VARIABLES_PATH`.

The variable name is `CLOUD_CACHE_` and the output name in upper case, with `-` as `_`. For example, the output `cache-hit` gives `CLOUD_CACHE_CACHE_HIT`.

A value with a newline is not written to this file, because the format is one `KEY=VALUE` for each line. The CLI writes a debug line instead.

Use `output-variables:` on the step to give these variables to later steps.

```yaml
- step:
    name: Build
    script:
      - node /tmp/cloud-cache.mjs restore --key "deps-{hash:package-lock.json}" --path node_modules
    output-variables:
      - CLOUD_CACHE_CACHE_HIT
- step:
    name: Report
    script:
      - echo "Cache hit was ${CLOUD_CACHE_CACHE_HIT}"
```

The commands `restore`, `save`, and `inspect` print a plain-text summary at the end. The command `prune` prints no summary. Set `--job-summary=false` to turn it off.

## Metrics

Each command appends one JSON line to a metrics file. On Bitbucket, the default file is `cloud-cache-metrics.jsonl` in the clone directory. Use `--metrics-file` or `CLOUD_CACHE_METRICS_FILE` to change it. For the common fields, read [Metrics and Timings](./getting-started.md#metrics-and-timings).

On Bitbucket, only the `restore` and `save` records have these extra fields. The CLI leaves out a field when it does not know the value.

| Field         | Meaning                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------- |
| `platform`    | The CI platform: `bitbucket`.                                                            |
| `compression` | The archive compression: `zstd` or `gzip`.                                               |
| `region`      | The region that the S3 client uses.                                                      |
| `setupMs`     | `restore` only. The setup time in milliseconds, from `CLOUD_CACHE_SETUP_MS`.            |
| `runner`      | The runner labels: `stepSize`, `cpus` and `memoryLimitBytes`.                            |

`stepSize` comes from `BITBUCKET_STEP_SIZE`. If the variable is not set, the value is `unknown`. `memoryLimitBytes` comes from the cgroup limit. The field is absent when there is no limit.

`CLOUD_CACHE_SETUP_MS` must be a whole number. If it is not, the CLI prints a warning and ignores it.

To make the `setupMs` value, measure the time of the `curl` command in your script. See [Usage pattern](#usage-pattern).

## Build images

Use an image that has Node.js 24. For example, use an image based on `maven:3.9.16-amazoncorretto-21-al2023` that adds Node.js 24 to the `PATH`.

The Amazon Linux 2023 images have GNU `tar` and `gzip`. They do not have `zstd`. Without `zstd`, the engine uses `gzip`. To use `zstd`, add it to the image:

```sh
dnf install -y zstd
```

To save the download time, put `cloud-cache.mjs` in your own build image. Then the step has no `curl`.

### Alpine

On Alpine Linux, install Node.js, GNU `tar` and `zstd`:

```sh
apk add nodejs tar zstd coreutils
```

BusyBox `tar` is not supported. The CLI stops at the start with an error message that names `apk add tar zstd`. Also check that the `nodejs` package is version 24 or later.

## Separate bucket for each CI system

Use a separate bucket for Bitbucket. If you cannot, use a separate `--prefix` for each CI system.

The GitHub Action and the CLI can write to the same bucket. The keys then depend on the repository name. A Bitbucket repository and a GitHub repository can have the same name. They would then share caches. Separate buckets or prefixes prevent this.

## How to compare with Bitbucket caches

To compare cloud-cache with the built-in `caches:` of Bitbucket, use the same step on two branches. One branch uses `caches:`. The other branch uses cloud-cache.

1. Pick an app. Make two branches of it.
2. Use the same step size on both branches. Do not change the image.
3. Run one cold run on each branch. A cold run has an empty cache.
4. Run at least 10 warm runs on each branch.
5. Read the step duration from the Bitbucket API (`/pipelines/{uuid}/steps`).
6. Compare the median, the 90th percentile, the minimum and the maximum.
7. Read the `setupMs` value as a separate number. It is the time of the download.

A group with fewer than 10 warm runs, or with mixed step sizes, is not enough data. Do not draw a conclusion from it.

## Limits

- `--use-fallback` and `--dual-cache` need the GitHub Actions cache service. It is not available in Bitbucket Pipelines. See [Limits of the CLI](./cli.md#limits).
- The npm package is not published yet. Use the release asset.
- The Docker pipe and the binaries that need no Node.js are not available yet.
