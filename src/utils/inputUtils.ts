import { getHost } from '../ci/host';
import type { InputOptions } from '../ci/host';
import { log } from '../ci/log';

export function getInputAsArray(name: string, options?: InputOptions): string[] {
  return getHost()
    .input(name, options)
    .split('\n')
    .map((s) => s.trim())
    .filter((x) => x !== '');
}

const TRUE_VALUES = ['true', 'True', 'TRUE'];
const FALSE_VALUES = ['false', 'False', 'FALSE'];

export function getInputAsBool(
  name: string,
  defaultValue = false,
  options?: InputOptions
): boolean {
  const value = getHost().input(name, options).trim();
  if (!value) {
    return defaultValue;
  }
  if (TRUE_VALUES.includes(value)) {
    return true;
  }
  if (FALSE_VALUES.includes(value)) {
    return false;
  }
  log.warning(
    `Input "${name}" must be one of true, True, TRUE, false, False, FALSE; got "${value}". Using "${defaultValue}".`
  );
  return defaultValue;
}

export function getInputAsEnum<T extends string>(
  name: string,
  allowed: readonly T[],
  defaultValue: T
): T {
  const value = getHost().input(name).trim();
  if (!value) {
    return defaultValue;
  }
  if ((allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  log.warning(
    `Input "${name}" must be one of ${allowed.join(', ')}; got "${value}". Using "${defaultValue}".`
  );
  return defaultValue;
}

export function getInputAsInt(
  name: string,
  defaultValue?: number,
  options?: InputOptions
): number | undefined {
  const value = getHost().input(name, options);
  if (!value) {
    return defaultValue;
  }
  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed < 0) {
    return defaultValue;
  }
  return parsed;
}

export function getInputWithEnv(
  inputName: string,
  envVarNames: string[] = [],
  camelCaseInputName?: string
): string {
  // Check primary input
  let value = getHost().input(inputName);
  if (value) {
    return value;
  }

  // Check camelCase alias if provided
  if (camelCaseInputName) {
    value = getHost().input(camelCaseInputName);
    if (value) {
      return value;
    }
  }

  // Check environment variables
  for (const envVar of envVarNames) {
    const envVal = getHost().context().env[envVar];
    if (envVal !== undefined && envVal !== '') {
      return envVal;
    }
  }

  return '';
}

export function isExactKeyMatch(primaryKey: string, matchedKey?: string): boolean {
  if (!matchedKey) {
    return false;
  }
  return primaryKey.trim().toLowerCase() === matchedKey.trim().toLowerCase();
}

export function isValidEvent(): boolean {
  const event = getHost().context().eventName;
  // GitHub Actions events that are not tied to a ref (e.g. issues, discussion) might not be appropriate for caching
  // actions/cache warns if event is not ref-based, but allows execution
  return Boolean(event);
}

export function formatSize(bytes?: number): string {
  if (bytes === undefined || bytes === null || isNaN(bytes)) {
    return '0 B';
  }
  if (bytes === 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const unitIndex = Math.min(i, units.length - 1);
  const size = (bytes / Math.pow(1024, unitIndex)).toFixed(2);
  return `${size} ${units[unitIndex]}`;
}

/** Reads an optional input that must be an integer of 0 or more; empty gives undefined. */
export function parseOptionalNonNegativeInt(raw: string, name: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return undefined;
  }
  if (!/^[0-9]+$/.test(trimmed) || !Number.isSafeInteger(Number(trimmed))) {
    throw new Error(`Input "${name}" must be a non-negative integer; got "${raw}".`);
  }
  return Number(trimmed);
}

/** Like `parsePositiveInt`, but an empty input gives undefined: the input is optional. */
export function parseOptionalPositiveInt(raw: string, name: string): number | undefined {
  return raw.trim() === '' ? undefined : parsePositiveInt(raw, name);
}

/**
 * Reads an input that must be a positive integer, failing the step on anything else: a typo
 * silently falling back to a default would hide a wrong-looking result rather than report it.
 */
export function parsePositiveInt(raw: string, name: string): number {
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed) || Number(trimmed) <= 0) {
    throw new Error(`Input "${name}" must be a positive integer; got "${raw}".`);
  }
  return Number(trimmed);
}
