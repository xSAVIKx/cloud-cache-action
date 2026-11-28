# Security policy

## Supported versions

The project supports the latest release of the `v1` major line. Fixes go into a new `v1` release.
The project does not backport fixes to older releases. Use `xSAVIKx/cloud-cache-action@v1`, or
pin a full release tag, and upgrade to the latest release.

## Report a vulnerability

Do not open a public issue for a vulnerability. Use GitHub private vulnerability reporting.

1. Open the [Security tab](https://github.com/xSAVIKx/cloud-cache-action/security) of the repository.
2. Select **Report a vulnerability**.
3. Fill in the form and submit it.

Only the maintainer can read the report.

## What to include

- The version of the action or the CLI.
- The storage provider and the runner operating system.
- A description of the problem and its effect.
- The steps to reproduce the problem. A minimal workflow is best.
- Any fix that you suggest.

Remove secrets from logs and workflow files before you attach them.

## What to expect

The maintainer reads each report and answers as soon as possible. The project has one maintainer,
so the answer time can vary. The maintainer tells you if the report is accepted or declined, and
tells you when a fix is released. Please give the maintainer time to release a fix before you
publish the details.

## Scope

These parts are in scope:

- The GitHub Action (`save`, `restore`, `prune` and `inspect` steps).
- The command-line interface (CLI).
- The documentation site.

A vulnerability in a storage provider or in the GitHub Actions platform is out of scope. Report it
to the owner of that product.
