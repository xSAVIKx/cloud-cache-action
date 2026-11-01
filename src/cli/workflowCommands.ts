import type { CiLogger } from '../ci/host';

/** A workflow command line: "::name[ properties]::message". */
const COMMAND = /^::([a-z-]+)(?: [^:]*)?::(.*)$/;

/** Decodes the characters that @actions/core escapes in a command message. */
function decode(text: string): string {
  return text.replace(/%0D/g, '\r').replace(/%0A/g, '\n').replace(/%25/g, '%');
}

/**
 * Sends one workflow command to the logger. It returns false for a line that is not a command
 * that the CLI knows, so the caller writes that line unchanged.
 */
function route(line: string, log: CiLogger): boolean {
  const match = COMMAND.exec(line);
  if (!match) {
    return false;
  }
  const message = decode(match[2]);
  switch (match[1]) {
    case 'debug':
      log.debug(message);
      return true;
    case 'warning':
      log.warning(message);
      return true;
    case 'error':
      log.error(message);
      return true;
    case 'notice':
      log.info(message);
      return true;
    case 'group':
      log.startGroup(message);
      return true;
    case 'endgroup':
      log.endGroup();
      return true;
    case 'add-mask':
      // Only GitHub Actions masks a value. Elsewhere the line would print the secret.
      return true;
    default:
      return false;
  }
}

/**
 * Runs the function with process.stdout.write intercepted. The @actions packages write workflow
 * commands (::debug::, ::warning::, ::group:: and others) to stdout, and only GitHub Actions reads
 * them. Each such line goes to the logger of the CLI host instead. Other text passes through
 * unchanged. The original write is always restored.
 */
export async function withWorkflowCommandsRouted<T>(
  log: CiLogger,
  fn: () => Promise<T>
): Promise<T> {
  const original = process.stdout.write;
  const write = (chunk: unknown, rest: unknown[]): boolean =>
    (original as (...args: unknown[]) => boolean).call(process.stdout, chunk, ...rest);
  // The logger writes to stdout too. Its text is output, not a command.
  let routing = false;
  const intercept = function (this: unknown, chunk: unknown, ...rest: unknown[]): boolean {
    if (routing || typeof chunk !== 'string' || !/(^|\n)::/.test(chunk)) {
      return write(chunk, rest);
    }
    let kept = '';
    const lines = chunk.split('\n');
    lines.forEach((line, index) => {
      const last = index === lines.length - 1;
      routing = true;
      let handled: boolean;
      try {
        handled = route(line.replace(/\r$/, ''), log);
      } finally {
        routing = false;
      }
      if (!handled && !(last && line === '')) {
        kept += last ? line : `${line}\n`;
      }
    });
    if (kept !== '') {
      return write(kept, rest);
    }
    const callback = rest.find((arg) => typeof arg === 'function') as (() => void) | undefined;
    callback?.();
    return true;
  };
  process.stdout.write = intercept as typeof process.stdout.write;
  try {
    return await fn();
  } finally {
    process.stdout.write = original;
  }
}
