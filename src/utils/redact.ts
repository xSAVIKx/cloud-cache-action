/** The longest error text, in characters, that one `Error:` line shows. */
export const MAX_ERROR_LENGTH = 1000;

/**
 * An HTTP URL starts here only when no scheme character comes before it, so a run of scheme
 * characters gives one start, not one for each character. `https:\/\/` is the JSON-escaped form.
 */
const HTTP_URL = String.raw`(?<![a-z0-9+.-])https?:(?:\/\/|\\\/\\\/)`;

/**
 * `http(s)://user:pass@host` -> `http(s)://host`. The user info ends at the last `@` before the
 * first `/`, `?`, `#`, quote or white space, so an `@` in a path or in later text stays. Other
 * schemes (`s3://`, `file://`) never hold user info in this action, so the rule leaves them.
 * Each match scans to the first `/` after its start, so the rule takes linear time.
 */
const USER_INFO = new RegExp(String.raw`(${HTTP_URL})[^\s\/\\?#"']*@`, 'gi');

/** The authority at the end of a cut text, which can hold part of the user info with no `@`. */
const CUT_AUTHORITY = new RegExp(String.raw`(${HTTP_URL})[^\s\/\\?#"']*$`, 'i');

/**
 * `http(s)://host/path?query` -> `http(s)://host/path?[query removed]`. A quote, `)` or `,` ends
 * the query. The path part stops at the next `://`, so a line of many URLs takes linear time.
 */
const QUERY = new RegExp(
  String.raw`(${HTTP_URL}(?:(?!:\/\/|:\\\/)[^\s?#"'),])*)\?[^\s#"'),]*`,
  'gi'
);

/** A signature or credential parameter name of an S3, GCS or Azure presigned URL. */
const PARAMETER_NAMES =
  'sig|signature|credential|AWSAccessKeyId|X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|X-Goog-Signature|X-Goog-Credential';

/**
 * A signature or credential parameter in a percent-encoded URL query: after an encoded `?` or `&`,
 * `key%3Dvalue`. A plain query is already gone (see QUERY). Prose, `s3://` keys and file paths do
 * not have an encoded `?` or `&` before the name, so they stay.
 */
const ENCODED_PARAMETER = new RegExp(
  String.raw`(?<=%3F|%26|%253F|%2526)(${PARAMETER_NAMES})(%3D|%253D)(?:(?!%26)[^\s&,"')\/\\])+`,
  'gi'
);

/** The value of an `X-Amz-*` or `X-Goog-*` secret header: `x-amz-security-token: <token>`. */
const SECRET_HEADER =
  /(?<![a-z0-9-])(x-amz-security-token|x-amz-credential|x-amz-signature|x-goog-credential|x-goog-signature)(:[ \t]*)[^\s,"')]+/gi;

/** The credential and the signature of a SigV4 `Authorization` header value. */
const SIGV4_AUTHORIZATION =
  /(AWS4-HMAC-SHA256[ \t]+Credential=)[^\s,]+(,[ \t]*SignedHeaders=[^\s,]+,[ \t]*Signature=)[^\s,"')]+/gi;

/** The text of an `Authorization:` header, to the end of the line. */
const AUTHORIZATION_HEADER = /(?<![a-z0-9-])(authorization:)[^\r\n]*/gi;

/**
 * Removes secrets from a text that the action prints: the user info of each HTTP URL, the query
 * string of each HTTP URL (a presigned or SAS URL holds its signature there), a signature or
 * credential parameter in a percent-encoded URL, the value of an `X-Amz-*` or `X-Goog-*` secret
 * header, the credential and signature of a SigV4 `Authorization` value, and the text of an
 * `Authorization:` header. The rest of the text stays. Each rule takes linear time, so a long text
 * is safe. The CI hosts call this for each warning, error, failure and debug line of the action,
 * and the CLI for each error that it prints.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(USER_INFO, '$1')
    .replace(QUERY, '$1?[query removed]')
    .replace(ENCODED_PARAMETER, '$1$2[removed]')
    .replace(SECRET_HEADER, '$1$2[removed]')
    .replace(SIGV4_AUTHORIZATION, '$1[removed]$2[removed]')
    .replace(AUTHORIZATION_HEADER, '$1 [removed]');
}

/**
 * Makes an error text safe and short for one `Error:` line of the job summary. First it cuts the
 * text to `MAX_ERROR_LENGTH` characters. Then `redactSecrets` removes the secrets.
 */
export function redactError(text: string): string {
  const cut = text.length > MAX_ERROR_LENGTH;
  let redacted = cut ? text.slice(0, MAX_ERROR_LENGTH) : text;
  if (cut) {
    // The cut can end inside the user info of a URL, before its `@`.
    redacted = redacted.replace(CUT_AUTHORITY, '$1[cut]');
  }
  redacted = redactSecrets(redacted);
  if (cut) {
    redacted += `... (${text.length - MAX_ERROR_LENGTH} more characters in the log)`;
  }
  return redacted;
}
