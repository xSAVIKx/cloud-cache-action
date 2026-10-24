import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

import {
  BOOLEAN_INPUTS,
  INPUT_DEFAULTS,
  MULTILINE_INPUTS,
  type CliCommand,
} from '../../../src/cli/defaults';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const MANIFESTS: Record<CliCommand, string> = {
  restore: 'action.yml',
  save: 'action.yml',
  inspect: 'inspect/action.yml',
  prune: 'prune/action.yml',
};

// Inputs that the code reads as booleans although the manifest has no default.
const BOOLEAN_WITHOUT_DEFAULT = ['force-path-style'];

function manifestDefaults(file: string): Record<string, string> {
  const manifest = parse(readFileSync(join(ROOT, file), 'utf8')) as {
    inputs: Record<string, { default?: unknown }>;
  };
  const result: Record<string, string> = {};
  for (const [name, spec] of Object.entries(manifest.inputs)) {
    result[name] = spec.default === undefined ? '' : String(spec.default);
  }
  return result;
}

describe('CLI input defaults', () => {
  it.each(Object.keys(MANIFESTS) as CliCommand[])(
    '%s table equals the manifest defaults',
    (command) => {
      expect(INPUT_DEFAULTS[command]).toEqual(manifestDefaults(MANIFESTS[command]));
    }
  );

  it('has a table for exactly the four commands', () => {
    expect(Object.keys(INPUT_DEFAULTS).sort()).toEqual(['inspect', 'prune', 'restore', 'save']);
  });

  it('BOOLEAN_INPUTS holds the true/false defaults and the boolean inputs without a default', () => {
    const expected = new Set<string>(BOOLEAN_WITHOUT_DEFAULT);
    for (const file of new Set(Object.values(MANIFESTS))) {
      for (const [name, value] of Object.entries(manifestDefaults(file))) {
        if (value === 'true' || value === 'false') expected.add(name);
      }
    }
    expect([...BOOLEAN_INPUTS].sort()).toEqual([...expected].sort());
  });

  it('MULTILINE_INPUTS holds the inputs that the action reads one per line', () => {
    expect([...MULTILINE_INPUTS].sort()).toEqual(['metadata', 'path', 'restore-keys', 'tags']);
  });

  it('every multiline and boolean input is an input of some command', () => {
    const all = new Set(Object.values(INPUT_DEFAULTS).flatMap((table) => Object.keys(table)));
    for (const name of [...MULTILINE_INPUTS, ...BOOLEAN_INPUTS]) {
      expect(all.has(name)).toBe(true);
    }
  });
});
