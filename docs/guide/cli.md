# The cloud-cache CLI

## What it is

`cloud-cache` is a command line tool. It runs the same cache engine as the GitHub Action. Use it in any CI system or on a local machine.

The CLI has four commands. They match the action and its sub-actions: `restore`, `save`, `inspect` and `prune`. The flags have the names of the action inputs. The cache keys and the S3 object keys are the same as the keys of the action.

## Requirements

- Node.js 24 or later.
- `tar` in the `PATH`.
- `zstd` in the `PATH`. If `zstd` is not available, the engine uses `gzip`.

BusyBox `tar` is not supported. The CLI stops with this message:

```text
BusyBox tar is not supported. Install GNU tar and zstd, for example: apk add tar zstd
```

On Alpine Linux, run `apk add tar zstd`.

## Install

Download the CLI from a GitHub release. The first release that includes the CLI, and each later release, has two files: `cloud-cache.mjs` and `SHA256SUMS`.

1. Set the version.
2. Download both files.
3. Check the checksum.
4. Run the file with Node.js.

```sh
VERSION=<version>
BASE="https://github.com/xSAVIKx/cloud-cache-action/releases/download/v${VERSION}"
curl -fsSLO "${BASE}/cloud-cache.mjs"
curl -fsSLO "${BASE}/SHA256SUMS"
sha256sum -c SHA256SUMS
node cloud-cache.mjs --version
```

Replace `<version>` with the version that you want. Use the version of a release that has the `cloud-cache.mjs` asset. The command `sha256sum -c` prints `cloud-cache.mjs: OK` when the file is correct. On macOS, use `shasum -a 256 -c SHA256SUMS`.

## Commands

```text
cloud-cache <command> [flags]
```

| Command   | What it does                                                | Matching action                          |
| --------- | ----------------------------------------------------------- | ---------------------------------------- |
| `restore` | Restores a cache. It saves its state for a later `save`.    | `xSAVIKx/cloud-cache-action/restore`     |
| `save`    | Saves a cache. After a `restore`, it reads the state of that restore. | `xSAVIKx/cloud-cache-action/save` |
| `inspect` | Shows which cache a restore would pick. It downloads nothing. | `xSAVIKx/cloud-cache-action/inspect`   |
| `prune`   | Deletes old caches.                                         | `xSAVIKx/cloud-cache-action/prune`       |

Run `cloud-cache --help` to see all flags of all commands, with their defaults.

## Inputs: flags and environment variables

Each flag has the name of an action input. For example, `--key`, `--path`, `--restore-keys` and `--bucket`.

Each input also has an environment variable. The name is `CLOUD_CACHE_` and the input name in upper case, with `-` as `_`. For example, `--restore-keys` reads `CLOUD_CACHE_RESTORE_KEYS`.

The CLI reads each input in this order:

1. The flag.
2. The environment variable.
3. The default value.

The default values are the same as the `default:` values in the action manifest of the command. For the meaning of each input, read the [README](https://github.com/xSAVIKx/cloud-cache-action#inputs).

Follow these rules for flag values:

- A boolean flag takes `true` or `false`. For example, `--lookup-only=true`. A flag without a value means `true`.
- Some inputs take one value for each line: `path`, `restore-keys`, `metadata` and `tags`. Repeat the flag for each line. The CLI joins the values with a newline.
- Put secrets in environment variables, not in flags. A flag is visible in the process list.

```sh
export CLOUD_CACHE_BUCKET=my-cache-bucket
export CLOUD_CACHE_ACCESS_KEY=...
export CLOUD_CACHE_SECRET_KEY=...

cloud-cache restore \
  --key "deps-$(sha256sum package-lock.json | cut -d' ' -f1)" \
  --restore-keys deps- \
  --path node_modules \
  --path ~/.npm
```

### Flags of the CLI itself

| Flag                   | Environment variable        | Meaning                                                          |
| ---------------------- | --------------------------- | ---------------------------------------------------------------- |
| `--state-file <path>`  | `CLOUD_CACHE_STATE_FILE`    | The state file. Default: `<tmpdir>/cloud-cache-state.json`.      |
| `--outputs-file <path>` | `CLOUD_CACHE_OUTPUTS_FILE` | The outputs file. Without it, the CLI only prints the outputs.   |
| `--debug`              | `CLOUD_CACHE_DEBUG`         | Prints debug messages. The variable accepts `true` or `1`.       |
| `--help`               |                             | Prints the help text.                                            |
| `--version`            |                             | Prints the version.                                              |

## Context variables

A CI system sets the repository and the refs. The CLI cannot find them, so you set them with these environment variables.

| Variable                       | Meaning                                                                   | Default                       |
| ------------------------------ | ------------------------------------------------------------------------- | ----------------------------- |
| `CLOUD_CACHE_REPOSITORY`       | The repository name. It replaces `${GITHUB_REPOSITORY}` in the key pattern. | Empty                       |
| `CLOUD_CACHE_REF`              | The ref of this run. A branch name or a full ref.                         | None                          |
| `CLOUD_CACHE_BASE_REF`         | The base branch of a pull request.                                        | None                          |
| `CLOUD_CACHE_DEFAULT_BRANCH`   | The default branch of the repository.                                     | None                          |
| `CLOUD_CACHE_WORKSPACE`        | The directory that relative paths use.                                    | The current directory         |
| `CLOUD_CACHE_EVENT_NAME`       | The name of the event that started the run.                               | `cli`                         |

These variables are not input values. An input with the same environment name reads only its flag. For example, the `prune` input `ref` reads only `--ref`, not `CLOUD_CACHE_REF`.

If `CLOUD_CACHE_REPOSITORY` is empty, the cache keys have no repository part. All repositories that use the same bucket and prefix then share their caches. The CLI prints a warning when the variable is empty. Set the variable in every job, or set `--scoped-to-repository=false` if you want to share the caches.

### How refs scope the keys

The key pattern contains `${ref}`. By default, a cache belongs to one ref. This is the same rule as in the action. See [S3 Key Templating](./s3-key-patterns.md).

- A bare branch name such as `main` and a full ref such as `refs/heads/main` give the same key.
- `save` writes under `CLOUD_CACHE_REF`.
- `restore` searches these refs in order: `CLOUD_CACHE_REF`, then `CLOUD_CACHE_BASE_REF`, then `CLOUD_CACHE_DEFAULT_BRANCH`.
- If you do not set `CLOUD_CACHE_REF`, the keys are not scoped to a ref. `save` and `restore` then use the same keys for all refs, and the CLI does not use `CLOUD_CACHE_BASE_REF` or `CLOUD_CACHE_DEFAULT_BRANCH`.

Set `CLOUD_CACHE_REF` in every job that uses a scoped cache.

## The state file

`restore` writes a JSON file. `save` reads it. This is how `save` knows which key a `restore` matched. After an exact hit, `save` skips the upload.

- The default path is `cloud-cache-state.json` in the temporary directory of the OS.
- Use the same `--state-file` for `restore` and `save` if the two commands run with different `TMPDIR` values.
- Each `restore` starts with an empty state file. It removes the state of the previous restore.
- After a `restore`, `save` takes the key and the paths from the state file, not from its flags. If `--key` or `--path` differ from the state, `save` prints a warning that names both values. The state from restore wins.
- Use one state file for each cache, and for each job that runs at the same time on one machine.
- If the file does not exist, `save` works as if no restore ran.
- If the file is not valid JSON, the CLI prints a warning and ignores it.

## The outputs file

The action sets step outputs. The CLI prints each output to the standard output as `name=value`. For example, `cache-hit=true`.

With `--outputs-file`, the CLI also appends each output to that file. The directory of the file must exist. If the CLI cannot write the file, the command fails with this error: `Cannot write the outputs file <path>: <reason>`.

A line has the form `name=value`.

```text
cache-hit=true
cache-matched-key=deps-abc123
```

A value with a newline uses the `name<<delimiter` form. The delimiter is `CLOUD_CACHE_EOF_` and 16 random hex characters.

```text
cache-metadata<<CLOUD_CACHE_EOF_0123456789abcdef
first line
second line
CLOUD_CACHE_EOF_0123456789abcdef
```

This is the same format as the `GITHUB_OUTPUT` file of GitHub Actions.

## Exit codes

| Code | Meaning                                                                          |
| ---- | -------------------------------------------------------------------------------- |
| 0    | Success. A cache miss is also success.                                           |
| 1    | A failure. For example, a required input is missing, `--fail-on-cache-miss=true` with a miss, or a failure with `--dual-cache-strict=true`. |
| 2    | A usage error. For example, an unknown command or flag.                          |

The CLI fails in the same cases in which the action fails the step. A storage error during restore or save is a warning. The exit code is 0.

## Example: a generic CI job

This example uses shell commands. It fits any CI system. Restore the cache before the build. Save the cache after the build.

1. Set the context variables and the credentials.
2. Run `cloud-cache restore` before the build.
3. Run the build.
4. Run `cloud-cache save` after the build.

```sh
export CLOUD_CACHE_REPOSITORY="my-org/my-project"
export CLOUD_CACHE_REF="$CI_BRANCH"
export CLOUD_CACHE_DEFAULT_BRANCH="main"
export CLOUD_CACHE_BUCKET="my-cache-bucket"
export CLOUD_CACHE_ENDPOINT="https://s3.example.com"
# CLOUD_CACHE_ACCESS_KEY and CLOUD_CACHE_SECRET_KEY come from the secret store of the CI system.

KEY="deps-$(sha256sum package-lock.json | cut -d' ' -f1)"

cloud-cache restore --key "$KEY" --restore-keys deps- --path node_modules --outputs-file outputs.env

npm ci
npm test

cloud-cache save --key "$KEY" --path node_modules
```

`save` takes the key and the paths from the state file of the `restore` before it. `save` skips the upload when `restore` found an exact hit. Use one state file for each cache, and for each job that runs at the same time on one machine.

To save the cache when the build fails, run `cloud-cache save` in a step that always runs. The syntax depends on the CI system.

## Limits

- `--use-fallback` and `--dual-cache` need the GitHub Actions cache service. This service is not available outside GitHub Actions. Do not use these flags with the CLI.
  - With `--use-fallback`, a `restore` that misses in S3 asks the GitHub service. It waits about 10 seconds, prints a warning, and reports a miss.
  - With `--dual-cache`, a `restore` also asks the GitHub service, with the same delay and warning. The S3 result is used.
  - With `--dual-cache`, a `save` writes to S3 and prints a warning for the GitHub cache. With `--dual-cache-strict=true`, that `save` fails with exit code 1.
- `--job-summary` has no effect. The CLI does not write a job summary.
- The CLI reads the repository and the refs from the `CLOUD_CACHE_*` context variables.
