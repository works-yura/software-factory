// Exercises concurrent real CLI subprocesses.
import * as NodeChildProcess from 'node:child_process';
import * as NodeFSP from 'node:fs/promises';
import * as NodeNet from 'node:net';
import * as NodePath from 'node:path';
import * as NodeUtil from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
  agentDeviceCloseOutcome,
  type AgentDeviceShimRuntime,
  bindAgentDeviceLauncher,
  ensureAgentDeviceShim,
  pruneAgentDeviceLaunchers,
} from './AgentDeviceShim.ts';
import { agentDeviceConfigPath, agentDeviceSession, writeAgentDeviceConfig } from './AgentDeviceTarget.ts';
import { fileExists } from './runtime.ts';
import { tempDir } from './testing.ts';

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const windows = process.platform === 'win32';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const temp = async (prefix: string) => {
  const { directory, cleanup } = await tempDir(prefix);
  cleanups.push(cleanup);
  return directory;
};

const shimRuntime = (overrides: Partial<AgentDeviceShimRuntime> = {}): AgentDeviceShimRuntime => ({
  fs: NodeFSP,
  platform: process.platform,
  env: process.env,
  execPath: process.execPath,
  isExecutable: false,
  ...overrides,
});

/** A loopback port that accepts connections until the test ends, like the device connection. */
const listeningPort = async () => {
  const server = await new Promise<NodeNet.Server>((resolve) => {
    const created = NodeNet.createServer((socket) => socket.destroy());
    created.listen(0, '127.0.0.1', () => resolve(created));
  });
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return (server.address() as NodeNet.AddressInfo).port;
};

describe('host-bound agent commands', () => {
  it.skipIf(windows)(
    'runs both desktop hops as Node with a stripped environment, preserving arguments and exit code',
    async () => {
      const root = await temp('device-target-');
      const dir = NodePath.join(root, 'quotes \'" $HOME `literal`');
      await NodeFSP.mkdir(dir);
      const desktopApp = NodePath.join(dir, 'Desktop App');
      // Dropping Node mode after checking it forces each hop to set it independently.
      await NodeFSP.writeFile(
        desktopApp,
        `#!/bin/sh
if [ "\${ELECTRON_RUN_AS_NODE:-}" != "1" ]; then
  echo "started the desktop app" >&2
  exit 134
fi
unset ELECTRON_RUN_AS_NODE
exec '${process.execPath.replaceAll("'", `'"'"'`)}' "$@"
`,
      );
      await NodeFSP.chmod(desktopApp, 0o755);
      const entryPath = NodePath.join(dir, 'cli.mjs');
      await NodeFSP.writeFile(entryPath, 'console.log(JSON.stringify(process.argv.slice(2))); process.exitCode = 23;');
      const shim = await ensureAgentDeviceShim(shimRuntime({ execPath: desktopApp }), { entryPath, stateDir: dir });
      const args = ['snapshot', '--config', NodePath.join(dir, 'config.json'), '--session', 'a!b!c', ''];
      await expect(
        exec(NodePath.join(shim, 'agent-device'), args, { env: { PATH: process.env.PATH ?? '', HOME: root } }),
      ).rejects.toMatchObject({ code: 23, stdout: `${JSON.stringify(args)}\n`, stderr: '' });
    },
  );

  it("binds one device's flags into its launcher and leaves help alone", async () => {
    const dir = await temp('device-bound-');
    const entryPath = NodePath.join(dir, 'cli.mjs');
    await NodeFSP.writeFile(entryPath, 'console.log(JSON.stringify(process.argv.slice(2)));');
    const target = ['--platform', 'ios', '--udid', 'UDID-1', '--config', '/h.json', '--session', 't3-a'];
    const runtime = shimRuntime();
    const command = await bindAgentDeviceLauncher(runtime, { entryPath, stateDir: dir, session: 't3-a', targetArgs: target });
    const shared = await ensureAgentDeviceShim(runtime, { entryPath, stateDir: dir });
    const launch = (launcher: string, args: ReadonlyArray<string>) =>
      exec(process.execPath, [NodePath.join(launcher, 'agent-device-launcher.mjs'), ...args]).then((result) =>
        JSON.parse(result.stdout),
      );
    const bound = NodePath.dirname(command);
    expect(await launch(bound, ['snapshot', '-i'])).toEqual(['snapshot', '-i', ...target]);
    // A flag the agent passes itself wins over the bound one.
    expect(await launch(bound, ['open', '--session', 'mine'])).toEqual([
      'open',
      '--session',
      'mine',
      '--platform',
      'ios',
      '--udid',
      'UDID-1',
      '--config',
      '/h.json',
    ]);
    expect(await launch(bound, ['snapshot', '--session=mine'])).toEqual([
      'snapshot',
      '--session=mine',
      '--platform',
      'ios',
      '--udid',
      'UDID-1',
      '--config',
      '/h.json',
    ]);
    // After `--` everything is text: no help, no overrides, and bound flags go before it.
    for (const text of [['--help'], ['literal text', '--session', 'mine']]) {
      expect(await launch(bound, ['fill', '@e5', '--', ...text])).toEqual(['fill', '@e5', ...target, '--', ...text]);
    }
    expect(await launch(shared, ['snapshot', '--config=/h.json', '--session=t3-a'])).toEqual([
      'snapshot',
      '--config=/h.json',
      '--session=t3-a',
    ]);
    await expect(launch(shared, ['fill', '@e5', '--', '--config', '/h.json', '--session', 't3-a'])).rejects.toThrow(
      'Call device_open first',
    );
    for (const args of [['help', 'gesture'], ['open', '--help'], ['record', '-h'], []]) {
      expect(await launch(bound, args)).toEqual(args);
      expect(await launch(shared, args)).toEqual(args);
    }
    await NodeFSP.rm(entryPath);
    await expect(launch(bound, ['snapshot'])).rejects.toThrow('Call device_open again');
  });

  it('passes each command only the bound flags agent-device accepts for it', async () => {
    const dir = await temp('device-commands-');
    const entryPath = NodePath.join(dir, 'cli.mjs');
    await NodeFSP.writeFile(entryPath, 'console.log(JSON.stringify(process.argv.slice(2)));');
    const command = await bindAgentDeviceLauncher(shimRuntime(), {
      entryPath,
      stateDir: dir,
      session: 't3-a',
      targetArgs: ['--platform', 'ios', '--udid', 'UDID-1', '--config', '/h.json', '--session', 't3-a'],
    });
    const launch = (args: ReadonlyArray<string>) =>
      exec(process.execPath, [NodePath.join(NodePath.dirname(command), 'agent-device-launcher.mjs'), ...args]).then(
        (result) => JSON.parse(result.stdout),
      );
    // agent-device 0.21.31 rejects these flags with "unknown option" or "not supported for command".
    const cdp = ['cdp', 'target', 'list', '--url', 'http://127.0.0.1:8081'];
    expect(await launch(cdp)).toEqual(cdp);
    expect(await launch(['connection'])).toEqual(['connection', '--config', '/h.json', '--session', 't3-a']);
    // The command is found past leading flags and their values, in either form.
    for (const config of [['--config', '/o.json'], ['--config=/o.json']]) {
      expect(await launch([...config, 'connection'])).toEqual([...config, 'connection', '--session', 't3-a']);
      // device status reads claims on the machine it runs on, which is not the device's host.
      await expect(launch([...config, 'device', 'status'])).rejects.toThrow(
        "`device status` reads this machine's device claims, not those on the device's host",
      );
    }
    expect(await launch(['--json', ...cdp])).toEqual(['--json', ...cdp]);
    for (const managed of [
      ['connect'],
      ['disconnect'],
      ['auth', 'status'],
      ['daemon', 'stop'],
      ['--config', '/o.json', 'auth', 'status'],
      ['--', 'connect'],
    ]) {
      await expect(launch(managed)).rejects.toThrow(
        `Factory manages this command's connection to the device, so \`${managed.find((arg) => ['connect', 'disconnect', 'auth', 'daemon'].includes(arg))}\` is not available through it.`,
      );
    }
  });

  it('tells a released session from a close that failed or timed out', () => {
    const result = (code: number | null, stderr = '', timedOut = false) => ({ stdout: '', stderr, code, timedOut });
    expect(agentDeviceCloseOutcome(result(0))).toBe('closed');
    // A session that never ran `open` has nothing to release.
    expect(agentDeviceCloseOutcome(result(1, 'Error (SESSION_NOT_FOUND): No active session. Run open first.'))).toBe(
      'no-session',
    );
    expect(agentDeviceCloseOutcome(result(1, 'Error (COMMAND_FAILED): Remote daemon is unavailable'))).toBe('failed');
    expect(agentDeviceCloseOutcome(result(null, '', true))).toBe('timed-out');
  });

  it("stops before agent-device when the server's device connection is down", async () => {
    const dir = await temp('device-endpoint-');
    const entryPath = NodePath.join(dir, 'cli.mjs');
    await NodeFSP.writeFile(entryPath, 'console.log(JSON.stringify(process.argv.slice(2)));');
    const configPath = NodePath.join(dir, 'host.json');
    // A port that was just free: nothing listens on it, so a connect is refused.
    const port = await new Promise<number>((resolve) => {
      const server = NodeNet.createServer();
      server.listen(0, '127.0.0.1', () => {
        const address = server.address() as NodeNet.AddressInfo;
        server.close(() => resolve(address.port));
      });
    });
    await writeAgentDeviceConfig(NodeFSP, configPath, { baseUrl: `http://127.0.0.1:${port}`, token: 'secret' });
    const command = await bindAgentDeviceLauncher(shimRuntime(), {
      entryPath,
      stateDir: dir,
      session: 't3-a',
      targetArgs: ['--config', configPath, '--session', 't3-a'],
    });
    const launch = (args: ReadonlyArray<string>) =>
      exec(process.execPath, [NodePath.join(NodePath.dirname(command), 'agent-device-launcher.mjs'), ...args]);
    await expect(launch(['screenshot', '/tmp/shot.png'])).rejects.toMatchObject({
      code: 1,
      stdout: '',
      stderr: `Factory's device connection at 127.0.0.1:${port} is not reachable from this shell (connect ECONNREFUSED). Call device_open again to reconnect; if that succeeds and this repeats, this shell runs in a network sandbox, so run the command with network access, outside the sandbox.\n`,
    });
    // An explicit --daemon-base-url wins over the config, as it does in agent-device.
    const override = `http://127.0.0.1:${await listeningPort()}`;
    for (const flag of [['--daemon-base-url', override], [`--daemon-base-url=${override}`]]) {
      expect(JSON.parse((await launch(['screenshot', '/tmp/shot.png', ...flag])).stdout)).toEqual([
        'screenshot',
        '/tmp/shot.png',
        ...flag,
        '--config',
        configPath,
        '--session',
        't3-a',
      ]);
    }
    // cdp talks to Metro, not to the device connection, so it still runs.
    expect(JSON.parse((await launch(['cdp', 'target', 'list'])).stdout)).toEqual(['cdp', 'target', 'list']);
  });

  it('prunes the launchers of ended sessions and keeps the shared one', async () => {
    const stateDir = await temp('device-prune-');
    const entryPath = NodePath.join(stateDir, 'cli.mjs');
    const runtime = shimRuntime();
    const shared = await ensureAgentDeviceShim(runtime, { entryPath, stateDir });
    const bind = (session: string) => bindAgentDeviceLauncher(runtime, { entryPath, stateDir, session, targetArgs: [] });
    const kept = await bind('t3-open');
    const ended = await bind('t3-closed');
    await pruneAgentDeviceLaunchers(runtime, { stateDir, live: new Set(['t3-open']) });
    expect(await fileExists(NodeFSP, kept)).toBe(true);
    expect(await fileExists(NodeFSP, NodePath.dirname(ended))).toBe(false);
    expect(await fileExists(NodeFSP, shared)).toBe(true);
    await pruneAgentDeviceLaunchers(runtime, { stateDir, live: new Set() });
    expect(await NodeFSP.readdir(NodePath.join(stateDir, 'device', 'targets'))).toEqual([]);
  });

  it.skipIf(windows)('tells the agent to reopen the device when the runtime it was bound to is gone', async () => {
    const dir = await temp('device-stale-');
    const runtimePath = NodePath.join(dir, 'old-node');
    await NodeFSP.writeFile(runtimePath, '#!/bin/sh\nexit 0\n');
    await NodeFSP.chmod(runtimePath, 0o755);
    const command = await bindAgentDeviceLauncher(shimRuntime({ execPath: runtimePath }), {
      entryPath: NodePath.join(dir, 'cli.mjs'),
      stateDir: dir,
      session: 't3-a',
      targetArgs: ['--config', '/h.json', '--session', 't3-a'],
    });
    await NodeFSP.rm(runtimePath);
    await expect(exec(command, ['snapshot'])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('Call device_open again'),
    });
  });

  it('runs two hosts concurrently and only updates the reconnected host', async () => {
    const root = await temp('device-target-');
    const dir = NodePath.join(root, windows ? 'paths with spaces' : 'quotes \'" $HOME `literal`');
    await NodeFSP.mkdir(dir);
    const entryPath = NodePath.join(dir, 'cli.mjs');
    await NodeFSP.writeFile(
      entryPath,
      `import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
console.log(readFileSync(args[args.indexOf('--config') + 1], 'utf8'));
if (process.env.AGENT_DEVICE_DAEMON_BASE_URL) process.exit(2);`,
    );
    // A packaged binary runs tools with the node on PATH.
    const shim = await ensureAgentDeviceShim(shimRuntime({ isExecutable: true, execPath: '/packaged/app' }), {
      entryPath,
      stateDir: dir,
    });
    const files = ['mini', 'android'].map((host) => agentDeviceConfigPath(dir, host));
    const ports = [await listeningPort(), await listeningPort(), await listeningPort()];
    for (const [index, file] of files.entries())
      await writeAgentDeviceConfig(NodeFSP, file, { baseUrl: `http://127.0.0.1:${ports[index]}`, token: `token-${index}` });
    const invoke = (file: string) =>
      exec(
        windows ? process.execPath : NodePath.join(shim, 'agent-device'),
        [
          ...(windows ? [NodePath.join(shim, 'agent-device-launcher.mjs')] : []),
          'snapshot',
          '--config',
          file,
          '--session',
          'test-session',
        ],
        { env: { ...process.env, AGENT_DEVICE_DAEMON_BASE_URL: 'http://wrong-host' } },
      ).then((result) => JSON.parse(result.stdout));
    expect(await Promise.all(files.map(invoke))).toEqual([
      { daemonBaseUrl: `http://127.0.0.1:${ports[0]}`, daemonAuthToken: 'token-0' },
      { daemonBaseUrl: `http://127.0.0.1:${ports[1]}`, daemonAuthToken: 'token-1' },
    ]);
    const second = await NodeFSP.readFile(files[1]!, 'utf8');
    await writeAgentDeviceConfig(NodeFSP, files[0]!, { baseUrl: `http://127.0.0.1:${ports[2]}`, token: 'new' });
    expect((await invoke(files[0]!)).daemonAuthToken).toBe('new');
    expect(await NodeFSP.readFile(files[1]!, 'utf8')).toBe(second);
    // Hosts with a daemon per device get a file per device, apart from the host's own.
    const perDevice = ['udid-1', 'udid-2'].map((device) => agentDeviceConfigPath(dir, 'cloud', device));
    expect(new Set([...perDevice, agentDeviceConfigPath(dir, 'cloud')]).size).toBe(3);
    expect(agentDeviceSession('thread', 'mini', 'same-id')).not.toBe(agentDeviceSession('thread', 'android', 'same-id'));
    for (const args of [
      ['snapshot'],
      ['snapshot', '--config', files[0]!],
      ['snapshot', '--config', 'help'],
      ['snapshot', '--config', files[0]!, '--session'],
    ]) {
      await expect(exec(process.execPath, [NodePath.join(shim, 'agent-device-launcher.mjs'), ...args])).rejects.toThrow(
        'Call device_open first',
      );
    }
  });
});
