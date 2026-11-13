import { describe, expect, it } from 'vitest';

import { renderRule } from '../sbpl.ts';

import { allowReads, allowWrites, denyLocalPorts, denyRawDevices, SYSTEM_WRITABLE } from './index.ts';

const text = (section: { rules: readonly Parameters<typeof renderRule>[0][] }) => section.rules.map(renderRule).join('\n');

describe('rule sets', () => {
  it('reads: full access to the folders, only metadata above them', () => {
    const rendered = text(allowReads(['/Volumes/dot/Project/factory/sandboxes']));
    expect(rendered).toContain('(allow file-read-metadata\n    (literal "/Volumes")');
    expect(rendered).toContain('(allow file-read*\n    (subpath "/Volumes/dot/Project/factory/sandboxes"))');
    expect(rendered).not.toMatch(/file-read\*\n {4}\(literal/);
  });

  it('writes: the given folders plus temp folders and devices, once each', () => {
    const rendered = text(allowWrites(['/tmp', '/w']));
    for (const path of ['/w', ...SYSTEM_WRITABLE]) expect(rendered).toContain(`(subpath "${path}")`);
    expect(rendered.match(/"\/tmp"/g)).toHaveLength(1);
  });

  it('local ports: refuses what is not a TCP port, renders nothing for none', () => {
    expect(() => denyLocalPorts([0])).toThrow(RangeError);
    expect(() => denyLocalPorts([70000])).toThrow(RangeError);
    expect(denyLocalPorts([]).rules).toEqual([]);
  });

  it('raw devices: denies reads and writes', () => {
    expect(text(denyRawDevices())).toContain('(deny file-read* file-write*');
  });
});
