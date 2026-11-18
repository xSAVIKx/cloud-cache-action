/**
 * The one boolean grammar of the action and the CLI. It is the set that the action inputs accept.
 * Flags, flag env vars and input env vars of the CLI use the same set.
 */
const TRUE_VALUES: readonly string[] = ['true', 'True', 'TRUE'];
const FALSE_VALUES: readonly string[] = ['false', 'False', 'FALSE'];

/** The accepted values, for messages. */
export const BOOLEAN_VALUES_TEXT = 'true, True, TRUE, false, False or FALSE';

/** Gives true or false for an accepted value, and undefined for every other value. */
export function parseBoolean(value: string): boolean | undefined {
  if (TRUE_VALUES.includes(value)) {
    return true;
  }
  if (FALSE_VALUES.includes(value)) {
    return false;
  }
  return undefined;
}
