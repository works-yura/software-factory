import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { nastyValue } from '../testing/fixtures.ts';

import { shellQuote } from './shell-quote.ts';

const echoThroughSh = (value: string) => spawnSync('/bin/sh', ['-c', `printf %s ${shellQuote(value)}`], { encoding: 'utf8' }).stdout;

function randomString(length: number, seed: number): string {
  let state = seed;
  let out = '';
  for (let i = 0; i < length; i++) {
    state = (state * 1_103_515_245 + 12_345) & 0x7fffffff;
    // Printable ASCII, quotes and controls but no NUL, plus a few non-ASCII code points.
    const code = state % 7 === 0 ? 0x400 + (state % 0x100) : 1 + (state % 126);
    out += String.fromCharCode(code);
  }
  return out;
}

describe('shellQuote', () => {
  it('survives a real shell unchanged: quotes, $(), backticks, globs, newlines', () => {
    expect(echoThroughSh(nastyValue)).toBe(nastyValue);
    expect(echoThroughSh("'")).toBe("'");
    expect(echoThroughSh('')).toBe('');
  });

  it('survives a real shell unchanged for 200 random strings', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const value = randomString(1 + (seed % 40), seed);
      expect(echoThroughSh(value), `seed ${seed}`).toBe(value);
    }
  });
});
