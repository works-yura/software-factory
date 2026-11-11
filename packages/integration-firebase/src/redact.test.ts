import { describe, expect, it } from 'vitest';

import { redactAndCut, redactDeep, redactText } from './redact.ts';

describe('redactText', () => {
  it.each([
    ['email', 'user anna.koval@example.com booked', 'user [email] booked'],
    ['phone', 'call +380 67 123 45 67 now', 'call [phone] now'],
    ['phone without plus', 'tel 067-123-45-67.', 'tel [phone].'],
    ['ipv4', 'from 203.0.113.42:443', 'from [ip]:443'],
    ['ipv6', 'from 2001:db8:85a3:0:0:8a2e:370:7334', 'from [ip]'],
    ['bearer', 'Authorization: Bearer abc.def-123456789', 'Authorization: Bearer [redacted-token]'],
    ['jwt', 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig_part-123', 'token [redacted-jwt]'],
    ['google key', 'key AIzaSyD-abcdefghijklmnopqrstuvwxyz012345', 'key [redacted-key]'],
    ['stripe key', 'sk_live_51HxQwErTyUiOp', '[redacted-key]'],
    ['secret pair', 'password=hunter2!!', 'password=[redacted]'],
    ['json secret', '{"api_key": "abcd1234efgh"}', '{"api_key": "[redacted]"}'],
  ])('masks %s', (_name, input, expected) => {
    expect(redactText(input)).toBe(expected);
  });

  it('keeps ordinary log text, versions, ids and timestamps', () => {
    const text = 'GET /api/bookings/42 500 in 1234 ms, version 2.4.1, at 2026-11-11T10:00:00Z';
    expect(redactText(text)).toBe(text);
  });

  it('masks a private key block', () => {
    expect(redactText('-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----')).toBe('[redacted-private-key]');
  });
});

describe('redactAndCut / redactDeep', () => {
  it('cuts after redacting and marks the cut', () => {
    expect(redactAndCut(`a@b.co ${'x'.repeat(50)}`, 10)).toBe('[email] xx…');
  });

  it('redacts every string in nested values and leaves the rest', () => {
    expect(redactDeep({ a: ['x@y.io', 3], b: { c: '10.0.0.1', d: null } })).toEqual({
      a: ['[email]', 3],
      b: { c: '[ip]', d: null },
    });
  });
});
