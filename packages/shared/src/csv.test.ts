import { describe, expect, it } from 'vitest';
import { CsvParseError, parseCsv, serializeCsv } from './csv.js';

describe('parseCsv', () => {
  it('reads plain rows and reports the line each started on', () => {
    const records = parseCsv('sku,name\nA-1,Widget\nA-2,Gadget\n');
    expect(records).toEqual([
      { line: 1, fields: ['sku', 'name'] },
      { line: 2, fields: ['A-1', 'Widget'] },
      { line: 3, fields: ['A-2', 'Gadget'] },
    ]);
  });

  it('accepts CRLF, a lone CR, and a missing final newline', () => {
    expect(parseCsv('a,b\r\nc,d\rE,f').map((record) => record.fields)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['E', 'f'],
    ]);
  });

  it('strips the byte order mark Excel writes', () => {
    const withBom = String.fromCharCode(0xfeff) + 'sku,name\nA-1,Widget\n';
    expect(parseCsv(withBom)[0]?.fields).toEqual(['sku', 'name']);
  });

  it('keeps commas, quotes and newlines that are inside a quoted value', () => {
    const records = parseCsv('sku,name\nA-1,"Bolt, 3"" long\nwith a note"\nA-2,Plain\n');
    expect(records[1]?.fields).toEqual(['A-1', 'Bolt, 3" long\nwith a note']);
  });

  it('counts the embedded newline, so the row after a multi-line value has the right line', () => {
    const records = parseCsv('sku,name\nA-1,"two\nlines"\nA-2,Plain\n');
    expect(records[2]).toEqual({ line: 4, fields: ['A-2', 'Plain'] });
  });

  it('skips blank lines rather than reporting them as empty rows', () => {
    expect(parseCsv('sku\n\nA-1\n\n\n')).toEqual([
      { line: 1, fields: ['sku'] },
      { line: 3, fields: ['A-1'] },
    ]);
  });

  it('keeps a row of empty values, which is not the same as a blank line', () => {
    expect(parseCsv('a,b\n,\n')[1]?.fields).toEqual(['', '']);
  });

  it('takes a bare quote in an unquoted value literally', () => {
    expect(parseCsv('size\n3" pipe\n')[1]?.fields).toEqual(['3" pipe']);
  });

  it('rejects an unclosed quote, naming the line it started on', () => {
    try {
      parseCsv('sku,name\nA-1,"never closed\nA-2,Plain\n');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(CsvParseError);
      expect((error as CsvParseError).line).toBe(2);
    }
  });

  it('rejects text after a closing quote', () => {
    expect(() => parseCsv('sku,name\nA-1,"quoted"trailing\n')).toThrow(CsvParseError);
  });
});

describe('serializeCsv', () => {
  it('quotes only what would otherwise change meaning', () => {
    const csv = serializeCsv([
      ['sku', 'name', 'note'],
      ['A-1', 'Bolt, 3" long', 'plain'],
      ['A-2', ' padded ', 'two\nlines'],
    ]);
    expect(csv).toBe(
      'sku,name,note\r\nA-1,"Bolt, 3"" long",plain\r\nA-2," padded ","two\nlines"\r\n',
    );
  });

  it('round-trips anything the parser can read', () => {
    const rows = [
      ['sku', 'name', 'attr:Colour'],
      ['A-1', 'Bolt, 3" long', 'red'],
      ['A-2', 'two\nlines', ''],
      ['A-3', ' padded ', 'blue'],
    ];
    expect(parseCsv(serializeCsv(rows)).map((record) => record.fields)).toEqual(rows);
  });
});
