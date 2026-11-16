import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import type { ExecutableSandbox } from './materialization.ts';
import { openFileIn, SessionFileError, sessionFilePath } from './session-files.ts';
import { hostExecutor } from './template/host-exec.ts';

const run = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A sandbox whose commands run in a shell on this host, like a local sandbox without an agent user. */
function hostSandbox(seen: string[] = []): ExecutableSandbox {
  return {
    executeCommand: async (command, args = []) => {
      seen.push(args[1] ?? command);
      try {
        const { stdout, stderr } = await run(command, args, { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });
        return { exitCode: 0, stdout, stderr };
      } catch (error) {
        const failed = error as { code?: number; stdout?: string; stderr?: string };
        return { exitCode: typeof failed.code === 'number' ? failed.code : 1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
      }
    },
  } as ExecutableSandbox;
}

async function folder() {
  const root = await mkdtemp(join(tmpdir(), 'session-files-'));
  roots.push(root);
  return root;
}

async function collect(content: AsyncIterable<Uint8Array>) {
  const parts: Buffer[] = [];
  for await (const chunk of content) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts);
}

describe('sessionFilePath', () => {
  it('takes a path relative to the folder or absolute inside it, and nothing outside', () => {
    expect(sessionFilePath('/w/card', 'build/app.apk')).toEqual({ absolute: '/w/card/build/app.apk', relative: 'build/app.apk' });
    expect(sessionFilePath('/w/card', '/w/card/out/a.zip').relative).toBe('out/a.zip');
    for (const outside of ['../other/x', '/etc/passwd', '/w/card-2/x', '.', '', 'a/../../x']) {
      expect(() => sessionFilePath('/w/card', outside), outside).toThrow(SessionFileError);
    }
  });
});

describe('openFileIn', () => {
  it('reads the file through the sandbox in chunks, byte for byte', async () => {
    const root = await folder();
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 123);
    for (let index = 0; index < bytes.length; index++) bytes[index] = (index * 31) % 256;
    await mkdir(join(root, 'build'), { recursive: true });
    await writeFile(join(root, 'build', 'app-release.apk'), bytes);
    const seen: string[] = [];

    const file = await openFileIn(hostSandbox(seen), root, { path: 'build/app-release.apk', maxBytes: 10 * 1024 * 1024, chunkBytes: 1024 * 1024 });

    expect(file).toMatchObject({ name: 'app-release.apk', relativePath: 'build/app-release.apk', size: bytes.length });
    expect((await collect(file.content)).equals(bytes)).toBe(true);
    expect(seen.filter(script => script.startsWith('dd '))).toHaveLength(3);
  });

  it('reads a large build whole through the host executor the local sandbox uses, in full-size chunks', async () => {
    // The executor kept only a 256 KB tail of a command's output; a 4 MB chunk comes out as 5.6 MB of
    // base64, so every download over a chunk failed as "changed while it was read".
    const root = await folder();
    const bytes = Buffer.alloc(9 * 1024 * 1024 + 321);
    for (let index = 0; index < bytes.length; index++) bytes[index] = (index * 131) % 256;
    await writeFile(join(root, 'app-release.apk'), bytes);

    const file = await openFileIn(hostExecutor(), root, { path: 'app-release.apk', maxBytes: 64 * 1024 * 1024 });

    expect((await collect(file.content)).equals(bytes)).toBe(true);
  });

  it('reads an empty file', async () => {
    const root = await folder();
    await writeFile(join(root, 'empty.txt'), '');
    const file = await openFileIn(hostSandbox(), root, { path: 'empty.txt', maxBytes: 10 });
    expect(file.size).toBe(0);
    expect((await collect(file.content)).length).toBe(0);
  });

  it('refuses a file over the limit before reading it', async () => {
    const root = await folder();
    await writeFile(join(root, 'big.bin'), Buffer.alloc(100));
    const seen: string[] = [];
    await expect(openFileIn(hostSandbox(seen), root, { path: 'big.bin', maxBytes: 99 })).rejects.toMatchObject({ reason: 'too_large' });
    expect(seen.some(script => script.startsWith('dd '))).toBe(false);
  });

  it('refuses what is missing or is not a regular file', async () => {
    const root = await folder();
    await mkdir(join(root, 'build'));
    await expect(openFileIn(hostSandbox(), root, { path: 'nope.apk', maxBytes: 10 })).rejects.toMatchObject({ reason: 'not_a_file' });
    await expect(openFileIn(hostSandbox(), root, { path: 'build', maxBytes: 10 })).rejects.toMatchObject({ reason: 'not_a_file' });
  });

  it('runs every read as a command of the sandbox, so a link is followed with the agent’s rights', async () => {
    const root = await folder();
    const outside = await folder();
    await writeFile(join(outside, 'secret'), 'owner data');
    await symlink(join(outside, 'secret'), join(root, 'link.apk'));
    const seen: string[] = [];
    // Here the "agent" may read the target, so the read succeeds — through the sandbox, never in-process.
    const file = await openFileIn(hostSandbox(seen), root, { path: 'link.apk', maxBytes: 100 });
    expect((await collect(file.content)).toString()).toBe('owner data');
    expect(seen.length).toBeGreaterThan(1);
  });
});
