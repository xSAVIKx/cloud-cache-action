/**
 * The version that `cloud-cache --version` prints. The bundle step replaces the identifier
 * `__CLI_VERSION__` with a string literal (an esbuild or webpack `define`). Without that
 * replacement, for example in tests, the version is `0.0.0-dev`.
 */
declare const __CLI_VERSION__: string | undefined;

export const CLI_VERSION: string =
  typeof __CLI_VERSION__ === 'string' ? __CLI_VERSION__ : '0.0.0-dev';
