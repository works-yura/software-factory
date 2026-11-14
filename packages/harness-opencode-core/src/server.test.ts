// Starting `opencode serve` and probing it, against the fake server (t3code's OpenCode2Server,
// versionProbe, OpenCodeServerLedger/Owner and inventory scenarios; see opencode-test-parity.md).
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { probeOpenCode } from './probe.ts';
import { spawnOpenCodeServer, type OpenCodeSpawn } from './server.ts';
import { startFakeOpenCode, type FakeOpenCode } from './testkit.ts';

const password = 'pw-never-shown';
let fake: FakeOpenCode;

beforeEach(async () => {
  fake = await startFakeOpenCode();
});

afterEach(async () => {
  await fake.close();
});

const start = (overrides: Partial<Parameters<typeof spawnOpenCodeServer>[0]> = {}) =>
  spawnOpenCodeServer({ cwd: '/w', env: { PATH: '/bin', OPENCODE_SERVER_PASSWORD: password }, spawn: fake.spawn, ...overrides });

const settle = () => new Promise(resolve => setTimeout(resolve, 20));

/** A process that never says where it listens, or exits at once with `stderr`. */
function silentSpawn(exit?: { code: number; stderr: string }): { spawn: OpenCodeSpawn; signals: string[] } {
  const signals: string[] = [];
  const spawn: OpenCodeSpawn = () => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; pid: number; kill: (signal?: string) => boolean };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.pid = 0;
    let exited = false;
    child.kill = signal => {
      signals.push(signal ?? 'SIGTERM');
      if (!exited) {
        exited = true;
        setImmediate(() => child.emit('exit', null, signal ?? 'SIGTERM'));
      }
      return true;
    };
    if (exit) {
      setImmediate(() => {
        child.stderr.write(exit.stderr);
        setTimeout(() => {
          exited = true;
          child.emit('exit', exit.code, null);
        }, 10);
      });
    }
    return child as unknown as ChildProcessWithoutNullStreams;
  };
  return { spawn, signals };
}

describe('spawnOpenCodeServer', () => {
  it('starts on a loopback port of its own, behind its password, and is ready once its health route answers', async () => {
    const server = await start({ port: async () => 45_123 });
    expect(fake.spawns[0]).toMatchObject({ args: ['serve', '--hostname=127.0.0.1', '--port=45123'], env: { OPENCODE_SERVER_PASSWORD: password } });
    expect(server.version).toBe('1.19.5');
    expect(fake.authorizations.at(-1)).toBe(`Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`);
    server.terminate();
    await settle();
    expect(fake.alive()).toBe(0);
  });

  it('refuses to start without a password of its own', async () => {
    await expect(start({ env: { PATH: '/bin' } })).rejects.toMatchObject({ kind: 'process', message: expect.stringContaining('OPENCODE_SERVER_PASSWORD') });
    expect(fake.spawns).toEqual([]);
  });

  it.each([
    { name: 'a refused password', health: { status: 401, body: '{"error":"unauthorized"}' }, kind: 'auth', message: /refused the password/ },
    { name: 'a refused password with no body', health: { status: 401, body: '' }, kind: 'auth', message: /refused the password/ },
    { name: 'a server error', health: { status: 502, body: 'bad gateway' }, kind: 'process', message: /failed its health check \(HTTP 502\)/ },
    { name: 'the web UI’s HTML', health: { contentType: 'text/html', body: '<!doctype html><html></html>' }, kind: 'process', message: /not an OpenCode server/ },
    { name: 'JSON that is not a health answer', health: { body: '{"version":"3.4.1"}' }, kind: 'process', message: /without a version/ },
    { name: 'a version it cannot read', health: { body: '{"healthy":true,"version":"local"}' }, kind: 'process', message: /cannot read/ },
    { name: 'a version too old', health: { body: '{"healthy":true,"version":"1.14.18"}' }, kind: 'process', message: /1\.14\.18 is too old/ },
  ])('says what is wrong with $name, stops the process, and never shows the password', async ({ health, kind, message }) => {
    fake.health = health;
    const error = await start().catch((failure: unknown) => failure);
    expect(error).toMatchObject({ _tag: 'OpenCodeError', kind, message: expect.stringMatching(message) });
    expect(String((error as Error).message)).not.toContain(password);
    await settle();
    expect(fake.alive()).toBe(0);
    // Nothing went on to use a server it could not trust.
    expect(fake.sessions.size).toBe(0);
  });

  it('gives up a start that never says where it listens, stops it, and starts again after', async () => {
    const silent = silentSpawn();
    await expect(start({ spawn: silent.spawn, startTimeoutMs: 50 })).rejects.toMatchObject({ kind: 'timeout' });
    expect(silent.signals[0]).toBe('SIGTERM');
    const server = await start();
    expect(server.isAlive()).toBe(true);
    server.terminate();
  });

  it('says why a server exited before it was ready, with what it wrote', async () => {
    const dying = silentSpawn({ code: 1, stderr: 'Error: EADDRINUSE' });
    await expect(start({ spawn: dying.spawn })).rejects.toMatchObject({ kind: 'process', message: expect.stringContaining('EADDRINUSE') });
  });
});

describe('probeOpenCode', () => {
  it('lists the providers and stops its server', async () => {
    fake.providers = { all: [{ id: 'opencode', models: { 'big-pickle': { id: 'big-pickle', cost: { input: 0, output: 0 } } } }] };
    const root = await mkdtemp(join(tmpdir(), 'opencode-probe-'));
    const result = await probeOpenCode({ root, spawn: fake.spawn, env: { PATH: '/bin' } });
    expect(result).toEqual({ providers: fake.providers, version: '1.19.5' });
    expect(JSON.parse(fake.spawns[0]!.env.OPENCODE_CONFIG_CONTENT!).permission).toMatchObject({ edit: 'deny', bash: 'deny', webfetch: 'deny' });
    await settle();
    expect(fake.alive()).toBe(0);
  });

  it('gives up a server that never lists its providers, and stops it', async () => {
    fake.hangProviders = true;
    const root = await mkdtemp(join(tmpdir(), 'opencode-probe-'));
    await expect(probeOpenCode({ root, spawn: fake.spawn, env: { PATH: '/bin' }, listTimeoutMs: 100 })).rejects.toMatchObject({ kind: 'timeout' });
    await settle();
    expect(fake.alive()).toBe(0);
  });
});
