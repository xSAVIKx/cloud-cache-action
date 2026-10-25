import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { hashFiles } from '@actions/glob';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
