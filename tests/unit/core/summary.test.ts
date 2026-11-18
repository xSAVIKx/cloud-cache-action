import * as fs from 'node:fs';
import * as path from 'node:path';
import * as core from '@actions/core';
import { makeTempDir, removeDir, setEnv } from '../../support/tempTree';
import { setHost, type CiHost } from '../../../src/ci/host';
import { TextSummaryWriter } from '../../../src/ci/textSummary';
import { writeRestoreSummary, writeSaveSummary } from '../../../src/core/summary';

describe('writeRestoreSummary / writeSaveSummary', () => {
  let dir: string;
  let summaryFile: string;
  let restoreEnv: () => void;

  beforeEach(() => {
    dir = makeTempDir('summary');
    summaryFile = path.join(dir, 'step-summary.md');
    fs.writeFileSync(summaryFile, '');
    restoreEnv = setEnv({ GITHUB_STEP_SUMMARY: summaryFile });
    // core.summary is a singleton that caches the resolved file path on first use; reset it so
    // each test's own temp file is picked up instead of a previous test's (now-deleted) one.
    (core.summary as unknown as { _filePath?: string })._filePath = undefined;
  });

  afterEach(() => {
    restoreEnv();
    removeDir(dir);
  });

  it('writes the restore table with the expected cells', async () => {
    await writeRestoreSummary({
      jobSummary: true,
      primaryKey: 'Linux-npm-abc',
      matchedKey: 'Linux-npm-old',
      cacheHit: false,
      source: 's3',
      size: 2048,
      durationMs: 1240,
    });

    const content = fs.readFileSync(summaryFile, 'utf8');
    expect(content).toContain('Cloud cache restore');
    expect(content).toContain('Primary key');
    expect(content).toContain('Linux-npm-abc');
    expect(content).toContain('Matched key');
    expect(content).toContain('Linux-npm-old');
    expect(content).toContain('Cache hit');
    expect(content).toContain('false');
    expect(content).toContain('Source');
    expect(content).toContain('s3');
    expect(content).toContain('Size');
    expect(content).toContain('2.00 KB');
    expect(content).toContain('Duration');
    expect(content).toContain('1.24 s');
  });

  it('names the preset and its resolved paths under the restore and save tables', async () => {
    await writeRestoreSummary({
      jobSummary: true,
      primaryKey: 'Linux-npm-abc',
      cacheHit: false,
      source: 'none',
      durationMs: 10,
      preset: 'npm',
      paths: ['~/.npm', 'a<b'],
    });
    await writeSaveSummary({
      jobSummary: true,
      key: 'Linux-npm-abc',
      savedTo: ['s3'],
      durationMs: 10,
      preset: 'npm',
      paths: ['~/.npm'],
    });

    const content = fs.readFileSync(summaryFile, 'utf8');
    expect(content).toContain(
      '<p>Preset <code>npm</code>, path <code>~/.npm</code>, <code>a&lt;b</code></p>'
    );
    expect(content).toContain('<p>Preset <code>npm</code>, path <code>~/.npm</code></p>');
  });

  it('adds no preset line without a preset', async () => {
    await writeSaveSummary({ jobSummary: true, key: 'k', savedTo: [], durationMs: 1 });
    expect(fs.readFileSync(summaryFile, 'utf8')).not.toContain('Preset');
  });

  it('adds a details block with escaped metadata when present', async () => {
    await writeRestoreSummary({
      jobSummary: true,
      primaryKey: 'Linux-npm-abc',
      matchedKey: 'Linux-npm-abc',
      cacheHit: true,
      source: 's3',
      size: 2048,
      durationMs: 1240,
      metadata: { team: 'a<b' },
    });

    const content = fs.readFileSync(summaryFile, 'utf8');
    expect(content).toContain('<details>');
    expect(content).toContain('team');
    expect(content).toContain('a&lt;b');
  });

  it('does not add a details block when metadata is empty or absent', async () => {
    await writeRestoreSummary({
      jobSummary: true,
      primaryKey: 'Linux-npm-abc',
      matchedKey: 'Linux-npm-abc',
      cacheHit: true,
      source: 's3',
      durationMs: 100,
      metadata: {},
    });

    const content = fs.readFileSync(summaryFile, 'utf8');
    expect(content).not.toContain('<details>');
  });

  it('renders — for a missing matched key and size on a restore miss', async () => {
    await writeRestoreSummary({
      jobSummary: true,
      primaryKey: 'Linux-npm-abc',
      cacheHit: false,
      source: 'none',
      durationMs: 500,
    });

    const content = fs.readFileSync(summaryFile, 'utf8');
    expect(content).toContain('—');
    expect(content).toContain('none');
    expect(content).toContain('0.50 s');
  });

  it('writes the save table with the expected cells', async () => {
    await writeSaveSummary({
      jobSummary: true,
      key: 'Linux-npm-abc',
      savedTo: ['s3', 'github'],
      size: 4096,
      durationMs: 2000,
    });

    const content = fs.readFileSync(summaryFile, 'utf8');
    expect(content).toContain('Cloud cache save');
    expect(content).toContain('Key');
    expect(content).toContain('Linux-npm-abc');
    expect(content).toContain('Saved to');
    expect(content).toContain('s3, github');
    expect(content).toContain('Size');
    expect(content).toContain('4.00 KB');
    expect(content).toContain('Duration');
    expect(content).toContain('2.00 s');
  });

  it('shows none when nothing was saved', async () => {
    await writeSaveSummary({
      jobSummary: true,
      key: 'Linux-npm-abc',
      savedTo: [],
      durationMs: 100,
    });

    const content = fs.readFileSync(summaryFile, 'utf8');
    expect(content).toContain('none');
  });

  it('shows a restore that the cache mode skipped as skipped, with the reason', async () => {
    await writeRestoreSummary({
      jobSummary: true,
      primaryKey: 'Linux-npm-abc',
      cacheHit: false,
      source: 'none',
      durationMs: 10,
      skipped: 'ACTIONS_CACHE_MODE is none',
    });

    const content = fs.readFileSync(summaryFile, 'utf8');
    expect(content).toContain('<td>skipped</td>');
    expect(content).not.toContain('<td>false</td>');
    expect(content).toContain('<p>Skipped: ACTIONS_CACHE_MODE is none</p>');
  });

  it('shows a save that the cache mode skipped as skipped, with the reason', async () => {
    await writeSaveSummary({
      jobSummary: true,
      key: 'Linux-npm-abc',
      savedTo: [],
      durationMs: 10,
      skipped: 'ACTIONS_CACHE_MODE is read',
    });

    const content = fs.readFileSync(summaryFile, 'utf8');
    expect(content).toContain('<td>skipped</td>');
    expect(content).toContain('<p>Skipped: ACTIONS_CACHE_MODE is read</p>');
  });

  it('adds no skipped line when the step was not skipped', async () => {
    await writeSaveSummary({ jobSummary: true, key: 'k', savedTo: [], durationMs: 10 });
    expect(fs.readFileSync(summaryFile, 'utf8')).not.toContain('Skipped');
  });

  it('writes nothing when job-summary is false', async () => {
    await writeRestoreSummary({
      jobSummary: false,
      primaryKey: 'Linux-npm-abc',
      cacheHit: false,
      source: 'none',
      durationMs: 100,
    });

    expect(fs.readFileSync(summaryFile, 'utf8')).toBe('');
  });

  it('writes nothing when GITHUB_STEP_SUMMARY is unset', async () => {
    restoreEnv();
    restoreEnv = setEnv({ GITHUB_STEP_SUMMARY: undefined });

    await expect(
      writeSaveSummary({
        jobSummary: true,
        key: 'Linux-npm-abc',
        savedTo: ['s3'],
        durationMs: 100,
      })
    ).resolves.toBeUndefined();

    expect(fs.readFileSync(summaryFile, 'utf8')).toBe('');
  });

  it('swallows a write failure instead of throwing', async () => {
    restoreEnv();
    const missingPath = path.join(dir, 'no-such-dir', 'step-summary.md');
    restoreEnv = setEnv({ GITHUB_STEP_SUMMARY: missingPath });

    await expect(
      writeRestoreSummary({
        jobSummary: true,
        primaryKey: 'Linux-npm-abc',
        cacheHit: false,
        source: 'none',
        durationMs: 100,
      })
    ).resolves.toBeUndefined();

    expect(fs.existsSync(missingPath)).toBe(false);
  });

  it('HTML-escapes keys in the restore table, so a key cannot break the markup', async () => {
    await writeRestoreSummary({
      jobSummary: true,
      primaryKey: 'a<b>&c',
      matchedKey: 'x"<td>y',
      cacheHit: true,
      source: 's3',
      durationMs: 100,
    });

    const content = fs.readFileSync(summaryFile, 'utf8');
    expect(content).toContain('<td>a&lt;b&gt;&amp;c</td>');
    expect(content).toContain('<td>x&quot;&lt;td&gt;y</td>');
    expect(content).not.toContain('a<b>');
    expect(content).not.toContain('<td>y');
  });

  it('HTML-escapes the key in the save table', async () => {
    await writeSaveSummary({
      jobSummary: true,
      key: 'a<b>&c',
      savedTo: ['s3'],
      durationMs: 100,
    });

    const content = fs.readFileSync(summaryFile, 'utf8');
    expect(content).toContain('<td>a&lt;b&gt;&amp;c</td>');
    expect(content).not.toContain('a<b>');
  });
});

describe('the Result column and the error lines', () => {
  let dir: string;
  let summaryFile: string;
  let restoreEnv: () => void;

  beforeEach(() => {
    dir = makeTempDir('summary-result');
    summaryFile = path.join(dir, 'step-summary.md');
    fs.writeFileSync(summaryFile, '');
    restoreEnv = setEnv({ GITHUB_STEP_SUMMARY: summaryFile });
    (core.summary as unknown as { _filePath?: string })._filePath = undefined;
  });

  afterEach(() => {
    restoreEnv();
    removeDir(dir);
  });

  const restoreBase = {
    jobSummary: true,
    primaryKey: 'Linux-npm-abc',
    durationMs: 410,
  };
  const restoreHeader =
    '<tr><th>Result</th><th>Primary key</th><th>Matched key</th><th>Cache hit</th><th>Source</th><th>Size</th><th>Duration</th></tr>';
  const s3Error =
    'Restoring from s3 failed, so it counts as a cache miss: HeadObject s3://ci-cache/k returned HTTP 403 Forbidden.';

  it('shows an exact hit', async () => {
    await writeRestoreSummary({
      ...restoreBase,
      matchedKey: 'Linux-npm-abc',
      cacheHit: true,
      source: 's3',
      size: 2048,
    });
    const content = fs.readFileSync(summaryFile, 'utf8');
    expect(content).toContain(restoreHeader);
    expect(content).toContain(
      '<tr><td>exact hit</td><td>Linux-npm-abc</td><td>Linux-npm-abc</td><td>true</td><td>s3</td><td>2.00 KB</td><td>0.41 s</td></tr>'
    );
    expect(content).not.toContain('Error:');
  });

  it('shows a restore-key hit as a partial hit', async () => {
    await writeRestoreSummary({
      ...restoreBase,
      matchedKey: 'Linux-npm-old',
      cacheHit: false,
      source: 's3',
      size: 2048,
    });
    expect(fs.readFileSync(summaryFile, 'utf8')).toContain(
      '<tr><td>partial hit (restore key)</td><td>Linux-npm-abc</td><td>Linux-npm-old</td><td>false</td><td>s3</td><td>2.00 KB</td><td>0.41 s</td></tr>'
    );
  });

  it('shows a lookup-only match as found', async () => {
    await writeRestoreSummary({
      ...restoreBase,
      matchedKey: 'Linux-npm-abc',
      cacheHit: true,
      source: 's3',
      lookupOnly: true,
    });
    expect(fs.readFileSync(summaryFile, 'utf8')).toContain('<tr><td>found (lookup only)</td>');
  });

  it('shows a normal miss', async () => {
    await writeRestoreSummary({ ...restoreBase, cacheHit: false, source: 'none', errors: [] });
    const content = fs.readFileSync(summaryFile, 'utf8');
    expect(content).toContain(
      '<tr><td>miss</td><td>Linux-npm-abc</td><td>—</td><td>false</td><td>none</td><td>—</td><td>0.41 s</td></tr>'
    );
    expect(content).not.toContain('Error:');
  });

  it('shows an S3 error that counts as a miss as an error, with the text under the table', async () => {
    await writeRestoreSummary({
      ...restoreBase,
      cacheHit: false,
      source: 'none',
      errors: [s3Error],
    });
    const content = fs.readFileSync(summaryFile, 'utf8');
    expect(content).toContain(
      '<tr><td>error (no cache)</td><td>Linux-npm-abc</td><td>—</td><td>false</td><td>none</td><td>—</td><td>0.41 s</td></tr>'
    );
    expect(content).toContain(`</table>\n<p>Error: ${s3Error}</p>`);
  });

  it('shows a GitHub fallback hit after an S3 error as a hit, and keeps the S3 error', async () => {
    await writeRestoreSummary({
      ...restoreBase,
      matchedKey: 'Linux-npm-abc',
      cacheHit: true,
      source: 'github',
      errors: [s3Error],
    });
    const content = fs.readFileSync(summaryFile, 'utf8');
    expect(content).toContain(
      '<tr><td>exact hit</td><td>Linux-npm-abc</td><td>Linux-npm-abc</td><td>true</td><td>github</td><td>—</td><td>0.41 s</td></tr>'
    );
    expect(content).toContain(`<p>Error: ${s3Error}</p>`);
  });

  it('shows a restore step that threw as an error, with the escaped message', async () => {
    await writeRestoreSummary({
      ...restoreBase,
      cacheHit: false,
      source: 'none',
      failed: true,
      errors: ['Bucket <name> is required.'],
    });
    const content = fs.readFileSync(summaryFile, 'utf8');
    expect(content).toContain('<tr><td>error (no cache)</td>');
    expect(content).toContain('<p>Error: Bucket &lt;name&gt; is required.</p>');
  });

  const saveBase = { jobSummary: true, key: 'Linux-npm-abc', durationMs: 2000 };

  it('shows a save that failed with a warning as an error, with the text under the table', async () => {
    await writeSaveSummary({
      ...saveBase,
      savedTo: [],
      outcome: 'error',
      errors: ['Failed to save cache to S3: SlowDown'],
    });
    const content = fs.readFileSync(summaryFile, 'utf8');
    expect(content).toContain(
      '<tr><th>Result</th><th>Key</th><th>Saved to</th><th>Size</th><th>Duration</th></tr>'
    );
    expect(content).toContain(
      '<tr><td>error (not saved)</td><td>Linux-npm-abc</td><td>none</td><td>—</td><td>2.00 s</td></tr>'
    );
    expect(content).toContain('</table>\n<p>Error: Failed to save cache to S3: SlowDown</p>');
  });

  it.each([
    [{ savedTo: ['s3'] as Array<'s3'>, outcome: 'saved' as const }, 'saved'],
    [{ savedTo: ['s3'] as Array<'s3'>, outcome: 'exists' as const }, 'already saved'],
    [{ savedTo: [], outcome: 'exists' as const, exactHit: true }, 'not necessary (exact hit)'],
    [{ savedTo: [], outcome: 'skipped' as const, skipReason: 'no paths matched' }, 'no files'],
    [{ savedTo: [], skipped: 'ACTIONS_CACHE_MODE is read' }, 'skipped'],
  ])('shows the save Result for %j as %s', async (fields, result) => {
    await writeSaveSummary({ ...saveBase, ...fields });
    expect(fs.readFileSync(summaryFile, 'utf8')).toContain(`<tr><td>${result}</td>`);
  });

  it('names the reason when a tier skipped the save for a reason other than no files', async () => {
    await writeSaveSummary({
      ...saveBase,
      savedTo: [],
      outcome: 'skipped',
      skipReason: 'GitHub Actions Cache did not save this key (see the messages above)',
    });
    const content = fs.readFileSync(summaryFile, 'utf8');
    expect(content).toContain('<tr><td>skipped</td>');
    expect(content).toContain(
      '<p>Skipped: GitHub Actions Cache did not save this key (see the messages above)</p>'
    );
  });

  it('adds no skipped line for no files, because the Result says it', async () => {
    await writeSaveSummary({
      ...saveBase,
      savedTo: [],
      outcome: 'skipped',
      skipReason: 'no paths matched',
    });
    expect(fs.readFileSync(summaryFile, 'utf8')).not.toContain('Skipped');
  });
});

describe('the summary on a host with a text summary (Bitbucket)', () => {
  afterEach(() => {
    setHost(undefined);
  });

  it('prints the Result column and the error line as plain text', async () => {
    let printed = '';
    setHost({
      summary: new TextSummaryWriter((text) => {
        printed += text;
      }),
    } as unknown as CiHost);
    await writeRestoreSummary({
      jobSummary: true,
      primaryKey: 'Linux-npm-abc',
      cacheHit: false,
      source: 'none',
      durationMs: 410,
      errors: ['Restoring from s3 failed, so it counts as a cache miss: HTTP 403 Forbidden'],
    });
    expect(printed).toBe(
      [
        '# Cloud cache restore',
        'Result            Primary key    Matched key  Cache hit  Source  Size  Duration',
        'error (no cache)  Linux-npm-abc  —            false      none    —     0.41 s',
        'Error: Restoring from s3 failed, so it counts as a cache miss: HTTP 403 Forbidden',
        '',
      ].join('\n')
    );
  });
});
