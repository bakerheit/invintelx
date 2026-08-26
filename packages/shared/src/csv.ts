/**
 * A CSV reader and writer, RFC 4180 shaped, with line numbers.
 *
 * Written here rather than pulled in as a dependency because the interesting
 * requirement is not "split on commas" — it is that a failure has to point at a
 * line the person can find in their spreadsheet. Most small parsers throw away
 * the position, and a record may span several physical lines when a field is
 * quoted, so the position cannot be recovered afterwards by counting newlines.
 *
 * Shared rather than server-only: the import screen parses the file locally to
 * offer the column mapping, and the server parses it again to decide what to
 * write. Both have to agree about what the file says, so both run this.
 */

/** A parsed record, with the 1-based line the record started on. */
export interface CsvRecord {
  line: number;
  fields: string[];
}

/**
 * A file that is not CSV at all. This is the failure the whole file is rejected
 * for — as opposed to a row whose *contents* are wrong, which is reported
 * per-row and leaves the rest of the file importable.
 */
export class CsvParseError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(message);
    this.name = 'CsvParseError';
  }
}

const QUOTE = '"';
const DELIMITER = ',';

/**
 * Excel writes a UTF-8 byte order mark and then reads its own files back
 * happily. Everything else sees it as an invisible character welded to the
 * first header, which turns "sku" into something that matches nothing.
 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Parse CSV text into records.
 *
 * `charAt` rather than `input[i]` throughout: it returns '' past the end, which
 * is a value the comparisons below can be written against without a cast, and
 * '' is not a character the grammar uses for anything.
 *
 * Blank lines are skipped rather than returned as a one-empty-field record: a
 * trailing newline is normal, and a file that ends in one should not report a
 * final row with a missing SKU.
 *
 * @throws {CsvParseError} on a quote the grammar cannot explain.
 */
export function parseCsv(text: string): CsvRecord[] {
  const input = stripBom(text);
  const records: CsvRecord[] = [];

  let fields: string[] = [];
  let field = '';
  let index = 0;
  let line = 1;
  let recordLine = 1;
  /*
   * Whether this record holds anything at all. A record of one empty field is
   * a blank line and gets dropped; a record of one *quoted* empty field, or of
   * two empty fields, was written deliberately and is kept.
   */
  let sawContent = false;
  /*
   * A quote only opens a quoted value at the very start of a field. Anywhere
   * else it is one of the characters in the value - which is what makes `3"
   * pipe` readable instead of a parse error.
   */
  let atFieldStart = true;

  const endField = () => {
    fields.push(field);
    field = '';
    atFieldStart = true;
  };

  const endRecord = () => {
    endField();
    if (sawContent || fields.length > 1) records.push({ line: recordLine, fields });
    fields = [];
    sawContent = false;
  };

  while (index < input.length) {
    const char = input.charAt(index);

    if (char === QUOTE && atFieldStart) {
      atFieldStart = false;
      sawContent = true;
      index += 1;
      // Inside a quoted field until a quote that is not doubled.
      for (;;) {
        if (index >= input.length) {
          throw new CsvParseError(
            'A quoted value is never closed - check for a stray " in the file',
            recordLine,
          );
        }
        const inner = input.charAt(index);
        if (inner === QUOTE) {
          if (input.charAt(index + 1) === QUOTE) {
            field += QUOTE;
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        if (inner === '\n') line += 1;
        field += inner;
        index += 1;
      }

      const next = input.charAt(index);
      if (next !== '' && next !== DELIMITER && next !== '\r' && next !== '\n') {
        throw new CsvParseError(
          'Unexpected text after a closing quote - a value containing " must double it as ""',
          recordLine,
        );
      }
      continue;
    }

    if (char === DELIMITER) {
      sawContent = true;
      endField();
      index += 1;
      continue;
    }

    if (char === '\r' || char === '\n') {
      // Treat CRLF as one terminator; a lone CR is an old Mac line ending.
      if (char === '\r' && input.charAt(index + 1) === '\n') index += 1;
      index += 1;
      line += 1;
      endRecord();
      recordLine = line;
      continue;
    }

    /*
     * A bare quote inside an unquoted field is taken literally. It is a common
     * export bug (`3" pipe`) and rejecting the whole file over it would be a
     * worse answer than importing the text the person clearly meant.
     */
    if (char.trim() !== '') sawContent = true;
    field += char;
    atFieldStart = false;
    index += 1;
  }

  if (sawContent || fields.length > 0 || field !== '') endRecord();

  return records;
}

/** True when writing this value unquoted would change what it means. */
function needsQuoting(value: string): boolean {
  if (value === '') return false;
  if (value.includes(QUOTE) || value.includes(DELIMITER)) return true;
  if (value.includes('\n') || value.includes('\r')) return true;
  // Leading or trailing space survives a round trip only inside quotes.
  return value !== value.trim();
}

function serializeField(value: string): string {
  return needsQuoting(value) ? `${QUOTE}${value.replaceAll(QUOTE, QUOTE + QUOTE)}${QUOTE}` : value;
}

/**
 * Render rows as CSV text, CRLF terminated as RFC 4180 asks, including after
 * the final row so appending to the file cannot join two records.
 */
export function serializeCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.map(serializeField).join(DELIMITER) + '\r\n').join('');
}
