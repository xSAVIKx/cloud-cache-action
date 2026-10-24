import type { CiLogger } from './host';
import { getHost } from './host';

/** Logger that sends each call to the active host, so a host change takes effect at once. */
export const log: CiLogger = {
  debug: (message) => getHost().log.debug(message),
  info: (message) => getHost().log.info(message),
  warning: (message) => getHost().log.warning(message),
  error: (message) => getHost().log.error(message),
  startGroup: (title) => getHost().log.startGroup(title),
  endGroup: () => getHost().log.endGroup(),
};
