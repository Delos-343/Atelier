import { describe, it, expect } from 'vitest';
import { toCsv } from '../csv';

describe('toCsv', () => {
  it('emits a header and rows joined with CRLF', () => {
    const csv = toCsv(
      ['A', 'B'],
      [
        ['1', '2'],
        ['3', '4'],
      ],
    );
    expect(csv).toBe('A,B\r\n1,2\r\n3,4');
  });

  it('quotes fields with commas, quotes, or newlines and doubles embedded quotes', () => {
    const csv = toCsv(['x'], [['a,b'], ['he said "hi"'], ['line1\nline2']]);
    expect(csv).toBe('x\r\n"a,b"\r\n"he said ""hi"""\r\n"line1\nline2"');
  });

  it('renders null/undefined as empty and coerces numbers', () => {
    const csv = toCsv(['a', 'b', 'c'], [[null, undefined, 42]]);
    expect(csv).toBe('a,b,c\r\n,,42');
  });
});
