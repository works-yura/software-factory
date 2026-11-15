import { describe, expect, it } from 'vitest';

import { hubAuthorization, hubSessionTokenOf, withoutHubSessionToken } from './hubSessionToken.ts';

const startup = '  Local:   http://localhost:51234/?token=Ab-9_x.~Z';

describe('hub session token', () => {
  it('reads the token from the link in the startup message and nothing from other lines', () => {
    expect(hubSessionTokenOf(startup)).toBe('Ab-9_x.~Z');
    expect(hubSessionTokenOf('Expo Device Hub ready')).toBeUndefined();
    expect(hubSessionTokenOf('  Network: pass --host 0.0.0.0 to expose on your local network')).toBeUndefined();
  });

  it('keeps the token out of logged lines', () => {
    expect(withoutHubSessionToken(startup)).toBe('  Local:   http://localhost:51234/?token=<token>');
    expect(withoutHubSessionToken('Expo Device Hub ready')).toBe('Expo Device Hub ready');
  });

  it('authorizes with a bearer header, as the hub expects', () => {
    expect(hubAuthorization('t')).toEqual({ authorization: 'Bearer t' });
  });
});
