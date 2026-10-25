import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { hashFiles } from '@actions/glob';
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { UsageError } from '../../../src/cli/args';
import { expandHashTemplates } from '../../../src/cli/hashTemplate';

let dir: string;

const sha = (data: string | Buffer): Buffer => createHash('sha256').update(data).digest();

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cli-hash-'));
  mkdirSync(join(dir, 'a'));
  mkdirSync(join(dir, 'b/target'), { recursive: true });
  writeFileSync(join(dir, 'a/pom.xml'), 'one');
  writeFileSync(join(dir, 'b/pom.xml'), 'two');
  writeFileSync(join(dir, 'b/target/x.xml'), 'x');
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('expandHashTemplates', () => {
  it('hashes the files when the workspace has a trailing slash', async () => {
    const plain = await expandHashTemplates('{hash:a/pom.xml}', dir);
    const slash = await expandHashTemplates('{hash:a/pom.xml}', `${dir}/`);
    expect(slash.unmatched).toEqual([]);
    expect(slash.text).not.toBe('');
    expect(slash.text).toBe(plain.text);
  });

  it('hashes the files when the workspace is relative', async () => {
    const cwd = process.cwd();
    const plain = await expandHashTemplates('{hash:a/pom.xml}', dir);
    process.chdir(dir);
    try {
      const dot = await expandHashTemplates('{hash:a/pom.xml}', '.');
      expect(dot.unmatched).toEqual([]);
      expect(dot.text).toBe(plain.text);
    } finally {
      process.chdir(cwd);
    }
    const rel = relative(cwd, dir);
    const viaRelative = await expandHashTemplates('{hash:a/pom.xml}', rel);
    expect(viaRelative.text).toBe(plain.text);
  });

  it('sends ::debug:: text from hashFiles to the callback and not to stdout', async () => {
    const lines: string[] = [];
    const written: string[] = [];
    const spy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    let result;
    try {
      result = await expandHashTemplates('{hash:a/pom.xml}', dir, (text) => lines.push(text));
      process.stdout.write('plain line\n');
    } finally {
      spy.mockRestore();
    }
    expect(result.text).not.toBe('');
    expect(lines.length).toBeGreaterThan(0);
    expect(written.join('')).not.toContain('::debug::');
    expect(written).toContain('plain line\n');
  });

  it('restores process.stdout.write after the call', async () => {
    const before = process.stdout.write;
    await expandHashTemplates('{hash:a/pom.xml}', dir);
    expect(process.stdout.write).toBe(before);
  });

  it('matches the GitHub hashFiles algorithm', async () => {
    const expected = createHash('sha256')
      .update(Buffer.concat([sha('one'), sha('two')]))
      .digest('hex');
    const { text, unmatched } = await expandHashTemplates('{hash:**/pom.xml}', dir);
    expect(text).toBe(expected);
    expect(unmatched).toEqual([]);
    expect(text).toBe(await hashFiles(join(dir, '**/pom.xml'), dir));
  });

  it('joins several globs with a comma', async () => {
    const only = await expandHashTemplates('{hash:a/pom.xml}', dir);
    const { text } = await expandHashTemplates('{hash:**/pom.xml,!b/**}', dir);
    expect(text).toBe(only.text);
    expect(text).toMatch(/^[0-9a-f]{64}$/);
  });

  it('expands every template in the text', async () => {
    const { text } = await expandHashTemplates('maven-{hash:a/pom.xml}-x-{hash:b/pom.xml}', dir);
    expect(text).toMatch(/^maven-[0-9a-f]{64}-x-[0-9a-f]{64}$/);
  });

  it('leaves ${hash:...} and text with no template as is', async () => {
    expect((await expandHashTemplates('a-${hash:pom.xml}-b', dir)).text).toBe(
      'a-${hash:pom.xml}-b'
    );
    expect(await expandHashTemplates('plain-key', dir)).toEqual({
      text: 'plain-key',
      unmatched: [],
    });
  });

  it('reports a template that matched no file', async () => {
    const result = await expandHashTemplates('k-{hash:**/none.xml}', dir);
    expect(result).toEqual({ text: 'k-', unmatched: ['**/none.xml'] });
  });

  it('rejects an unclosed template', async () => {
    const call = expandHashTemplates('maven-{hash:pom.xml', dir);
    await expect(call).rejects.toBeInstanceOf(UsageError);
    await expect(call).rejects.toThrow('{hash:');
  });
});
