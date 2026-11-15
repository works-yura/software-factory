import { describe, expect, it } from 'vitest';

import { findDeviceCode, findSignInUrl, stripTerminalEscapes } from './sign-in-output.ts';

const AUTHORIZE =
  'https://claude.com/cai/oauth/authorize?code=true&client_id=client-1&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference+user%3Aprofile&code_challenge=challenge-1&code_challenge_method=S256&state=state-1';
const HOSTS = ['claude.com', 'claude.ai', 'anthropic.com'];

describe('findSignInUrl', () => {
  it('reads the URL a piped CLI prints', () => {
    const text = `Opening browser to sign in…\nIf the browser didn't open, visit: ${AUTHORIZE}\nPaste code here if prompted > `;
    expect(findSignInUrl(text, HOSTS)).toBe(AUTHORIZE);
  });

  it('reads the URL inside an OSC 8 hyperlink (BEL or ST ended) once, not its target and text joined', () => {
    for (const end of ['\x07', '\x1b\\']) {
      const text = `If the browser didn't open, visit: \x1b]8;;${AUTHORIZE}${end}${AUTHORIZE}\x1b]8;;${end}\nPaste code here if prompted > `;
      expect(findSignInUrl(text, HOSTS)).toBe(AUTHORIZE);
    }
  });

  it('cuts a URL printed twice in a row, and keeps the first value of a repeated parameter', () => {
    expect(findSignInUrl(`visit: ${AUTHORIZE}${AUTHORIZE}\n`, HOSTS)).toBe(AUTHORIZE);
    const repeated = findSignInUrl(`visit: ${AUTHORIZE}&state=state-2&code=false\n`, HOSTS)!;
    const params = new URL(repeated).searchParams;
    expect(params.getAll('state')).toEqual(['state-1']);
    expect(params.getAll('code')).toEqual(['true']);
    expect(params.get('redirect_uri')).toBe('https://platform.claude.com/oauth/code/callback');
  });

  it('waits for the whole line, and shows no URL off the provider’s hosts or not https', () => {
    expect(findSignInUrl('Opening browser to sign in…', HOSTS)).toBeUndefined();
    expect(findSignInUrl('visit: https://evil.example/claude.com/authorize\n', HOSTS)).toBeUndefined();
    expect(findSignInUrl('visit: http://claude.com/cai/oauth/authorize\n', HOSTS)).toBeUndefined();
    expect(findSignInUrl('visit: https://user:pw@claude.com/x\n', HOSTS)).toBeUndefined();
    expect(findSignInUrl('visit: https://notclaude.com/x\n', HOSTS)).toBeUndefined();
    expect(findSignInUrl('see https://evil.example/x then https://auth.claude.com/x.\n', HOSTS)).toBe('https://auth.claude.com/x');
    // A URL at the very end may go on in the next piece of output.
    expect(findSignInUrl(`visit: ${AUTHORIZE.slice(0, 40)}`, HOSTS)).toBeUndefined();
  });
});

describe('findDeviceCode', () => {
  it('reads the one-time code Codex prints, colours and all', () => {
    const text =
      '\nWelcome to Codex [v\x1b[90m0.166.0\x1b[0m]\n\nFollow these steps to sign in with ChatGPT using device code authorization:\n\n' +
      '1. Open this link in your browser and sign in to your account\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n' +
      '2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94mABCD-EFGH1\x1b[0m\n';
    expect(findDeviceCode(text)).toBe('ABCD-EFGH1');
    expect(findSignInUrl(text, ['openai.com'])).toBe('https://auth.openai.com/codex/device');
    expect(findDeviceCode(text.slice(0, text.indexOf('ABCD')))).toBeUndefined();
    // Cut mid-code: the rest comes in the next piece.
    expect(findDeviceCode(text.slice(0, text.indexOf('ABCD') + 9))).toBeUndefined();
    expect(findDeviceCode('ABCD-EFGH1 without the words')).toBeUndefined();
  });

  it('strips colours and hyperlinks', () => {
    expect(stripTerminalEscapes('\x1b[94mhi\x1b[0m \x1b]8;;https://x.example\x07link\x1b]8;;\x07')).toBe('hi link');
  });
});
