import { describe, expect, it } from 'vitest';

import { MAX_SANDBOX_ENV_VALUE_LENGTH, parseDotenv, reviewImport } from './dotenv';

describe('parseDotenv', () => {
  it('reads plain assignments, export, comments, blank lines and empty values', () => {
    const text = ['﻿# comment', '', 'export API_KEY=sk-1', '  SPACED = value  ', 'EMPTY=', 'URL=http://x # note'].join(
      '\r\n',
    );

    expect(parseDotenv(text)).toEqual({
      entries: [
        { key: 'API_KEY', value: 'sk-1', line: 3 },
        { key: 'SPACED', value: 'value', line: 4 },
        { key: 'EMPTY', value: '', line: 5 },
        { key: 'URL', value: 'http://x', line: 6 },
      ],
      problems: [],
    });
  });

  it('keeps = inside values and # without a space before it', () => {
    expect(parseDotenv('DATABASE_URL=postgres://u:p@h:5432/db?sslmode=require\nCOLOR=#fff\nHASH=a#b').entries).toEqual([
      { key: 'DATABASE_URL', value: 'postgres://u:p@h:5432/db?sslmode=require', line: 1 },
      { key: 'COLOR', value: '#fff', line: 2 },
      { key: 'HASH', value: 'a#b', line: 3 },
    ]);
  });

  it('unquotes values: escapes in double quotes, literal single and backtick quotes, comments after', () => {
    const text = [
      'DOUBLE="a \\"b\\" \\n c # not a comment"',
      "SINGLE='a \\n b' # comment",
      'TICK=`x "y" z`',
      'SPACES="  padded  "',
      'EMPTY_QUOTED=""',
    ].join('\n');

    expect(parseDotenv(text)).toEqual({
      entries: [
        { key: 'DOUBLE', value: 'a "b" \n c # not a comment', line: 1 },
        { key: 'SINGLE', value: 'a \\n b', line: 2 },
        { key: 'TICK', value: 'x "y" z', line: 3 },
        { key: 'SPACES', value: '  padded  ', line: 4 },
        { key: 'EMPTY_QUOTED', value: '', line: 5 },
      ],
      problems: [],
    });
  });

  it('reads a quoted value across lines and goes on after it', () => {
    const text = ['PRIVATE_KEY="-----BEGIN KEY-----', 'MIIabc', '-----END KEY-----"', 'NEXT=1'].join('\n');

    expect(parseDotenv(text).entries).toEqual([
      { key: 'PRIVATE_KEY', value: '-----BEGIN KEY-----\nMIIabc\n-----END KEY-----', line: 1 },
      { key: 'NEXT', value: '1', line: 4 },
    ]);
  });

  it('reports lines it cannot read instead of dropping them, never with the value', () => {
    const text = ['JUST_A_WORD', '=nameless', 'OPEN="never closed', 'AFTER=1', 'TRAIL="ok" extra'].join('\n');

    expect(parseDotenv(text)).toEqual({
      entries: [{ key: 'AFTER', value: '1', line: 4 }],
      problems: [
        { line: 1, problem: 'missingEquals' },
        { line: 2, problem: 'missingName' },
        { line: 3, problem: 'unterminatedQuote', key: 'OPEN' },
        { line: 5, problem: 'textAfterQuote', key: 'TRAIL' },
      ],
    });
  });
});

describe('reviewImport', () => {
  it('flags overwrites, duplicates (last wins) and names or values the server refuses', () => {
    const rows = reviewImport(
      [
        { key: 'API_KEY', value: 'old', line: 1 },
        { key: 'EXISTING', value: 'v', line: 2 },
        { key: 'API_KEY', value: 'new', line: 3 },
        { key: '1BAD', value: 'v', line: 4 },
        { key: 'GH_TOKEN', value: 'v', line: 5 },
        { key: 'toString', value: 'v', line: 6 },
        { key: 'BIG', value: 'x'.repeat(MAX_SANDBOX_ENV_VALUE_LENGTH + 1), line: 7 },
        { key: 'NUL', value: 'a\0b', line: 8 },
      ],
      new Set(['EXISTING']),
    );

    expect(rows.map(({ key, line, problem, replacedBy, overwrites }) => ({ key, line, problem, replacedBy, overwrites }))).toEqual([
      { key: 'API_KEY', line: 1, problem: 'duplicate', replacedBy: 3, overwrites: false },
      { key: 'EXISTING', line: 2, problem: undefined, replacedBy: undefined, overwrites: true },
      { key: 'API_KEY', line: 3, problem: undefined, replacedBy: undefined, overwrites: false },
      { key: '1BAD', line: 4, problem: 'invalidName', replacedBy: undefined, overwrites: false },
      { key: 'GH_TOKEN', line: 5, problem: 'reserved', replacedBy: undefined, overwrites: false },
      { key: 'toString', line: 6, problem: 'invalidName', replacedBy: undefined, overwrites: false },
      { key: 'BIG', line: 7, problem: 'valueTooLong', replacedBy: undefined, overwrites: false },
      { key: 'NUL', line: 8, problem: 'valueNul', replacedBy: undefined, overwrites: false },
    ]);
  });
});
