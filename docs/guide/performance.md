---
title: Performance
---

# Performance

The `download-concurrency`, `download-chunk-size`, `upload-concurrency` and `upload-chunk-size`
inputs decide how many connections a transfer uses and how much each request carries. The
`compression-level` input decides how hard `zstd` or `gzip` work on a save. This page measures
both sets of inputs on real data, so you can pick values for your provider and your cache instead
of guessing. See [Parallel Transfers](https://github.com/xSAVIKx/cloud-cache-action#parallel-transfers)
in the README for how the transfer inputs work.

## How the numbers were measured

The [Transfer benchmark](https://github.com/xSAVIKx/cloud-cache-action/actions/workflows/benchmark.yml)
workflow (`tests/ci/benchmark.ts`) saves a 512 MiB archive of random bytes, which does not
compress, with several upload settings, then restores it with several download settings, and
verifies every restored file. Each configuration ran twice and the tables show the median.

- Runner: `ubuntu-latest` (4 vCPU), Node 24.20.0, run
  [35654848985](https://github.com/xSAVIKx/cloud-cache-action/actions/runs/35654848985) on
  2026-09-21.
- **Transfer** is the S3 transfer alone (`cache-transfer-duration-ms`). In streaming mode the
  archive is extracted or compressed as it moves, so the same figure covers download plus extract
  or tar plus upload.
- **Whole step** is the full step (`cache-restore-duration-ms` or `cache-save-duration-ms`),
  including tar, compression, the sha256 check and, on streaming saves, the metadata copy.
- Absolute numbers depend on the bucket region, the runner's location and the time of day. Your
  numbers will differ, but the ratios between rows are what to look at.

## Restore

| Configuration | Cloudflare R2 | Amazon S3 | Google Cloud Storage |
| --- | ---: | ---: | ---: |
| `download-concurrency: 1` (single request) | 13.6 s, 38 MiB/s | 10.7 s, 48 MiB/s | 4.1 s, 124 MiB/s |
| `actions/cache` values: 8 × 4 MiB | 4.6 s, 111 MiB/s | 2.5 s, 203 MiB/s | 3.7 s, 138 MiB/s |
| **Default: 8 × 8 MiB** | 3.7 s, 140 MiB/s | 1.9 s, 268 MiB/s | 2.4 s, 213 MiB/s |
| 8 × 16 MiB | 3.2 s, 159 MiB/s | 1.8 s, 287 MiB/s | 1.9 s, 264 MiB/s |
| 16 × 8 MiB | 2.4 s, 209 MiB/s | 2.0 s, 254 MiB/s | 2.1 s, 249 MiB/s |
| 32 × 16 MiB | 2.3 s, 225 MiB/s | 2.1 s, 248 MiB/s | 2.1 s, 243 MiB/s |
| `streaming: true`, single request | 6.0 s, 86 MiB/s | 5.4 s, 95 MiB/s | 2.8 s, 180 MiB/s |
| `streaming: true`, default 8 × 8 MiB | 4.0 s, 129 MiB/s | 3.3 s, 157 MiB/s | 3.3 s, 156 MiB/s |
| `streaming: true`, 16 × 8 MiB | 4.1 s, 125 MiB/s | 3.3 s, 156 MiB/s | 3.4 s, 151 MiB/s |

What the table says:

- **The parallel download is the big win.** Against a single request, the default cuts the
  transfer 3.7× on R2 and 5.6× on S3. GCS served the single request unusually fast in this run
  (an earlier run took 12.5 s); the default still gains 1.7× there.
- **8 MiB blocks beat the `actions/cache` 4 MiB** by 1.2× to 1.5× on every provider, and by
  more on GCS in the earlier run, which is why 8 MiB is the default here.
- **Past 8 × 16 MiB or 16 × 8 MiB the gains flatten.** R2 keeps improving up to 16 connections;
  S3 and GCS do not.
- **Streaming restores gain less from parallel parts**, because one `tar` process consumes the
  bytes in order while the parts wait, and on GCS a single streamed request was fastest. Streaming
  still saves the disk space of the temporary archive.

## Save

| Configuration | Cloudflare R2 | Amazon S3 | Google Cloud Storage |
| --- | ---: | ---: | ---: |
| v1.3 defaults: 4 × 10 MiB | 17.0 s, 30 MiB/s | 4.0 s, 127 MiB/s | 4.8 s, 106 MiB/s |
| **Default: 8 × 64 MiB** | 9.1 s, 56 MiB/s | 2.3 s, 221 MiB/s | 2.3 s, 227 MiB/s |
| 16 × 32 MiB | 5.2 s, 98 MiB/s | 2.2 s, 228 MiB/s | 2.2 s, 232 MiB/s |
| `streaming: true`, default 8 × 64 MiB | 6.2 s, 82 MiB/s | 2.9 s, 176 MiB/s | 2.8 s, 183 MiB/s |

What the table says:

- **The new upload defaults are 1.7× to 2.1× faster than v1.3's** 4 × 10 MiB on every provider,
  and were 2.2× to 3.8× faster in the earlier run.
- **R2 benefits from more connections.** 16 × 32 MiB is another 1.75× faster there, and holds the
  same 512 MiB of parts in memory as the default.
- **Streaming saves pay for the metadata copy on S3.** The whole step took 10.9 s against 2.9 s
  of transfer in both runs, because the sha256 is attached by copying the 512 MiB object onto
  itself after the upload. R2 and GCS copy in well under a second. File mode sends the checksum
  with the upload and has no copy. This run predates v1.6: a streamed save now attaches the
  checksum as an object tag instead, which removes this gap on S3 in the normal case. See
  [Object Metadata and Tags](https://github.com/xSAVIKx/cloud-cache-action#object-metadata-and-tags)
  in the README for when the copy still applies.

## Run-to-run variance

The same workflow ran twice, about two hours apart
([35653417989](https://github.com/xSAVIKx/cloud-cache-action/actions/runs/35653417989) and
[35654848985](https://github.com/xSAVIKx/cloud-cache-action/actions/runs/35654848985)). The ranking
of the settings was the same both times, but single figures moved a lot: the GCS single-request
restore took 12.5 s and then 4.1 s, the S3 one 6.2 s and then 10.7 s, and every R2 save was 15%
to 20% slower the second time. Treat a difference under about 30% between two rows as noise, and
run the benchmark more than once before tuning for one provider.

## Recommended settings

The defaults are the `actions/cache` values and are a safe starting point on every provider. When
transfer time matters, these settings measured best:

```yaml
# Fastest restores on Amazon S3 and Google Cloud Storage: larger parts.
    download-concurrency: 8
    download-chunk-size: 16777216    # 16 MiB; 128 MiB of parts in memory in streaming mode

# Fastest restores on Cloudflare R2: more connections.
    download-concurrency: 16
    download-chunk-size: 8388608     # 8 MiB

# Cloudflare R2 saves: more, smaller parts.
    upload-concurrency: 16
    upload-chunk-size: 33554432      # 32 MiB

# Small self-hosted runner: keep memory low at the cost of speed.
    download-concurrency: 4
    download-chunk-size: 4194304
    upload-concurrency: 4
    upload-chunk-size: 10485760
```

Memory per transfer is concurrency × chunk size: 64 MiB for the default download and 512 MiB for
the default upload.

## Running the benchmark yourself

Trigger the **Transfer benchmark** workflow from the Actions tab, or:

```sh
gh workflow run benchmark.yml -f size-mb=1024 -f repeats=3
```

It runs one job per provider whose secrets are configured (the same secrets as the live provider
suites), writes a table per provider to the job summary, uploads `benchmark-results.md` and
`benchmark-results.json` as `benchmark-<provider>` artifacts, and deletes the objects it created.

## Compression

`compression-level` sets the zstd (1–19) or gzip (1–9) level a save uses. It only changes saving:
restore always decodes whatever level a cache was saved with, so changing this input never
invalidates a cache and never changes restore speed.

### Fixtures

Measured 2026-09-22 on two real dependency trees, pinned to 4 cores with `zstd -T4` to emulate a
4-vCPU hosted runner.

| Fixture | Size | Files | Shape |
| --- | ---: | ---: | --- |
| `node_modules` from this repository | 278 MiB | 20916 | mostly small text |
| Python site-packages, wheels unpacked and byte-compiled | 354 MiB | 8927 | mixed, 198 shared objects |

### `node_modules`, 4 cores

Save time is compress plus upload at 200 MiB/s. Restore time is extract plus download at the same
rate.

| Level | Archive | Ratio | Compress | Extract | Save | Restore |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| zstd-1 | 60.6 MiB | 4.58 | 0.9 s | 0.7 s | 1.2 s | 1.0 s |
| zstd-2 | 57.8 MiB | 4.80 | 1.0 s | 0.7 s | 1.3 s | 1.0 s |
| **zstd-3, today** | 55.0 MiB | 5.05 | 1.1 s | 0.8 s | 1.4 s | 1.0 s |
| zstd-5 | 52.6 MiB | 5.27 | 1.8 s | 0.8 s | 2.1 s | 1.0 s |
| zstd-9 | 48.8 MiB | 5.69 | 3.0 s | 0.7 s | 3.3 s | 1.0 s |
| gzip-6, the gzip default | 71.4 MiB | 3.89 | 11.7 s | 1.9 s | 12.1 s | 2.2 s |
| gzip-1 | 85.2 MiB | 3.26 | 4.9 s | 2.2 s | 5.3 s | 2.6 s |

### Python site-packages, 4 cores

Same 200 MiB/s transfer assumption; zstd rows from the same sweep, gzip rows measured by hand.

| Level | Archive | Ratio | Compress | Extract | Save | Restore |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| zstd-1 | 112.4 MiB | 3.15 | 1.1 s | 0.8 s | 1.7 s | 1.4 s |
| zstd-2 | 105.6 MiB | 3.35 | 1.2 s | 0.9 s | 1.8 s | 1.4 s |
| **zstd-3, today** | 100.1 MiB | 3.53 | 1.5 s | 0.9 s | 2.0 s | 1.4 s |
| zstd-5 | 96.1 MiB | 3.68 | 2.6 s | 0.9 s | 3.1 s | 1.4 s |
| zstd-9 | 88.4 MiB | 4.00 | 4.3 s | 0.9 s | 4.7 s | 1.4 s |
| gzip-6, the gzip default | 111.7 MiB | 3.17 | 17.6 s | 2.6 s | 18.1 s | 3.2 s |
| gzip-1 | 127.4 MiB | 2.77 | 6.6 s | 2.9 s | 7.3 s | 3.5 s |

### Findings

Both fixtures, and both a fast and a slow link:

1. **Levels 1, 2 and 3 are within 0.3 s of each other on save.** Level 1 is nominally fastest, and
   it pays 10 to 12 percent more bytes for it, on every save and every restore from then on.
2. **On a slow link the gap closes further**, because the smaller archive wins back the extra CPU.
   At 60 MiB/s, level 2 is the fastest save on the Python tree, and level 1 and 2 tie on
   `node_modules`.
3. **Restore barely depends on the level at all.** Extract takes 0.67 s to 0.77 s on `node_modules`
   and 0.84 s to 0.94 s on the Python tree across every zstd level, a spread of about a tenth of a
   second within either fixture, so the level is a save-side trade only.
4. **Levels above 5 cost real time for little size.** Level 9 triples compress time to save 11
   percent of bytes against level 3. Level 19, measured on 12 cores, took 55 s to 64 s.
5. **On `node_modules`, gzip loses on both axes.** Its default level takes 10 times the CPU of
   zstd level 3 and still produces a larger archive than zstd level 1. On the Python tree gzip's
   CPU cost is the same story, but its default archive comes out slightly smaller than zstd
   level 1's (111.7 MiB against 112.4 MiB) — the size advantage is fixture-dependent; the CPU cost
   is not.

### Why the default stays at zstd level 3

The measurement says today's default is within 0.3 s of the fastest option, and it produces the
second-smallest archive of the fast group. Moving the default to level 1 would trade a permanent
10 percent size increase for a saving that is noise on a 300 MiB cache. This release changes no
default and only adds the `compression-level` input.

Two starting points, if you want to change it:

- `compression-level: 1` for the shortest save on a large cache, and for the gzip fallback path,
  where it roughly halves save time.
- `compression-level: 9` for the smallest archive, at about two extra seconds of CPU per save.

## Measure it yourself

The `compression` mode of the benchmark (`tests/ci/compressionBenchmark.ts`) measures your own
cache paths directly. It builds each archive through the action's real `buildCreateCommands` plan,
so the measured command is the one a save actually runs. It sweeps zstd levels only; it does not
reproduce the gzip rows above, which were measured by hand.

```sh
BENCH_FIXTURES="node_modules=/abs/path/to/node_modules" node tests/ci/compressionBenchmark.ts
```

- `BENCH_FIXTURES` (required): comma-separated `name=/abs/path` pairs. Point it at any directory
  you cache, not only `node_modules` — a build output directory or a vendored dependency tree
  works the same way.
- `BENCH_LEVELS` (default `1,2,3,5,9`): comma-separated zstd levels to sweep.
- `BENCH_REPEATS` (default `2`): repeats per level; the table shows the fastest.
- `BENCH_OUT` (default the workspace): directory for `compression-results.md` and
  `compression-results.json`.

Each row reports the archive size, the ratio against the raw tree size, the compress time and the
extract time, each the fastest of `BENCH_REPEATS` runs. Restore barely depends on the level: in
the measurements above, extract time moves by about a tenth of a second across the whole zstd
range, so treat the level as a save-side trade only.

**Warning:** the action always runs zstd as `zstd -T0`, which spreads compression across every
core the machine has. A developer machine with more cores than a hosted runner will therefore
understate compress time: your local sweep finishes faster than the same levels would on a 4-vCPU
runner. Pin the sweep to the core count you care about before trusting it, for example
`taskset -c 0-3 node tests/ci/compressionBenchmark.ts` on Linux, or run it in CI instead, where a
runner's own core count is already the honest number.

Trigger the **Transfer benchmark** workflow from the Actions tab, or:

```sh
gh workflow run benchmark.yml
```

Its `compression` job now runs alongside the transfer jobs: it builds a `node_modules` fixture
from this repository and a Python site-packages fixture from a small `pip download` set, sweeps
both, and uploads `compression-results.md` and `compression-results.json` as the
`benchmark-compression` artifact. The job warns in its own log when the runner has more than 4
CPUs, for the same reason as above.
