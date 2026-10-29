---
description: "Cache presets for npm, yarn, pnpm, bun, pip, poetry, uv, gradle, maven, cargo and go: one preset input sets path, key and restore-keys for the S3 cache."
---

# Cache Presets

The `preset` input gives the cache `path`, `key` and `restore-keys` for one package manager. It
works like the `cache:` input of `actions/setup-node`. Use one input instead of three:

```yaml
- name: Cache npm downloads
  uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: my-ci-cache-bucket
    access-key: ${{ secrets.S3_ACCESS_KEY }}
    secret-key: ${{ secrets.S3_SECRET_KEY }}
    preset: npm
```

This step does the same as the step below on a Linux runner:

```yaml
- name: Cache npm downloads
  uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: my-ci-cache-bucket
    access-key: ${{ secrets.S3_ACCESS_KEY }}
    secret-key: ${{ secrets.S3_SECRET_KEY }}
    path: ~/.npm
    key: Linux-npm-${{ hashFiles('**/package-lock.json', '**/npm-shrinkwrap.json', '!**/node_modules/**') }}
    restore-keys: |
      Linux-npm-
```

The `preset` input is available on the main action and on the `restore` and `save` sub-actions.
The `prune` and `inspect` sub-actions do not take it.

## What a preset gives

- **`path`**: the download cache of the package manager for the runner OS. A preset never caches
  `node_modules`, a virtual environment or a build output. These hold installed or built files
  that depend on the tool version and the OS.
- **`key`**: `<runner.os>-<preset>-<hash>`. `runner.os` is `Linux`, `macOS` or `Windows`. The
  action reads it from the `RUNNER_OS` environment variable. `<hash>` is the result of the
  `hashFiles` function of `@actions/glob` on the lockfile globs of the preset. This is the same
  function that `hashFiles()` in a workflow uses. The globs are relative to `GITHUB_WORKSPACE`.
- **`restore-keys`**: `<runner.os>-<preset>-`. A changed lockfile then restores the newest older
  cache of the same preset.

The action logs the resolved path and key. When the job summary is on, the summary also names the
preset and the resolved paths.

## Presets

| Preset   | Linux path                                                   | macOS path                                                       | Windows path                                                          | Lockfile globs                                                                                                                                                   |
| -------- | ------------------------------------------------------------ | ---------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm`    | `~/.npm`                                                     | `~/.npm`                                                         | `~\AppData\Local\npm-cache`                                           | `**/package-lock.json`, `**/npm-shrinkwrap.json`                                                                                                                 |
| `yarn`   | `~/.cache/yarn`, `~/.yarn/berry/cache`, `.yarn/cache`        | `~/Library/Caches/Yarn`, `~/.yarn/berry/cache`, `.yarn/cache`    | `~\AppData\Local\Yarn\Cache`, `~\AppData\Local\Yarn\Berry\cache`, `.yarn\cache` | `**/yarn.lock`                                                                                                                                         |
| `pnpm`   | `~/.local/share/pnpm/store`                                  | `~/Library/pnpm/store`                                           | `~\AppData\Local\pnpm\store`                                          | `**/pnpm-lock.yaml`                                                                                                                                              |
| `bun`    | `~/.bun/install/cache`                                       | `~/.bun/install/cache`                                           | `~\.bun\install\cache`                                                | `**/bun.lock`, `**/bun.lockb`                                                                                                                                    |
| `pip`    | `~/.cache/pip`                                               | `~/Library/Caches/pip`                                           | `~\AppData\Local\pip\Cache`                                           | `**/requirements.txt`                                                                                                                                            |
| `poetry` | `~/.cache/pypoetry/cache`, `~/.cache/pypoetry/artifacts` | `~/Library/Caches/pypoetry/cache`, `~/Library/Caches/pypoetry/artifacts` | `~\AppData\Local\pypoetry\Cache\cache`, `~\AppData\Local\pypoetry\Cache\artifacts` | `**/poetry.lock` |
| `uv`     | `~/.cache/uv`                                                | `~/.cache/uv`                                                    | `~\AppData\Local\uv\cache`                                            | `**/*requirements*.txt`, `**/*requirements*.in`, `**/*constraints*.txt`, `**/*constraints*.in`, `**/pyproject.toml`, `**/uv.lock`, `**/*.py.lock`                |
| `gradle` | `~/.gradle/caches`, `~/.gradle/wrapper`                      | `~/.gradle/caches`, `~/.gradle/wrapper`                          | `~\.gradle\caches`, `~\.gradle\wrapper`                               | `**/*.gradle*`, `**/gradle.properties`, `**/gradle-wrapper.properties`, `buildSrc/**/Versions.kt`, `buildSrc/**/Dependencies.kt`, `gradle/*.versions.toml`, `**/versions.properties` |
| `maven`  | `~/.m2/repository`                                           | `~/.m2/repository`                                               | `~\.m2\repository`                                                    | `**/pom.xml`, `**/.mvn/wrapper/maven-wrapper.properties`, `**/.mvn/extensions.xml`                                                                               |
| `cargo`  | `~/.cargo/registry/index`, `~/.cargo/registry/cache`, `~/.cargo/git/db` | the same as Linux                                     | the same as Linux, with `\`                                           | `**/Cargo.lock`                                                                                                                                                  |
| `go`     | `~/go/pkg/mod`, `~/.cache/go-build`                          | `~/go/pkg/mod`, `~/Library/Caches/go-build`                      | `~\go\pkg\mod`, `~\AppData\Local\go-build`                            | `**/go.sum`                                                                                                                                                      |

The `npm`, `yarn`, `pnpm` and `bun` presets also exclude `!**/node_modules/**` from the hash. A
package in `node_modules` can contain its own lockfile. Without the exclusion, the key after an
install is different from the key before the install.

## Sources

Each path is the default that the tool documents, with no environment variable or configuration
that changes it.

- **`npm`**: the npm `cache` configuration: `~/.npm` on Posix, `%LocalAppData%\npm-cache` on
  Windows. The actions/cache `examples.md` gives `~\AppData\npm-cache` for Windows, but npm 7 and
  later use `%LocalAppData%`. The globs follow `actions/setup-node` and the actions/cache
  examples. `actions/setup-node` also hashes `yarn.lock` for npm. This action does not, because
  `yarn` has its own preset.
- **`yarn`**: three directories.
  - The Yarn 1 cache folder per OS, which `yarn cache dir` prints. The Yarn 1 docs do not give
    the path. The source is `getCacheDir` in `src/util/user-dirs.js` of the Yarn 1 repository:
    `~/.cache/yarn` on Linux, `~/Library/Caches/Yarn` on macOS, and
    `%LOCALAPPDATA%\Yarn\Cache` on Windows.
  - The Yarn 2 and later global cache. The yarnrc docs say that `enableGlobalCache` is `true` by
    default and that the cache is then in `globalFolder`. `Configuration.ts` of Yarn 2 and later
    sets the cache to `${globalFolder}/cache`. The docs give `${HOME}/.yarn/berry` for
    `globalFolder`. On Windows, `getDefaultGlobalFolder` in `folderUtils.ts` uses
    `%LOCALAPPDATA%\Yarn\Berry`.
  - The Yarn 2 and later project cache (`cacheFolder`, `./.yarn/cache`).

  The glob follows `actions/setup-node` and the actions/cache examples.
- **`pnpm`**: the pnpm `storeDir` setting, when `PNPM_HOME` and `XDG_DATA_HOME` are not set. The
  glob follows `actions/setup-node`.
- **`bun`**: the Bun install cache documentation and the actions/cache examples. The examples give
  `~\.bun` for Windows. That directory also holds the Bun binary, so this action caches only the
  install cache below it.
- **`pip`**: the actions/cache examples for pip, per OS. The glob follows `actions/setup-python`.
- **`poetry`**: the Poetry `cache-dir` setting gives the directory. The Poetry docs do not name
  its children. Poetry's `src/poetry/config/config.py` puts the repository cache in
  `{cache-dir}/cache/repositories` and the artifact cache in `{cache-dir}/artifacts`. The preset
  caches these two directories. It does not cache `{cache-dir}/virtualenvs`, which holds
  environments for one Python version, because the key does not contain the Python version. A
  `!` line cannot do this: when an include pattern matches a directory, `tar` archives the full
  directory (see [Paths and Exclusions](./getting-started.md#paths-and-exclusions)). The glob
  follows `actions/setup-python`.
- **`uv`**: the uv cache directory: `$HOME/.cache/uv` on Linux and macOS (uv uses the XDG
  directories on both), `%LOCALAPPDATA%\uv\cache` on Windows. The globs are the
  `cache-dependency-glob` default of `astral-sh/setup-uv`.
- **`gradle`**: the actions/cache examples for Gradle. The globs follow `actions/setup-java`.
- **`maven`**: the actions/cache examples for Maven. The globs follow `actions/setup-java`.
- **`cargo`**: the actions/cache examples for Cargo, without `~/.cargo/bin` and `target`.
- **`go`**: the actions/cache examples for Go modules, per OS.

### Why `cargo` does not cache `target`

`target` holds build output, not downloads. It grows with each build, because Cargo does not
remove old artifacts. Its content depends on the compiler version, the profile and the features,
so a restored `target` is often stale and large. `~/.cargo/bin` holds installed binaries, not
downloads. To cache `target` too, set `path` yourself:

```yaml
    preset: cargo
    path: |
      ~/.cargo/registry/index
      ~/.cargo/registry/cache
      ~/.cargo/git/db
      target
```

## A custom cache directory

The action does not run the package manager to find its cache directory. `actions/setup-node`
runs `npm config get cache`, but this action uses the static default above. When you move the
cache, for example with `npm_config_cache`, `PIP_CACHE_DIR`, `GOMODCACHE` or a `.yarnrc.yml`
setting, set `path` to the directory you use. The preset still gives the key and the restore keys.

### GitHub-hosted Windows runners

The runner image can change the default directory of a tool. Two reports are not measured here:

- The Windows image can set the npm cache to another directory, reported as `C:\npm\cache`.
- pnpm can put its store at the root of the workspace drive, for example `D:\.pnpm-store`, when
  the home directory is on a different drive. pnpm does this because hard links do not work
  across drives.

In both cases the preset path does not exist. The save then logs
`Path Validation Error: Path(s) specified in the action for caching do(es) not exist, hence no cache is being saved.`
When you see this message, run `npm config get cache` or `pnpm store path` in the job and set
`path` to the directory that it prints.

## Explicit inputs win

An explicit `path`, `key` or `restore-keys` input replaces the preset value for that one input:

| You set           | `path`              | `key`                    | `restore-keys`                                                |
| ----------------- | ------------------- | ------------------------ | ------------------------------------------------------------- |
| `preset` only     | preset              | preset                   | preset                                                        |
| `preset`, `path`  | yours               | preset                   | preset                                                        |
| `preset`, `key`   | preset              | yours, with no hash added | none                                                         |
| `preset`, `restore-keys` | preset       | preset                   | yours                                                         |

When you set `key`, the action does not add the preset restore keys. A prefix such as `Linux-npm-`
matches only keys that the preset made, so it could restore a cache that your key scheme does not
expect. Set `restore-keys` too if you want a fallback.

The cache version contains the `path` lines. A preset path and the same path that you type give
the same version on the same OS. A different `path` list is a different cache.

## Errors

- With no lockfile that matches the globs, the step fails. The message names the globs:
  `Preset "go" found no lockfile to hash in /home/runner/work/app/app. It looked for: **/go.sum.
  Add a lockfile, or set the key input.`
- An unknown preset fails the step and lists the valid presets.
- With no `preset` and no `key` or `path`, the restore fails with
  `Input required and not supplied: key. Set key and path, or set preset.`

On the save step, the same errors give a warning, and the step does not save.

## The post step

The main action restores in its main step and saves in its post step. The post step does not hash
the lockfiles again. It uses the key and the paths that the restore step resolved. An install
between the two steps can change a lockfile, but the save then still uses the key that the restore
looked up.

The `save` sub-action runs on its own and has no restore state. It hashes the lockfiles at the time
it runs. To save under the key that a `restore` sub-action looked up, pass that key:

```yaml
- uses: xSAVIKx/cloud-cache-action/restore@v1
  id: restore
  with:
    bucket: my-ci-cache-bucket
    preset: pnpm

- run: pnpm install --frozen-lockfile

- uses: xSAVIKx/cloud-cache-action/save@v1
  with:
    bucket: my-ci-cache-bucket
    preset: pnpm
    key: ${{ steps.restore.outputs.cache-primary-key }}
```
