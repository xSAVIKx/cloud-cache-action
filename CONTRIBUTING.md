# Contributing

This file tells how to build and test the action, and how a release is made. The source of the
user documentation is in `docs/`. The [README](README.md) links to the published site.

## Development and local testing

```bash
# Install dependencies
npm ci

# Run unit and contract test suites
npm test

# Spin up a local S3 server for integration tests (garage, seaweedfs, minio or rustfs)
docker compose -f docker-compose.test.yml up -d garage

# Build distribution bundles (dist/)
npm run build

# Build documentation site
npm run docs:build
```

Live provider suites (Amazon S3, Cloudflare R2, Google Cloud Storage) run on `main`, nightly and on manual dispatch. To run them on a pull request, add the `full-ci` label; every self-hosted-S3 job still runs on every PR.

Use biome and eslint for formatting and lint (`npm run format:check`, `npm run lint`). Build
`dist/` only from a clean `npm ci` install. The CI job compares `dist/` with a fresh build and
fails when they are different.

## Releasing

Releases are made by [release-please](https://github.com/googleapis/release-please), from [Conventional Commit](https://www.conventionalcommits.org/) messages on `main`. Do not edit [CHANGELOG.md](CHANGELOG.md) or the version in `package.json` by hand.

1. Write each commit message as a Conventional Commit. `feat:` makes a minor release, and `fix:`, `perf:` and `deps:` make a patch release. `feat!:` or a `BREAKING CHANGE:` footer makes a major release. `docs:`, `build:`, `ci:`, `test:`, `refactor:` and `chore:` do not appear in the changelog.
2. After CI passes on `main`, [`.github/workflows/release-please.yml`](.github/workflows/release-please.yml) opens or updates a release PR named `chore: release vX.Y.Z`. The PR sets the version and adds the CHANGELOG entry.
3. GitHub does not run CI on a PR that `GITHUB_TOKEN` opens. To run CI on the release PR, close it and open it again.
4. Merge the release PR. After CI passes on `main` again, release-please tags `vX.Y.Z`, creates the GitHub release, and calls [`.github/workflows/release.yml`](.github/workflows/release.yml).

The release workflow also runs when you publish a GitHub release by hand. It:

- Verifies that `package.json`'s `version` matches the tag (without its `v` prefix), failing the run otherwise.
- Verifies that `dist/` is up to date by rebuilding it and diffing the result, failing the run if it is stale.
- Moves the major version tag (e.g. `v1`) to point at the release, so `uses: xSAVIKx/cloud-cache-action@v1` picks up the new release automatically. It only does this when the release is the highest stable `vX.y.z` tag of its major, so publishing an older patch never moves the tag backwards.

Pre-releases skip moving the major tag, so marking a release as a pre-release lets you publish it without affecting existing `@v1` consumers.

Dependency updates (npm and GitHub Actions) are proposed automatically by [Dependabot](.github/dependabot.yml), grouped into a single minor/patch PR per ecosystem so routine bumps do not create review noise; major version bumps are still proposed individually.
