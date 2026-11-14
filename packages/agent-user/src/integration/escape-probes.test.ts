import { describe, expect, it } from 'vitest';

import { parseListeners, portProbes } from './escape-probes.ts';

describe('parseListeners', () => {
  it('reads lsof -F pcn output, one entry per address and port', () => {
    const output = ['p401', 'cControlCenter', 'f9', 'n*:7000', 'f10', 'n*:7000', 'p507', 'cClickUp', 'f19', 'n127.0.0.1:23435', 'p9', 'cnode', 'f3', 'n[::1]:5874'].join('\n');
    expect(parseListeners(output)).toEqual([
      { command: 'ControlCenter', address: '*', port: 7000 },
      { command: 'ClickUp', address: '127.0.0.1', port: 23435 },
      { command: 'node', address: '::1', port: 5874 },
    ]);
  });
});

describe('portProbes', () => {
  it('probes a wildcard listener on every local address and a bound one on its own', () => {
    const probes = portProbes(
      [
        { command: 'ControlCenter', address: '*', port: 7000 },
        { command: 'node', address: '127.0.0.1', port: 5874 },
      ],
      ['127.0.0.1', '192.168.1.5'],
    );
    expect(probes.map(probe => `${probe.host}:${probe.port}`)).toEqual(['127.0.0.1:7000', '192.168.1.5:7000', '127.0.0.1:5874']);
  });
});
