import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';

/** One output as a line for an outputs file. A value with a newline uses the delimiter form. */
export function formatOutput(name: string, value: string): string {
  if (!value.includes('\n') && !value.includes('\r')) {
    return `${name}=${value}\n`;
  }
  const delimiter = `CLOUD_CACHE_EOF_${randomBytes(8).toString('hex')}`;
  return `${name}<<${delimiter}\n${value}\n${delimiter}\n`;
}

/** Appends text to an output file. A failure names the file and the reason. */
export function appendToOutputFile(file: string, text: string, label: string): void {
  try {
    appendFileSync(file, text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot write the ${label} ${file}: ${reason}`, { cause: error });
  }
}
