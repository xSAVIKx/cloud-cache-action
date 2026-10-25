import type { SummaryTableRow, SummaryWriter } from './host';

const ENTITIES: [RegExp, string][] = [
  [/&lt;/g, '<'],
  [/&gt;/g, '>'],
  [/&quot;/g, '"'],
  [/&#39;/g, "'"],
  [/&amp;/g, '&'],
];

/** Turns the HTML of the shared summary code into plain text. */
function toText(html: string): string {
  let text = html
    .replace(/<li>/gi, '- ')
    .replace(/<\/(li|p|pre|ul|summary)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '');
  for (const [pattern, replacement] of ENTITIES) {
    text = text.replace(pattern, replacement);
  }
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

/** A summary writer for hosts without a summary page. It prints plain text on write. */
export class TextSummaryWriter implements SummaryWriter {
  private buffer: string[] = [];

  constructor(private readonly out: (text: string) => void = (t) => process.stdout.write(t)) {}

  addHeading(text: string, level = 1): this {
    this.buffer.push(`${'#'.repeat(Math.min(Math.max(level, 1), 6))} ${toText(text)}\n`);
    return this;
  }

  addRaw(text: string, addEOL = false): this {
    this.buffer.push(toText(text) + (addEOL ? '\n' : ''));
    return this;
  }

  addTable(rows: SummaryTableRow[]): this {
    const cells = rows.map((row) =>
      row.map((cell) => toText(typeof cell === 'string' ? cell : cell.data))
    );
    const widths: number[] = [];
    for (const row of cells) {
      row.forEach((cell, i) => {
        widths[i] = Math.max(widths[i] ?? 0, cell.length);
      });
    }
    for (const row of cells) {
      this.buffer.push(
        `${row
          .map((cell, i) => cell.padEnd(widths[i] ?? 0))
          .join('  ')
          .trimEnd()}\n`
      );
    }
    return this;
  }

  addDetails(label: string, content: string): this {
    this.buffer.push(`${toText(label)}:\n${toText(content)}\n`);
    return this;
  }

  emptyBuffer(): this {
    this.buffer = [];
    return this;
  }

  async write(): Promise<this> {
    if (this.buffer.length > 0) {
      const text = this.buffer.join('');
      this.buffer = [];
      this.out(text.endsWith('\n') ? text : `${text}\n`);
    }
    return this;
  }
}
