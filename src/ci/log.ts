import type { CiLogger } from './host';
import { getHost } from './host';

/** The annotation title of a warning that gives no title of its own. See `setWarningTitle`. */
let stepWarningTitle: string | undefined;

/**
 * Sets the annotation title of each warning that gives no title, until the next call. A cache step
 * sets its name at the start and undefined at the end, so a warning from shared code (the config,
 * the S3 tier) also names the step that warned.
 */
export function setWarningTitle(title: string | undefined): void {
  stepWarningTitle = title;
}

/** Logger that sends each call to the active host, so a host change takes effect at once. */
export const log: CiLogger = {
  debug: (message) => getHost().log.debug(message),
  info: (message) => getHost().log.info(message),
  warning: (message, title) => getHost().log.warning(message, title ?? stepWarningTitle),
  error: (message) => getHost().log.error(message),
  startGroup: (title) => getHost().log.startGroup(title),
  endGroup: () => getHost().log.endGroup(),
};
