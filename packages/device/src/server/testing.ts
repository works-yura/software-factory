// Fakes for tests: a runtime whose process, network and clock seams fail loudly unless replaced.
import * as NodeFSP from 'node:fs/promises';
import * as NodeOS from 'node:os';
import * as NodePath from 'node:path';

import { type DeviceRuntime, type ProcessRunOutput, silentLogger } from './runtime.ts';

export const processOutput = (code: number | null, stdout = '', stderr = '', timedOut = false): ProcessRunOutput => ({
  code,
  stdout,
  stderr,
  timedOut,
});

const unexpected = (what: string) => () => {
  throw new Error(`Unexpected ${what} in this test`);
};

export const fakeRuntime = (overrides: Partial<DeviceRuntime> = {}): DeviceRuntime => ({
  platform: 'darwin',
  env: { PATH: '' },
  cwd: process.cwd(),
  uid: 1000,
  execPath: process.execPath,
  isExecutable: false,
  fs: NodeFSP,
  runner: { run: async () => unexpected('process run')() },
  spawn: async () => unexpected('process spawn')(),
  fetch: async () => unexpected('network request')(),
  reserveLoopbackPort: async () => 45_678,
  now: () => Date.now(),
  log: silentLogger,
  ...overrides,
});

/** A temporary directory removed by the returned cleanup. */
export const tempDir = async (prefix: string) => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix));
  return { directory, cleanup: () => NodeFSP.rm(directory, { recursive: true, force: true }) };
};

/** A never-settling promise that rejects when `signal` aborts, like a request to a hung server. */
export const hang = <T>(signal: AbortSignal | null | undefined): Promise<T> =>
  new Promise<T>((_, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
