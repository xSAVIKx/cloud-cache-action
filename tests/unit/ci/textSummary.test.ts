import { describe, expect, it } from '@jest/globals';
import { TextSummaryWriter } from '../../../src/ci/textSummary';
import { escapeHtml } from '../../../src/core/summary';

function writer() {
  const chunks: string[] = [];
  return { chunks, w: new TextSummaryWriter((t) => chunks.push(t)) };
}

describe('TextSummaryWriter', () => {
  it('prints a heading and aligned rows without HTML tags', async () => {
    const { chunks, w } = writer();
    await w
      .addHeading('Cache restore')
      .addTable([
        [
          { data: 'Key', header: true },
          { data: 'Value', header: true },
        ],
        ['key', 'k'],
      ])
      .write();
    const out = chunks.join('');
    expect(out).toContain('Cache restore');
    expect(out).toContain('Key  Value');
    expect(out).toContain('key  k');
    expect(out).not.toMatch(/<[^>]+>/);
  });

  it('decodes the entities of escapeHtml', async () => {
    const { chunks, w } = writer();
    await w
      .addRaw(`<p>Skipped: ${escapeHtml('a<b & "c">')}</p>`, true)
      .addTable([[escapeHtml('<x>'), escapeHtml('a&b')]])
      .write();
    const out = chunks.join('');
    expect(out).toContain('Skipped: a<b & "c">');
    expect(out).toContain('<x>');
    expect(out).toContain('a&b');
  });

  it('renders details and strips tags', async () => {
    const { chunks, w } = writer();
    await w.addDetails('Object metadata', '<ul><li><code>k</code>: v</li></ul>').write();
    const out = chunks.join('');
    expect(out).toContain('Object metadata');
    expect(out).toContain('- k: v');
    expect(out).not.toMatch(/<[^>]+>/);
  });

  it('emptyBuffer drops the text and an empty write prints nothing', async () => {
    const { chunks, w } = writer();
    await w.addHeading('x').emptyBuffer().write();
    await w.write();
    expect(chunks).toEqual([]);
  });

  it('clears the buffer after a write', async () => {
    const { chunks, w } = writer();
    await w.addHeading('x').write();
    await w.write();
    expect(chunks).toHaveLength(1);
  });
});
