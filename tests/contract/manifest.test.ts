import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { Defaults, Inputs, Outputs } from '../../src/constants';
import { PRESET_NAMES } from '../../src/core/presets';

interface ManifestInput {
  description: string;
  required?: boolean;
  default?: string;
}

interface Manifest {
  inputs: Record<string, ManifestInput>;
  outputs: Record<string, { description: string }>;
  runs: { using: string; main: string; post?: string; 'post-if'?: string };
  branding: { icon: string; color: string };
}

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const load = (relative: string): Manifest =>
  parse(readFileSync(path.join(REPO, relative), 'utf8')) as Manifest;

const root = load('action.yml');
const pruneManifest = load('prune/action.yml');
const inspectManifest = load('inspect/action.yml');
const subActions: Array<[string, Manifest]> = [
  ['restore/action.yml', load('restore/action.yml')],
  ['save/action.yml', load('save/action.yml')],
];
const allManifests: Array<[string, Manifest]> = [
  ['action.yml', root],
  ...subActions,
  ['prune/action.yml', pruneManifest],
  ['inspect/action.yml', inspectManifest],
];

// Inputs/outputs that exist only for the prune sub-action and are exempt from the root manifest.
const PRUNE_ONLY_INPUTS: string[] = [
  Inputs.OlderThanDays,
  Inputs.KeepLatest,
  Inputs.MaxTotalSize,
  Inputs.AbortUploadsOlderThanHours,
  Inputs.Ref,
  Inputs.DryRun,
];
const PRUNE_ONLY_OUTPUTS: string[] = [
  Outputs.PrunedCount,
  Outputs.PrunedBytes,
  Outputs.KeptCount,
  Outputs.AbortedUploads,
];

// Inputs/outputs that exist only for the inspect sub-action and are exempt from the root manifest.
const INSPECT_ONLY_INPUTS: string[] = [Inputs.MaxCandidates];
const INSPECT_ONLY_OUTPUTS: string[] = [
  Outputs.WouldHit,
  Outputs.WouldMatchKey,
  Outputs.WouldMatchObject,
  Outputs.CandidateCount,
  Outputs.Report,
];

describe('action manifests', () => {
  it('declare every input the code reads', () => {
    const missing = Object.values(Inputs)
      .filter((name) => !PRUNE_ONLY_INPUTS.includes(name) && !INSPECT_ONLY_INPUTS.includes(name))
      .filter((name) => !(name in root.inputs));
    expect(missing).toEqual([]);
  });

  it('do not declare inputs the code never reads', () => {
    const known = new Set<string>(Object.values(Inputs));
    for (const [file, manifest] of allManifests) {
      const unknown = Object.keys(manifest.inputs).filter((name) => !known.has(name));
      expect({ file, unknown }).toEqual({ file, unknown: [] });
    }
  });

  it('declare every output the code sets', () => {
    const missing = Object.values(Outputs)
      .filter((name) => !PRUNE_ONLY_OUTPUTS.includes(name) && !INSPECT_ONLY_OUTPUTS.includes(name))
      .filter((name) => !(name in root.outputs));
    expect(missing).toEqual([]);
  });

  it.each(subActions)('%s is a subset of the root manifest with the same defaults', (_file, m) => {
    for (const [name, input] of Object.entries(m.inputs)) {
      expect({ name, inRoot: name in root.inputs }).toEqual({ name, inRoot: true });
      expect({ name, default: input.default }).toEqual({
        name,
        default: root.inputs[name].default,
      });
    }
    for (const name of Object.keys(m.outputs)) {
      expect({ name, inRoot: name in root.outputs }).toEqual({ name, inRoot: true });
    }
  });

  it("prune/action.yml's shared inputs are a subset of the root manifest with the same defaults", () => {
    for (const [name, input] of Object.entries(pruneManifest.inputs)) {
      if (PRUNE_ONLY_INPUTS.includes(name)) {
        continue;
      }
      expect({ name, inRoot: name in root.inputs }).toEqual({ name, inRoot: true });
      expect({ name, default: input.default }).toEqual({
        name,
        default: root.inputs[name].default,
      });
    }
  });

  it("inspect/action.yml's shared inputs are a subset of the root manifest with the same defaults", () => {
    for (const [name, input] of Object.entries(inspectManifest.inputs)) {
      if (INSPECT_ONLY_INPUTS.includes(name)) {
        continue;
      }
      expect({ name, inRoot: name in root.inputs }).toEqual({ name, inRoot: true });
      expect({ name, default: input.default }).toEqual({
        name,
        default: root.inputs[name].default,
      });
    }
  });

  it('inspect/action.yml declares max-candidates defaulting to 20 and the five inspect outputs', () => {
    expect(inspectManifest.inputs[Inputs.MaxCandidates].default).toBe('20');
    expect(inspectManifest.inputs[Inputs.MaxCandidates].required ?? false).toBe(false);
    expect(Object.keys(inspectManifest.outputs).sort()).toEqual(
      [...INSPECT_ONLY_OUTPUTS, Outputs.CacheStorageProvider].sort()
    );
  });

  it('prune/action.yml declares the four rule inputs as optional with no default, and dry-run defaulting to false', () => {
    for (const name of [
      Inputs.OlderThanDays,
      Inputs.KeepLatest,
      Inputs.MaxTotalSize,
      Inputs.AbortUploadsOlderThanHours,
    ]) {
      expect(pruneManifest.inputs[name].required ?? false).toBe(false);
      expect(pruneManifest.inputs[name].default).toBeUndefined();
    }
    expect(pruneManifest.inputs[Inputs.DryRun].default).toBe('false');
  });

  it.each(allManifests)('%s uses the defaults the code falls back to', (_file, manifest) => {
    const expectDefault = (name: string, value: string): void => {
      if (name in manifest.inputs) {
        expect({ name, default: manifest.inputs[name].default }).toEqual({ name, default: value });
      }
    };
    expectDefault(Inputs.S3KeyPattern, Defaults.DefaultS3KeyPattern);
    expectDefault(Inputs.RetryCount, String(Defaults.DefaultRetryCount));
    expectDefault(Inputs.TransferTuning, 'fixed');
    expectDefault(Inputs.RestorePriority, Defaults.DefaultRestorePriority);
    expectDefault(Inputs.DualCacheStrategy, Defaults.DefaultDualCacheStrategy);
  });

  it.each(allManifests)(
    '%s gives the transfer inputs no default, so transfer-tuning: auto can tell a set value from an unset one',
    (_file, manifest) => {
      for (const [name, value] of [
        [Inputs.DownloadConcurrency, String(Defaults.DefaultDownloadConcurrency)],
        [Inputs.DownloadChunkSize, String(Defaults.DefaultDownloadChunkSize)],
        [Inputs.UploadConcurrency, String(Defaults.DefaultUploadConcurrency)],
        [Inputs.UploadChunkSize, '64 MiB'],
      ]) {
        if (name in manifest.inputs) {
          expect({ name, default: manifest.inputs[name].default }).toEqual({
            name,
            default: undefined,
          });
          expect(manifest.inputs[name].description).toContain(value);
        }
      }
    }
  );

  it('no longer offers save-always, which post-if can never honour', () => {
    for (const [, manifest] of allManifests) {
      expect(Object.keys(manifest.inputs)).not.toContain('save-always');
    }
  });

  it('runs the bundled entrypoints on node24', () => {
    expect(root.runs).toEqual({
      using: 'node24',
      main: 'dist/restore/index.js',
      post: 'dist/save/index.js',
      'post-if': 'success()',
    });
    expect(subActions[0][1].runs).toEqual({
      using: 'node24',
      main: '../dist/restore-only/index.js',
    });
    expect(subActions[1][1].runs).toEqual({ using: 'node24', main: '../dist/save-only/index.js' });
    expect(pruneManifest.runs).toEqual({ using: 'node24', main: '../dist/prune/index.js' });
    expect(inspectManifest.runs).toEqual({ using: 'node24', main: '../dist/inspect/index.js' });
  });

  it('points each entrypoint at one function of the shared dist/lib bundle', async () => {
    const main = await import('../../src/main');
    const expected: Record<string, string> = {
      'dist/restore/index.js': 'runRestore',
      'dist/save/index.js': 'runSave',
      'dist/restore-only/index.js': 'runRestoreOnly',
      'dist/save-only/index.js': 'runSaveOnly',
      'dist/prune/index.js': 'runPrune',
      'dist/inspect/index.js': 'runInspect',
    };
    const entries = allManifests.flatMap(([file, manifest]) =>
      [manifest.runs.main, manifest.runs.post]
        .filter((entry): entry is string => entry !== undefined)
        .map((entry) =>
          // path.relative gives backslashes on Windows; the expected keys use forward slashes.
          path
            .relative(REPO, path.resolve(REPO, path.dirname(file), entry))
            .split(path.sep)
            .join('/')
        )
    );
    expect(entries.sort()).toEqual(Object.keys(expected).sort());
    for (const [entry, fn] of Object.entries(expected)) {
      expect(typeof (main as Record<string, unknown>)[fn]).toBe('function');
      // Git may check out text files with CRLF on Windows.
      const stub = readFileSync(path.join(REPO, entry), 'utf8').replace(/\r\n/g, '\n');
      expect(stub).toBe(
        `// Generated by scripts/writeEntries.ts. Do not edit.
import fs from 'node:fs';
import module from 'node:module';
import os from 'node:os';
import path from 'node:path';

try {
  const dir = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'cloud-cache-action-v8');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  fs.accessSync(dir, fs.constants.W_OK);
  module.enableCompileCache?.(dir);
} catch {}
const { ${fn} } = await import('../lib/index.js');
${fn}(true);
`
      );
    }
  });

  it.each(allManifests)('%s uses a valid Feather branding icon', (_file, manifest) => {
    const allowedIcons = ['cloud', 'upload-cloud', 'download-cloud', 'trash-2', 'search'];
    expect(allowedIcons).toContain(manifest.branding.icon);
  });

  it('declares cache-metadata on the root and restore manifests only', () => {
    expect(root.outputs[Outputs.CacheMetadata]).toBeDefined();
    expect(subActions[0][1].outputs[Outputs.CacheMetadata]).toBeDefined();
    expect(subActions[1][1].outputs[Outputs.CacheMetadata]).toBeUndefined();
    expect(pruneManifest.outputs?.[Outputs.CacheMetadata]).toBeUndefined();
    expect(inspectManifest.outputs?.[Outputs.CacheMetadata]).toBeUndefined();
  });

  it('declares explain on the root and restore manifests only, defaulting to false', () => {
    expect(root.inputs[Inputs.Explain]?.default).toBe('false');
    expect(subActions[0][1].inputs[Inputs.Explain]?.default).toBe('false');
    expect(subActions[1][1].inputs[Inputs.Explain]).toBeUndefined();
    expect(pruneManifest.inputs[Inputs.Explain]).toBeUndefined();
    expect(inspectManifest.inputs[Inputs.Explain]).toBeUndefined();
  });

  it('declares metrics-file on all five manifests with an empty default', () => {
    for (const [file, manifest] of allManifests) {
      const input = manifest.inputs[Inputs.MetricsFile];
      expect({ file, declared: input !== undefined }).toEqual({ file, declared: true });
      expect({ file, default: input.default }).toEqual({ file, default: '' });
      expect({ file, required: input.required ?? false }).toEqual({ file, required: false });
    }
  });

  it('declares the metrics outputs on the root, restore and save manifests', () => {
    for (const name of [
      Outputs.CacheRestoreDurationMs,
      Outputs.CacheSaveDurationMs,
      Outputs.CacheTransferDurationMs,
      Outputs.CacheBytes,
    ]) {
      expect(root.outputs[name]).toBeDefined();
    }
    const [, restoreManifest] = subActions[0];
    const [, saveManifest] = subActions[1];
    expect(Object.keys(restoreManifest.outputs)).toEqual(
      expect.arrayContaining([
        Outputs.CacheRestoreDurationMs,
        Outputs.CacheTransferDurationMs,
        Outputs.CacheBytes,
      ])
    );
    expect(restoreManifest.outputs[Outputs.CacheSaveDurationMs]).toBeUndefined();
    expect(Object.keys(saveManifest.outputs)).toEqual(
      expect.arrayContaining([
        Outputs.CacheSaveDurationMs,
        Outputs.CacheTransferDurationMs,
        Outputs.CacheBytes,
      ])
    );
    expect(saveManifest.outputs[Outputs.CacheRestoreDurationMs]).toBeUndefined();
    expect(pruneManifest.outputs?.[Outputs.CacheBytes]).toBeUndefined();
    expect(inspectManifest.outputs?.[Outputs.CacheBytes]).toBeUndefined();
  });

  it('declare metadata and tags on the root and save manifests only, with no default', () => {
    const [, restoreManifest] = subActions[0];
    const [, saveManifest] = subActions[1];
    for (const [file, manifest] of [
      ['action.yml', root],
      ['save/action.yml', saveManifest],
    ] as Array<[string, Manifest]>) {
      for (const name of [Inputs.Metadata, Inputs.Tags]) {
        expect({ file, name, declared: manifest.inputs[name] !== undefined }).toEqual({
          file,
          name,
          declared: true,
        });
        expect(manifest.inputs[name].default ?? '').toBe('');
        expect(manifest.inputs[name].required ?? false).toBe(false);
      }
    }
    // The manifests whose action never saves must not offer inputs that would do nothing.
    for (const [file, manifest] of [
      ['restore/action.yml', restoreManifest],
      ['prune/action.yml', pruneManifest],
      ['inspect/action.yml', inspectManifest],
    ] as Array<[string, Manifest]>) {
      for (const name of [Inputs.Metadata, Inputs.Tags]) {
        expect({ file, name, declared: manifest.inputs[name] !== undefined }).toEqual({
          file,
          name,
          declared: false,
        });
      }
    }
  });

  it('declares preset on the root, restore and save manifests only, and makes path and key optional there', () => {
    for (const [file, manifest] of [['action.yml', root], ...subActions] as Array<
      [string, Manifest]
    >) {
      const preset = manifest.inputs[Inputs.Preset];
      expect({ file, declared: preset !== undefined }).toEqual({ file, declared: true });
      expect({ file, default: preset.default }).toEqual({ file, default: undefined });
      expect({ file, required: preset.required }).toEqual({ file, required: false });
      expect({ file, description: preset.description }).toEqual({
        file,
        description: root.inputs[Inputs.Preset].description,
      });
      for (const name of [Inputs.Path, Inputs.Key]) {
        expect({ file, name, required: manifest.inputs[name].required }).toEqual({
          file,
          name,
          required: false,
        });
      }
    }
    for (const name of PRESET_NAMES) {
      expect(root.inputs[Inputs.Preset].description).toContain(name);
    }
    expect(pruneManifest.inputs[Inputs.Preset]).toBeUndefined();
    expect(inspectManifest.inputs[Inputs.Preset]).toBeUndefined();
  });

  it('declares the tier inputs the inspect report reads on inspect/action.yml', () => {
    for (const name of [Inputs.DualCache, Inputs.UseFallback, Inputs.RestorePriority]) {
      expect({ name, declared: inspectManifest.inputs[name] !== undefined }).toEqual({
        name,
        declared: true,
      });
      expect({ name, description: inspectManifest.inputs[name].description }).toEqual({
        name,
        description: root.inputs[name].description,
      });
    }
  });

  it('says a streamed upload attaches the checksum as a tag', () => {
    for (const [file, manifest] of allManifests) {
      const stream = manifest.inputs[Inputs.Streaming];
      if (!stream) continue;
      expect({ file, text: stream.description }).toEqual({
        file,
        text: expect.not.stringContaining('no integrity checksum'),
      });
      expect(stream.description).toContain('checksum is attached after the upload, as a tag');
    }
  });

  it('lists none as a cache-saved-sources value', () => {
    for (const [file, manifest] of allManifests) {
      const output = manifest.outputs[Outputs.CacheSavedSources];
      if (!output) continue;
      expect({ file, none: output.description.includes('none') }).toEqual({ file, none: true });
    }
  });

  it('says an explicit key turns off the preset restore-keys', () => {
    for (const [file, manifest] of allManifests) {
      const preset = manifest.inputs[Inputs.Preset];
      if (!preset) continue;
      expect({ file, text: preset.description }).toEqual({
        file,
        text: expect.stringContaining('Setting key also turns off the preset restore-keys'),
      });
    }
  });
});
