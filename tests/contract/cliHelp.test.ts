import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from '@jest/globals';
import { buildFlagDescriptions } from '../../scripts/cliFlagDescriptions.js';
import { GenericHost } from '../../src/ci/generic';
import { setHost } from '../../src/ci/host';
import { type CliCommand, INPUT_DEFAULTS } from '../../src/cli/defaults';
import { FLAG_DESCRIPTIONS } from '../../src/cli/flagDescriptions';
import {
  CLI_NOTES,
  commandUsage,
  descriptionGivesDefault,
  FALLBACK_ENV,
  FLAG_GROUPS,
  inputEnvName,
  inputFlagText,
} from '../../src/cli/help';
import { createStorageContext } from '../../src/storage/client';

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
      if (value === '') {
        continue;
      }
      const description = FLAG_DESCRIPTIONS[command][name] ?? '';
      const text = inputFlagText(command, name);
      // Either the manifest text gives this exact default, or the help adds "Default: <value>.".
      const shown = descriptionGivesDefault(description, value)
        ? text.startsWith(description)
        : text.includes(`Default: ${value}.`);
      expect([name, shown]).toEqual([name, true]);
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

  it('the exact default check needs the whole value', () => {
    expect(descriptionGivesDefault('Show N candidates (default 20)', '20')).toBe(true);
    expect(descriptionGivesDefault('Show N candidates (default 20)', '2')).toBe(false);
    expect(descriptionGivesDefault('Retries (default: 2.5)', '2')).toBe(false);
    expect(descriptionGivesDefault('Scope by repository (default: true).', 'true')).toBe(true);
    expect(descriptionGivesDefault('Restore from the default branch', 'true')).toBe(false);
  });

  it('every CLI note is for an input', () => {
    const inputs = new Set(COMMANDS.flatMap((command) => Object.keys(INPUT_DEFAULTS[command])));
    for (const name of Object.keys(CLI_NOTES)) {
      expect([name, inputs.has(name)]).toEqual([name, true]);
    }
  });

  it('the fallback env vars in the help are the env vars that the storage client reads', async () => {
    const base: Record<string, string> = {
      bucket: 'flag-bucket',
      'access-key': 'flag-access',
      'secret-key': 'flag-secret',
    };
    // Each read gives the value that createStorageContext took for one input.
    const reads: Record<string, (ctx: ReturnType<typeof createStorageContext>) => Promise<string>> =
      {
        bucket: async (ctx) => ctx.bucket,
        endpoint: async (ctx) => ctx.providerConfig.endpoint ?? '',
        region: async (ctx) => ctx.providerConfig.region,
        'access-key': async (ctx) => (await ctx.client.config.credentials()).accessKeyId,
        'secret-key': async (ctx) => (await ctx.client.config.credentials()).secretAccessKey,
        'session-token': async (ctx) => (await ctx.client.config.credentials()).sessionToken ?? '',
      };
    expect(Object.keys(FALLBACK_ENV).sort()).toEqual(Object.keys(reads).sort());
    try {
      for (const [name, envNames] of Object.entries(FALLBACK_ENV)) {
        for (const envName of envNames) {
          const inputs = { ...base };
          delete inputs[name];
          const value = name === 'endpoint' ? 'https://s3.example.test' : `env-${envName}`;
          setHost(
            new GenericHost({
              inputs,
              defaults: {},
              env: { CLOUD_CACHE_REPOSITORY: 'o/r', [envName]: value },
              stateFile: path.join(ROOT, 'no-such-state.json'),
            })
          );
          const ctx = createStorageContext({ maxAttempts: 1 });
          expect([name, envName, await reads[name](ctx)]).toEqual([name, envName, value]);
        }
      }
    } finally {
      setHost(undefined);
    }
  });
});
