import { describe, expect, it } from 'vitest';

import { SeatbeltAgentPolicy } from './agent-policy.ts';

const profile = new SeatbeltAgentPolicy({ home: '/Users/factory', writableRoots: ['/Volumes/dot/Project/factory/sandboxes'] }).render();
const at = (needle: string) => {
  const index = profile.indexOf(needle);
  expect(index, needle).toBeGreaterThan(-1);
  return index;
};

describe('SeatbeltAgentPolicy', () => {
  it('re-allows only after it denies (Seatbelt applies the last match)', () => {
    expect(at('(deny file-write*\n    (subpath "/"))')).toBeLessThan(at('(allow file-write*'));
    expect(at('(deny file-read*\n    (subpath "/Users"))')).toBeLessThan(at('(subpath "/Users/factory")'));
    expect(at('(deny file-read*\n    (subpath "/Volumes"))')).toBeLessThan(at('(subpath "/Volumes/dot/Project/factory/sandboxes")'));
  });

  it('denies raw devices after the /dev write allow, so the deny wins', () => {
    expect(at('(subpath "/dev")')).toBeLessThan(at('(regex #"^/dev/r?disk")'));
  });

  it('denies the Factory server and Chrome debugger ports by default', () => {
    at('(remote ip "localhost:5874")');
    at('(remote ip "localhost:9222")');
  });

  it('takes other ports and read-only folders', () => {
    const custom = new SeatbeltAgentPolicy({ home: '/h', writableRoots: ['/w'], readableRoots: ['/opt/tools'], deniedLocalPorts: [7000] }).render();
    expect(custom).toContain('(remote ip "localhost:7000")');
    expect(custom).not.toContain('5874');
    expect(custom).toContain('(subpath "/opt/tools")');
    expect(custom.match(/\(subpath "\/opt\/tools"\)/g)).toHaveLength(1);
  });
});
