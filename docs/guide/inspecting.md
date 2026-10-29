---
description: "Find out why a GitHub Actions cache restore missed: the explain input and the inspect sub-action list each S3 object that the lookup checked, with no download."
---

# Inspecting Lookups

When a cache misses and you expected a hit, find out which objects the restore checked, and why
it used none of them. Cloud Cache Action gives this report in two ways. Both ways print the same
report:

- **`explain: true`** on the restore (or on the main action) logs the report right before the
  restore runs, in the same step.
- **The `inspect` sub-action** runs the lookup on its own, downloads nothing, writes nothing, and
  exposes the answer as step outputs.

Both only **list** objects. Neither downloads an archive, and neither writes to the bucket, so
running them is safe on any branch and in any job.

## `explain` vs `inspect`

| | `explain: true` | `inspect` sub-action |
| --- | --- | --- |
| Where it runs | Inside the restore step, before restoring | As its own step |
| Restores the cache | Yes, the report is only extra logging | No, never |
| Result | Log group + job summary section | Log group + job summary section + outputs |
| Failure mode | Never fails the step; a broken report only logs a warning | Fails the step on a bad input or an S3 error, and on a miss when `fail-on-cache-miss: true` |
| Use it for | Debugging a real workflow in place | Asserting on the lookup, dashboards, matrix guards |

Rule of thumb: reach for `explain` when you want to know why the cache you are already restoring
missed, and for `inspect` when the lookup result itself is the thing you want to act on.

### `explain` on a restore

`explain` is available on the main action and on the `restore` sub-action. It defaults to `false`.

```yaml
- name: Restore cache
  uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: my-ci-cache-bucket
    access-key: ${{ secrets.S3_ACCESS_KEY }}
    secret-key: ${{ secrets.S3_SECRET_KEY }}
    path: ~/.npm
    key: ${{ runner.os }}-node-${{ hashFiles('**/package-lock.json') }}
    restore-keys: |
      ${{ runner.os }}-node-
    explain: true
```

The report is written to a `Cache lookup explained` log group before the restore starts, and, when
`job-summary` is on (the default), to a `Cache lookup explained` job summary section. Building it
is best-effort: if it throws, the step logs
`Could not explain the cache lookup: <reason>` and restores as usual.

`explain: true` pairs well with `lookup-only: true` when you only want the answer and not the
archive. Note that a `lookup-only` restore stops before the download, so the `cache-metadata`
output stays `{}` even on a hit: read the metadata from a full restore, or the object itself, when
you need it.

### The `inspect` sub-action

```yaml
- name: Inspect the cache lookup
  id: lookup
  uses: xSAVIKx/cloud-cache-action/inspect@v1
  with:
    bucket: my-ci-cache-bucket
    access-key: ${{ secrets.S3_ACCESS_KEY }}
    secret-key: ${{ secrets.S3_SECRET_KEY }}
    path: ~/.npm
    key: ${{ runner.os }}-node-${{ hashFiles('**/package-lock.json') }}
    restore-keys: |
      ${{ runner.os }}-node-

- name: Report
  run: |
    echo "would hit: ${{ steps.lookup.outputs.would-hit }}"
    echo "object:    ${{ steps.lookup.outputs.would-match-object }}"
```

`inspect` takes the restore inputs that decide the lookup — `path`, `key`, `restore-keys`,
`enableCrossOsArchive`, `fail-on-cache-miss`, every storage input, `prefix`, `s3-key-pattern`,
`scoped-to-repository`, `scoped-to-ref`, `retry`, `retry-count`, `job-summary` — plus
`use-fallback`, `dual-cache` and `restore-priority`, which decide the report's `Tiers:` line, plus
two of its own:

| Input | Required | Default | Description |
| --- | :---: | :---: | --- |
| `max-candidates` | No | `20` | How many candidate objects the report shows per search; every object under the prefix is still listed, as a restore does, and the rest are counted as "… and N more not shown" |
| `metrics-file` | No | `""` | Append one JSON line of timings and sizes for this step to this file (see [Metrics](#metrics)) |

It deliberately has no `lookup-only` input: it never downloads anything in the first place. And
while `use-fallback`, `dual-cache` and `restore-priority` are reported in the `Tiers:` line, only
the S3 tier is listed and explained — it is the tier whose key layout is worth explaining.

## A sample report

```text
Cache lookup for key "Linux-node-9f2c1a"
Bucket: s3://my-ci-cache-bucket (r2)
Pattern: ${GITHUB_REPOSITORY}/${prefix}${ref}/${key}/${version}/${archive_filename} → octo/app/${ref}/${key}/${version}/${archive_filename}
Version: 4d0f1b2c9a7e35f1 (paths: ~/.npm; compression: zstd; cross-OS: false)
Refs searched: refs/heads/feat → refs/heads/main
Tiers: s3
Restore keys: Linux-node-
[refs/heads/feat] prefix "octo/app/refs%2Fheads%2Ffeat/Linux-node-9f2c1a": 0 candidates
[refs/heads/feat] prefix "octo/app/refs%2Fheads%2Ffeat/Linux-node-": 2 candidates
  ✗ octo/app/refs%2Fheads%2Ffeat/Linux-node-11ab/8c31d0e5b2447aa0/cache.tar.zst (version 8c31d0e5b2447aa0, 184.22 MB, 2026-09-16T08:11:02.000Z)
  ✗ octo/app/refs%2Fheads%2Ffeat/Linux-node-22cd/8c31d0e5b2447aa0/cache.tar.zst (version 8c31d0e5b2447aa0, 181.07 MB, 2026-09-15T21:40:55.000Z)
[refs/heads/main] prefix "octo/app/refs%2Fheads%2Fmain/Linux-node-9f2c1a": 0 candidates
[refs/heads/main] prefix "octo/app/refs%2Fheads%2Fmain/Linux-node-": 1 candidate
  ✓ octo/app/refs%2Fheads%2Fmain/Linux-node-77ef/4d0f1b2c9a7e35f1/cache.tar.zst (version 4d0f1b2c9a7e35f1, 190.55 MB, 2026-09-17T06:02:19.000Z)
Result: No objects match key prefix "Linux-node-9f2c1a" on refs/heads/feat, refs/heads/main.
Result: 2 objects match key prefix "Linux-node-" on refs/heads/feat but none has version 4d0f1b2c9a7e35f1 (this job hashes paths ~/.npm with zstd; they were saved with different paths, compression or cross-OS setting).
Result: Would restore octo/app/refs%2Fheads%2Fmain/Linux-node-77ef/4d0f1b2c9a7e35f1/cache.tar.zst (key "Linux-node-77ef", refs/heads/main).
```

Reading it top to bottom:

- **Bucket** is the bucket the lookup ran against and the resolved storage provider.
- **Pattern** shows the raw `s3-key-pattern` and the same pattern with the repository and `prefix`
  already substituted; `${ref}`, `${key}`, `${version}` and `${archive_filename}` stay symbolic
  because they vary per search.
- **Version** is the `${version}` hash **this** job computes, followed by the three things it
  hashes.
- **Refs searched** is the restore order: the current ref, then the pull request base branch, then
  the default branch. With `scoped-to-ref: false` the line reads `Not scoped to a ref` and the
  searches are labelled `[unscoped]`.
- **Tiers** is the tier order a restore would use — `s3`, or `s3 → github` / `github → s3` when
  `use-fallback` or `dual-cache` adds the GitHub tier. Only the S3 tier is listed and explained.
- **Each `[ref] prefix "…"` line** is one listing the restore would perform: the primary key first,
  then each restore key, for each ref, stopping at the first search that would hit.
- **`✓` / `✗`** on a candidate says whether the object's `${version}` matches this job's.
- **`Result:`** lines are the plain-language summary, in report order.

### "… but none has version …"

This is the most common miss, and it never means the key was wrong — the key prefix matched, the
objects are right there. It means those objects were saved by a job whose **`${version}` hash
differs**, and the hash covers exactly three things:

1. **`path`** — the list of paths, as written. Adding, removing or reordering a path changes the
   hash, so a job caching `~/.npm` never restores an archive saved for `~/.npm` plus `node_modules`.
2. **The compression method** — `zstd` or `gzip`. A runner without `zstd` saves a `gzip` archive
   and will not restore a `zstd` one, and vice versa.
3. **`enableCrossOsArchive`** (on Windows) — a cross-OS archive and a Windows-native one hash
   differently on purpose.

Compare the `Version:` line's inputs with how the other job is configured; the difference is
always one of those three.

### A caveat on freshness

The report lists objects; it never issues a `HEAD` for the exact key. On a provider whose listings
are eventually consistent, an object saved moments ago may not be listed yet, so a report taken
right after a save can say "would miss" where a real restore — which does `HEAD` the exact key
first — would hit. Give the listing a moment, or inspect in a later job.

## Outputs

| Output | Description |
| --- | --- |
| `would-hit` | `'true'` when a restore with these inputs would find a cache, `'false'` otherwise |
| `would-match-key` | The cache key a restore would match; empty when none |
| `would-match-object` | The S3 object key a restore would download; empty when none |
| `candidate-count` | How many objects were listed across every search |
| `report` | The full report as JSON |
| `cache-storage-provider` | The resolved S3-compatible storage provider |

The outputs are set once the lookup finishes. A step that fails earlier — a missing `key` or
`path`, an invalid `max-candidates`, an S3 error — sets none of them, so guard on
`steps.<id>.outcome` before reading them in a later step (`prune` behaves the same way). A
`fail-on-cache-miss` failure is the exception: the lookup did finish, so the outputs are set and
`would-hit` is `'false'`.

`report` is `ExplainReport` serialized as JSON: the pattern, the version and its inputs, the refs,
the keys, the tiers, every search with its candidates, the `wouldHit` object when there is one, and
the `reasons` sentences. GitHub truncates step outputs, so beyond 64 KB the action substitutes a
small summary — `{"truncated":true,"wouldHit":<bool>,"candidateCount":<n>}` — instead. Check
`truncated` before parsing the rest:

```yaml
- name: Count candidates
  run: |
    echo '${{ steps.lookup.outputs.report }}' | jq 'if .truncated then .candidateCount else (.searches | map(.candidates | length) | add) end'
```

## Guarding a matrix job

`fail-on-cache-miss: true` makes `inspect` fail when nothing would be restored, which turns "is
this cache warm?" into an ordinary job result. That is useful when an expensive matrix should not
start until a warm-up job has populated the cache:

```yaml
jobs:
  cache-ready:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: xSAVIKx/cloud-cache-action/inspect@v1
        with:
          bucket: my-ci-cache-bucket
          access-key: ${{ secrets.S3_ACCESS_KEY }}
          secret-key: ${{ secrets.S3_SECRET_KEY }}
          path: ~/.npm
          key: ${{ runner.os }}-node-${{ hashFiles('**/package-lock.json') }}
          fail-on-cache-miss: true

  build:
    needs: cache-ready
    strategy:
      matrix:
        shard: [1, 2, 3, 4]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      # … every shard now restores a cache that is known to exist
```

To report instead of fail, leave `fail-on-cache-miss` at `false` and branch on `would-hit`:

```yaml
      - uses: xSAVIKx/cloud-cache-action/inspect@v1
        id: lookup
        with: { bucket: my-ci-cache-bucket, path: ~/.npm, key: ${{ runner.os }}-node-${{ hashFiles('**/package-lock.json') }} }

      - name: Warm the cache
        if: steps.lookup.outputs.would-hit != 'true'
        run: npm ci
```

Note that the version hash is computed on the runner that inspects, so a lookup that would hit on
`ubuntu-latest` says nothing about `windows-latest`: give each OS in the matrix its own guard job,
or its own `inspect` step.

## Metrics

Every step — restore, save, prune and `inspect` — writes one `cloud-cache-metrics <json>` debug
line, and appends the same JSON as one line to `metrics-file` when that input is set. See
[Metrics and timings](./getting-started.md#metrics-and-timings) for the line's shape; `inspect` reports
`"step":"inspect"` with an outcome of `would-hit` or `would-miss` and a `candidateCount` in
`extra`. As with `prune`, a step that fails before finishing the lookup writes no line at all.
