import {
  encodeTagging,
  metadataBytes,
  parseMetadata,
  parseTags,
  stripReservedMetadata,
  withChecksumTag,
} from '../../../src/core/objectAttributes';

describe('parseMetadata', () => {
  it('returns an empty object for empty or blank input', () => {
    expect(parseMetadata('')).toEqual({});
    expect(parseMetadata('\n  \n')).toEqual({});
  });

  it('parses key=value lines, trimming and lower-casing keys', () => {
    expect(parseMetadata('Team=platform\n build-id = 42 \nurl=https://a/b?c=d')).toEqual({
      team: 'platform',
      'build-id': '42',
      url: 'https://a/b?c=d',
    });
  });

  it('rejects a line without =', () => {
    expect(() => parseMetadata('team')).toThrow(
      'Invalid "metadata" line "team": expected key=value.'
    );
  });

  it('rejects an invalid key', () => {
    expect(() => parseMetadata('-x=1')).toThrow('Invalid "metadata" key "-x"');
    expect(() => parseMetadata('a b=1')).toThrow('Invalid "metadata" key "a b"');
  });

  it('rejects the reserved cloud-cache- prefix', () => {
    expect(() => parseMetadata('cloud-cache-sha256=abc')).toThrow(
      '"metadata" key "cloud-cache-sha256" is reserved (cloud-cache-* keys are set by the action).'
    );
  });

  it('rejects non-printable-ASCII values', () => {
    expect(() => parseMetadata('team=plätform')).toThrow(
      'Invalid "metadata" value for "team": only printable ASCII is allowed.'
    );
    expect(() => parseMetadata('team=a\tb')).toThrow('only printable ASCII');
  });

  it('fails when the total exceeds 2048 bytes including the sha256 entry', () => {
    const value = 'x'.repeat(1990);
    expect(() => parseMetadata(`k=${value}`)).toThrow(
      'metadata is too large: 2073 bytes with the cloud-cache-sha256 entry; the S3 limit is 2048.'
    );
    expect(parseMetadata(`k=${'x'.repeat(1900)}`)).toEqual({ k: 'x'.repeat(1900) });
  });

  it('last duplicate wins', () => {
    expect(parseMetadata('a=1\nA=2')).toEqual({ a: '2' });
  });
});

describe('parseTags', () => {
  it('returns [] for empty input and parses pairs in order', () => {
    expect(parseTags('')).toEqual([]);
    expect(parseTags('Team=platform\nrepo=acme/app\nempty=')).toEqual([
      { Key: 'Team', Value: 'platform' },
      { Key: 'repo', Value: 'acme/app' },
      { Key: 'empty', Value: '' },
    ]);
  });

  it('rejects more than 10 tags', () => {
    const lines = Array.from({ length: 11 }, (_, i) => `k${i}=v`).join('\n');
    expect(() => parseTags(lines)).toThrow('"tags" allows at most 10 tags; got 11.');
  });

  it('rejects duplicate keys, case-sensitively', () => {
    expect(() => parseTags('a=1\na=2')).toThrow('Duplicate "tags" key "a".');
    expect(parseTags('a=1\nA=2')).toHaveLength(2);
  });

  it('rejects disallowed characters and over-long keys or values', () => {
    expect(() => parseTags('a#b=1')).toThrow('Invalid "tags" key "a#b"');
    expect(() => parseTags('a=1,2')).toThrow('Invalid "tags" value for "a"');
    expect(() => parseTags(`${'k'.repeat(129)}=1`)).toThrow('at most 128 characters');
    expect(() => parseTags(`k=${'v'.repeat(257)}`)).toThrow('at most 256 characters');
  });

  it('accepts a lower tag cap and names it in the error', () => {
    const nine = Array.from({ length: 9 }, (_, i) => `k${i}=v`).join('\n');
    expect(parseTags(nine, 'tags', 9)).toHaveLength(9);
    expect(() => parseTags(`${nine}\nk9=v`, 'tags', 9)).toThrow(
      '"tags" allows at most 9 tags; got 10.'
    );
  });

  it('appends the reserved checksum tag after the user tags', () => {
    expect(withChecksumTag([{ Key: 'team', Value: 'platform' }], 'abc')).toEqual([
      { Key: 'team', Value: 'platform' },
      { Key: 'cloud-cache-sha256', Value: 'abc' },
    ]);
  });
});

describe('encodeTagging and helpers', () => {
  it('URL-encodes tags as a query string, undefined when empty', () => {
    expect(encodeTagging([])).toBeUndefined();
    expect(
      encodeTagging([
        { Key: 'repo', Value: 'acme/app' },
        { Key: 'a b', Value: 'c=d' },
      ])
    ).toBe('repo=acme%2Fapp&a%20b=c%3Dd');
  });

  it('counts metadata bytes as key plus value lengths', () => {
    expect(metadataBytes({ ab: 'cde' })).toBe(5);
  });

  it('strips reserved keys', () => {
    expect(stripReservedMetadata({ 'cloud-cache-sha256': 'x', team: 'a' })).toEqual({ team: 'a' });
    expect(stripReservedMetadata(undefined)).toEqual({});
  });
});
