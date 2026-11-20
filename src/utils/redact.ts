/** The longest error text, in characters, that one `Error:` line shows. */
export const MAX_ERROR_LENGTH = 1000;

/** A URL scheme starts here only when no scheme character comes before it (a linear match). */
const SCHEME = String.raw`(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/`;

/** `scheme://user:pass@` -> `scheme://`. It takes all text up to the last `@` before the host. */
const USER_INFO = new RegExp(String.raw`(${SCHEME})[^\s?#]*@`, 'gi');

/** The authority at the end of a cut text, which can hold part of the user info with no `@`. */
const CUT_AUTHORITY = new RegExp(String.raw`(${SCHEME})[^\s/?#]*$`, 'i');

/** `http(s)://host/path?query` -> `http(s)://host/path?[query removed]`. A quote, `)` or `,` ends it. */
const QUERY = /(?<![a-z0-9+.-])(https?:\/\/[^\s?#"'),]*)\?[^\s#"'),]*/gi;

/**
 * A signature or credential parameter or header outside a URL query: `key=value`, `key%3Dvalue`
 * (percent-encoded, also after an encoded `?` or `&`), or `key: value` (header text). The value ends at white space, `&`, `%26`, a
 * comma, a quote or `)`.
 */
const SECRET_PARAMETER = new RegExp(
  String.raw`(?:(?<![a-z0-9-])|(?<=%3F|%26|%253F|%2526))(sig|signature|credential|AWSAccessKeyId|X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|X-Goog-Signature|X-Goog-Credential)(=|%3D|%253D|:[ \t]*)(?:(?!%26)[^\s&,"')])+`,
  'gi'
);

/** The text of an `Authorization:` header, to the end of the line. */
const AUTHORIZATION_HEADER = /(?<![a-z0-9-])(authorization:)[^\r\n]*/gi;

/**
 * Removes secrets from a text that the action prints: the user info of each URL, the query string
 * of each HTTP URL (a presigned or SAS URL holds its signature there), the value of each signature
 * or credential parameter or header, and the text of an `Authorization:` header. The rest of the
 * text stays. Each rule takes linear time, so a long text is safe. The CI hosts call this for each
 * warning, error, failure and debug line, and the CLI for each error that it prints.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(USER_INFO, '$1')
    .replace(QUERY, '$1?[query removed]')
    .replace(SECRET_PARAMETER, '$1$2[removed]')
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
