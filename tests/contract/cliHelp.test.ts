import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from '@jest/globals';
import { buildFlagDescriptions } from '../../scripts/cliFlagDescriptions.js';
import { GenericHost } from '../../src/ci/generic';
import { type CliCommand, INPUT_DEFAULTS } from '../../src/cli/defaults';
import { FLAG_DESCRIPTIONS } from '../../src/cli/flagDescriptions';
import { commandUsage, FLAG_GROUPS, inputEnvName, inputFlagText } from '../../src/cli/help';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const COMMANDS = Object.keys(INPUT_DEFAULTS) as CliCommand[];

describe('CLI flag help', () => {
  it('src/cli/flagDescriptions.ts equals the manifest descriptions', () => {
    // Run `node scripts/cliFlagDescriptions.ts` after a change to a manifest description.
    expect(FLAG_DESCRIPTIONS).toEqual(buildFlagDescriptions(ROOT));
  });

  it.each(COMMANDS)('every %s flag has a description', (command) => {
    for (const name of Object.keys(INPUT_DEFAULTS[command])) {
      expect([name, FLAG_DESCRIPTIONS[command][name]?.trim() ?? '']).toEqual([
        name,
        expect.stringMatching(/\S/),
      ]);
    }
    expect(Object.keys(FLAG_DESCRIPTIONS[command]).sort()).toEqual(
      Object.keys(INPUT_DEFAULTS[command]).sort()
    );
  });

  it('every input of every command is in exactly one help group', () => {
    const grouped = Object.values(FLAG_GROUPS).flat();
    expect(new Set(grouped).size).toBe(grouped.length);
    const inputs = new Set(COMMANDS.flatMap((command) => Object.keys(INPUT_DEFAULTS[command])));
    expect([...new Set(grouped)].sort()).toEqual([...inputs].sort());
  });

  it.each(COMMANDS)('the %s help shows every flag of the command', (command) => {
    const text = commandUsage(command);
    for (const name of Object.keys(INPUT_DEFAULTS[command])) {
      expect(text).toMatch(new RegExp(`^  --${name}[ [<]?`, 'm'));
    }
  });

  it.each(COMMANDS)('the %s help gives each non-empty default', (command) => {
    for (const [name, value] of Object.entries(INPUT_DEFAULTS[command])) {
      if (value !== '') {
        expect([name, inputFlagText(command, name)]).toEqual([
          name,
          expect.stringContaining(value),
        ]);
      }
    }
  });

  it('the env var in the help is the env var that the CLI host reads', () => {
    for (const command of COMMANDS) {
      for (const name of Object.keys(INPUT_DEFAULTS[command])) {
        const envName = `CLOUD_CACHE_${name.toUpperCase().replace(/-/g, '_')}`;
        const host = new GenericHost({
          inputs: {},
          defaults: {},
          env: { [envName]: 'from-env' },
          stateFile: path.join(ROOT, 'no-such-state.json'),
        });
        const reads = host.input(name) === 'from-env';
        expect([name, inputEnvName(name)]).toEqual([name, reads ? envName : undefined]);
      }
    }
  });
});
