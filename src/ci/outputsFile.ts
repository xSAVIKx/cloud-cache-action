import { randomBytes } from 'node:crypto';

/** One output as a line for an outputs file. A value with a newline uses the delimiter form. */
export function formatOutput(name: string, value: string): string {
  if (!value.includes('\n') && !value.includes('\r')) {
    return `${name}=${value}\n`;
  }
  const delimiter = `CLOUD_CACHE_EOF_${randomBytes(8).toString('hex')}`;
  return `${name}<<${delimiter}\n${value}\n${delimiter}\n`;
}
