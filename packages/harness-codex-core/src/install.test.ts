import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { findCodexBinary } from './install.ts';

describe('findCodexBinary', () => {
  it('finds an executable codex on PATH or at an absolute path, and nothing otherwise', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-bin-'));
    const binary = join(dir, 'codex');
    writeFileSync(binary, '#!/bin/sh\n');
    chmodSync(binary, 0o755);
    expect(findCodexBinary('codex', { PATH: `/nowhere:${dir}` })).toBe(binary);
    expect(findCodexBinary(binary, {})).toBe(binary);
    expect(findCodexBinary('codex', { PATH: '/nowhere' })).toBeUndefined();
    expect(findCodexBinary(join(dir, 'missing'), {})).toBeUndefined();
  });
});
