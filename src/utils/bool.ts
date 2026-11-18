/**
 * The boolean grammar of the action inputs. The CLI flags and the CLI input env vars use the same
 * set. The env vars of the CLI flags keep their own older set (see `envBool` in `src/cli/args.ts`).
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
