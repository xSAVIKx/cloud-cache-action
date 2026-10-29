---
title: How Caches Are Stored
---

# How Caches Are Stored

This page tells how a save writes a cache object and how a restore checks it. It covers the
sha256 checksum, the conditional create that protects concurrent saves, user metadata and object
tags, and the experimental streaming mode. You do not have to set an input for the checksum or
for the conditional create. The action does both on every save.

## Archive Integrity

Every save computes the sha256 checksum of the archive. A file-mode save stores the checksum as
object metadata (`cloud-cache-sha256`), as before. A streamed save stores the checksum as an
object tag instead. Four cases still use the metadata copy: user `metadata` is set, the provider
has no tagging API (Garage), the conditional create was not honored, or the save could not confirm
that it still owns the object after the tag — see
[Object Metadata and Tags](#object-metadata-and-tags).

On restore, the S3 tier looks for the checksum in metadata first. When metadata carries none, it
reads the tag, unless the object reports a tag count of exactly zero. Some servers never report
a tag count, and an unknown count is not proof that the object has no tags. When neither metadata
nor a tag carries a checksum, verification is skipped. When a checksum is found, the downloaded archive is hashed again and
compared before extraction. A mismatch does not extract the archive: the S3 tier reports an
`Integrity check failed for s3://<bucket>/<key>: expected sha256 <expected>, got <actual>` error,
which the restore logs as a warning (`Restoring from s3 failed, so it counts as a cache miss: ...`)
and treats as a cache miss, like any other S3 tier failure. With dual-cache the GitHub tier is
tried next, `fail-on-cache-miss: true` fails the step as it would for any miss, and only
`dual-cache-strict: true` turns the mismatch itself into a step failure. With
[streaming](#streaming-archives-experimental), the archive is hashed while it is extracted, so a
mismatch is only detected at the end and files may already have been extracted.

Objects with no checksum at all skip verification: caches from v1.1, or objects whose tagging or
metadata write the provider rejected. This is not a breaking change. An action older than v1.6
that restores a cache saved as a tag finds no checksum metadata. It skips the integrity check the
same way, instead of failing.

**Garage** does preserve this metadata, so integrity checks apply there like everywhere else.

## Safe Concurrent Saves

Uploads use a conditional create (`If-None-Match: *`). On providers that enforce it (verified on
AWS S3, MinIO, SeaweedFS and RustFS), when two jobs race to save the same key, only the first upload
succeeds; the second detects the precondition failure, logs `Another job saved s3://<bucket>/<key>
first; keeping its cache.`, and finishes without overwriting it. A `409 ConditionalRequestConflict`
(a concurrent write or delete of the same key, such as a prune, landing mid-upload) is retried once
with the same condition. Storage servers that reject the `If-None-Match` header outright are
detected automatically and the upload is retried once without it, so this never breaks the action
on providers with partial S3 API support.

**Providers that ignore `If-None-Match` keep last-writer-wins.** Garage (verified) does not support
conditional writes, and Google Cloud Storage's S3 interoperability reportedly ignores the header
too, so a race between two saves for the same key is last-writer-wins there, the same as v1.1's
behavior. The existing HEAD check before archiving still avoids pointless work when the key already
exists.

## Object Metadata and Tags

`metadata` stores user metadata (`x-amz-meta-*`) on every cache object the step saves, and `tags`
sets object tags, one `key=value` per line; surrounding whitespace is trimmed from each key and
value. Metadata is returned on restore as the `cache-metadata` output (a JSON object), except with
`lookup-only: true`, which never downloads the object. Tags are what bucket lifecycle rules and
IAM policies can filter on. Both inputs live on the main action and on
`cloud-cache-action/save@v1`: the standalone `restore` sub-action never saves, so it does not take
them.

```yaml
    metadata: |
      team=platform
      build=${{ github.run_id }}
    tags: |
      cloud-cache=true
      repo=${{ github.repository }}
```

Keys starting with `cloud-cache-` are reserved. Metadata is limited to 2 KB in total and tags to
10. With `streaming: true`, the cap drops to 9: a streamed save reserves one tag slot for the
`cloud-cache-sha256` checksum (see below). The cap is set from the `streaming` input itself, so a
streamed save that falls back to file mode on Windows still uses the stricter cap of 9. On
providers without object tagging the save logs one warning
(`s3://<bucket> could not store object tags (<reason>); saved without them.`) and completes without
tags.
Both are best-effort extras: neither can fail the save.

| Provider | Metadata | Tags |
|---|---|---|
| MinIO | ✅ verified | ✅ verified |
| SeaweedFS | ✅ verified | ✅ verified |
| RustFS | ✅ verified | ✅ verified |
| Garage | ✅ verified | ⚠️ accepted on upload, but Garage implements no tagging API (`GetObjectTagging`/`PutObjectTagging` answer `501 NotImplemented`), so the tags cannot be read back and should be assumed dropped |
| AWS S3, Cloudflare R2, GCS, B2, Fastly | ✅ | see provider docs |

Verified rows were measured by `tests/integration/objectAttributes.test.ts` against local MinIO,
SeaweedFS, RustFS and Garage servers; the last row is not covered by the local integration suite.

With [streaming](#streaming-archives-experimental), the sha256 checksum is only known once the
stream has finished, so it is attached after the upload. Normally it is attached as an object tag
(`PutObjectTagging`), sent together with any user `tags`. Four cases attach it with a copy of the
object onto itself instead, the same mechanism v1.2 through v1.5 always used: user `metadata` is
set, the provider has no tagging API (Garage today), the conditional create was not honored, or
the ownership check after the tag could not confirm the object. A tag write that fails for any
other reason falls back to the copy as well. When the upload reported no ETag, these last two
cases keep no checksum instead (see below). A provider that cannot do the copy either — or an
archive over 5 GiB, since a copy cannot span more than 5 GiB — costs the checksum, not the cache:
the save logs
`Saved s3://<bucket>/<key> but could not attach metadata: <reason>` and succeeds. A tag has no
size limit, so a streamed archive over 5 GiB gets a checksum for the first time when the tag path
applies. The copy was verified to work on MinIO, SeaweedFS, RustFS and Garage. Google Cloud
Storage has no tagging API, so a streamed save to GCS always uses the copy. GCS cannot check
`CopySourceIfMatch` against the ETag of a multipart upload. On GCS the copy therefore names the
generation that the upload wrote as its source version (`?versionId=`). When another job replaced
the object in between, the copy finds no source and fails, and the save keeps no checksum. With
Object Versioning on the bucket, an old generation stays readable: the copy can then put an older
save back over a newer one, with a checksum that matches its bytes.

The ownership check is one `HeadObject` after the tag. It proves that no other job replaced the
object between the upload and the tag. When the upload and the HEAD both report an ETag, the save
compares the ETags. Otherwise it compares the `cloud-cache-writer` metadata. The upload writes a
random id for this save into that field when the tag path applies, so a streamed object that
carries the checksum tag also carries `cloud-cache-writer=<id>` as user metadata. Like all
`cloud-cache-` keys, it is not reported in `cache-metadata`. It does not count against the
metadata limit, because the upload sends it only when no user `metadata` is set. When the check
shows that another job wrote the object, the save removes its checksum tag, warns, and does not
copy. The tag set has no partial update, so this can also remove the checksum tag of the other
job: that cache then has no checksum, but never a false one. When the check cannot confirm the
object (no object, a failed HEAD, or neither value returned), the save removes its checksum tag.
It then uses the copy only when the upload reported an ETag, because only then can
`CopySourceIfMatch` guard the copy. With no upload ETag, the save keeps no checksum and logs
`Saved s3://<bucket>/<key> without a checksum: the upload reported no ETag, ...`. A failed tag
write with no upload ETag has the same result. A missing checksum only skips the integrity check,
but a false checksum would reject a good cache. MinIO, SeaweedFS, RustFS and
Garage return the `cloud-cache-writer` field on `HeadObject` for single-part and multipart
uploads.

## Streaming Archives (Experimental)

Set `streaming: true` to stream archives directly between `tar` and S3 instead of writing a
temporary archive file first. This applies to the S3 tier only (the GitHub Actions Cache tier is
unaffected), uses less disk, and can be faster for large caches — but with these trade-offs:

- **No whole-archive retry.** A streaming upload cannot be retried as a single unit if it fails
  partway; only the S3 SDK's own per-part retries apply. Non-streaming (file-mode) saves are
  unaffected and keep full retry support.
- **No whole-download retry, and possibly partial extraction, on restore.** A streamed restore
  extracts the archive as it downloads, so a network or `tar` failure mid-stream becomes a cache
  miss (with a warning) and can leave the workspace partly extracted. File-mode restores download
  to a temporary file first and retry the whole download before extracting anything.
- **The integrity checksum is attached after the upload.** The digest is only known once the
  stream has finished, so a streamed save attaches `cloud-cache-sha256` afterwards, normally as an
  object tag rather than metadata (a copy of the object onto itself in four narrower cases; see
  [Object Metadata and Tags](#object-metadata-and-tags)). This drops about 8 seconds from a
  512 MiB save on Amazon S3, where the copy used to dominate the step. Attaching it is
  best-effort: on a provider that rejects both attempts the save still succeeds, logs
  `Saved s3://<bucket>/<key> but could not attach metadata: <reason>`, and the object carries no
  checksum, so restoring it skips the integrity check. An action older than v1.6 restoring a
  streamed cache saved by v1.6 or later finds no checksum metadata and skips the integrity check
  the same way, instead of failing.
- **`tags` allows one fewer entry.** With `streaming: true` the cap drops from 10 to 9, because
  the checksum tag reserves one slot. The cap follows the `streaming` input itself, so a streamed
  save that falls back to file mode on Windows keeps the stricter cap of 9.

Streaming is opt-in and defaults to `false`; disabling it (or leaving it unset) is identical to
v1.1 behavior. It automatically falls back to file mode — logging
`Streaming is not supported with BSD tar and zstd on Windows; using a temporary archive file.` —
when the plan requires the two-step BSD-tar-plus-zstd path on Windows. It follows the same
conditional-create and Garage fallback rules as [Safe Concurrent Saves](#safe-concurrent-saves).

